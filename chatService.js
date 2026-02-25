import { LiveChat } from "youtube-chat";
import { scheduler } from "node:timers/promises";
import { Faction, Megaphone, TTSModel, MODERATION_FILTERS } from "./config.js";
import { textToSpeech } from "./ttsService.js";
import { getViewerCount } from "./youtubeService.js"; // For viewer count updates
import { getRandomDelay } from "./systemUtils.js";
import { createMessage } from "./messageService.js";
import {
  sendTextToDXGroup,
  TEST_GROUP_ID,
  PUBLIC_GROUP_ID,
} from "./whatsapp.js";

let fedLiveChat = null;
let zeonLiveChat = null;
let liveChatInterval = null;
let viewerCountInterval = null;
const messageCache = new Map();

let currentMegaphoneState = Megaphone.ENABLED; // Internal state for chatService
let isPublicStream = true;
const serviceStartTime = Date.now();

export function updateMegaphoneState(newState) {
  currentMegaphoneState = newState;
}

function undoModerationFilters(text) {
  let originalText = text;
  for (const [original, replacement] of Object.entries(MODERATION_FILTERS)) {
    const regex = new RegExp(replacement, "g");
    originalText = originalText.replace(regex, original);
  }
  return originalText;
}

function processChatMessage(chatItem, faction, io) {
  const msg = createMessage({
    isFederation: faction === Faction.FEDERATION,
    authorName: chatItem.author.name,
    profilePic: chatItem.author.thumbnail.url,
    message: chatItem.message
      .map((item) =>
        item.text
          ? undoModerationFilters(item.text)
          : `<img class="emoji" src="${item.url}" alt="${
              item.emojiText || item.alt
            }" shared-tooltip-text="${item.alt}" >`,
      )
      .join(""),
    plainMessage: chatItem.message
      .map((item) =>
        item.text
          ? undoModerationFilters(item.text)
          : item.emojiText ||
            (item.alt.startsWith(":") ? item.alt : `:${item.alt}:`),
      )
      .join(""),
    timestamp: new Date(chatItem.timestamp),
  });

  io.emit("chatlog", `${msg.authorName}: ${msg.plainMessage}`);

  const currentTime = Date.now();
  // Composite key: Author + Message + Original YouTube Timestamp
  // This uniquely identifies this specific message instance from the API.
  const messageKey = `${msg.authorName}:${msg.plainMessage}:${
    msg.timestamp ? msg.timestamp.getTime() : ""
  }`;

  if (messageCache.has(messageKey)) {
    // Refresh the cache timer: as long as the API repeats this specific message,
    // it stays in the cache and remains blocked.
    messageCache.set(messageKey, currentTime);
    return; // Skip duplicate
  }

  // Cleanup old entries (older than 5 minutes)
  for (const [key, timestamp] of messageCache) {
    if (currentTime - timestamp > 300000) {
      messageCache.delete(key);
    }
  }

  // Set the initial cache entry
  messageCache.set(messageKey, currentTime);

  // Handle WhatsApp forwarded messages pattern: "💬Name: Message" or "💬Name 開咪"
  // Move this BEFORE TTS logic so it doesn't get confused by megaphone icons

  // Pattern 1: Suffix pattern (for single-message TTS) "!gossip Hello !:Edward Li"
  const suffixMatch = msg.plainMessage.match(/^(.*)\s+!:(.+)$/s);
  if (suffixMatch) {
    msg.authorName = `💬${suffixMatch[2].trim()}`;
    msg.plainMessage = suffixMatch[1].trim();
    msg.message = msg.plainMessage; // Use plain text to avoid HTML emoji/tag mess
  }
  // Pattern 2: Prefix pattern (for standard messages) "💬Name: Message"
  else {
    const whatsappPrefixRegex = /(💬|:?speech_balloon:?)\s*/i;
    if (whatsappPrefixRegex.test(msg.plainMessage)) {
      const cleanPlain = msg.plainMessage.replace(whatsappPrefixRegex, "");

      // Pattern 1: "Name: Message"
      const waMatch = cleanPlain.match(/^(.+?)\s*[:：]\s*(.*)$/s);

      if (waMatch) {
        msg.authorName = `💬${waMatch[1].trim()}`;
        msg.plainMessage = waMatch[2].trim();
        msg.message = msg.plainMessage; // Use plain text to avoid HTML emoji/tag mess
      }
    }
  }

  // --- TTS & Icon Prefixing ---

  let ttsText = null;
  let ttsVoiceID = null;
  let ttsModel = TTSModel.AZURE_AI; // Default model

  if (
    msg.plainMessage.startsWith("!say ") ||
    msg.plainMessage.startsWith("！say ")
  ) {
    ttsText = msg.plainMessage.slice(5);
    msg.message = `${currentMegaphoneState.icon} ` + msg.message.slice(5);
    msg.plainMessage = `${currentMegaphoneState.icon} ` + ttsText;
    ttsVoiceID = "zh-HK-WanLungNeural"; // Male
  } else if (
    msg.plainMessage.startsWith("!msay ") ||
    msg.plainMessage.startsWith("！msay ")
  ) {
    ttsText = msg.plainMessage.slice(6);
    msg.message = `🇨🇳${currentMegaphoneState.icon} ` + msg.message.slice(6);
    msg.plainMessage = `🇨🇳${currentMegaphoneState.icon} ` + ttsText;
    ttsVoiceID = "zh-CN-YunjianNeural";
  } else if (
    msg.plainMessage.startsWith("!gossip ") ||
    msg.plainMessage.startsWith("！gossip ")
  ) {
    ttsText = msg.plainMessage.slice(8);
    msg.message = `${currentMegaphoneState.gossip} ` + msg.message.slice(8);
    msg.plainMessage = `${currentMegaphoneState.gossip} ` + ttsText;
    ttsVoiceID = "zh-HK-HiuMaanNeural"; // Casual Female
  } else if (
    msg.plainMessage.startsWith("!mgossip ") ||
    msg.plainMessage.startsWith("！mgossip ")
  ) {
    ttsText = msg.plainMessage.slice(9);
    msg.message = `🇨🇳${currentMegaphoneState.gossip} ` + msg.message.slice(9);
    msg.plainMessage = `🇨🇳${currentMegaphoneState.gossip} ` + ttsText;
    ttsVoiceID = "zh-CN-XiaoyiNeural";
  } else if (
    msg.plainMessage.startsWith("!anchor ") ||
    msg.plainMessage.startsWith("！anchor ")
  ) {
    ttsText = msg.plainMessage.slice(8);
    msg.message = `${currentMegaphoneState.anchor} ` + msg.message.slice(8);
    msg.plainMessage = `${currentMegaphoneState.anchor} ` + ttsText;
    ttsVoiceID = "zh-HK-HiuGaaiNeural"; // News Reporter Female
  } else if (
    msg.plainMessage.startsWith("!manchor ") ||
    msg.plainMessage.startsWith("！manchor ")
  ) {
    ttsText = msg.plainMessage.slice(9);
    msg.message = `🇨🇳${currentMegaphoneState.anchor} ` + msg.message.slice(9);
    msg.plainMessage = `🇨🇳${currentMegaphoneState.anchor} ` + ttsText;
    ttsVoiceID = "zh-CN-XiaoxiaoNeural";
  }

  // NOW we emit the final version with the icon to the chat box
  io.emit("message", msg);

  // Guard: Only perform TTS and WhatsApp forwarding for messages sent after the service started
  if (msg.timestamp) {
    let msgTime = msg.timestamp.getTime();

    // YouTube internal timestamps are sometimes in microseconds (16 digits).
    // Convert to milliseconds if detected.
    if (msgTime > 10000000000000) {
      msgTime = Math.floor(msgTime / 1000);
    }

    if (msgTime < serviceStartTime) {
      return;
    }
  }

  if (ttsText && currentMegaphoneState.enabled) {
    textToSpeech({
      text: ttsText,
      model: ttsModel,
      voiceID: ttsVoiceID,
    });
  }

  const prefix = faction === Faction.FEDERATION ? "🔵" : "🔴";
  const targetGroupId = isPublicStream ? PUBLIC_GROUP_ID : TEST_GROUP_ID;
  sendTextToDXGroup(`${prefix} ${msg.authorName}: ${msg.plainMessage}`, {
    groupId: targetGroupId,
    withTyping: true,
    typingDurationMs: getRandomDelay(200, 450), // Randomize typing speed
    pauseAfterMs: getRandomDelay(50, 150),
  });
}

export function setupLiveChatForFaction({ broadcastId, faction, io }) {
  return new Promise((resolve, reject) => {
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
      resolve(liveChat); // Resolve the promise on successful start
    });

    liveChat.on("end", (reason) => {
      console.log(`Live chat ended for ${faction.value}: ${reason}`);
    });

    liveChat.on("chat", (chatItem) => {
      processChatMessage(chatItem, faction, io);
    });

    liveChat.on("error", (err) => {
      console.error(`Live chat error for ${faction.value}:`, err);
      reject(err); // Reject the promise on error
    });

    liveChat.start().catch((err) => {
      console.error(`Failed to start live chat for ${faction.value}: ${err}`);
      reject(err); // Also reject if the start call itself fails
    });
  });
}

async function fetchAndSumViewers({ broadcastIds, io }) {
  try {
    const viewerCounts = await Promise.all(
      broadcastIds.map((videoId) => getViewerCount(videoId)),
    );
    const totalViewers = viewerCounts.reduce((sum, count) => sum + count, 0);
    console.log(`Total Viewers: ${totalViewers}`);
    io.emit("totalviewers", totalViewers);
  } catch (error) {
    console.error("Error in fetchAndSumViewers:", error.message);
  }
}

export async function startLiveChatAndViewerCount({
  broadcastIds,
  io,
  isPublic = true,
}) {
  isPublicStream = isPublic;
  if (broadcastIds.length !== 2) {
    console.error(
      "Cannot start live chat and viewer count: Expected 2 broadcast IDs.",
    );
    return;
  }

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      console.log(
        `Attempt ${attempts + 1} to set up live chat for Federation and Zeon...`,
      );

      const fedPromise = setupLiveChatForFaction({
        broadcastId: broadcastIds[0],
        faction: Faction.FEDERATION,
        io,
      });

      const zeonPromise = setupLiveChatForFaction({
        broadcastId: broadcastIds[1],
        faction: Faction.ZEON,
        io,
      });

      await Promise.all([fedPromise, zeonPromise]);

      console.log("Setting up live viewer count...");
      fetchAndSumViewers({ broadcastIds, io }); // Initial fetch
      if (viewerCountInterval) clearInterval(viewerCountInterval);
      viewerCountInterval = setInterval(
        () => fetchAndSumViewers({ broadcastIds, io }),
        25 * 1000, // every 25 seconds
      );

      console.log("Successfully started live chat and viewer count.");
      return; // Exit the loop and function on success
    } catch (error) {
      console.error(`Attempt ${attempts + 1} failed:`, error.message || error);
      attempts++;
      if (attempts < maxAttempts) {
        console.log(`Retrying in 30 seconds...`);
        await scheduler.wait(30000);
      } else {
        console.error("All attempts to start live chat failed.");
      }
    }
  }
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
