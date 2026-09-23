import { OFFLINE_RESPONSES } from "./whatsappYouTubeBridge.js";

export function createFusionCommandHandler({
  publicGroupId, testGroupId, getStreamState, play, now = Date.now, random = Math.random,
}) {
  return async function handleFusionCommand(message) {
    // 1. Guard: Only process messages from the allowed groups.
    const isPublicGroup = Boolean(publicGroupId) && message.from === publicGroupId;
    const isTestGroup = Boolean(testGroupId) && message.from === testGroupId;
    if ((!isPublicGroup && !isTestGroup) || message.fromMe) return;

    // 2. Guard: Only accept the complete !fusion command, without arguments.
    if (!/^[!！]fusion$/i.test(String(message.body || "").trim())) return;
    // Do not replay old effects when WhatsApp reconnects and catches up.
    const timestamp = Number(message.timestamp) * 1000;
    if (!Number.isFinite(timestamp) || timestamp <= 0 || now() - timestamp > 30000) return;

    const stream = getStreamState();
    // 3. Guard: Keep the existing funny offline response.
    if (stream.broadcastIds.length !== 2) {
      return message.reply(OFFLINE_RESPONSES[Math.floor(random() * OFFLINE_RESPONSES.length)]);
    }

    // 4. Guard: Ensure the group matches the current stream visibility.
    if ((stream.streamType === "public" && !isPublicGroup) ||
      (stream.streamType === "unlisted" && !isTestGroup)) return;

    // This is a local monitor effect; no contact lookup or YouTube comment.
    return play();
  };
}
