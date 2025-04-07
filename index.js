const { google } = require("googleapis");
const { OAuth2Client } = require("google-auth-library");
const { OBSWebSocket } = require("obs-websocket-js");
const fs = require("fs").promises;
const Youtube = require("youtube-api");
const { LiveChat } = require("youtube-chat");
const http = require("http");
const path = require("path");
const url = require("url");
require("dotenv").config();

const obs = new OBSWebSocket();

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

const io = require("socket.io")(server);
let socketClient = null;
io.on("connection", (client) => {
  console.log("Client connected");
  socketClient = client;
  client.on("disconnect", () => {
    socketClient = null;
    console.log("Client disconnected");
  });
});
server.listen(3000, () => console.log("Server running on port 3000"));

// Authorize OAuth 2.0
async function authorize() {
  try {
    const tokenData = await fs.readFile(TOKEN_PATH).catch(() => null);
    if (tokenData) {
      oAuth2Client.setCredentials(JSON.parse(tokenData));
      return;
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

oAuth2Client.on("tokens", async (tokens) => {
  if (tokens.refresh_token) {
    const currentTokens = oAuth2Client.credentials;
    currentTokens.refresh_token = tokens.refresh_token;
    await fs.writeFile(TOKEN_PATH, JSON.stringify(currentTokens));
    console.log("Refresh token updated and saved");
  }
  oAuth2Client.setCredentials(tokens);
});

// OBS WebSocket connection
async function obsConnect() {
  try {
    await obs.connect("ws://localhost:4455", process.env.OBS_PASSWORD);
    console.log("Connected to OBS WebSocket");
  } catch (error) {
    console.error("OBS Connection Error:", error);
  }
}

// Function to check for active live streams and return their IDs
async function checkLiveStreams(broadcastStatus) {
  try {
    const response = await youtube.liveBroadcasts.list({
      part: ["id"], // Only need the ID part
      broadcastStatus: broadcastStatus, // Filter for active streams
      // mine: true, // Only works with OAuth; omit if using API key and add channelId
      // // channelId: 'YOUR_CHANNEL_ID', // Uncomment and replace if using API key
      maxResults: 5, // Limit results (adjust as needed)
    });

    const liveStreams = response.data.items || []; // Default to empty array if no items
    const liveStreamIds = liveStreams.map((stream) => stream.id); // Extract IDs

    return liveStreamIds; // Return array of IDs
  } catch (error) {
    console.error("Error checking live streams:", error.message);
    return []; // Return empty array on error
  }
}

async function createScheduledLiveStream(isFederation, isPublic) {
  try {
    // Fetch existing live streams
    const streamListResponse = await youtube.liveStreams.list({
      part: "id,snippet,cdn",
      mine: true, // Only fetch streams for the authenticated user
    });
    //   console.log('Available streams:', streamListResponse.data.items);

    // Find the stream with the matching name
    const existingStream = streamListResponse.data.items.find(
      (stream) =>
        stream.snippet.title ===
        `${isFederation ? "OBS Federation" : "OBS Zeon"}`
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
          title: `荔枝角 Gundam DX【${
            isFederation ? "連邦" : "自護"
          }側】Mobile Suit Gundam: Federation vs. Zeon DX 機動戦士ガンダム 連邦vs.ジオンDX 高達DX`,
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
          title: `荔枝角 Gundam DX【${
            isFederation ? "連邦" : "自護"
          }側】Mobile Suit Gundam: Federation vs. Zeon DX 機動戦士ガンダム 連邦vs.ジオンDX 高達DX`,
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
    throw error;
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
  } catch (error) {
    console.error("Error stopping OBS or closing:", error);
  }
}

// Setup Live Comment Fetching
function setupLiveChat(broadcastId, isFederation) {
  const liveChat = new LiveChat({ liveId: broadcastId });

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
      isFederation: isFederation,
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
    };

    if (socketClient) {
      socketClient.emit("message", msg);
    }
  });

  liveChat.on("error", (err) => {
    console.error("Live chat error:", err);
  });

  liveChat.start();
}

// Main function
async function main() {
  await authorize();
  await obsConnect();

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
      const broadcastIdFed = await createScheduledLiveStream(true, true); // Public
      broadcastIds.push(broadcastIdFed);

      const broadcastIdZeon = await createScheduledLiveStream(false, true); // Unlisted
      broadcastIds.push(broadcastIdZeon);
    }
  }
  console.log("Broadcast IDs:", broadcastIds);

  if (broadcastIds.length != 2) {
    console.log("broadcastIds: Wrong size!!?");
    return;
  }

  await startOBSStreaming();

  setTimeout(async () => {
    setupLiveChat(broadcastIds[0], true); // true = Federation
    setupLiveChat(broadcastIds[1], false); // false = Zeon
  }, 10000);
}

main().catch(console.error);
