import { promisify } from "util";
import { execFile } from "child_process";
import fs from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import axios from "axios";
import Bottleneck from "bottleneck";
import { io } from "./serverSetup.js";
import { TTSModel, MINIMAX_GROUP_ID, MINIMAX_API_KEY } from "./config.js";

import { playCaptionAudio } from "./ttsPlayback.js";
import { parseSrt, CAPTION_HOLD_MS, CAPTION_GAP_MS } from "./ttsTiming.js";

const execFilePromise = promisify(execFile);

// Create rate limiter: 20 requests per minute (60,000ms / 20 = 3,000ms between requests)
const limiter = new Bottleneck({
  minTime: 3000, // 3,000ms between requests
  maxConcurrent: 1,
});

// Wrap axios.post with rate limiter
const rateLimitedPost = limiter.wrap(axios.post);

const audioQueue = [];
let isPlaying = false;

// Function to preprocess text for Azure AI TTS
function preprocessAzureText(inputText, voiceID) {
  let processedText = inputText;

  // Cantonese (zh-HK) specific replacements
  if (voiceID.startsWith("zh-HK")) {
    // Order matters for some replacements to avoid conflicts
    processedText = processedText.replace(/usus/g, "呃suz"); // Must be before other 'us' if any
    processedText = processedText.replace(/[鳩𨳊]/g, "朻");
    processedText = processedText.replace(/[閪屄]/g, "溪");
    processedText = processedText.replace(/𨶙/g, "撚");
    processedText = processedText.replace(/[柒𨳍]/g, "chaat");
    processedText = processedText.replace(/仆/g, "poke");
    processedText = processedText.replace(/矇/g, "mown");
    processedText = processedText.replace(/咁/g, "感");
  }

  // Mandarin (zh-CN) specific replacements
  if (voiceID.startsWith("zh-CN")) {
    processedText = processedText.replace(/[撚𨶙]/g, "能");
    processedText = processedText.replace(/[鳩𨳊]/g, "夠");
    processedText = processedText.replace(/[閪屄]/g, "嗨");
  }

  return processedText;
}

async function processTTSQueue() {
  if (isPlaying || audioQueue.length === 0) {
    return;
  }

  isPlaying = true;
  let { text, model, voiceID, messageId } = audioQueue.shift();
  let tempDirectory;
  let status = "failed";

  try {
    if (io) io.emit("tts_preparing", { messageId });
    // os.tmpdir() uses Windows' temp directory. Remove the entire job directory
    // ourselves after playback/failure; an interrupted process leaves only temp files.
    tempDirectory = await fs.mkdtemp(join(tmpdir(), "gdx-tts-"));
    const audioPath = join(tempDirectory, "speech.mp3");
    let cues = [];
    if (model === TTSModel.AZURE_AI) {
      const originalText = text;
      text = preprocessAzureText(text, voiceID);
      if (originalText !== text) {
        console.log(
          `Azure TTS (${voiceID}): Original text: "${originalText}" | Preprocessed: "${text}"`,
        );
      }
      const textPath = join(tempDirectory, "speech.txt");
      const subtitlePath = join(tempDirectory, "speech.srt");
      await fs.writeFile(textPath, text, "utf8");
      // One synthesis request writes both audio and sentence timing. A text file
      // avoids shell quoting and Windows command-line length limits.
      await execFilePromise("edge-tts", [
        "--rate=-30%", "--volume=+100%", "--voice", voiceID,
        "--file", textPath, "--write-media", audioPath,
        "--write-subtitles", subtitlePath,
      ], { windowsHide: true, timeout: 120000 });
      try {
        cues = parseSrt(await fs.readFile(subtitlePath, "utf8"));
      } catch (error) {
        // Missing subtitles should not discard successfully downloaded speech.
        console.warn("TTS subtitles unavailable; using estimated caption timing:", error.message);
      }
    } else {
      // MiniMaxAI TTS
      const response = await rateLimitedPost(
        `https://api.minimax.chat/v1/t2a_v2?GroupId=${MINIMAX_GROUP_ID}`,
        {
          model: "speech-02-turbo",
          text,
          stream: false,
          language_boost: "Chinese,Yue",
          timber_weights: [
            {
              voice_id: "Chinese (Mandarin)_Radio_Host",
              weight: 1,
            },
          ],
          voice_setting: {
            voice_id: "",
            speed: 0.75,
            vol: 2,
            pitch: 0,
            emotion: "angry",
          },
        },
        {
          headers: {
            Authorization: `Bearer ${MINIMAX_API_KEY}`,
            "Content-Type": "application/json",
          },
        },
      );

      if (response.status !== 200 || response.data.base_resp?.status_code !== 0) {
        throw new Error(`MiniMax API response error: ${JSON.stringify(response.data?.base_resp)}`);
      }
      await fs.writeFile(audioPath, Buffer.from(response.data.data?.audio, "hex"));
    }

    await playCaptionAudio(audioPath, (durationMs) => {
      if (io) io.emit("tts_started", { messageId, startedAt: Date.now(), durationMs, cues });
    });
    status = "finished";
    console.log(`${model === TTSModel.AZURE_AI ? "Azure AI" : "MiniMax AI"} Speech playback completed`);
  } catch (error) {
    const errorMessage = error.response ? error.response.data : error.message;
    console.error("Error in audio playback:", errorMessage);
  } finally {
    if (io) io.emit("tts_finished", { messageId, status, finishedAt: Date.now() });
    if (tempDirectory) {
      await fs.rm(tempDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
        .catch((error) => console.error("Error removing temp TTS files:", error.message));
    }
    // Give viewers time to look up, then leave the reviewed idle gap before
    // another spoken caption. Audio without an overlay keeps its original gap.
    await new Promise((resolve) => setTimeout(resolve,
      messageId ? CAPTION_HOLD_MS + CAPTION_GAP_MS : 1500));
    isPlaying = false;
    if (audioQueue.length > 0) await processTTSQueue();
  }
}

export async function textToSpeech({ text, model, voiceID, messageId }) {
  // Add message to queue
  audioQueue.push({ text, model, voiceID, messageId });

  // If already playing, return and let the queue handle it
  if (isPlaying) {
    return;
  }

  // Process the queue
  await processTTSQueue();
}
