import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ACTIVE = new Set(["pending", "inflight", "submitted"]);
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORDS = 10000;
const NOTICE_MAX_AGE_MS = 10 * 60 * 1000;
const TTS_COMMAND = /^[!！]([mu]?say|[mu]?gossip|[mu]?anchor)\b/i;
export const OFFLINE_RESPONSES = Object.freeze([
  "東主有喜，暫停直播。",
  "噢~噢噢噢~噢噢噢~ 我俾碌蕉你含~",
  "朋友，你返去印度食蕉啦",
  "邊撚個chok到呢句出嚟，就輸一蚊",
  "由於節目調動嘅關係，原定播映嘅龍珠二世將會暫停播映，敬請留意。",
  "你嗌破喉嚨都冇人理你㗎喇！哈哈哈哈哈哈哈哈~",
]);

export function parseWhatsAppCommand(body) {
  const text = String(body || "").trim();
  // Preserve the original command grammar and text, including case/spacing.
  const isFed = text.startsWith("!fed ") || text.startsWith("！fed ");
  const isZeon = text.startsWith("!zeon ") || text.startsWith("！zeon ");
  if (!isFed && !isZeon && !TTS_COMMAND.test(text)) return null;
  const content = isFed ? text.slice(5).trim() : isZeon ? text.slice(6).trim() : text;
  return {
    faction: isZeon ? "zeon" : "fed",
    content,
    tts: TTS_COMMAND.test(content),
  };
}

// One server owns this journal. Receipt/state writes are serialized and replace
// the journal atomically; HTTP acknowledgement happens only after fsync/rename.
export class WhatsAppYouTubeBridge {
  constructor({ directory, publicGroupId, testGroupId, getStreamState, send, canSend = () => true,
    notify = null, canNotify = () => true,
    now = Date.now, maxAgeMs = 5 * 60 * 1000, confirmationMs = 90 * 1000,
    maxAttempts = 5, logger = console, random = Math.random }) {
    this.directory = directory;
    this.file = path.join(directory, "state.json");
    this.publicGroupId = publicGroupId;
    this.testGroupId = testGroupId;
    this.getStreamState = getStreamState;
    this.send = send;
    this.canSend = canSend;
    this.notify = notify;
    this.canNotify = canNotify;
    this.now = now;
    this.maxAgeMs = maxAgeMs;
    this.confirmationMs = confirmationMs;
    this.maxAttempts = maxAttempts;
    this.logger = logger;
    this.random = random;
    this.records = [];
    this._writes = Promise.resolve();
    this._initializing = null;
    this._running = null;
    this._notifying = null;
    this._timer = null;
    this._observedIds = new Set();
  }

  initialize() {
    if (!this._initializing) {
      this._initializing = this._load();
      this._initializing.catch(() => { this._initializing = null; });
    }
    return this._initializing;
  }

  async _load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let stored;
    try { stored = JSON.parse(await readFile(this.file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!stored) return;
    if (stored.version !== 1 || !Array.isArray(stored.records) ||
      stored.records.some((record) => !record.key || !record.status ||
        !Number.isFinite(record.createdAt))) {
      throw new Error("Invalid WhatsApp → YouTube journal; refusing to discard it.");
    }
    const records = stored.records.map((record) => {
      let recovered = record.status === "inflight"
        ? { ...record, status: "uncertain", reason: "interruptedDuringSubmission", updatedAt: this.now() }
        : record;
      // Older queue versions kept offline commands for a future stream.
      // Preserve their receipt without ever binding them to a new broadcast.
      if (recovered.status === "pending" && !recovered.videoId) {
        recovered = { ...recovered, status: "offline", reason: "noActiveStreams",
          offlineReply: this._offlineResponse(), updatedAt: this.now() };
      }
      return recovered.notification?.status === "sending"
        ? { ...recovered, notification: { ...recovered.notification,
          status: "uncertain", reason: "interruptedDuringNotification" } }
        : recovered;
    });
    await this._save(records);
    for (const record of records) {
      if (["pending", "uncertain", "rejected", "unconfirmed"].includes(record.status)) {
        this._log(record);
      }
    }
  }

  async _save(records) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, records }, null, 2));
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, this.file);
      this.records = records;
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") this.logger.error("Outbox temporary-file cleanup failed:", error);
      });
    }
  }

  _exclusive(operation) {
    const result = this._writes.then(operation);
    this._writes = result.catch(() => {});
    return result;
  }

  _log(record) {
    this.logger.log(`WhatsApp → YouTube ${record.key}: ${record.status}` +
      ` (attempts=${record.attempts}, video=${record.videoId || "waiting"}` +
      `${record.youtubeId ? `, comment=${record.youtubeId}` : ""}` +
      `${record.notification ? `, notification=${record.notification.status}` : ""}` +
      `${record.reason ? `, reason=${record.reason}` : ""})`);
  }

  async _update(key, changes, expectedStatuses) {
    return this._exclusive(async () => {
      const record = this.records.find((item) => item.key === key);
      if (!record || (expectedStatuses && !expectedStatuses.includes(record.status))) return record;
      const updated = { ...record, ...changes, updatedAt: this.now() };
      await this._save(this.records.map((item) => item.key === key ? updated : item));
      this._log(updated);
      return updated;
    });
  }

  async accept(message) {
    // 1. Guard: Only process messages from the allowed groups.
    const isPublicGroup = Boolean(this.publicGroupId) && message.from === this.publicGroupId;
    const isTestGroup = Boolean(this.testGroupId) && message.from === this.testGroupId;
    if (!isPublicGroup && !isTestGroup) return;

    // 2. Guard: Only process the original expected command prefixes.
    const command = parseWhatsAppCommand(message.body);
    if (!command) return;

    const stream = this.getStreamState();
    const broadcastIds = [...stream.broadcastIds];
    // 3. Guard: Reply with an offline joke before checking stream visibility.
    if (broadcastIds.length !== 2) {
      return this._recordCommand(message, command, {
        status: "offline", reason: "noActiveStreams",
      });
    }

    // 4. Guard: Ensure the group matches the current stream visibility.
    if (
      (stream.streamType === "public" && !isPublicGroup) ||
      (stream.streamType === "unlisted" && !isTestGroup)
    ) {
      return this._recordCommand(message, command, {
        status: "ignored", reason: "streamVisibilityMismatch",
      });
    }

    if (!command.content) return;
    return this._recordCommand(message, command, {
      status: "pending", videoId: broadcastIds[command.faction === "zeon" ? 1 : 0],
    });
  }

  // Journal the guard's decision before acknowledgement. Offline and ignored
  // commands are terminal; only eligible commands need a contact lookup.
  async _recordCommand(message, command, { status, reason = null, videoId = null }) {
    if (!message.id?._serialized) throw new Error("A WhatsApp command ID is required.");
    await this.initialize();
    const key = `${message.from}:${message.id._serialized}`;
    return this._exclusive(async () => {
      const existing = this.records.find((record) => record.key === key);
      if (existing) return existing;
      const now = this.now();
      const records = this.records.filter((record) =>
        ACTIVE.has(record.status) || now - record.updatedAt < RETENTION_MS);
      if (records.length >= MAX_RECORDS) throw new Error("WhatsApp → YouTube journal is full.");
      const timestamp = Number(message.timestamp) * 1000;
      const createdAt = Number.isFinite(timestamp) && timestamp > 0 ? Math.min(timestamp, now) : now;
      const expired = now - createdAt >= this.maxAgeMs;
      const canForward = !expired && status === "pending";
      let text = null;
      if (canForward) {
        const contact = await message.getContact();
        // Use only pushname to avoid exposing phone numbers. Never fall back
        // to contact.name, contact.number, IDs, or the sender JID.
        const name = contact?.pushname || "神秘人";
        text = command.tts ? `${command.content} !:${name}` : `💬${name}: ${command.content}`;
      }
      const record = {
        key, groupId: message.from, text, faction: command.faction,
        whatsappMessageId: message.id._serialized, senderJid: message.author || null,
        createdAt, updatedAt: now, attempts: 0, nextAttemptAt: now,
        videoId: canForward ? videoId : null,
        status: expired ? "expired" : status,
        reason: expired ? "commandTooOld" : reason,
        offlineReply: !expired && status === "offline" ? this._offlineResponse() : null,
      };
      await this._save([...records, record]);
      this._log(record);
      return record;
    });
  }

  start() {
    if (this._timer) return;
    const run = () => {
      this.tick().catch((error) =>
        this.logger.error("WhatsApp → YouTube queue error:", error));
      // WhatsApp being slow must not hold up other YouTube submissions.
      this.notifyPending().catch((error) =>
        this.logger.error("WhatsApp delivery notification error:", error));
    };
    this._timer = setInterval(run, 1000);
    this._timer.unref?.();
    run();
  }

  async close() {
    clearInterval(this._timer);
    this._timer = null;
    await this._running;
    await this._notifying;
    await this._writes;
  }

  tick() {
    if (!this._running) {
      this._running = this._tick().finally(() => { this._running = null; });
    }
    return this._running;
  }

  async _tick() {
    await this.initialize();
    for (const record of this.records) {
      if (record.status === "submitted" && this._observedIds.has(record.youtubeId)) {
        await this._update(record.key, { status: "observed", reason: null }, ["submitted", "unconfirmed"]);
      } else if (record.status === "submitted" && this.now() - record.updatedAt >= this.confirmationMs) {
        await this._update(record.key, { status: "unconfirmed", reason: "notObservedInChat; possibleModerationOrPollingGap" }, ["submitted"]);
      }
      if (record.status === "pending" && this.now() - record.createdAt >= this.maxAgeMs) {
        await this._update(record.key, { status: "expired", reason: "commandTooOld" });
      }
    }
    if (!this.canSend()) return;
    const record = this.records.find((item) => item.status === "pending" && item.nextAttemptAt <= this.now());
    if (!record) return;
    const stream = this.getStreamState();
    const videoId = record.videoId;
    if (![this.publicGroupId, this.testGroupId].filter(Boolean).includes(record.groupId)) {
      await this._update(record.key, { status: "ignored", reason: "groupNoLongerAllowed" });
      return;
    }
    // A retry must still pass the stream guards. After restart, wait for the
    // original broadcast to be selected; never post while the app is offline.
    if (stream.broadcastIds.length !== 2) return;
    if ((stream.streamType === "public" && record.groupId !== this.publicGroupId) ||
      (stream.streamType === "unlisted" && record.groupId !== this.testGroupId)) {
      await this._update(record.key, { status: "ignored", reason: "streamVisibilityMismatch" });
      return;
    }
    if (!videoId || !stream.broadcastIds.includes(videoId)) {
      await this._update(record.key, { status: "expired", reason: "targetStreamChanged" });
      return;
    }

    // Commit the attempt BEFORE making the request. A crash anywhere after
    // this write leaves an uncertain outcome and must never cause a repost.
    const sending = await this._update(record.key, {
      videoId, status: "inflight", attempts: record.attempts + 1, reason: null,
    });
    let result;
    let failure;
    try {
      result = await this.send(videoId, record.text);
      if (!result?.id) throw new Error("YouTube returned no comment ID.");
    } catch (error) { failure = error; }
    // Keep persistence errors outside the send catch: they must leave the
    // saved inflight record intact, never schedule another insertion.
    if (failure) {
      const canRetry = failure.outcome === "retry" && sending.attempts < this.maxAttempts;
      await this._update(record.key, {
        status: canRetry ? "pending" : failure.outcome === "retry" ? "failed"
          : failure.outcome === "rejected" ? "rejected" : "uncertain",
        reason: failure.reason || failure.message,
        nextAttemptAt: this.now() + Math.max(2000 * 2 ** (sending.attempts - 1), failure.retryAfterMs || 0),
      });
    } else {
      await this._update(record.key, {
        status: this._observedIds.has(result.id) ? "observed" : "submitted",
        youtubeId: result.id,
      });
    }
  }

  async observe(youtubeId) {
    if (!youtubeId) return;
    this._observedIds.add(youtubeId);
    if (this._observedIds.size > 5000) this._observedIds.delete(this._observedIds.values().next().value);
    await this.initialize();
    const record = this.records.find((item) => item.youtubeId === youtubeId &&
      ["submitted", "unconfirmed"].includes(item.status));
    if (record) await this._update(record.key, { status: "observed", reason: null }, ["submitted", "unconfirmed"]);
  }

  _notificationText(record) {
    if (record.status === "offline") return record.offlineReply;
    if (record.status === "unconfirmed" && !this._observedIds.has(record.youtubeId)) {
      return "⚠️ 呢條指令嘅留言暫時未喺 YouTube 直播聊天室出現，可能被 YouTube 審核攔截，亦可能係聊天室同步延遲。系統唔會自動重發。";
    }
    if (record.status !== "rejected") return null;
    if (record.reason === "messageTextInvalid") {
      return "⚠️ YouTube 未接受呢條指令嘅留言，可能被審核攔截或內容唔符合要求。系統唔會自動重發。";
    }
    if (["forbidden", "403"].includes(record.reason)) {
      return "⚠️ YouTube 拒絕咗呢條指令嘅留言，可能涉及審核或發佈權限。系統唔會自動重發。";
    }
    // Quota, ended chat, and transport failures are not moderation evidence.
    return null;
  }

  _offlineResponse() {
    return OFFLINE_RESPONSES[Math.floor(this.random() * OFFLINE_RESPONSES.length)];
  }

  notifyPending() {
    if (!this._notifying) {
      this._notifying = this._notifyPending().finally(() => { this._notifying = null; });
    }
    return this._notifying;
  }

  async _notifyPending() {
    if (!this.notify || !this.canNotify()) return;
    await this.initialize();
    const claimed = await this._exclusive(async () => {
      const record = this.records.find((item) => !item.notification &&
        [this.publicGroupId, this.testGroupId].filter(Boolean).includes(item.groupId) &&
        this._notificationText(item));
      if (!record) return null;
      const text = this._notificationText(record);
      const expired = this.now() - record.createdAt >= NOTICE_MAX_AGE_MS;
      const updated = { ...record, notification: {
        status: expired ? "expired" : "sending", startedAt: this.now(),
      } };
      // Save before sending: a crash or ambiguous error must not spam replies.
      await this._save(this.records.map((item) => item.key === record.key ? updated : item));
      this._log(updated);
      return expired ? null : { record: updated, text };
    });
    if (!claimed) return;
    const { record, text } = claimed;
    let sent;
    let failure;
    try {
      // Older journals stored the original ID only as part of their key.
      const replyTo = record.whatsappMessageId || record.key.slice(record.groupId.length + 1);
      sent = await this.notify(record.groupId, text, {
        replyTo, replyToSender: record.senderJid || undefined,
      });
      if (!sent?.id?._serialized) throw new Error("WhatsApp returned no notification message ID.");
    } catch (error) { failure = error; }
    // Do not catch persistence failures as send failures: leave the saved
    // 'sending' record for conservative crash recovery instead of resending.
    await this._update(record.key, { notification: {
      ...record.notification,
      status: failure ? "uncertain" : "sent",
      finishedAt: this.now(),
      messageId: sent?.id?._serialized || null,
      reason: failure?.message || null,
    } });
    if (failure) this.logger.error(`WhatsApp delivery notice failed for ${record.key}:`, failure);
  }
}
