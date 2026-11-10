// Run in the background after local streaming services have started. Do not
// queue old stream links through a reauthentication or switch of broadcasts.
export async function announceStreamLinks({ broadcastIds, groupId, isCurrent, isReady, send, logger = console }) {
  for (const id of broadcastIds) {
    if (!isCurrent() || !isReady()) {
      logger.log("WhatsApp stream announcements skipped: stream changed or WhatsApp is not ready.");
      return;
    }
    try {
      const sent = await send(`https://youtu.be/${id}`, { groupId, pauseAfterMs: 0 });
      if (!sent) {
        logger.error("WhatsApp stream announcement failed; streaming continues.");
        return;
      }
      logger.log(`WhatsApp stream announcement sent: https://youtu.be/${id}`);
    } catch (error) {
      logger.error("WhatsApp stream announcement failed; streaming continues:", error);
      return;
    }
  }
}
