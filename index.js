import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { OBSWebSocket } from "obs-websocket-js";
import fs, { writeFile, unlink } from "fs/promises";
import { LiveChat } from "youtube-chat";
import http from "http";
import path, { join } from "path";
import os, { tmpdir } from "os";
import { exec, spawn } from "child_process";
import url from "url";
import { scheduler } from "node:timers/promises";
import schedule from "node-schedule";
import { Server } from "socket.io";
import axios from "axios";
import sound from "sound-play";
import Bottleneck from "bottleneck";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
dotenv.config();

// Path to OBS directory and executable
const obsDir = "C:\\Program Files\\obs-studio\\bin\\64bit";
const obsPath = `${obsDir}\\obs64.exe`; // Full path to executable
const obs = new OBSWebSocket();
const __dirname = import.meta.dirname;

// OAuth 2.0 Client Configuration
const oAuth2Client = new OAuth2Client({
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  redirectUri: "http://localhost:3000/oauth2callback",
});

const SCOPES = ["https://www.googleapis.com/auth/youtube"];
const TOKEN_PATH = "token.json";

// YouTube API setup with OAuth2 for creating streams
const youtube = google.youtube({
  version: "v3",
  auth: oAuth2Client,
});

// HTTP Server for Socket.IO and OAuth2 Callback
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  // console.log('Requested URL:', req.url); // Debug log

  if (parsedUrl.pathname === "/oauth2callback") {
    const code = parsedUrl.query.code;
    if (code) {
      oAuth2Client.getToken(code, (err, tokens) => {
        if (err) {
          res.writeHead(500);
          res.end("Error retrieving tokens");
          console.error("Error getting tokens:", err);
          return;
        }
        oAuth2Client.setCredentials(tokens);
        fs.writeFile(TOKEN_PATH, JSON.stringify(tokens), (err) => {
          if (err) console.error("Error saving token:", err);
          console.log("Token stored to", TOKEN_PATH);
        });
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Authorization successful! You can close this window.</h1>"
        );
      });
    } else {
      res.writeHead(400);
      res.end("No authorization code provided");
    }
  } else {
    // Serve static files
    const filePath = path.join(
      __dirname,
      parsedUrl.pathname === "/" ? "comments.html" : parsedUrl.pathname.slice(1)
    );
    const extname = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".png": "image/png",
    };

    if ([".html", ".js", ".png"].includes(extname)) {
      fs.readFile(filePath)
        .then((data) => {
          res.writeHead(200, {
            "Content-Type": contentTypes[extname] || "application/octet-stream",
          });
          res.end(data);
        })
        .catch((err) => {
          console.error("Error serving file:", err);
          res.writeHead(404);
          res.end("File not found");
        });
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  }
});

const io = new Server(server);

// Override console.log to send to all clients
const originalConsoleLog = console.log;
console.log = function (...args) {
  const message = args.join(" ");
  io.emit("console", message);
  originalConsoleLog.apply(console, args);
};
server.listen(3000, () => console.log("Server running on port 3000"));

// Authorize OAuth 2.0
async function authorize() {
  try {
    const tokenData = await fs.readFile(TOKEN_PATH).catch(() => null);
    if (tokenData) {
      const credentials = JSON.parse(tokenData);
      oAuth2Client.setCredentials(credentials);
      // Test token validity
      try {
        await oAuth2Client.getAccessToken();
        return;
      } catch (error) {
        console.log("Stored token is invalid, requesting new authorization");
      }
    }

    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
    });
    console.log("Authorize this app by visiting this URL:", authUrl);
    console.log(
      "After authorizing, the browser will redirect to http://localhost:3000/oauth2callback"
    );
  } catch (error) {
    console.error("Error during authorization:", error);
    throw error;
  }
}

// Persist tokens when updated
oAuth2Client.on("tokens", async (tokens) => {
  try {
    console.log("Received new tokens");
    // Update credentials with new tokens
    const currentTokens = {
      ...oAuth2Client.credentials,
      ...tokens,
    };
    // Save all tokens to disk
    await fs.writeFile(TOKEN_PATH, JSON.stringify(currentTokens));
    console.log("Tokens saved to", TOKEN_PATH);
    oAuth2Client.setCredentials(currentTokens);
  } catch (error) {
    console.error("Error saving tokens:", error);
  }
});

// OBS WebSocket connection
async function obsConnect(callback) {
  try {
    await obs.connect("ws://localhost:4455", process.env.OBS_PASSWORD);
    console.log("Connected to OBS WebSocket");
    callback(true);
  } catch (error) {
    console.error("OBS Connection Error:", error);
    callback(false);
  }
}

// Define Faction enum with additional properties
const Faction = Object.freeze({
  FEDERATION: {
    value: "federation",
    streamSnippetName: "OBS Federation",
    displayName: "連邦",
  },
  ZEON: {
    value: "zeon",
    streamSnippetName: "OBS Zeon",
    displayName: "自護",
  },
});

let blockStartStreamingUntil = 0;

// Function to check for active live streams and return their IDs
async function checkLiveStreams(broadcastStatus) {
  try {
    const response = await youtube.liveBroadcasts.list({
      part: ["id,snippet"], // Get the name from snippet for sorting
      broadcastStatus: broadcastStatus, // Filter for active streams
      // mine: true, // Only works with OAuth; omit if using API key and add channelId
      maxResults: 5, // Limit results (adjust as needed)
    });

    const liveStreams = response.data.items || []; // Default to empty array if no items

    // Sort array: Place streams with "連邦側" in title first
    liveStreams.sort((a, b) => {
      const titleA = a.snippet.title || "";
      const titleB = b.snippet.title || "";
      if (titleA.includes("連邦側") && !titleB.includes("連邦側")) return -1; // a comes first
      if (!titleA.includes("連邦側") && titleB.includes("連邦側")) return 1; // b comes first
      return 0; // No change if both or neither have "連邦側"
    });

    const liveStreamIds = liveStreams.map((stream) => stream.id); // Extract IDs

    return liveStreamIds; // Return array of IDs
  } catch (error) {
    console.error("Error checking live streams:", error.message);
    return []; // Return empty array on error
  }
}

async function createScheduledLiveStream({ faction, isPublic }) {
  try {
    // Fetch existing live streams
    const streamListResponse = await youtube.liveStreams.list({
      part: "id,snippet,cdn",
      mine: true, // Only fetch streams for the authenticated user
    });
    //   console.log('Available streams:', streamListResponse.data.items);

    // Find the stream with the matching name
    const existingStream = streamListResponse.data.items.find(
      (stream) => stream.snippet.title === faction.streamSnippetName
    );

    if (!existingStream) {
      throw new Error(
        `No existing stream found with name. Please create it in YouTube Studio first.`
      );
    }

    const streamId = existingStream.id;

    const broadcastResponse = await youtube.liveBroadcasts.insert({
      part: "snippet,contentDetails,status",
      resource: {
        snippet: {
          title: `荔枝角 Gundam DX【${faction.displayName}側】Mobile Suit Gundam: Federation vs. Zeon DX 機動戦士ガンダム 連邦vs.ジオンDX 高達DX`,
          description:
            "活力城 Power City 遊戲機中心\n九龍長沙灣道833號長沙灣廣場二期地下G09B3號舖 (荔枝角站)\n營業時間：0800 ~ 2600",
          scheduledStartTime: new Date(
            Date.now() + 10 * 60 * 1000
          ).toISOString(),
        },
        contentDetails: {
          enableEmbed: true,
          enableAutoStart: true,
          enableAutoStop: true,
          enableContentEncryption: false,
          enableReactions: true,
          latencyPreference: "low",
        },
        status: {
          privacyStatus: isPublic ? "public" : "unlisted",
          selfDeclaredMadeForKids: false,
          containsSyntheticMedia: false,
        },
      },
    });

    const broadcastId = broadcastResponse.data.id;

    await youtube.liveBroadcasts.bind({
      part: "id,snippet",
      id: broadcastId,
      streamId: streamId,
    });

    // Update the category to Gaming (categoryId: '20') after insert
    await youtube.videos.update({
      part: "snippet,status",
      resource: {
        id: broadcastId,
        snippet: {
          title: `荔枝角 Gundam DX【${faction.displayName}側】Mobile Suit Gundam: Federation vs. Zeon DX 機動戦士ガンダム 連邦vs.ジオンDX 高達DX`,
          description:
            "活力城 Power City 遊戲機中心\n九龍長沙灣道833號長沙灣廣場二期地下G09B3號舖 (荔枝角站)\n營業時間：0800 ~ 2600",
          categoryId: "20", // Force Gaming category
          tags: [
            "Mobile Suit Gundam: Federation vs. Zeon DX",
            "機動戦士ガンダム 連邦vs.ジオンDX",
            "連ジ",
            "Gundam",
            "Gundam DX",
            "Mobile Suit Gundam",
            "高達",
            "高達DX",
            "連邦vs.ジオン",
            "Sega NAOMI",
            "Gaming",
            "Gundam VS",
            "Arcade Games",
          ],
        },
        status: {
          containsSyntheticMedia: false,
        },
      },
    });

    console.log(`Scheduled live stream: ${broadcastId}`);
    return broadcastId;
  } catch (error) {
    console.error("Error creating live stream:", error);
  }
}

async function deleteLiveBroadcasts(broadcastIds) {
  try {
    for (const id of broadcastIds) {
      await youtube.liveBroadcasts.delete({
        id: id,
      });
      console.log(`Deleted broadcast with ID: ${id}`);
    }
    console.log("All scheduled broadcasts deleted.");
  } catch (error) {
    console.error("Error deleting broadcasts:", error.message);
  }
}

// Start streaming in OBS
async function startOBSStreaming() {
  try {
    let streamStatus = await obs.call("GetStreamStatus");
    if (streamStatus.outputActive == false) {
      await obs.call("StartStream");
      console.log("OBS streaming started");
    } else {
      console.log("OBS is streaming already!");
    }
  } catch (error) {
    console.error("Error starting OBS stream:", error);
  }
}

// Stop streaming and close OBS
async function stopOBSStreaming() {
  try {
    let streamStatus = await obs.call("GetStreamStatus");
    if (streamStatus.outputActive == false) {
      console.log("OBS streaming not started");
    } else {
      await obs.call("StopStream");
      console.log("OBS streaming stopped");
    }
    await obs.disconnect();
    await scheduler.wait(3000);

    exec('taskkill /im obs64.exe"', (error, stdout, stderr) => {
      if (error) {
        console.error(`Error terminating OBS: ${error.message}`);
        return;
      }
      console.log(stdout);
      return;
    });
  } catch (error) {
    console.error("Error stopping OBS or closing:", error);
  }
}

let fedLiveChat = null;
let zeonLiveChat = null;
let liveChatInterval = null;

// Setup Live Comment Fetching
function setupLiveChat({ broadcastId, faction }) {
  const liveChat = new LiveChat({ liveId: broadcastId });
  if (faction === Faction.FEDERATION) {
    fedLiveChat = liveChat;
  } else {
    zeonLiveChat = liveChat;
  }

  liveChat.on("start", (liveId) => {
    console.log(`start: ${liveId}`);
  });

  liveChat.on("end", (reason) => {
    console.log(`end: ${reason}`);
  });

  liveChat.on("chat", (chatItem) => {
    const date = new Date(chatItem.timestamp);
    const options = {
      hour: "numeric",
      minute: "numeric",
      hour12: true,
      timeZone: "Asia/Hong_Kong",
    };
    const formatter = new Intl.DateTimeFormat("en-US", options);
    const formattedTime = formatter.format(date);

    const msg = {
      isFederation: faction === Faction.FEDERATION,
      time: formattedTime,
      authorName: chatItem.author.name,
      profilePic: chatItem.author.thumbnail.url,
      message: chatItem.message
        .map((item) =>
          item.text
            ? item.text
            : `<img class="emoji" src="${item.url}" alt="${item.emojiText}" shared-tooltip-text="${item.alt}" >`
        )
        .join(""),
      plainMessage: chatItem.message
        .map((item) => (item.text ? item.text : ` :${item.alt}: `))
        .join(""),
    };
    console.log(`${msg.authorName}: ${msg.plainMessage}`);

    io.emit("message", msg);
    textToAudio(msg.plainMessage);
  });

  liveChat.on("error", (err) => {
    console.error("Live chat error:", err);
  });

  liveChat.start();
}

// Function to fetch viewer count for a single video
async function getViewerCount(videoId) {
  try {
    const response = await youtube.videos.list({
      part: ["liveStreamingDetails"],
      id: videoId,
    });

    const video = response.data.items[0];
    if (
      video &&
      video.liveStreamingDetails &&
      video.liveStreamingDetails.concurrentViewers
    ) {
      return parseInt(video.liveStreamingDetails.concurrentViewers, 10);
    }
    return 0; // Return 0 if no viewers or not live
  } catch (error) {
    console.error(
      `Error fetching viewer count for video ${videoId}:`,
      error.message
    );
    return 0;
  }
}

// Function to fetch and sum viewer counts for an array of video IDs
async function fetchAndSumViewers({ broadcastIds }) {
  try {
    // Fetch viewerIFIER counts concurrently
    const viewerCounts = await Promise.all(
      broadcastIds.map((videoId) => getViewerCount(videoId))
    );

    // Sum the viewer counts
    const totalViewers = viewerCounts.reduce((sum, count) => sum + count, 0);

    // Log the total
    console.log(`Total Viewers: ${totalViewers}`);
    io.emit("totalviewers", totalViewers);
  } catch (error) {
    console.error("Error in fetchAndSumViewers:", error.message);
  }
}

async function setupLiveViewerCount({ broadcastIds }) {
  fetchAndSumViewers({ broadcastIds });

  if (liveChatInterval) clearInterval(liveChatInterval);
  liveChatInterval = setInterval(
    () => fetchAndSumViewers({ broadcastIds }),
    25 * 1000
  );
}

// Function to launch OBS
async function launchOBS() {
  await obsConnect(async (isRunning) => {
    if (isRunning) {
      console.log("OBS Studio is already running");
    } else {
      console.log("OBS Studio is not running, starting it...");
      await exec(`"${obsPath}"`, { cwd: obsDir }, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error launching OBS: ${error.message}`);
          return;
        }
        if (stderr) {
          console.error(`stderr: ${stderr}`);
          return;
        }
      });

      //Reset capture card DirectShow settings
      await exec(
        `${path.join(os.homedir(), "Documents\\WebCameraConfig.exe")}`,
        { cwd: `${path.join(os.homedir(), "Documents\\")}` },
        (error, stdout, stderr) => {
          if (error) {
            console.error(`Error setting camera config: ${error.message}`);
            return;
          }
          if (stderr) {
            console.error(`stderr: ${stderr}`);
            return;
          } else {
            console.log("Capture card config set.");
          }
          console.log(stdout);
        }
      );

      console.log("Wait 5 second before connecting to the OBS WebSocket");
      await scheduler.wait(5000);

      await obsConnect((isRunning) => {
        if (isRunning == false) {
          console.log("Cannot connect to OBS Studio");
          return;
        }
      });
    }
  });
}

// Start Streaming
async function startStreaming({ isPublic }) {
  // Check if startStreaming is blocked
  if (Date.now() < blockStartStreamingUntil) {
    io.emit("isStreaming", false);
    console.log("Please wait for 60 seconds before starting again");
    return;
  }

  let broadcastIds = [];

  // Launch OBS
  await launchOBS();

  // Pre create events
  broadcastIds = await checkLiveStreams("active");
  if (broadcastIds.length > 0) {
    console.log("Live Broadcasting");
  } else {
    // check if event is scheduled
    broadcastIds = await checkLiveStreams("upcoming");
    if (broadcastIds.length > 0) {
      console.log("Schduled already");
    } else {
      console.log("No Upcoming and No Live Streaming, create!");

      const broadcastPromises = [Faction.FEDERATION, Faction.ZEON].map(
        (faction) => createScheduledLiveStream({ faction, isPublic })
      );
      broadcastIds = await Promise.all(broadcastPromises);
    }
  }
  console.log("Broadcast IDs:", broadcastIds);

  if (broadcastIds.length != 2) {
    console.log("broadcastIds: Wrong size!!?");
    await deleteLiveBroadcasts(broadcastIds);

    console.log("Try create live stream again!");

    const broadcastPromises = [Faction.FEDERATION, Faction.ZEON].map(
      (faction) => createScheduledLiveStream({ faction, isPublic })
    );
    broadcastIds = await Promise.all(broadcastPromises);
  }

  await scheduler.wait(5000);
  // Start Streaming
  await startOBSStreaming();

  console.log(`Started ${isPublic ? "Public" : "Unlisted"} streaming`);

  io.emit("streamUrls", {
    url1: `https://youtu.be/${broadcastIds[0]}`,
    url2: `https://youtu.be/${broadcastIds[1]}`,
  });

  // Start ChatFusion
  await scheduler.wait(30000);

  [Faction.FEDERATION, Faction.ZEON].forEach((faction, index) =>
    setupLiveChat({ broadcastId: broadcastIds[index], faction })
  );
  setupLiveViewerCount({ broadcastIds });
}

async function stopStreaming() {
  try {
    blockStartStreamingUntil = Date.now() + 60 * 1000; // Block for 60 seconds

    let streamStatus = await obs.call("GetStreamStatus");
    if (streamStatus.outputActive) {
      await stopOBSStreaming();
      fedLiveChat?.stop();
      zeonLiveChat?.stop();
      clearInterval(liveChatInterval);
      fedLiveChat = null;
      zeonLiveChat = null;
      liveChatInterval = null;
    } else {
      console.log("Not Streaming!");
    }
  } catch (error) {
    console.error("Cannot get OBS Status", error);
  }
}

async function updateStreamingStatus() {
  try {
    let streamStatus = await obs.call("GetStreamStatus");
    io.emit("isStreaming", streamStatus.outputActive);
  } catch (error) {
    // console.error("Cannot get OBS Status", error);
    io.emit("isStreaming", false);
  }
}

io.on("connection", async (client) => {
  console.log("Client connected");

  client.on("startPublic", async () => {
    console.log("Starting public streaming...");
    await startStreaming({ isPublic: true });
    updateStreamingStatus();
  });

  client.on("startUnlisted", async () => {
    console.log("Starting unlisted streaming...");
    await startStreaming({ isPublic: false });
    updateStreamingStatus();
  });

  client.on("stopStreaming", async () => {
    console.log("Stopping streaming...");
    await stopStreaming();
    io.emit("status", "Streaming stopped");
    updateStreamingStatus();
  });

  client.on("disconnect", () => {
    console.log("Client disconnected");
  });

  client.on("getStreamingStatus", () => {
    updateStreamingStatus();
  });
});

// Schedule the function to run every day at 02:10 AM
schedule.scheduleJob("10 2 * * *", async () => {
  await stopStreaming();
  io.emit("status", "Streaming stopped");
  updateStreamingStatus();
});

// Create rate limiter: 20 requests per minute (60,000ms / 20 = 3,000ms between requests)
const limiter = new Bottleneck({
  minTime: 3000, // 3,000ms between requests
  maxConcurrent: 1,
});

// Wrap axios.post with rate limiter
const rateLimitedPost = limiter.wrap(axios.post);

async function textToAudio(text) {
  const attemptRequest = async (retryCount = 0) => {
    try {
      const response = await rateLimitedPost(
        `https://api.minimax.chat/v1/t2a_v2?GroupId=${process.env.MINIMAX_GROUP_ID}`,
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
            speed: 0.8,
            vol: 3,
            pitch: 0,
            emotion: "angry",
          },
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      console.log(response.data.base_resp);
      if (
        response.status === 200 &&
        response.data.base_resp?.status_code === 0
      ) {
        const tempFilePath = join(tmpdir(), `${randomUUID()}.mp3`);
        console.log(tempFilePath);

        try {
          // Convert hex to binary (Buffer)
          const mp3Buffer = Buffer.from(response.data.data?.audio, "hex");

          // Write the buffer to a temporary MP3 file
          await writeFile(tempFilePath, mp3Buffer);
          console.log(`Temporary file created: ${tempFilePath}`);

          // Play the MP3 file (volume set to 50%)
          await sound.play(tempFilePath, 1.0);
          console.log("Audio playback completed");

          // Clean up the temporary file
          // await unlink(tempFilePath);
          // console.log(`Temporary file deleted: ${tempFilePath}`);
        } catch (error) {
          console.error("Error processing audio:", error.message);
        }
      } else {
        console.error("API response error:", response.data.base_resp);
      }

      return response.data;
    } catch (error) {
      const errorMessage = error.response ? error.response.data : error.message;
      console.error(`Attempt ${retryCount + 1} failed:`, errorMessage);

      // Retry once if this was the first attempt
      if (retryCount < 1) {
        console.log("Retrying...");
        return attemptRequest(retryCount + 1);
      }

      // Log final error and return null instead of throwing
      console.error("All retry attempts failed");
      return null;
    }
  };

  return attemptRequest();
}

async function startDXOPScreen() {
  const tempUserDataDir = path.join(__dirname, `chrome-user-data}`);
  await fs.mkdir(tempUserDataDir, { recursive: true });
  // Command to open Chrome in kiosk mode with isolated user data directory
  const chromePath =
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"; // Adjust path if needed
  const url = "http://127.0.0.1:3000/control.html";

  const chromeProcess = spawn(
    chromePath,
    [
      "--kiosk",
      "--new-window",
      "--window-position=1920,0",
      `--user-data-dir=${tempUserDataDir}`,
      url,
    ],
    {
      stdio: "ignore", // Ignore stdio to prevent buffering issues
      detached: false, // Ensure child process is not detached
    }
  );
  chromeProcess.on("error", (err) => {
    console.error(`Error opening Chrome: ${err.message}`);
  });

  chromeProcess.on("close", (code) => {
    console.log(`Chrome process exited with code ${code}`);
  });
}

function lofiTest() {
  let broadcastIds = ["jfKfPfyJRdk", "4xDzrJKXOOY"];
  // let broadcastIds = ["ARa-IibEfvY", "sLNGhHC0WyM"];
  [Faction.FEDERATION, Faction.ZEON].forEach((faction, index) =>
    setupLiveChat({ broadcastId: broadcastIds[index], faction })
  );
  setupLiveViewerCount({ broadcastIds });
}

// Main function
async function main() {
  await authorize();
  await obsConnect(() => {});
  startDXOPScreen();
  // await startStreaming({ isPublic: false });
  // await scheduler.wait(30000);
  // await stopOBSStreaming();
  // lofiTest();
  // let audio = await textToAudio("點呀出色嘅螢火蟲🤣");
}

main().catch(console.error);
