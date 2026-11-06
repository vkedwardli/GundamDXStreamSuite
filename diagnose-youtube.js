// Read-only check. Do not import youtubeService.js: its token listener writes
// credentials, and the running streaming process should remain their owner.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { describeYouTubeFailure } from "./youtubeChatDelivery.js";

export async function inspectYouTubeChat(youtube, videoId) {
  const results = await Promise.allSettled([
    youtube.channels.list({ part: ["id", "snippet"], mine: true }, { retry: false, timeout: 15000 }),
    youtube.videos.list({
      part: ["snippet", "status", "liveStreamingDetails"], id: videoId,
    }, { retry: false, timeout: 15000 }),
  ]);
  const [channels, video] = results;
  const report = { videoId };
  if (channels.status === "rejected") {
    report.channelLookupError = describeYouTubeFailure(channels.reason);
  } else {
    report.authorizedChannels = (channels.value.data.items || []).map(({ id, snippet }) => ({
      id, title: snippet?.title,
    }));
  }
  if (video.status === "rejected") {
    report.videoLookupError = describeYouTubeFailure(video.reason);
  } else {
    const item = video.value.data.items?.[0];
    report.video = item ? {
      id: item.id, title: item.snippet?.title,
      channelId: item.snippet?.channelId, channelTitle: item.snippet?.channelTitle,
      privacyStatus: item.status?.privacyStatus, madeForKids: item.status?.madeForKids,
      activeLiveChatId: item.liveStreamingDetails?.activeLiveChatId || null,
      actualStartTime: item.liveStreamingDetails?.actualStartTime || null,
      actualEndTime: item.liveStreamingDetails?.actualEndTime || null,
    } : null;
    if (item && report.authorizedChannels) {
      report.authorizedChannelOwnsVideo = report.authorizedChannels.some(({ id }) =>
        id === item.snippet?.channelId);
    }
  }
  return report;
}

async function main() {
  const videoId = process.argv[2];
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) {
    console.error("Usage: npm run diagnose:youtube -- VIDEO_ID");
    process.exitCode = 2;
    return;
  }
  try {
    const { CLIENT_ID, CLIENT_SECRET, TOKEN_PATH } = await import("./config.js");
    const { OAuth2Client } = await import("google-auth-library");
    const { youtube: createYouTube } = await import("googleapis/build/src/apis/youtube/index.js");
    const credentials = JSON.parse(await readFile(TOKEN_PATH, "utf8"));
    const auth = new OAuth2Client({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    auth.setCredentials(credentials);
    await auth.getAccessToken();
    const report = await inspectYouTubeChat(createYouTube({ version: "v3", auth }), videoId);
    console.log(JSON.stringify({ storedScope: credentials.scope || null, ...report }, null, 2));
    console.log("Read-only check: no comments sent. Successful lookups do not prove posting permission.");
    if (report.channelLookupError || report.videoLookupError) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ diagnosticError: describeYouTubeFailure(error) }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
