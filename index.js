import { scheduler } from "node:timers/promises";
import schedule from "node-schedule";
import path from "node:path";
import { WhatsAppYouTubeBridge } from "./whatsappYouTubeBridge.js";
import { createFusionCommandHandler } from "./fusionCommand.js";

// Configuration and Constants
import { Faction, Megaphone, TTSModel } from "./config.js";

// Services
import { textToSpeech, queueMonitorVideo } from "./ttsService.js";
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
  getRandomDelay,
  startOverlay,
  stopOverlay,
} from "./systemUtils.js";
import { createMessage } from "./messageService.js";
import {
  broadcastGameState,
  broadcastDummyGameState,
  markCameraAsDisabled,
} from "./score.js";
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
      client.emit("isStreaming", {
        isStreaming,
        streamType: currentStreamType,
      });
      client.emit("megaphoneStatus", megaphoneState);
      if (isStreaming && currentBroadcastIds.length === 2) {
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

  client.on("getStreamingStatus", async () => {
    io.emit("isStreaming", {
      isStreaming: await IsLiveStreaming(),
      streamType: currentStreamType,
    });
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
async function startStreaming({ isPublic, retryCount = 0, io }) {
  const MAX_RETRIES = 3;
  currentStreamType = isPublic ? "public" : "unlisted";

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

  let broadcastIds = [];

  const obsLaunched = await launchOBS(); // Ensures OBS is running and connected
  if (!obsLaunched) {
    console.error("OBS failed to launch or connect. Aborting startStreaming.");
    io.emit("isStreaming", { isStreaming: false, streamType: null }); // Ensure client UI reflects this
    return;
  }

  broadcastIds = await checkLiveStreams("active");
  if (broadcastIds.length > 0) {
    console.log("Live stream(s) already active:", broadcastIds);
  } else {
    broadcastIds = await checkLiveStreams("upcoming");
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
        console.log(
          "Successfully created and updated new streams:",
          broadcastIds,
        );

        try {
          const targetGroupId = isPublic
            ? WA_PUBLIC_GROUP_ID
            : WA_TEST_GROUP_ID;
          for (const id of broadcastIds) {
            const announcement = await sendTextToDXGroup(`https://youtu.be/${id}`, {
              withTyping: true,
              typingDurationMs: getRandomDelay(1200, 2000), // Shorter "pasting" time
              pauseAfterMs: getRandomDelay(800, 1200), // Quick safety pause
              groupId: targetGroupId,
            });
            if (announcement) {
              console.log(`WhatsApp stream announcement sent: https://youtu.be/${id}`);
            } else {
              console.error(`WhatsApp stream announcement failed: https://youtu.be/${id}`);
            }
            // Snappier delay between the two messages
            if (broadcastIds.indexOf(id) === 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, getRandomDelay(1000, 2000)),
              );
            }
          }
        } catch (err) {
          console.error("Failed to send WhatsApp notification:", err);
        }
      } catch (error) {
        console.error("Error during stream creation/update:", error);
        if (broadcastIds.length > 0) await deleteLiveBroadcasts(broadcastIds); // Clean up partially created
        broadcastIds = []; // Reset for retry logic
      }
    }
  }

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
      return startStreaming({ isPublic, retryCount: retryCount + 1, io });
    } else {
      console.error("Max retries reached. Failed to set up live streams.");
      io.emit("isStreaming", { isStreaming: false, streamType: null });
      return;
    }
  }

  currentBroadcastIds = [...broadcastIds]; // Store current IDs

  await scheduler.wait(2000); // Short delay before starting OBS stream
  await hideZDXPopup();

  // Define what happens if the system detects 10 minutes of total inactivity.
  // This is passed as a callback to the OCR monitoring system.
  const handleIdleShutdown = async () => {
    console.log("Idle shutdown triggered via OCR logic.");
    const idleCloseMessage = "機台閒置時間過長，直播即將關閉，多謝收睇。";

    // 1. Final YouTube Comment
    await sendToFederationLiveChat(idleCloseMessage);

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

    // 4. Perform full cleanup and stop streaming
    await stopStreaming(io);
  };

  await startOBSStreamingAndRecognition(handleIdleShutdown, isPublic); // From obsService
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
  io.emit("isStreaming", { isStreaming: true, streamType: currentStreamType });

  await scheduler.wait(15000); // Wait for streams to be fully live before starting chat
  startLiveChatAndViewerCount({ broadcastIds, io, isPublic });
}

async function stopStreaming(io) {
  // io might be needed for emitting status during stop
  try {
    // 0. Guard: Check if we are actually streaming
    const isActuallyStreaming = await IsLiveStreaming();
    if (!isActuallyStreaming) {
      console.log("Stop requested, but OBS is not streaming. Skipping shutdown sequence.");
      return;
    }

    const now = new Date();
    const hour = now.getHours();
    // Check if the time is between 10 PM (22) and 3 AM (exclusive of 3, so 22, 23, 0, 1, 2)
    const isLateNight = hour >= 22 || hour < 3;

    if (isLateNight) {
      const farewellMessage = "歡樂今宵再會，各位觀眾……晚安";
      console.log(
        "Late night stop detected. Playing and sending announcement.",
      );

      // 1. Final YouTube Comment
      await sendToFederationLiveChat(farewellMessage);

      // 2. Play the announcement via TTS
      await textToSpeech({
        text: farewellMessage,
        model: TTSModel.AZURE_AI,
        voiceID: "zh-HK-HiuMaanNeural",
      });

      // 3. Adding a delay to ensure the sound finishes and YouTube chat syncs (approx 5s)
      await scheduler.wait(5000);
    }

    blockStartStreamingUntil = Date.now() + 60 * 1000; // Block for 60 seconds
    megaphoneState = Megaphone.ENABLED; // Reset megaphone state
    currentStreamType = null; // Reset stream type
    updateMegaphoneState(megaphoneState);
    if (io) io.emit("megaphoneStatus", megaphoneState);

    await stopOBSStreamingAndRecognition(); // From obsService
    stopLiveChatAndViewerCount(); // From chatService
    clearLiveChatCache();
    stopOverlay();

    currentBroadcastIds = []; // Clear current broadcast IDs
    if (io) {
      io.emit("totalviewers", 0); // Reset viewers
      io.emit("isStreaming", { isStreaming: false, streamType: null });
    }

    closeOBS();

    console.log("Streaming fully stopped and services cleaned up.");
  } catch (error) {
    console.error("Error during stopStreaming:", error);
  }
}

// --- Scheduled Tasks ---
schedule.scheduleJob("10 2 * * *", async () => {
  console.log("Scheduled task: Stopping stream at 02:10 AM");
  if (socketIoInstance) {
    await stopStreaming(socketIoInstance);
    socketIoInstance.emit("status", "Streaming stopped by schedule");
  } else {
    console.error(
      "Scheduled task: io instance not available to stop streaming.",
    );
  }
});

// --- Main Application ---
async function main() {
  const { server } = setupServer(handleClientConnection);
  // Establish single-server ownership before opening the forwarding journal.
  // A second process must exit on a port conflict instead of draining it too.
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  await whatsappYouTubeBridge.initialize();
  await authorizeYouTube();
  whatsappYouTubeBridge.start();
  await startDXOPScreen();
  await connectSpeaker("HK Onyx Studio", "0C:A6:94:08:F6:A1");
  startTimeAnnouncer();

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
