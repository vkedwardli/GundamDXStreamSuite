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
import { startDXOPScreen, connectSpeaker, lofiTest } from "./systemUtils.js";
import {
  broadcastGameState,
  broadcastDummyGameState,
  markCameraAsDisabled,
} from "./score.js";
// --- Global State (moved from various places, consider if these need to be in a dedicated state module later) ---
let megaphoneState = Megaphone.ENABLED;
let blockStartStreamingUntil = 0;
let currentBroadcastIds = []; // To store IDs of current streams

// --- Socket.IO Client Connection Handler ---
// This function will be passed to setupServer
function handleClientConnection(client, io) {
  // Emit initial status to newly connected client
  IsLiveStreaming()
    .then((isStreaming) => {
      client.emit("isStreaming", isStreaming);
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
    io.emit("isStreaming", await IsLiveStreaming());
  });

  client.on("startUnlisted", async () => {
    console.log("Socket.IO: Received startUnlisted request");
    await startStreaming({ isPublic: false, io }); // Pass io
    io.emit("isStreaming", await IsLiveStreaming());
  });

  client.on("stopStreaming", async () => {
    console.log("Socket.IO: Received stopStreaming request");
    await stopStreaming(io); // Pass io
    io.emit("status", "Streaming stopped");
    io.emit("isStreaming", await IsLiveStreaming());
  });

  client.on("getStreamingStatus", async () => {
    io.emit("isStreaming", await IsLiveStreaming());
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
      const msg = {
        isFederation: true, // Or some other default
        time: new Date().toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "numeric",
          hour12: true,
          timeZone: "Asia/Hong_Kong",
        }),
        authorName: "現場發動滅聲",
        profilePic: "images/mute.png", // Ensure this file is served
        message:
          "我真係唔得喇，你唔好再... 💥 你老闆話你真係，我已經話咗唔得嫁啦，你仲要喔噢喔噢咁，完全唔理我幾咁難受嘅你！😡",
        plainMessage:
          "我真係唔得喇，你唔好再... 💥 你老闆話你真係，我已經話咗唔得嫁啦，你仲要喔噢喔噢咁，完全唔理我幾咁難受嘅你！😡",
      };
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

  if (Date.now() < blockStartStreamingUntil) {
    io.emit("isStreaming", false);
    console.error(
      `Start request ignored: Please wait for ${Math.ceil(
        (blockStartStreamingUntil - Date.now()) / 1000
      )} seconds before starting again.`
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
    io.emit("isStreaming", false); // Ensure client UI reflects this
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
        "No active or upcoming streams found. Creating new scheduled streams..."
      );
      try {
        const broadcastPromises = [Faction.FEDERATION, Faction.ZEON].map(
          (faction) => createScheduledLiveStream({ faction, isPublic })
        );
        const broadcastResults = await Promise.all(broadcastPromises);

        const federationResult = broadcastResults.find(
          (result) => result.faction === Faction.FEDERATION
        );
        const zeonResult = broadcastResults.find(
          (result) => result.faction === Faction.ZEON
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
          broadcastIds
        );
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
      broadcastIds
    );
    if (broadcastIds.length > 0) await deleteLiveBroadcasts(broadcastIds); // Cleanup

    if (retryCount < MAX_RETRIES) {
      console.log(
        `Retrying stream setup (Attempt ${retryCount + 1}/${MAX_RETRIES})`
      );
      await scheduler.wait(5000); // Wait before retrying
      return startStreaming({ isPublic, retryCount: retryCount + 1, io });
    } else {
      console.error("Max retries reached. Failed to set up live streams.");
      io.emit("isStreaming", false);
      return;
    }
  }

  currentBroadcastIds = [...broadcastIds]; // Store current IDs

  await scheduler.wait(2000); // Short delay before starting OBS stream
  await startOBSStreamingAndRecognition(); // From obsService

  console.log(
    `Stream starting process initiated for ${
      isPublic ? "Public" : "Unlisted"
    } streams.`
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
  io.emit("isStreaming", true);

  await scheduler.wait(15000); // Wait for streams to be fully live before starting chat
  startLiveChatAndViewerCount({ broadcastIds, io });
}

async function stopStreaming(io) {
  // io might be needed for emitting status during stop
  try {
    blockStartStreamingUntil = Date.now() + 60 * 1000; // Block for 60 seconds
    megaphoneState = Megaphone.ENABLED; // Reset megaphone state
    updateMegaphoneState(megaphoneState);
    if (io) io.emit("megaphoneStatus", megaphoneState);

    await stopOBSStreamingAndRecognition(); // From obsService
    stopLiveChatAndViewerCount(); // From chatService

    currentBroadcastIds = []; // Clear current broadcast IDs
    if (io) {
      io.emit("totalviewers", 0); // Reset viewers
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
      "Scheduled task: io instance not available to stop streaming."
    );
  }
});

// --- Main Application ---
async function main() {
  setupServer(handleClientConnection); // Setup server, io instance will be set in serverSetup.js

  await authorizeYouTube();
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
