import { promisify } from "util";
import { exec } from "child_process";
import fs, { writeFile, unlink } from "fs/promises";
import path, { join } from "path";
import os, { tmpdir } from "os";
import axios from "axios";
import sound from "sound-play";
import Bottleneck from "bottleneck";
import { randomUUID } from "crypto";
import { TTSModel, MINIMAX_GROUP_ID, MINIMAX_API_KEY } from "./config.js";

const execPromise = promisify(exec);

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
function preprocessAzureText(inputText) {
  let processedText = inputText;
  // Order matters for some replacements to avoid conflicts
  processedText = processedText.replace(/usus/g, "呃suz"); // Must be before other 'us' if any
  processedText = processedText.replace(/[鳩𨳊]/g, "朻");
  processedText = processedText.replace(/[閪屄]/g, "西");
  processedText = processedText.replace(/𨶙/g, "撚");
  processedText = processedText.replace(/[柒𨳍]/g, "chaat");
  processedText = processedText.replace(/仆/g, "poke");
  processedText = processedText.replace(/矇/g, "mown");
  processedText = processedText.replace(/咁/g, "感");
  // Add more replacements here if needed
  return processedText;
}

async function processTTSQueue() {
  if (isPlaying || audioQueue.length === 0) {
    return;
  }

  isPlaying = true;
  let { text, model, voiceID } = audioQueue.shift(); // Make text mutable

  try {
    if (model === TTSModel.AZURE_AI) {
      const originalText = text;
      text = preprocessAzureText(text);
      if (originalText !== text) {
        console.log(
          `Azure TTS: Original text: "${originalText}" | Preprocessed: "${text}"`
        );
      }
      await execPromise(
        `edge-playback --rate=-30% --volume=+100% --voice "${voiceID}" --text "${text}"`
      );
      console.log("Azure AI Speech playback completed");
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
        }
      );

      // console.log(response.data.base_resp); // Keep this commented unless debugging
      if (
        response.status === 200 &&
        response.data.base_resp?.status_code === 0
      ) {
        const tempFilePath = join(tmpdir(), `${randomUUID()}.mp3`);
        // console.log(tempFilePath); // Keep this commented unless debugging

        try {
          // Convert hex to binary (Buffer)
          const mp3Buffer = Buffer.from(response.data.data?.audio, "hex");

          // Write the buffer to a temporary MP3 file
          await writeFile(tempFilePath, mp3Buffer);

          // Play the MP3 file
          await sound.play(tempFilePath, 1.0);
          console.log("MiniMax AI Speech playback completed");

          // Clean up the temporary file
          setTimeout(() => {
            unlink(tempFilePath).catch((err) =>
              console.error("Error unlinking temp TTS file:", err)
            );
          }, 1000);
        } catch (error) {
          console.error("Error processing audio:", error.message);
        }
      } else {
        console.error(
          "API response error:",
          response.data?.base_resp || "Unknown API error"
        );
      }
    }

    // Wait for 1.5 seconds before processing the next item
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } catch (error) {
    const errorMessage = error.response ? error.response.data : error.message;
    console.error("Error in audio playback:", errorMessage);
  } finally {
    isPlaying = false;
    // Process the next item in the queue
    if (audioQueue.length > 0) {
      await processTTSQueue();
    }
  }
}

export async function textToSpeech({ text, model, voiceID }) {
  // Add message to queue
  audioQueue.push({ text, model, voiceID });

  // If already playing, return and let the queue handle it
  if (isPlaying) {
    return;
  }

  // Process the queue
  await processTTSQueue();
}
