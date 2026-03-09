import Tesseract, { PSM } from "tesseract.js";
import { PassThrough } from "stream";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import { io, internalEvents } from "./serverSetup.js";
import { scheduler } from "timers/promises";
import { textToSpeech } from "./ttsService.js";
import { TTSModel, Faction } from "./config.js";
import { enableCam, showZDXPopup } from "./obsService.js";
import { createMessage, getFormattedTime } from "./messageService.js";

const recentlyDisabledCams = new Map();
const MANUAL_DISABLE_LOCKOUT_MS = 10000; // 10 seconds

// This function is called from serverSetup.js when a user manually disables a camera
const markCameraAsDisabled = (cameraName) => {
  console.log(
    `${getFormattedTime()}: Manually disabling ${cameraName}, locking for ${
      MANUAL_DISABLE_LOCKOUT_MS / 1000
    }s.`,
  );
  recentlyDisabledCams.set(cameraName, Date.now());
};

// Define the regions in the stacked image
// All areas are scaled to 562px width for FFmpeg vstack.
// Areas 1-4: Game Over (562x105)
// Areas 5-6: Banpresto Large (scaled from 585x104 to 562x100)
// Areas 7-8: Banpresto Small (scaled from 249x47 to 562x106)
const targetAreas = [
  { y: 0, height: 105, name: "Area1" },
  { y: 105, height: 105, name: "Area2" },
  { y: 210, height: 105, name: "Area3" },
  { y: 315, height: 105, name: "Area4" },
  { y: 420, height: 100, name: "IdleArea1" },
  { y: 520, height: 100, name: "IdleArea2" },
  { y: 620, height: 106, name: "IdleArea3" },
  { y: 726, height: 106, name: "IdleArea4" },
];

/* 
  BANPRESTO COORDINATES (Save for later):
  - Area 5-6: w=585:h=104:x=180:y=233 (scaled to 562x100)
  - Area 7-8: w=249:h=47:x=630:y=843 (scaled to 562x106)
*/

// Function to capture the stacked image
async function captureStackedImage() {
  return new Promise((resolve, reject) => {
    const stream = new PassThrough();
    let imageBuffer = [];

    stream.on("data", (chunk) => {
      imageBuffer.push(chunk);
    });
    stream.on("end", () => {
      const buffer = Buffer.concat(imageBuffer);
      if (buffer.length === 0) {
        reject(new Error("Empty buffer received from FFmpeg"));
      } else {
        resolve(buffer);
      }
    });
    stream.on("error", (err) =>
      reject(new Error(`Stream error: ${err.message}`)),
    );

    const ffmpegArgs = [
      "-y",
      "-framerate",
      "60",
      "-f",
      os.platform() === "darwin" ? "avfoundation" : "dshow",
      "-pixel_format",
      os.platform() === "darwin" ? "uyvy422" : "nv12",
      "-video_size",
      "1920x1080",
      "-i",
      os.platform() === "darwin"
        ? "OBS Virtual Camera"
        : "video=OBS Virtual Camera",
      "-filter_complex",
      "[0:v]scale=w=1920:h=1080,format=gray[scaled];" +
        "[scaled]crop=w=562:h=105:x=195:y=307[crop1];" +
        "[scaled]crop=w=562:h=105:x=1158:y=307[crop2];" +
        "[scaled]crop=w=240:h=50:x=637:y=874[crop3a];[crop3a]scale=w=562:h=105[crop3];" +
        "[scaled]crop=w=240:h=50:x=1039:y=874[crop4a];[crop4a]scale=w=562:h=105[crop4];" +
        "[scaled]crop=w=585:h=104:x=180:y=233[crop5a];[crop5a]scale=w=562:h=100[crop5];" +
        "[scaled]crop=w=585:h=104:x=1149:y=233[crop6a];[crop6a]scale=w=562:h=100[crop6];" +
        "[scaled]crop=w=249:h=47:x=630:y=843[crop7a];[crop7a]scale=w=562:h=106[crop7];" +
        "[scaled]crop=w=249:h=47:x=1035:y=843[crop8a];[crop8a]scale=w=562:h=106[crop8];" +
        "[crop1][crop2][crop3][crop4][crop5][crop6][crop7][crop8]vstack=inputs=8[out]",
      "-map",
      "[out]",
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-c:v",
      "mjpeg",
      "-q:v",
      "5",
      "pipe:",
    ];

    // console.log(`FFmpeg command: ffmpeg ${ffmpegArgs.join(" ")}`);

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    ffmpeg.stdout.pipe(stream);
    // ffmpeg.stdout.on("data", () => {});

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data;
      // console.error(`FFmpeg stderr: ${data}`);
    });
    ffmpeg.on("error", (err) =>
      reject(new Error(`FFmpeg spawn error: ${err.message}`)),
    );
    ffmpeg.on("close", (code) => {
      // console.log(`FFmpeg process exited with code ${code}`);
      if (code !== 0) {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      }
    });
  });
}

// Function to process a single region of the stacked image
async function processRegion(buffer, area, worker) {
  if (!worker) return { area: area.name, text: "" };
  try {
    const {
      data: { text, confidence },
    } = await worker.recognize(buffer, {
      rectangle: { left: 0, top: area.y, width: 561, height: area.height },
    });
    return { area: area.name, text };
  } catch (err) {
    throw new Error(`Tesseract error for ${area.name}: ${err.message}`);
  }
}

// Function to process the stacked image
async function processFrame() {
  try {
    // Capture image
    const buffer = await captureStackedImage();

    // Process regions
    const results = await Promise.all(
      targetAreas.map((area) => processRegion(buffer, area, worker)),
    );

    return results;
  } catch (err) {
    throw err;
  }
}

// --- Tesseract and Global Worker ---
let worker = null;
let intervalId = null;

// --- Constants ---
const STREAK_RESET_THRESHOLD_MS = 360000; // 6 minutes
const GAMEOVER_DISPLAY_CLEAR_DELAY_MS = 2000; // 2 seconds

// --- Centralized Game State ---
const gameState = {
  // Counters for the current winning streak
  streaks: {
    [Faction.ZEON.value]: 0,
    [Faction.FEDERATION.value]: 0,
  },
  // Lifetime counters for all valid 2v2 matches
  totalWins: {
    [Faction.ZEON.value]: 0,
    [Faction.FEDERATION.value]: 0,
  },
  totalBattles: 0,
  totalDraws: 0,
  lastWinner: null, // Faction object
  lastOutcomeTime: 0, // Timestamp of the last processed win/draw
  lastBattleAnnouncement: 0,
  lastZDXAnnouncement: 0,
  idleAreaStats: {
    IdleArea1: { lastSeen: 0, idleStart: 0, lastEventTime: 0 },
    IdleArea2: { lastSeen: 0, idleStart: 0, lastEventTime: 0 },
    IdleArea3: { lastSeen: 0, idleStart: 0, lastEventTime: 0 },
    IdleArea4: { lastSeen: 0, idleStart: 0, lastEventTime: 0 },
  },
  lastIdleWarningTime: 0,
};

let idleShutdownCallback = null;
let isShuttingDown = false;

// --- Battle Detection Buffering ---
let detectionBuffer = new Set();
let processOutcomeTimeoutId = null;

const streakMessages = {
  3: "帽子戲法",
  4: "大四喜",
  5: "五福臨門",
  6: "六六無窮",
  7: "七星報喜",
  8: "八仙過海",
  9: "九霄雲外",
  10: "十全十美",
};
const superStreakMessage = "數唔到喇，打L死人咩";

// Broadcasts the current game state to the client via a prefixed console log
const broadcastGameState = () => {
  if (io) {
    io.emit("battleResult", { state: gameState });
  }
};

// Prints the overall battle statistics with the win ratio as a percentage.
const logBattleSummary = () => {
  const { totalBattles, totalDraws, totalWins } = gameState;
  const fedWins = totalWins[Faction.FEDERATION.value];
  const zeonWins = totalWins[Faction.ZEON.value];
  const totalWinGames = fedWins + zeonWins;

  let ratioString;

  // Handle the edge case where no wins have been recorded to avoid division by zero.
  if (totalWinGames === 0) {
    ratioString = "N/A (no wins recorded yet)";
  } else {
    // Calculate the win percentage for each faction out of the total games won.
    const fedWinPercentage = (fedWins / totalWinGames) * 100;
    const zeonWinPercentage = (zeonWins / totalWinGames) * 100;

    // Format the string to one decimal place for readability.
    ratioString = `Federation: ${fedWinPercentage.toFixed(
      1,
    )}% | Zeon: ${zeonWinPercentage.toFixed(1)}%`;
  }

  const summary = `
-------------------- BATTLE STATS --------------------
Total Matches: ${totalBattles}
Wins:          Federation: ${fedWins} | Zeon: ${zeonWins}
Draws:         ${totalDraws}
Win Ratio:     ${ratioString}
----------------------------------------------------`;
  // console.log(summary);
};

// Centralized function to reset win streaks for any reason
const resetStreaks = (reason) => {
  if (gameState.lastWinner) {
    // Only log if there was an active streak
    console.log(`${getFormattedTime()}: Win streak reset due to ${reason}.`);
  }
  gameState.streaks[Faction.ZEON.value] = 0;
  gameState.streaks[Faction.FEDERATION.value] = 0;
  gameState.lastWinner = null;
  broadcastGameState(); // Broadcast the updated state
  // Note: Total stats are NOT reset here, only streaks.
};

const announceTuesdaySpecial = () => {
  const now = new Date();
  const day = now.getDay(); // 0 = Sun, 1 = Mon, 2 = Tue, 3 = Wed
  const hour = now.getHours();

  // "Business Tuesday": Tuesday 08:00 -> Wednesday 01:59 (station open until 2am)
  const isBusinessTuesday =
    (day === 2 && hour >= 8) || // Tuesday after 8am
    (day === 3 && hour < 2); // Early Wednesday still counts as Tuesday night

  if (
    isBusinessTuesday &&
    gameState.totalBattles > 0 &&
    (gameState.totalBattles - 1) % 10 === 0 &&
    gameState.totalBattles !== gameState.lastBattleAnnouncement
  ) {
    gameState.lastBattleAnnouncement = gameState.totalBattles;
    const text = `荔枝角超級星期二提提你：今晚無限制，推槍笠頭鳩搲乜都得！`;

    textToSpeech({
      text,
      model: TTSModel.AZURE_AI,
      voiceID: "zh-HK-HiuMaanNeural",
    });

    const msg = createMessage({
      authorName: "規矩L",
      profilePic: "images/star.png",
      message: text,
    });
    io.emit("message", msg);
  }
};

const triggerZDXPopup = () => {
  if (
    gameState.totalBattles > 0 &&
    (gameState.totalBattles - 6) % 10 === 0 &&
    gameState.lastZDXAnnouncement !== gameState.totalBattles
  ) {
    gameState.lastZDXAnnouncement = gameState.totalBattles;
    showZDXPopup();
  }
};

// Main function to determine and process the battle's outcome
const processBattleOutcome = () => {
  if (detectionBuffer.size === 0) return; // Guard against empty processing

  const detectedAreas = new Set(detectionBuffer);
  detectionBuffer.clear(); // Process and clear immediately

  const zeonLost = detectedAreas.has("Area3") && detectedAreas.has("Area4");
  const federationLost =
    detectedAreas.has("Area1") && detectedAreas.has("Area2");

  let outcome = null;

  if (zeonLost && federationLost) {
    outcome = "Draw";
  } else if (zeonLost) {
    outcome = Faction.FEDERATION; // Zeon lost, so Federation wins
  } else if (federationLost) {
    outcome = Faction.ZEON; // Federation lost, so Zeon wins
  } else {
    // Incomplete match (e.g., only 1 player, or 1 from each side)
    resetStreaks("an incomplete match");
    console.log(
      `${getFormattedTime()}: Ignoring incomplete detection, stats unchanged:`,
      Array.from(detectedAreas),
    );
    broadcastGameState(); // Broadcast state even on incomplete matches to clear stars
    return;
  }

  // A valid 2v2 match was detected, update totals.
  gameState.totalBattles++;
  gameState.lastOutcomeTime = Date.now();

  // Reset the idle state for relevant machines when a game is finished.
  const resetAreaIdle = (area) => {
    if (gameState.idleAreaStats[area]) {
      gameState.idleAreaStats[area].idleStart = 0;
      gameState.idleAreaStats[area].lastSeen = 0;
    }
  };

  if (outcome === "Draw") {
    gameState.totalDraws++;
    resetStreaks("a draw");
    console.log(`${getFormattedTime()}: Game ended in a DRAW.`);
    logBattleSummary(); // Log the summary after a draw
    broadcastGameState(); // Broadcast the updated state
    ["IdleArea1", "IdleArea2", "IdleArea3", "IdleArea4"].forEach(resetAreaIdle);
    return;
  }

  const winner = outcome;
  const loser = winner === Faction.ZEON ? Faction.FEDERATION : Faction.ZEON;

  // Federation side is playing if they win or lose
  resetAreaIdle("IdleArea1");
  resetAreaIdle("IdleArea2");
  // Zeon side is playing if they win or lose
  resetAreaIdle("IdleArea3");
  resetAreaIdle("IdleArea4");

  // --- Camera Control on Score ---
  const resetCamera = (cameraName) => {
    const lastDisabledTime = recentlyDisabledCams.get(cameraName);
    if (lastDisabledTime) {
      const timeSinceDisabled = Date.now() - lastDisabledTime;
      if (timeSinceDisabled < MANUAL_DISABLE_LOCKOUT_MS) {
        console.log(
          `${getFormattedTime()}: Skipping re-enable for ${cameraName} due to recent manual disable.`,
        );
        return; // Skip re-enabling
      }
      // Lockout has expired, remove the flag so it can be enabled next time
      recentlyDisabledCams.delete(cameraName);
    }
    enableCam(cameraName);
  };

  if (winner === Faction.FEDERATION) {
    // Zeon lost, enable their cameras
    resetCamera("zeon-left");
    resetCamera("zeon-right");
  } else if (winner === Faction.ZEON) {
    // Federation lost, enable their cameras
    resetCamera("federation-left");
    resetCamera("federation-right");
  }

  // --- 1. Update TOTAL win counts ---
  gameState.totalWins[winner.value]++;

  // --- 2. Update STREAK counts ---
  gameState.streaks[loser.value] = 0;
  const newStreak = ++gameState.streaks[winner.value];
  gameState.lastWinner = winner;

  const outputMessage = `${getFormattedTime()}: ${
    winner.value
  } wins! Consecutive wins: ${newStreak}`;
  console.log(outputMessage);

  // --- 3. Handle Streak Announcements ---
  const streakMessage =
    newStreak > 10 ? superStreakMessage : streakMessages[newStreak];
  if (streakMessage) {
    // Play TTS
    textToSpeech({
      text: streakMessage,
      model: TTSModel.AZURE_AI,
      voiceID: "zh-HK-HiuMaanNeural", // Gossip voice
    });

    // Emit chat message
    const msg = createMessage({
      isFederation: winner === Faction.FEDERATION,
      authorName: `${winner.displayName}連勝！`,
      profilePic: "images/star.png",
      message: streakMessage,
    });
    io.emit("message", msg);
  }

  // --- 4. Log the overall summary ---
  logBattleSummary();

  // --- 5. Broadcast the new game state ---
  broadcastGameState();

  // --- 6. Check for Tuesday special announcement ---
  announceTuesdaySpecial();

  // --- 7. Check for ZDX Popup ---
  triggerZDXPopup();
};

async function startRecognizeBattleResults(onIdleShutdown, isPublic) {
  idleShutdownCallback = onIdleShutdown;
  isShuttingDown = false; // Reset shutdown flag on start
  worker = await Tesseract.createWorker("eng");
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: "GAMEOVERBANPREST",
    debug_file: "/dev/null",
  });

  console.log("OCR worker started. Monitoring for battle results...");
  broadcastGameState(); // Broadcast initial state on start

  intervalId = setInterval(async () => {
    try {
      const currentTime = Date.now();

      // --- 1. Proactive Streak Reset on Inactivity ---
      if (
        gameState.lastWinner &&
        currentTime - gameState.lastOutcomeTime > STREAK_RESET_THRESHOLD_MS
      ) {
        resetStreaks("prolonged inactivity");
        gameState.lastOutcomeTime = 0; // Reset time to prevent repeated logs
      }

      // --- 2. OCR and Buffer Management ---
      const results = await processFrame();

      const gamedOverAreas = results
        .filter(({ text }) => text.startsWith("GAMEOVER"))
        .map(({ area }) => area);

      // --- 3. Idle Detection Logic ---
      const idleResults = results.filter(({ area }) =>
        area.startsWith("IdleArea"),
      );
      let areaStatuses = [];

      idleResults.forEach(({ area, text }) => {
        // Fuzzy detection for BANPRESTO
        const isAreaOk = /BANP|REST|PREST|ANPRE/.test(text);
        const stats = gameState.idleAreaStats[area];

        if (isAreaOk) {
          // If the logo appears, we treat it as an 'event'.
          // We only process it once every 30 seconds to avoid rapid counting.
          if (currentTime - stats.lastEventTime > 30000) {
            // Mark idle start immediately if not already tracking
            if (stats.idleStart === 0) {
              stats.idleStart = currentTime;
              console.log(
                `[${area}] IDLE started: ${new Date(stats.idleStart).toLocaleTimeString()}`,
              );
            }
            stats.lastSeen = currentTime;
            stats.lastEventTime = currentTime; // Update this ONLY when a new event is registered
          }
        }

        // Safety timeout: If no logo seen for 5 mins, machine might be in use
        if (stats.lastSeen > 0 && currentTime - stats.lastSeen > 300000) {
          if (stats.idleStart > 0)
            console.log(
              `[${area}] Idle cycle broken (no logo for 5m). Machine active.`,
            );
          stats.idleStart = 0;
          stats.lastSeen = 0;
        }

        let status = "NO LOGO";
        if (isAreaOk) status = "LOGO DETECTED";

        const secondsSinceSeen =
          stats.lastSeen > 0
            ? Math.floor((currentTime - stats.lastSeen) / 1000)
            : null;

        if (stats.idleStart > 0) {
          const durationMins = Math.floor(
            (currentTime - stats.idleStart) / 60000,
          );
          status += ` (Idle: ${durationMins}m, last seen: ${secondsSinceSeen}s ago)`;
        }
        areaStatuses.push(`${area}: ${status}`);
      });

      // Check Global Shutdown Condition:
      // System idle duration is calculated from the time the LAST machine went idle.
      const allIdle = Object.values(gameState.idleAreaStats).every(
        (s) => s.idleStart > 0,
      );
      if (allIdle) {
        const durations = Object.values(gameState.idleAreaStats).map(
          (s) => currentTime - s.idleStart,
        );
        const minDurationMs = Math.min(...durations);
        const minDurationMins = Math.floor(minDurationMs / 60000);

        // Only log system idle status every 30 seconds to avoid flooding
        if (currentTime % 30000 < 1000) {
          console.log(
            `[SYSTEM IDLE] All machines confirmed idle for ${minDurationMins} minutes.`,
          );
        }

        // Minute 5: Play Warning (fires exactly once between min 5 and 10)
        if (
          minDurationMins >= 5 &&
          minDurationMins < 10 &&
          gameState.lastIdleWarningTime === 0
        ) {
          gameState.lastIdleWarningTime = currentTime;
          const text =
            "檢測到全線機台閒置超過五分鐘，直播將於五分鐘後自動關閉。";

          if (isPublic) {
            textToSpeech({
              text,
              model: TTSModel.AZURE_AI,
              voiceID: "zh-HK-HiuMaanNeural",
            });
          }

          if (internalEvents) {
            // Request index.js to send a real YouTube message to the Federation stream
            internalEvents.emit("sendYouTubeMessage", text);
          }
        }

        // Minute 10: Trigger Shutdown
        if (minDurationMins >= 10 && !isShuttingDown) {
          isShuttingDown = true;
          console.log(
            "CRITICAL: 10-minute idle threshold reached. Triggering auto-shutdown...",
          );
          if (idleShutdownCallback) {
            await idleShutdownCallback();
          }
        }
      } else {
        // Reset warning timer if any machine becomes active
        gameState.lastIdleWarningTime = 0;
      }

      if (gamedOverAreas.length > 0) {
        console.log(
          `[OCR] GAME OVER detected in: ${gamedOverAreas.join(", ")}`,
        );
        gamedOverAreas.forEach((area) => detectionBuffer.add(area));
        clearTimeout(processOutcomeTimeoutId);
        processOutcomeTimeoutId = setTimeout(
          processBattleOutcome,
          GAMEOVER_DISPLAY_CLEAR_DELAY_MS,
        );
      }
    } catch (err) {
      console.error("Error during recognition cycle:", err.message);
    }
  }, 1000); // OCR every second

  const gracefulShutdown = async () => {
    console.log("\nReceived shutdown signal (Ctrl+C).");
    await stopRecognizeBattleResults();
    process.exit(0);
  };

  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);
}

async function stopRecognizeBattleResults() {
  console.log("Attempting to stop battle recognition...");
  isShuttingDown = false; // Reset flag so it can shut down again if restarted

  // 1. Stop the interval from running any more recognition tasks
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null; // Set to null to indicate it's stopped
    console.log("Recognition interval stopped.");
  }

  // 2. Terminate the Tesseract worker to free up resources
  if (worker) {
    console.log("Terminating Tesseract worker...");
    await worker.terminate();
    worker = null; // Set to null to indicate it's terminated
    console.log("Worker terminated.");
  }

  console.log("Battle recognition process has been shut down.");
}

// This function is for testing animation and position placement only.
// It can be called from another module (like serverSetup) when a new client connects.
async function broadcastDummyGameState() {
  let getRandomInt = (min, max) => {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };

  gameState.totalWins[Faction.FEDERATION.value] = 12;
  gameState.totalWins[Faction.ZEON.value] = 34;
  gameState.streaks[Faction.FEDERATION.value] = 0;
  gameState.streaks[Faction.ZEON.value] = 0;
  broadcastGameState();

  await scheduler.wait(3000);
  gameState.totalWins[Faction.ZEON.value]++;
  gameState.streaks[Faction.ZEON.value]++;
  broadcastGameState();

  await scheduler.wait(3000);
  gameState.totalWins[Faction.ZEON.value]++;
  gameState.streaks[Faction.ZEON.value]++;
  broadcastGameState();
}

export {
  startRecognizeBattleResults,
  stopRecognizeBattleResults,
  broadcastGameState,
  broadcastDummyGameState,
  markCameraAsDisabled,
  gameState,
};
