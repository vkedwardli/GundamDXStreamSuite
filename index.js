import { scheduler } from "node:timers/promises";
import schedule from "node-schedule";

// Configuration and Constants
import { Faction, Megaphone, TTSModel } from "./config.js";

// Services
import { textToSpeech } from "./ttsService.js";
import {
  authorize as authorizeYouTube,
  checkLiveStreams,
  createScheduledLiveStream,
  updateVideoDetails,
  deleteLiveBroadcasts,
  sendLiveChatMessage,
  clearLiveChatCache,
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
} from "./obsService.js";
import {
  startLiveChatAndViewerCount,
  stopLiveChatAndViewerCount,
  updateMegaphoneState,
} from "./chatService.js";
import { setupServer, io as socketIoInstance } from "./serverSetup.js"; // Import io
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
  TEST_GROUP_ID,
  PUBLIC_GROUP_ID,
  client as whatsappClient,
} from "./whatsapp.js";
// --- Global State (moved from various places, consider if these need to be in a dedicated state module later) ---
let megaphoneState = Megaphone.ENABLED;
let blockStartStreamingUntil = 0;
let currentBroadcastIds = []; // To store IDs of current streams
let currentStreamType = null; // 'public' or 'unlisted'

// --- Socket.IO Client Connection Handler ---
// This function will be passed to setupServer
function handleClientConnection(client, io) {
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
}

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
          const targetGroupId = isPublic ? PUBLIC_GROUP_ID : TEST_GROUP_ID;
          for (const id of broadcastIds) {
            await sendTextToDXGroup(`https://youtu.be/${id}`, {
              withTyping: true,
              typingDurationMs: getRandomDelay(1500, 2200),
              pauseAfterMs: getRandomDelay(1000, 1500),
              groupId: targetGroupId,
            });
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
  await startOBSStreamingAndRecognition(); // From obsService
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
    const now = new Date();
    const hour = now.getHours();
    // Check if the time is between 10 PM (22) and 3 AM (exclusive of 3, so 22, 23, 0, 1, 2)
    const isLateNight = hour >= 22 || hour < 3;

    if (isLateNight) {
      const farewellMessage = "歡樂今宵再會，各位觀眾……晚安";
      console.log(
        "Late night stop detected. Playing and sending announcement.",
      );

      // Send message to local chat display
      const msg = createMessage({
        authorName: "收皮",
        profilePic: "images/star.png",
        message: farewellMessage,
      });
      if (io) io.emit("message", msg);

      // Play the announcement via TTS
      await textToSpeech({
        text: farewellMessage,
        model: TTSModel.AZURE_AI,
        voiceID: "zh-HK-HiuMaanNeural",
      });

      // Adding a small delay to ensure the sound finishes playing before OBS is killed.
      await scheduler.wait(2000);
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
  setupServer(handleClientConnection); // Setup server, io instance will be set in serverSetup.js

  await authorizeYouTube();
  await startDXOPScreen();
  await connectSpeaker("HK Onyx Studio", "0C:A6:94:08:F6:A1");
  startTimeAnnouncer();

  // WhatsApp command handler for forwarding messages to YouTube Live Chat
  whatsappClient.on("message", async (msg) => {
    // 1. Guard: Only process messages from the allowed groups
    const isPublicGroup = msg.from === PUBLIC_GROUP_ID;
    const isTestGroup = msg.from === TEST_GROUP_ID;
    if (!isPublicGroup && !isTestGroup) return;

    // 2. Guard: Only process if it starts with the expected commands
    const body = msg.body.trim();
    if (!body.startsWith("!fed ") && !body.startsWith("!zeon ")) return;

    const offlineResponses = [
      "東主有喜，暫停直播。",
      "噢~噢噢噢~噢噢噢~ 我俾碌蕉你含~",
      "朋友，你返去印度食蕉啦",
      "邊撚個chok到呢句出嚟，就輸一蚊",
      "由於節目調動嘅關係，原定播映嘅龍珠二世將會暫停播映，敬請留意。",
      "你嗌破喉嚨都冇人理你㗎喇！哈哈哈哈哈哈哈哈~",
    ];

    const sendOfflineReply = async () => {
      const randomMsg =
        offlineResponses[Math.floor(Math.random() * offlineResponses.length)];
      await msg.reply(randomMsg);
    };

    // 3. Guard: If no active streams are found, send funny offline response
    if (currentBroadcastIds.length !== 2) {
      await sendOfflineReply();
      return;
    }

    // 4. Guard: Ensure the group matches the current stream visibility
    if (
      (currentStreamType === "public" && !isPublicGroup) ||
      (currentStreamType === "unlisted" && !isTestGroup)
    ) {
      return;
    }

    let targetVideoId = null;
    let messageContent = "";

    if (body.startsWith("!fed ")) {
      targetVideoId = currentBroadcastIds[0];
      messageContent = body.slice(5).trim();
    } else if (body.startsWith("!zeon ")) {
      targetVideoId = currentBroadcastIds[1];
      messageContent = body.slice(6).trim();
    }

    if (targetVideoId && messageContent) {
      try {
        const contact = await msg.getContact();
        // Use only pushname to avoid exposing phone numbers. Fallback to a generic name if missing.
        const senderName = contact.pushname || "神秘人";

        // Check if message starts with any of the TTS command variants
        const isTTS = /^[!！](m?say|m?gossip|m?anchor)\b/i.test(messageContent);

        if (isTTS) {
          // Send a single combined message: "!gossip Hello !:Edward Li"
          await sendLiveChatMessage(
            targetVideoId,
            `${messageContent} !:${senderName}`,
          );
        } else {
          await sendLiveChatMessage(
            targetVideoId,
            `💬${senderName}: ${messageContent}`,
          );
        }
      } catch (error) {
        console.error("Error processing WhatsApp to YouTube command:", error);
      }
    }
  });

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
