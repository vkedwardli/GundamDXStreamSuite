import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import fs from "fs/promises";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  SCOPES,
  TOKEN_PATH,
  Faction,
} from "./config.js";

// OAuth 2.0 Client Configuration
export const oAuth2Client = new OAuth2Client({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: "http://localhost:3000/oauth2callback",
});

// YouTube API setup with OAuth2
export const youtube = google.youtube({
  version: "v3",
  auth: oAuth2Client,
});

// Authorize OAuth 2.0
export async function authorize() {
  try {
    const tokenData = await fs.readFile(TOKEN_PATH).catch(() => null);
    if (tokenData) {
      const credentials = JSON.parse(tokenData);
      oAuth2Client.setCredentials(credentials);
      // Test token validity
      try {
        await oAuth2Client.getAccessToken();
        console.log("YouTube token is valid.");
        return;
      } catch (error) {
        console.log(
          "Stored YouTube token is invalid, requesting new authorization"
        );
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
    console.error("Error during YouTube authorization:", error);
    throw error;
  }
}

// Persist tokens when updated
oAuth2Client.on("tokens", async (tokens) => {
  try {
    console.log("Received new YouTube tokens");
    const currentTokens = {
      ...oAuth2Client.credentials,
      ...tokens,
    };
    await fs.writeFile(TOKEN_PATH, JSON.stringify(currentTokens));
    console.log("YouTube tokens saved to", TOKEN_PATH);
    oAuth2Client.setCredentials(currentTokens);
  } catch (error) {
    console.error("Error saving YouTube tokens:", error);
  }
});

// Function to check for active live streams and return their IDs
export async function checkLiveStreams(broadcastStatus) {
  try {
    const response = await youtube.liveBroadcasts.list({
      part: ["id,snippet"],
      broadcastStatus: broadcastStatus,
      maxResults: 5,
    });

    const liveStreams = response.data.items || [];
    liveStreams.sort((a, b) => {
      const titleA = a.snippet.title || "";
      const titleB = b.snippet.title || "";
      if (titleA.includes("連邦側") && !titleB.includes("連邦側")) return -1;
      if (!titleA.includes("連邦側") && titleB.includes("連邦側")) return 1;
      return 0;
    });
    return liveStreams.map((stream) => stream.id);
  } catch (error) {
    console.error("Error checking live streams:", error.message);
    return [];
  }
}

export async function createScheduledLiveStream({ faction, isPublic }) {
  try {
    const streamListResponse = await youtube.liveStreams.list({
      part: "id,snippet,cdn",
      mine: true,
    });

    const existingStream = streamListResponse.data.items.find(
      (stream) => stream.snippet.title === faction.streamSnippetName
    );

    if (!existingStream) {
      throw new Error(
        `No existing stream found with name ${faction.streamSnippetName}. Please create it in YouTube Studio first.`
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
          defaultLanguage: "yue-HK",
          defaultAudioLanguage: "yue-HK",
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

    console.log(`Scheduled ${faction.value} live stream: ${broadcastId}`);
    return { broadcastId, faction };
  } catch (error) {
    console.error(`Error creating ${faction.value} live stream:`, error);
    throw error;
  }
}

export async function updateVideoDetails({
  broadcastId,
  faction,
  opponentBroadcastId,
}) {
  try {
    const currentDate = new Date()
      .toLocaleDateString("en-CA", {
        timeZone: "Asia/Hong_Kong",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
      .replace(/-/g, "/");

    await youtube.videos.update({
      part: "snippet,status",
      resource: {
        id: broadcastId,
        snippet: {
          title: `荔枝角 Gundam DX【${faction.displayName}側】${currentDate} Mobile Suit Gundam: Federation vs. Zeon DX 機動戦士ガンダム 連邦vs.ジオンDX 高達DX`,
          description: `👁️‍🗨️ 切換視點到${
            faction === Faction.FEDERATION
              ? Faction.ZEON.displayName
              : Faction.FEDERATION.displayName
          }側: https://youtu.be/${opponentBroadcastId}

🔊 留言大聲公：
使用 *!say [message]* 格式，系統就會自動讀出你嘅留言！

🕹️ 活力城 Power City 遊戲機中心
九龍長沙灣道833號長沙灣廣場二期地下G09B3號舖 (荔枝角站)
營業時間：0800 ~ 2600

🔗 Facebook： https://facebook.com/Mobile.Suit.Gundam.DX
🔗 Gundam DX 吹水台 Telegram： http://t.me/GundamDX （傾Online對戰都得！）

🧑‍🎨 Design by zetaeddie
🧑‍💻 Setup by Edw

#Gundam #GundamDX #連ジ #arcade #GundamVS`,
          categoryId: "20",
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
          defaultLanguage: "yue-HK",
          defaultAudioLanguage: "yue-HK",
        },
        status: {
          containsSyntheticMedia: false,
        },
      },
    });
    console.log(
      `Updated video details for ${faction.value} broadcast: https://youtu.be/${broadcastId}`
    );
  } catch (error) {
    console.error(
      `Error updating ${faction.value} video details for ${broadcastId}:`,
      error
    );
  }
}

export async function deleteLiveBroadcasts(broadcastIds) {
  try {
    for (const id of broadcastIds) {
      await youtube.liveBroadcasts.delete({ id: id });
      console.log(`Deleted broadcast with ID: ${id}`);
    }
    console.log("All specified broadcasts deleted.");
  } catch (error) {
    console.error("Error deleting broadcasts:", error.message);
  }
}

export async function getViewerCount(videoId) {
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
    return 0;
  } catch (error) {
    console.error(
      `Error fetching viewer count for video ${videoId}:`,
      error.message
    );
    return 0;
  }
}
