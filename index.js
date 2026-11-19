import { scheduler } from "node:timers/promises";
import schedule from "node-schedule";
import path from "node:path";
import { WhatsAppYouTubeBridge } from "./whatsappYouTubeBridge.js";
import { createFusionCommandHandler } from "./fusionCommand.js";

// Configuration and Constants
import { Faction, Megaphone, TTSModel } from "./config.js";

// Services
import { textToSpeech, queueMonitorVideo, isPlaybackBusy } from "./ttsService.js";
import {
  authorize as authorizeYouTube,
  checkLiveStreams,
  createScheduledLiveStream,
  updateVideoDetails,
  deleteLiveBroadcasts,
  sendLiveChatMessage,
  clearLiveChatCache,
  oAuth2Client,
} from "./youtubeService.js";
import {
  obs, // direct obs instance for some specific calls if needed outside service
  obsConnect,
  IsLiveStreaming,
  getOBSStreamingState,
  startOBSStreamingAndRecognition,
  stopOBSStreamingAndRecognition,
  launchOBS,
  closeOBS,
  toggleCam,
  getAllCamsStatus,
  hideZDXPopup,
} from "./obsService.js";
import {
  startLiveChatAndViewerCount,
  stopLiveChatAndViewerCount,
  updateMegaphoneState,
} from "./chatService.js";
import {
  setupServer,
  io as socketIoInstance,
  internalEvents,
} from "./serverSetup.js"; // Import io and internalEvents
import {
  startDXOPScreen,
  connectSpeaker,
  lofiTest,
  startOverlay,
  stopOverlay,
} from "./systemUtils.js";
import { createMessage } from "./messageService.js";
import {
  broadcastGameState,
  broadcastDummyGameState,
  markCameraAsDisabled,
  restoreScoreFromArgs,
  stopRecognizeBattleResults,
} from "./score.js";
import { installShutdownHandlers, withTimeout } from "./shutdown.js";
import { announceStreamLinks } from "./streamAnnouncements.js";
import { startWeatherAnnouncements } from "./morningWeather.js";
import { startTimeAnnouncer } from "./timeAnnouncer.js";
import {
  sendTextToDXGroup,
  WA_TEST_GROUP_ID,
  WA_PUBLIC_GROUP_ID,
  client as whatsappClient,
} from "./whatsapp.js";
// --- Global State (moved from various places, consider if these need to be in a dedicated state module later) ---
let megaphoneState = Megaphone.ENABLED;
let blockStartStreamingUntil = 0;
let currentBroadcastIds = []; // To store IDs of current streams
let currentStreamType = null; // 'public' or 'unlisted'
let stopStreamingPromise = null;
let startStreamingPromise = null;
let restartStreamingPromise = null;
let restartIncomplete = false;
let shutdownIncomplete = false;
let streamGeneration = 0;

const whatsappYouTubeBridge = new WhatsAppYouTubeBridge({
  directory: path.join(whatsappClient.storeDir, "youtube-outbox"),
  publicGroupId: WA_PUBLIC_GROUP_ID,
  testGroupId: WA_TEST_GROUP_ID,
  getStreamState: () => ({ broadcastIds: currentBroadcastIds, streamType: currentStreamType }),
  send: sendLiveChatMessage,
  notify: (groupId, text, options) => whatsappClient.sendMessage(groupId, text, options),
  canNotify: () => whatsappClient.ready,
  canSend: () => Boolean(oAuth2Client.credentials.access_token || oAuth2Client.credentials.refresh_token),
});
// Install before any awaited startup work, so early webhooks are saved too.
whatsappClient.setMessageHandler((message) => whatsappYouTubeBridge.accept(message));
whatsappClient.setShutdownHandler(() => whatsappYouTubeBridge.close());
const handleFusionCommand = createFusionCommandHandler({
  isPlaybackBusy,
  publicGroupId: WA_PUBLIC_GROUP_ID,
  testGroupId: WA_TEST_GROUP_ID,
  getStreamState: () => ({ broadcastIds: currentBroadcastIds, streamType: currentStreamType }),
  play: () => {
    const streamKey = currentBroadcastIds.join(",");
    console.log("WhatsApp !fusion: queued monitor video after earlier speech.");
    return queueMonitorVideo(async () => {
      // Do not carry an old stream's queued effect into a later stream.
      if (currentBroadcastIds.join(",") !== streamKey) return;
      const monitorId = socketIoInstance?.sockets.adapter.rooms.get("monitor-overlay")?.values().next().value;
      const monitor = socketIoInstance?.sockets.sockets.get(monitorId);
      if (!monitor) throw new Error("Monitor overlay is not connected.");
      // The monitor acknowledges only after the clip ends or fails. Speech
      // stays queued throughout loading AND playback, without a fixed sleep.
      const result = await monitor.timeout(45000).emitWithAck("playFusion");
      if (!result?.played) throw new Error(result?.error || "Video did not finish playing.");
      console.log("Fusion video finished.");
    });
  },
});
// The WhatsApp client emits this only once per message ID, after receipt handling.
whatsappClient.on("message", (message) => {
  handleFusionCommand(message).catch((error) => console.error("WhatsApp !fusion failed:", error));
});
internalEvents.on("youtubeChatMessageObserved", (id) => {
  whatsappYouTubeBridge.observe(id).catch((error) =>
    console.error("Failed to record YouTube comment observation:", error));
});

// --- Socket.IO Client Connection Handler ---
// This function will be passed to setupServer
function handleClientConnection(client, io) {
  // Only the local monitor plays the clip, avoiding sound from other chat pages.
  if (client.handshake.auth?.monitorOverlay === true) {
    client.join("monitor-overlay");
    client.on("fusionPlaybackStatus", ({ status, error } = {}) => {
      if (status === "failed") console.error("Fusion video playback failed:", error);
      else if (status === "playing" || status === "ended") console.log(`Fusion video ${status}.`);
    });
  }
  // Emit initial status to newly connected client
  IsLiveStreaming()
    .then((isStreaming) => {
      client.emit("isStreaming", streamingStatus(isStreaming));
      client.emit("megaphoneStatus", megaphoneState);
      if (currentBroadcastIds.length === 2) {
        client.emit("streamUrls", {
          url1: `https://youtu.be/${currentBroadcastIds[0]}`,
          url2: `https://youtu.be/${currentBroadcastIds[1]}`,
        });
      }
    })
    .catch(console.error);

  client.on("startPublic", async () => {
    console.log("Socket.IO: Received startPublic request");
    await startStreaming({ isPublic: true, io }); // Pass io
  });

  client.on("startUnlisted", async () => {
    console.log("Socket.IO: Received startUnlisted request");
    await startStreaming({ isPublic: false, io }); // Pass io
  });

  client.on("stopStreaming", async () => {
    console.log("Socket.IO: Received stopStreaming request");
    await stopStreaming(io); // Pass io
  });

  client.on("restartStreaming", async () => {
    console.log("Socket.IO: Received restartStreaming request");
    await restartStreaming(io);
  });

  client.on("getStreamingStatus", async () => {
    io.emit("isStreaming", streamingStatus(await IsLiveStreaming()));
  });

  client.on("toggleMegaphone", async () => {
    if (!(await IsLiveStreaming())) {
      console.log("Megaphone toggle: Not streaming");
      return;
    }
    megaphoneState = megaphoneState.enabled
      ? Megaphone.MUTED
      : Megaphone.ENABLED;
    updateMegaphoneState(megaphoneState); // Update state in chatService
    io.emit("megaphoneStatus", megaphoneState);
    if (megaphoneState === Megaphone.MUTED) {
      const msg = createMessage({
        authorName: "現場發動滅聲",
        profilePic: "images/mute.png",
        message:
          "我真係唔得喇，你唔好再... 💥 你老闆話你真係，我已經話咗唔得嫁啦，你仲要喔噢喔噢咁，完全唔理我幾咁難受嘅你！😡",
      });
      io.emit("message", msg);
    }
  });

  client.on("setMegaphone", (enabled) => {
    megaphoneState = enabled ? Megaphone.ENABLED : Megaphone.MUTED;
    updateMegaphoneState(megaphoneState); // Update state in chatService
    io.emit("megaphoneStatus", megaphoneState);
  });

  client.on("getMegaphoneStatus", () => {
    io.emit("megaphoneStatus", megaphoneState);
  });

  client.on("getInitialGameState", () => {
    console.log("Client requested initial game state.");
    broadcastGameState();
  });

  client.on("toggleCam", async (cameraName) => {
    console.log(`Socket.IO: Received toggleCam request for ${cameraName}`);
    const isNowEnabled = await toggleCam(cameraName);

    // If the camera was just turned OFF, mark it as recently disabled.
    if (isNowEnabled === false) {
      markCameraAsDisabled(cameraName);
    }
  });

  client.on("getCamStatuses", async () => {
    const statuses = await getAllCamsStatus();
    client.emit("allCamStatuses", statuses);
  });

  client.on("sendYouTubeMessage", async (message) => {
    await sendToFederationLiveChat(message);
  });
}

/**
 * Helper to send a message specifically to the active Federation YouTube stream.
 * Since the Live ChatBox overlay syncs and displays comments from both Federation
 * and Zeon streams, sending to the Federation side is sufficient for all viewers to see.
 */
async function sendToFederationLiveChat(message) {
  if (currentBroadcastIds.length > 0) {
    console.log(`Sending to Federation YouTube stream: ${message}`);
    try {
      await sendLiveChatMessage(currentBroadcastIds[0], message);
    } catch (error) {
      console.error(`YouTube comment ${error.outcome || "failed"}:`, error.message);
    }
  }
}

// Subscribe index.js to internal events
internalEvents.on("sendYouTubeMessage", async (message) => {
  await sendToFederationLiveChat(message);
});

// --- Main Streaming Logic ---
function streamingStatus(isStreaming) {
  return {
    isStreaming: shutdownIncomplete || restartIncomplete || restartStreamingPromise ? null : isStreaming,
    streamType: currentStreamType,
    shutdownIncomplete,
    restarting: Boolean(restartStreamingPromise),
    restartIncomplete,
    canRestart: !shutdownIncomplete && currentBroadcastIds.length === 2 &&
      (isStreaming === true || restartIncomplete),
  };
}

function startStreaming(options) {
  if (restartStreamingPromise || restartIncomplete) {
    options.io.emit("status", "OBS recovery is pending. Retry 重開直播 or use Stop before starting a new session.");
    options.io.emit("isStreaming", streamingStatus(null));
    return Promise.resolve();
  }
  if (startStreamingPromise) return startStreamingPromise;
  startStreamingPromise = performStartStreaming(options).finally(() => { startStreamingPromise = null; });
  return startStreamingPromise;
}

async function performStartStreaming({ isPublic, retryCount = 0, io, generation }) {
  const MAX_RETRIES = 3;
  if (stopStreamingPromise || shutdownIncomplete) {
    io.emit("status", "Shutdown is incomplete. Wait for Stop to finish, or retry Stop before starting.");
    io.emit("isStreaming", { isStreaming: null, streamType: currentStreamType, shutdownIncomplete: true });
    return;
  }

  if (Date.now() < blockStartStreamingUntil) {
    io.emit("isStreaming", { isStreaming: false, streamType: null });
    console.error(
      `Start request ignored: Please wait for ${Math.ceil(
        (blockStartStreamingUntil - Date.now()) / 1000,
      )} seconds before starting again.`,
    );
    textToSpeech({
      text: "啱啱先停播，等一分鐘先再開直播啦",
      model: TTSModel.AZURE_AI,
      voiceID: "zh-HK-HiuMaanNeural",
    });
    return;
  }
  const startupGeneration = generation ?? ++streamGeneration;
  const isCurrent = () => startupGeneration === streamGeneration;
  if (!isCurrent()) return;
  currentStreamType = isPublic ? "public" : "unlisted";

  let broadcastIds = [];
  let announceNewStreams = false;

  const obsLaunched = await launchOBS(); // Ensures OBS is running and connected
  if (!isCurrent()) return;
  if (!obsLaunched) {
    console.error("OBS failed to launch or connect. Aborting startStreaming.");
    io.emit("isStreaming", { isStreaming: false, streamType: null }); // Ensure client UI reflects this
    return;
  }

  broadcastIds = await checkLiveStreams("active");
  if (!isCurrent()) return;
  if (broadcastIds.length > 0) {
    console.log("Live stream(s) already active:", broadcastIds);
  } else {
    broadcastIds = await checkLiveStreams("upcoming");
    if (!isCurrent()) return;
    if (broadcastIds.length > 0) {
      console.log("Upcoming stream(s) already scheduled:", broadcastIds);
    } else {
      console.log(
        "No active or upcoming streams found. Creating new scheduled streams...",
      );
      try {
        const broadcastPromises = [Faction.FEDERATION, Faction.ZEON].map(
          (faction) => createScheduledLiveStream({ faction, isPublic }),
        );
        const broadcastResults = await Promise.all(broadcastPromises);
        if (!isCurrent()) return;

        const federationResult = broadcastResults.find(
          (result) => result.faction === Faction.FEDERATION,
        );
        const zeonResult = broadcastResults.find(
          (result) => result.faction === Faction.ZEON,
        );

        if (!federationResult || !zeonResult) {
          throw new Error("Failed to create one or both faction streams.");
        }
        broadcastIds = [federationResult.broadcastId, zeonResult.broadcastId];

        await Promise.all([
          updateVideoDetails({
            broadcastId: federationResult.broadcastId,
            faction: federationResult.faction,
            opponentBroadcastId: zeonResult.broadcastId,
          }),
          updateVideoDetails({
            broadcastId: zeonResult.broadcastId,
            faction: zeonResult.faction,
            opponentBroadcastId: federationResult.broadcastId,
          }),
        ]);
        if (!isCurrent()) return;
        console.log(
          "Successfully created and updated new streams:",
          broadcastIds,
        );

        announceNewStreams = true;
      } catch (error) {
        console.error("Error during stream creation/update:", error);
        if (broadcastIds.length > 0) await deleteLiveBroadcasts(broadcastIds); // Clean up partially created
        broadcastIds = []; // Reset for retry logic
      }
    }
  }

  if (!isCurrent()) return;
  if (broadcastIds.length !== 2) {
    console.error(
      "Failed to obtain 2 valid broadcast IDs. Current IDs:",
      broadcastIds,
    );
    if (broadcastIds.length > 0) await deleteLiveBroadcasts(broadcastIds); // Cleanup

    if (retryCount < MAX_RETRIES) {
      console.log(
        `Retrying stream setup (Attempt ${retryCount + 1}/${MAX_RETRIES})`,
      );
      await scheduler.wait(5000); // Wait before retrying
      if (!isCurrent()) return;
      return performStartStreaming({ isPublic, retryCount: retryCount + 1, io, generation: startupGeneration });
    } else {
      console.error("Max retries reached. Failed to set up live streams.");
      io.emit("isStreaming", { isStreaming: false, streamType: null });
      return;
    }
  }

  currentBroadcastIds = [...broadcastIds]; // Store current IDs

  await scheduler.wait(2000); // Short delay before starting OBS stream
  if (!isCurrent()) return;
  await hideZDXPopup();
  if (!isCurrent()) return;

  const started = await startOBSStreamingAndRecognition(createIdleShutdown(io, isPublic, isCurrent), isPublic, isCurrent);
  if (!isCurrent()) return;
  if (started === false) {
    shutdownIncomplete = true;
    io.emit("status", "OBS startup failed. Use Stop to complete cleanup before trying again.");
    io.emit("isStreaming", streamingStatus(null));
    return;
  }
  startOverlay();

  console.log(
    `Stream starting process initiated for ${
      isPublic ? "Public" : "Unlisted"
    } streams.`,
  );

  if (!isPublic) {
    textToSpeech({
      text: "荔枝角興趣班，上線啦！學員想睇重播嘅話，記得要scan個QR code呀",
      model: TTSModel.AZURE_AI,
      voiceID: "zh-HK-HiuMaanNeural",
    });
  }

  io.emit("streamUrls", {
    url1: `https://youtu.be/${broadcastIds[0]}`,
    url2: `https://youtu.be/${broadcastIds[1]}`,
  });
  io.emit("isStreaming", streamingStatus(true));

  if (announceNewStreams) {
    // Announcements are optional; WhatsApp auth/sends must not gate OCR or chat.
    void announceStreamLinks({
      broadcastIds: [...broadcastIds],
      groupId: isPublic ? WA_PUBLIC_GROUP_ID : WA_TEST_GROUP_ID,
      isCurrent: () => isCurrent() && currentBroadcastIds.join(",") === broadcastIds.join(","),
      isReady: () => whatsappClient.ready,
      send: sendTextToDXGroup,
    });
  }

  await scheduler.wait(15000); // Wait for streams to be fully live before starting chat
  if (!isCurrent()) return;
  startLiveChatAndViewerCount({ broadcastIds, io, isPublic });
}

function createIdleShutdown(io, isPublic, isCurrent) {
  return async () => {
    if (!isCurrent()) return;
    console.log("Idle shutdown triggered via OCR logic.");
    const idleCloseMessage = "機台閒置時間過長，直播即將關閉，多謝收睇。";

    // 1. Final YouTube Comment
    await sendToFederationLiveChat(idleCloseMessage);
    if (!isCurrent()) return;

    // 2. Final TTS Announcement (Public only)
    if (isPublic) {
      await textToSpeech({
        text: idleCloseMessage,
        model: TTSModel.AZURE_AI,
        voiceID: "zh-HK-HiuMaanNeural",
      });
    }

    // 3. Grace period for sound to finish and YouTube chat to sync (approx 5s)
    await scheduler.wait(5000);
    if (!isCurrent()) return;

    // 4. Perform full cleanup and stop streaming
    await stopStreaming(io);
  };
}

function restartStreaming(io) {
  if (restartStreamingPromise) return restartStreamingPromise;
  if (stopStreamingPromise || shutdownIncomplete || currentBroadcastIds.length !== 2) {
    io.emit("status", "重開直播 requires the current broadcasts and a completed startup. Finish Stop first if shutdown failed.");
    io.emit("isStreaming", streamingStatus(null));
    return Promise.resolve(false);
  }
  const previousGeneration = streamGeneration;
  restartStreamingPromise = (async () => {
    // Let an existing startup finish before taking ownership of OBS/OCR.
    await startStreamingPromise;
    if (previousGeneration !== streamGeneration || shutdownIncomplete || currentBroadcastIds.length !== 2) return false;
    const isPublic = currentStreamType === "public";
    const state = await getOBSStreamingState({ reconnect: true });
    if (previousGeneration !== streamGeneration) return false;
    if (state !== true && !restartIncomplete) {
      io.emit("status", "OBS is not confirmed streaming. Check OBS before using 重開直播.");
      return false;
    }
    const generation = ++streamGeneration;
    const isCurrent = () => generation === streamGeneration;
    restartIncomplete = true;
    io.emit("status", "重開直播：正在停止直播及虛擬鏡頭，關閉並重新啟動 OBS…");
    const stopped = await stopOBSStreamingAndRecognition();
    if (!isCurrent()) return false;
    // Process exit also confirms stream/camera release when StopStream failed.
    const closed = await closeOBS();
    if (!isCurrent()) return false;
    if (!closed) throw new Error("Could not confirm OBS process exit. A second OBS instance will not be launched.");
    if (!stopped?.recognitionStopped) throw new Error("Battle recognition did not stop; retry recovery.");
    if (!await launchOBS()) throw new Error("OBS could not be restarted or connected.");
    if (!isCurrent()) return false;
    const started = await startOBSStreamingAndRecognition(
      createIdleShutdown(io, isPublic, isCurrent), isPublic, isCurrent, { recovery: true });
    if (!isCurrent()) return false;
    if (started !== true) throw new Error("OBS stream or virtual camera could not be restarted.");
    restartIncomplete = false;
    io.emit("status", "重開直播完成：OBS 直播及虛擬鏡頭已恢復，沿用原有 YouTube 直播連結。");
    return true;
  })().catch(error => {
    console.error("OBS recovery failed:", error);
    io.emit("status", `重開直播失敗：${error.message} 可重試重開直播，或按停播完成清理。`);
    return false;
  }).finally(async () => {
    const active = stopStreamingPromise ? null : await IsLiveStreaming();
    restartStreamingPromise = null;
    if (!stopStreamingPromise) io.emit("isStreaming", streamingStatus(active));
  });
  io.emit("isStreaming", streamingStatus(null));
  return restartStreamingPromise;
}

function stopStreaming(io) {
  if (stopStreamingPromise) return stopStreamingPromise;
  // Invalidate delayed startup work before awaiting anything during shutdown.
  streamGeneration++;
  const recovery = restartStreamingPromise;
  stopStreamingPromise = (async () => {
    // Stop cancels recovery immediately, then waits for any in-flight process
    // launch/start request before doing the final cleanup.
    await recovery;
    restartIncomplete = false;
    return performStopStreaming(io);
  })().finally(() => {
    blockStartStreamingUntil = Date.now() + 60 * 1000;
    stopStreamingPromise = null;
  });
  return stopStreamingPromise;
}

async function performStopStreaming(io) {
  const broadcastIds = currentBroadcastIds;
  currentBroadcastIds = []; // Stop accepting commands or sending queued stream links.
  currentStreamType = null;
  try {
    const state = await getOBSStreamingState();
    const now = new Date();
    const hour = now.getHours();
    const isLateNight = hour >= 22 || hour < 3;
    if (state === true && isLateNight) {
      const farewellMessage = "歡樂今宵再會，各位觀眾……晚安";
      console.log("Late night stop detected. Playing and sending announcement.");
      // Optional announcements must not prevent shutdown on a service failure.
      if (broadcastIds.length) {
        await withTimeout(() => sendLiveChatMessage(broadcastIds[0], farewellMessage),
          15000, "Farewell comment").catch(error =>
          console.error("Farewell comment failed:", error.message));
      }
      await withTimeout(() => textToSpeech({ text: farewellMessage,
        model: TTSModel.AZURE_AI, voiceID: "zh-HK-HiuMaanNeural" }),
      20000, "Farewell speech");
      await scheduler.wait(5000);
    }
  } catch (error) {
    console.error("Shutdown announcement/status check failed; continuing cleanup:", error.message);
  }

  const cleanups = [
    ["chat and viewer polling", () => stopLiveChatAndViewerCount()],
    ["YouTube chat cache", () => clearLiveChatCache()],
    ["scoreboard overlay", () => stopOverlay()],
    ["OBS and battle recognition", () => stopOBSStreamingAndRecognition()],
  ];
  const results = await Promise.allSettled(cleanups.map(([, cleanup]) => Promise.resolve().then(cleanup)));
  results.forEach((result, index) => {
    if (result.status === "rejected") console.error(`Failed to stop ${cleanups[index][0]}:`, result.reason);
  });
  const obsResult = results[3].status === "fulfilled" ? results[3].value : null;
  let closed = false;
  try {
    closed = await closeOBS();
  } catch (error) {
    console.error("Error closing OBS:", error.message);
  }
  const streamStopped = obsResult?.streamStopped === true || closed === true;
  const cleanedUp = results.every(result => result.status === "fulfilled") &&
    obsResult?.recognitionStopped === true;
  shutdownIncomplete = !streamStopped || !cleanedUp || closed !== true;

  megaphoneState = Megaphone.ENABLED;
  try {
    updateMegaphoneState(megaphoneState);
    if (io) {
      io.emit("megaphoneStatus", megaphoneState);
      io.emit("totalviewers", 0);
      io.emit("isStreaming", { isStreaming: streamStopped ? false : null,
        streamType: null, shutdownIncomplete });
    }
  } catch (error) {
    console.error("Error reporting shutdown state:", error.message);
  }
  const status = shutdownIncomplete
    ? "Shutdown incomplete. Retry Stop or check OBS manually; see errors above."
    : "Streaming stopped and local services cleaned up.";
  if (shutdownIncomplete) console.error(status);
  else console.log(status);
  if (io) io.emit("status", status);
  return { streamStopped, cleanedUp, complete: !shutdownIncomplete };
}

// --- Scheduled Tasks ---
schedule.scheduleJob("10 2 * * *", async () => {
  console.log("Scheduled task: Stopping stream at 02:10 AM");
  if (socketIoInstance) {
    const result = await stopStreaming(socketIoInstance);
    if (result.complete) socketIoInstance.emit("status", "Streaming stopped by schedule");
  } else {
    console.error(
      "Scheduled task: io instance not available to stop streaming.",
    );
  }
});

// One owner waits for both local services; OBS continues broadcasting.
let stopWeatherAnnouncements = () => {};
installShutdownHandlers([
  () => stopWeatherAnnouncements(),
  () => stopRecognizeBattleResults(),
  () => whatsappClient.destroy(),
]);

// --- Main Application ---
async function main() {
  restoreScoreFromArgs(process.argv.slice(2));
  const { server } = setupServer(handleClientConnection);
  // Establish single-server ownership before opening the forwarding journal.
  // A second process must exit on a port conflict instead of draining it too.
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  startTimeAnnouncer();
  stopWeatherAnnouncements = startWeatherAnnouncements({
    client: whatsappClient,
    groupId: WA_PUBLIC_GROUP_ID,
    directory: path.join(whatsappClient.storeDir, "weather-announcements"),
  });
  await whatsappYouTubeBridge.initialize();
  await authorizeYouTube();
  whatsappYouTubeBridge.start();
  await startDXOPScreen();
  await connectSpeaker("HK Onyx Studio", "0C:A6:94:08:F6:A1");

  // Example: For testing lofi mode directly on start (usually triggered by client)
  // lofiTest(io);

  // Example: For testing TTS directly on start
  // textToSpeech({
  //   text: "系統啟動成功",
  //   model: TTSModel.AZURE_AI,
  //   voiceID: "zh-HK-WanLungNeural"
  // });
}

main().catch((error) => {
  console.error("Unhandled error in main:", error);
  process.exit(1); // Exit if main setup fails critically
});
