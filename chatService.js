import { LiveChat } from "youtube-chat";
import { Faction, Megaphone, TTSModel } from "./config.js";
import { textToSpeech } from "./ttsService.js";
import { getViewerCount } from "./youtubeService.js"; // For viewer count updates

let fedLiveChat = null;
let zeonLiveChat = null;
let liveChatInterval = null;
let viewerCountInterval = null;
const messageCache = new Map();

let currentMegaphoneState = Megaphone.ENABLED; // Internal state for chatService

export function updateMegaphoneState(newState) {
  currentMegaphoneState = newState;
}

function processChatMessage(chatItem, faction, io) {
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
  io.emit("chatlog", `${msg.authorName}: ${msg.plainMessage}`);

  const currentTime = Date.now();
  const messageKey = msg.plainMessage;

  for (const [key, timestamp] of messageCache) {
    if (currentTime - timestamp > 2000) {
      // 2 second cache
      messageCache.delete(key);
    }
  }

  if (messageCache.has(messageKey)) {
    return; // Skip duplicate
  }
  messageCache.set(messageKey, currentTime);

  let ttsText = null;
  let ttsVoiceID = null;
  let ttsModel = TTSModel.AZURE_AI; // Default model

  if (
    msg.plainMessage.startsWith("!say ") ||
    msg.plainMessage.startsWith("！say ")
  ) {
    ttsText = msg.plainMessage.slice(5);
    msg.message = `${currentMegaphoneState.icon} ` + msg.message.slice(5);
    ttsVoiceID = "zh-HK-WanLungNeural"; // Male
  } else if (
    msg.plainMessage.startsWith("!gossip ") ||
    msg.plainMessage.startsWith("！gossip ")
  ) {
    ttsText = msg.plainMessage.slice(8);
    msg.message = `${currentMegaphoneState.gossip} ` + msg.message.slice(8);
    ttsVoiceID = "zh-HK-HiuMaanNeural"; // Casual Female
  } else if (
    msg.plainMessage.startsWith("!anchor ") ||
    msg.plainMessage.startsWith("！anchor ")
  ) {
    ttsText = msg.plainMessage.slice(8);
    msg.message = `${currentMegaphoneState.anchor} ` + msg.message.slice(8);
    ttsVoiceID = "zh-HK-HiuGaaiNeural"; // News Reporter Female
  }

  if (ttsText && currentMegaphoneState.enabled) {
    textToSpeech({
      text: ttsText,
      model: ttsModel,
      voiceID: ttsVoiceID,
    });
  }
  io.emit("message", msg);
}

export function setupLiveChatForFaction({ broadcastId, faction, io }) {
  const liveChat = new LiveChat({ liveId: broadcastId });

  if (faction === Faction.FEDERATION) {
    if (fedLiveChat) fedLiveChat.stop();
    fedLiveChat = liveChat;
  } else {
    if (zeonLiveChat) zeonLiveChat.stop();
    zeonLiveChat = liveChat;
  }

  liveChat.on("start", (liveId) => {
    console.log(`Live chat started for ${faction.value}: ${liveId}`);
  });

  liveChat.on("end", (reason) => {
    console.log(`Live chat ended for ${faction.value}: ${reason}`);
  });

  liveChat.on("chat", (chatItem) => {
    processChatMessage(chatItem, faction, io);
  });

  liveChat.on("error", (err) => {
    console.error(`Live chat error for ${faction.value}:`, err);
  });

  liveChat.start().catch((err) => {
    console.error(`Failed to start live chat for ${faction.value}: ${err}`);
  });
  return liveChat;
}

async function fetchAndSumViewers({ broadcastIds, io }) {
  try {
    const viewerCounts = await Promise.all(
      broadcastIds.map((videoId) => getViewerCount(videoId))
    );
    const totalViewers = viewerCounts.reduce((sum, count) => sum + count, 0);
    console.log(`Total Viewers: ${totalViewers}`);
    io.emit("totalviewers", totalViewers);
  } catch (error) {
    console.error("Error in fetchAndSumViewers:", error.message);
  }
}

export function startLiveChatAndViewerCount({ broadcastIds, io }) {
  if (broadcastIds.length !== 2) {
    console.error(
      "Cannot start live chat and viewer count: Expected 2 broadcast IDs."
    );
    return;
  }
  console.log("Setting up live chat for Federation and Zeon...");
  setupLiveChatForFaction({
    broadcastId: broadcastIds[0],
    faction: Faction.FEDERATION,
    io,
  });
  setupLiveChatForFaction({
    broadcastId: broadcastIds[1],
    faction: Faction.ZEON,
    io,
  });

  console.log("Setting up live viewer count...");
  fetchAndSumViewers({ broadcastIds, io }); // Initial fetch
  if (viewerCountInterval) clearInterval(viewerCountInterval);
  viewerCountInterval = setInterval(
    () => fetchAndSumViewers({ broadcastIds, io }),
    25 * 1000 // every 25 seconds
  );
}

export function stopLiveChatAndViewerCount() {
  console.log("Stopping live chat for Federation and Zeon...");
  if (fedLiveChat) {
    fedLiveChat.stop();
    fedLiveChat = null;
  }
  if (zeonLiveChat) {
    zeonLiveChat.stop();
    zeonLiveChat = null;
  }
  if (liveChatInterval) {
    // This variable was defined but not used for chat, maybe meant for viewer count?
    clearInterval(liveChatInterval);
    liveChatInterval = null;
  }
  if (viewerCountInterval) {
    clearInterval(viewerCountInterval);
    viewerCountInterval = null;
    console.log("Viewer count interval stopped.");
  }
  messageCache.clear();
  console.log("Live chat and viewer count services stopped.");
}
