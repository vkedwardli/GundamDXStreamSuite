import Tesseract, { PSM } from "tesseract.js";
import { PassThrough } from "stream";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import { io } from "./serverSetup.js";
import { scheduler } from "timers/promises";
import { textToSpeech } from "./ttsService.js";
import { TTSModel, Faction } from "./config.js";

// Define the four regions in the stacked image (562x105 each)
const targetAreas = [
  { y: 0, height: 105, name: "Area1" },
  { y: 105, height: 105, name: "Area2" },
  { y: 210, height: 105, name: "Area3" },
  { y: 315, height: 105, name: "Area4" },
];

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
      reject(new Error(`Stream error: ${err.message}`))
    );

    const ffmpegArgs = [
      "-y",
      "-framerate",
      "60",
      "-f",
      os.platform() === "darwin" ? "avfoundation" : "dshow",
      "-pixel_format",
      os.platform() === "darwin" ? "uyvy422" : "nv12",
      "-i",
      os.platform() === "darwin"
        ? "OBS Virtual Camera"
        : "video=OBS Virtual Camera",
      "-filter_complex",
      "[0:v]scale=w=1920:h=1080,format=gray[scaled];[scaled]crop=w=562:h=105:x=195:y=307[crop1];[scaled]crop=w=562:h=105:x=1158:y=307[crop2];[scaled]crop=w=240:h=50:x=637:y=874[crop3a];[crop3a]scale=w=562:h=105[crop3];[scaled]crop=w=240:h=50:x=1039:y=874[crop4a];[crop4a]scale=w=562:h=105[crop4];[crop1][crop2][crop3][crop4]vstack=inputs=4[out]",
      //"[0:v]scale=w=1920:h=1080,format=gray[scaled];[scaled]crop=w=102:h=40:x=113:y=196[crop1];[scaled]crop=w=102:h=40:x=1081:y=196[crop2];[scaled]crop=w=43:h=18:x=839:y=831[crop3a];[crop3a]scale=w=102:h=40[crop3];[scaled]crop=w=43:h=18:x=1240:y=831[crop4a];[crop4a]scale=w=102:h=40[crop4];[crop1][crop2][crop3][crop4]vstack=inputs=4[out]",
      "-map",
      "[out]",
      "-vframes",
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
      reject(new Error(`FFmpeg spawn error: ${err.message}`))
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
      targetAreas.map((area) => processRegion(buffer, area, worker))
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
};

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

// Helper for consistent time formatting
const getFormattedTime = () =>
  new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: true,
    timeZone: "Asia/Hong_Kong", // Or your target timezone
  });

// Broadcasts the current game state to the client via a prefixed console log
const broadcastGameState = () => {
  io.emit("battleResult", { state: gameState });
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
      1
    )}% | Zeon: ${zeonWinPercentage.toFixed(1)}%`;
  }

  const summary = `
-------------------- BATTLE STATS --------------------
Total Matches: ${totalBattles}
Wins:          Federation: ${fedWins} | Zeon: ${zeonWins}
Draws:         ${totalDraws}
Win Ratio:     ${ratioString}
----------------------------------------------------`;
  console.log(summary);
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

// Main function to determine and process the battle's outcome
const processBattleOutcome = () => {
  if (detectionBuffer.size === 0) return; // Guard against empty processing

  const detectedAreas = new Set(detectionBuffer);
  detectionBuffer.clear(); // Process and clear immediately

  const zeonLost = detectedAreas.has("Area1") && detectedAreas.has("Area2");
  const federationLost =
    detectedAreas.has("Area3") && detectedAreas.has("Area4");

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
      Array.from(detectedAreas)
    );
    broadcastGameState(); // Broadcast state even on incomplete matches to clear stars
    return;
  }

  // A valid 2v2 match was detected, update totals.
  gameState.totalBattles++;
  gameState.lastOutcomeTime = Date.now();

  if (outcome === "Draw") {
    gameState.totalDraws++;
    resetStreaks("a draw");
    console.log(`${getFormattedTime()}: Game ended in a DRAW.`);
    logBattleSummary(); // Log the summary after a draw
    broadcastGameState(); // Broadcast the updated state
    return;
  }

  const winner = outcome;
  const loser = winner === Faction.ZEON ? Faction.FEDERATION : Faction.ZEON;

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
    const msg = {
      isFederation: winner === Faction.FEDERATION,
      time: getFormattedTime(),
      authorName: `${winner.displayName}連勝！`,
      profilePic: "images/star.png", // Using star icon for the message
      message: streakMessage,
      plainMessage: streakMessage,
    };
    io.emit("message", msg);
  }

  // --- 4. Log the overall summary ---
  logBattleSummary();

  // --- 5. Broadcast the new game state ---
  broadcastGameState();
};

async function startRecognizeBattleResults() {
  worker = await Tesseract.createWorker("eng");
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: "GAMEOVER",
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
      const results = await processFrame(); // Assumes processFrame() is defined elsewhere
      const gamedOverAreas = results
        .filter(({ text }) => text.startsWith("GAMEOVER"))
        .map(({ area }) => area);

      if (gamedOverAreas.length > 0) {
        gamedOverAreas.forEach((area) => detectionBuffer.add(area));
        clearTimeout(processOutcomeTimeoutId);
        processOutcomeTimeoutId = setTimeout(
          processBattleOutcome,
          GAMEOVER_DISPLAY_CLEAR_DELAY_MS
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
};
