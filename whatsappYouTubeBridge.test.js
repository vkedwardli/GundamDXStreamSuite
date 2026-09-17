import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WhatsAppYouTubeBridge, parseWhatsAppCommand, OFFLINE_RESPONSES } from "./whatsappYouTubeBridge.js";
import { YouTubeDeliveryError } from "./youtubeChatDelivery.js";

const PUBLIC = "public@g.us";
const TEST = "test@g.us";

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wa-youtube-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = 1800000000000;
  let stream = { broadcastIds: ["fed-video", "zeon-video"], streamType: "public" };
  const sends = [];
  const options = {
    directory, publicGroupId: PUBLIC, testGroupId: TEST,
    getStreamState: () => stream, now: () => clock,
    send: async (...args) => { sends.push(args); return { id: `yt-${sends.length}` }; },
    logger: { log() {}, error() {} }, ...overrides,
  };
  const bridge = new WhatsAppYouTubeBridge(options);
  const message = (id = "wa-1", body = "!say hello", from = PUBLIC) => ({
    id: { _serialized: id }, body, from, timestamp: clock / 1000,
    getContact: async () => ({ pushname: "Lo~" }),
  });
  return { bridge, options, sends, message,
    advance(ms) { clock += ms; }, setStream(value) { stream = value; },
    async stored() { return JSON.parse(await readFile(bridge.file, "utf8")).records; },
  };
}

test("parses supported commands, preserves text, and ignores ordinary chat", () => {
  assert.equal(parseWhatsAppCommand("hello"), null);
  assert.deepEqual(parseWhatsAppCommand("!say"), { faction: "fed", content: "!say", tts: true });
  assert.deepEqual(parseWhatsAppCommand("！zeon !Say 自殺"), {
    faction: "zeon", content: "!Say 自殺", tts: true,
  });
  assert.equal(parseWhatsAppCommand("!Fed hello"), null);
  assert.equal(parseWhatsAppCommand("!zeon\thello"), null);
  assert.equal(parseWhatsAppCommand("!sayhello"), null);
  assert.deepEqual(parseWhatsAppCommand("！msay  多謝"), {
    faction: "fed", content: "！msay  多謝", tts: true,
  });
});

test("receipt is persisted before sending; concurrent duplicates and restarts do not repost", async (t) => {
  const f = await fixture(t);
  await Promise.all([f.bridge.accept(f.message()), f.bridge.accept(f.message())]);
  assert.equal(f.sends.length, 0);
  assert.equal((await f.stored()).length, 1);
  assert.equal((await f.stored())[0].status, "pending");
  const restarted = new WhatsAppYouTubeBridge(f.options);
  await restarted.accept(f.message());
  await restarted.tick();
  assert.deepEqual(f.sends, [["fed-video", "!say hello !:Lo~"]]);
  const again = new WhatsAppYouTubeBridge(f.options);
  await again.accept(f.message());
  await again.tick();
  assert.equal(f.sends.length, 1);
});

test("retries rate limits with backoff, retains the target, and accepts the returned ID", async (t) => {
  let attempts = 0;
  const f = await fixture(t, { send: async (video, text) => {
    assert.equal(video, "zeon-video");
    assert.equal(text, "!say hello !:Lo~");
    if (++attempts === 1) throw new YouTubeDeliveryError("rate limit", {
      outcome: "retry", reason: "rateLimitExceeded", retryAfterMs: 12000,
    });
    return { id: "accepted" };
  } });
  await f.bridge.accept(f.message("wa-1", "!zeon !say hello"));
  await f.bridge.tick();
  const restarted = new WhatsAppYouTubeBridge(f.options);
  f.advance(11999);
  await restarted.tick();
  assert.equal(attempts, 1);
  f.advance(1);
  await restarted.tick();
  assert.equal(attempts, 2);
  assert.equal((await f.stored())[0].youtubeId, "accepted");
});

test("moderation rejection is recorded once and does not block the next command", async (t) => {
  const texts = [];
  const f = await fixture(t, { send: async (_video, text) => {
    texts.push(text);
    if (text.includes("自殺")) throw new YouTubeDeliveryError("invalid message", {
      outcome: "rejected", reason: "messageTextInvalid",
    });
    return { id: "accepted" };
  } });
  await f.bridge.accept(f.message("blocked", "!say 自殺"));
  await f.bridge.accept(f.message("next", "!say hello"));
  await f.bridge.tick();
  await f.bridge.tick();
  f.advance(120000);
  const restarted = new WhatsAppYouTubeBridge(f.options);
  await restarted.accept(f.message("blocked", "!say 自殺"));
  await restarted.tick();
  assert.equal(texts.length, 2);
  assert.equal((await f.stored())[0].status, "rejected");
});

test("API acceptance without chat visibility is flagged, never automatically reposted", async (t) => {
  const f = await fixture(t);
  await f.bridge.accept(f.message());
  await f.bridge.tick();
  assert.equal((await f.stored())[0].status, "submitted");
  f.advance(90001);
  await f.bridge.tick();
  assert.equal((await f.stored())[0].status, "unconfirmed");
  await f.bridge.observe("yt-1");
  assert.equal((await f.stored())[0].status, "observed");
  await f.bridge.tick();
  assert.equal(f.sends.length, 1);
});

test("an observation arriving before the insert response is retained", async (t) => {
  const f = await fixture(t);
  f.bridge.send = async () => {
    await f.bridge.observe("early-id");
    return { id: "early-id" };
  };
  await f.bridge.accept(f.message());
  await f.bridge.tick();
  assert.equal((await f.stored())[0].status, "observed");
});

test("timeouts and interrupted submissions are uncertain across restarts", async (t) => {
  const f = await fixture(t, { send: async () => { throw new Error("connection lost"); } });
  await f.bridge.accept(f.message());
  await f.bridge.tick();
  assert.equal((await f.stored())[0].status, "uncertain");
  const records = await f.stored();
  records[0].status = "inflight"; // Crash with no committed outcome.
  await writeFile(f.bridge.file, JSON.stringify({ version: 1, records }));
  let attempts = 0;
  const restarted = new WhatsAppYouTubeBridge({ ...f.options,
    send: async () => { attempts += 1; return { id: "duplicate" }; },
  });
  await restarted.tick();
  assert.equal(attempts, 0);
  assert.equal((await f.stored())[0].status, "uncertain");
});

test("bounded retries give up and stale messages expire", async (t) => {
  let attempts = 0;
  const f = await fixture(t, { send: async () => {
    attempts += 1;
    throw new YouTubeDeliveryError("offline", { outcome: "retry", reason: "ENOTFOUND" });
  } });
  await f.bridge.accept(f.message());
  for (let index = 0; index < 6; index += 1) {
    await f.bridge.tick();
    f.advance(32000);
  }
  assert.equal(attempts, 5);
  assert.equal((await f.stored())[0].status, "failed");
  await f.bridge.accept(f.message("stale"));
  f.advance(300001);
  await f.bridge.tick();
  assert.equal((await f.stored())[1].status, "expired");
  assert.equal(attempts, 5);
});

test("offline commands get the original jokes before the visibility guard and never reach a later stream", async (t) => {
  const replies = [];
  const f = await fixture(t, {
    notify: async (...args) => { replies.push(args); return { id: { _serialized: `reply-${replies.length}` } }; },
  });
  for (const [id, group, broadcastIds] of [["public", PUBLIC, []], ["test", TEST, ["partial-stream"]]]) {
    f.setStream({ broadcastIds, streamType: "public" });
    await f.bridge.accept({ ...f.message(id, "!say hello", group),
      getContact: async () => { throw new Error("Offline guard must run before contact lookup"); },
    });
    await f.bridge.tick();
    await f.bridge.notifyPending();
  }
  assert.equal(f.sends.length, 0);
  assert.equal(replies.length, 2);
  assert.deepEqual(replies.map(([group]) => group), [PUBLIC, TEST]);
  assert.deepEqual(replies.map(([, , options]) => options.replyTo), ["public", "test"]);
  assert.ok(replies.every(([, text]) => OFFLINE_RESPONSES.includes(text)));
  assert.ok((await f.stored()).every((record) => record.status === "offline"));

  f.setStream({ broadcastIds: ["fed-video", "zeon-video"], streamType: "public" });
  const restarted = new WhatsAppYouTubeBridge(f.options);
  await restarted.accept(f.message("public"));
  await restarted.tick();
  await restarted.notifyPending();
  assert.equal(replies.length, 2);
  assert.equal(f.sends.length, 0);
});

test("preserves visibility checks and never switches a bound stream", async (t) => {
  const f = await fixture(t);
  await f.bridge.accept({ ...f.message("wrong-group", "!say hello", TEST),
    getContact: async () => { throw new Error("Visibility guard must run before contact lookup"); },
  });
  assert.equal((await f.stored())[0].status, "ignored");
  await f.bridge.accept(f.message("old-stream"));
  f.setStream({ broadcastIds: ["new-fed", "new-zeon"], streamType: "public" });
  await f.bridge.tick();
  assert.equal(f.sends.length, 0);
  assert.equal((await f.stored())[1].status, "expired");
});

test("group and command guards run before stream lookup, contact access, or persistence", async (t) => {
  const f = await fixture(t, {
    getStreamState: () => { throw new Error("Unexpected stream lookup"); },
  });
  const guarded = { getContact: async () => { throw new Error("Unexpected contact lookup"); } };
  await f.bridge.accept({ ...f.message("other", "!say hello", "other@g.us"), ...guarded });
  for (const body of ["hello", "!other hello", "!Fed hello", "!sayhello"]) {
    await f.bridge.accept({ ...f.message("invalid", body), ...guarded });
  }
  await assert.rejects(readFile(f.bridge.file), { code: "ENOENT" });
  assert.equal(f.sends.length, 0);
});

test("the offline decision is taken on receipt, even if a stream starts during persistence", async (t) => {
  const f = await fixture(t);
  f.setStream({ broadcastIds: [], streamType: null });
  const accepting = f.bridge.accept(f.message());
  f.setStream({ broadcastIds: ["fed-video", "zeon-video"], streamType: "public" });
  await accepting;
  await f.bridge.tick();
  assert.equal((await f.stored())[0].status, "offline");
  assert.equal(f.sends.length, 0);
});

test("forwarding uses only pushname or 神秘人, never contact names or phone-number identifiers", async (t) => {
  const f = await fixture(t);
  const privateContact = { name: "85290000000", number: "85290000000", id: { _serialized: "85290000000@s.whatsapp.net" } };
  await f.bridge.accept({ ...f.message("tts"), author: privateContact.id._serialized,
    getContact: async () => privateContact,
  });
  await f.bridge.tick();
  await f.bridge.accept({ ...f.message("plain", "!zeon hello"),
    getContact: async () => ({ ...privateContact, pushname: "" }),
  });
  await f.bridge.tick();
  await f.bridge.accept({ ...f.message("named", "!gossip hello"),
    getContact: async () => ({ ...privateContact, pushname: "Lo~" }),
  });
  await f.bridge.tick();
  assert.deepEqual(f.sends, [
    ["fed-video", "!say hello !:神秘人"],
    ["zeon-video", "💬神秘人: hello"],
    ["fed-video", "!gossip hello !:Lo~"],
  ]);
  assert.ok(f.sends.every(([, text]) => !text.includes(privateContact.number)));
});

test("an active-stream retry waits while offline and can only resume its original broadcast", async (t) => {
  let attempts = 0;
  const f = await fixture(t, { send: async () => {
    if (++attempts === 1) throw new YouTubeDeliveryError("rate limit", { outcome: "retry" });
    return { id: "accepted" };
  } });
  await f.bridge.accept(f.message());
  await f.bridge.tick();
  f.advance(2000);
  f.setStream({ broadcastIds: [], streamType: null });
  const restarted = new WhatsAppYouTubeBridge(f.options);
  await restarted.tick();
  assert.equal(attempts, 1);
  f.setStream({ broadcastIds: ["fed-video", "zeon-video"], streamType: "public" });
  await restarted.tick();
  assert.equal(attempts, 2);
});

test("legacy commands saved without a target become offline replies instead of future posts", async (t) => {
  const f = await fixture(t);
  await f.bridge.accept(f.message());
  const records = await f.stored();
  records[0].videoId = null;
  await writeFile(f.bridge.file, JSON.stringify({ version: 1, records }));
  const restarted = new WhatsAppYouTubeBridge(f.options);
  await restarted.tick();
  const [record] = await f.stored();
  assert.equal(record.status, "offline");
  assert.ok(OFFLINE_RESPONSES.includes(record.offlineReply));
  assert.equal(f.sends.length, 0);
});

test("unlisted commands go to the test stream and unconfigured groups are ignored", async (t) => {
  const f = await fixture(t);
  f.setStream({ broadcastIds: ["fed-video", "zeon-video"], streamType: "unlisted" });
  await f.bridge.accept(f.message("unlisted", "!zeon hello", TEST));
  await f.bridge.accept(f.message("outsider", "!say hello", "outsider@g.us"));
  await f.bridge.tick();
  assert.deepEqual(f.sends, [["zeon-video", "💬Lo~: hello"]]);
  assert.equal((await f.stored()).length, 1);
});

test("a visibility change cannot forward a pending public command into an unlisted session", async (t) => {
  const f = await fixture(t);
  await f.bridge.accept(f.message());
  f.setStream({ broadcastIds: ["fed-video", "zeon-video"], streamType: "unlisted" });
  await f.bridge.tick();
  assert.equal(f.sends.length, 0);
  assert.equal((await f.stored())[0].status, "ignored");
});

test("does not submit before credentials are available", async (t) => {
  let ready = false;
  const f = await fixture(t, { canSend: () => ready });
  await f.bridge.accept(f.message());
  await f.bridge.tick();
  assert.equal(f.sends.length, 0);
  ready = true;
  await f.bridge.tick();
  assert.equal(f.sends.length, 1);
});

test("journal write failure rejects receipt and never inserts or marks it as saved", async (t) => {
  const f = await fixture(t);
  const save = f.bridge._save;
  f.bridge._save = async () => { throw new Error("disk full"); };
  await assert.rejects(f.bridge.accept(f.message()), /disk full/);
  assert.equal(f.bridge.records.length, 0);
  f.bridge._save = save;
  await f.bridge.accept(f.message());
  await f.bridge.tick();
  assert.equal(f.sends.length, 1);
});

test("failure to persist a submission result leaves inflight state and cannot cause a retry", async (t) => {
  const f = await fixture(t);
  await f.bridge.accept(f.message());
  const save = f.bridge._save.bind(f.bridge);
  f.bridge._save = async (records) => {
    if (records.some((record) => record.status === "submitted")) throw new Error("disk full");
    return save(records);
  };
  await assert.rejects(f.bridge.tick(), /disk full/);
  assert.equal((await f.stored())[0].status, "inflight");
  await f.bridge.tick();
  const restarted = new WhatsAppYouTubeBridge(f.options);
  await restarted.tick();
  assert.equal(f.sends.length, 1);
  assert.equal((await f.stored())[0].status, "uncertain");
});

test("a corrupted journal fails closed without overwriting pending work", async (t) => {
  const f = await fixture(t);
  await writeFile(f.bridge.file, "broken json");
  await assert.rejects(f.bridge.tick(), SyntaxError);
  assert.equal(await readFile(f.bridge.file, "utf8"), "broken json");
  assert.equal(f.sends.length, 0);
});

test("a content rejection sends one quoted WhatsApp warning, including across restart and redelivery", async (t) => {
  const notices = [];
  const f = await fixture(t, {
    send: async () => { throw new YouTubeDeliveryError("invalid text", {
      outcome: "rejected", reason: "messageTextInvalid",
    }); },
    notify: async (...args) => { notices.push(args); return { id: { _serialized: "notice-1" } }; },
  });
  const message = { ...f.message("blocked", "!say 自殺"), author: "sender@s.whatsapp.net" };
  await f.bridge.accept(message);
  await f.bridge.tick();
  await Promise.all([f.bridge.notifyPending(), f.bridge.notifyPending()]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0][0], PUBLIC);
  assert.match(notices[0][1], /可能被審核攔截/);
  assert.deepEqual(notices[0][2], { replyTo: "blocked", replyToSender: message.author });
  assert.equal((await f.stored())[0].notification.status, "sent");

  const restarted = new WhatsAppYouTubeBridge(f.options);
  await restarted.accept(message);
  await restarted.tick();
  await restarted.notifyPending();
  assert.equal(notices.length, 1);
});

test("an unobserved comment warns its original test group after 90 seconds without reposting", async (t) => {
  const notices = [];
  const f = await fixture(t, {
    notify: async (...args) => { notices.push(args); return { id: { _serialized: "notice" } }; },
  });
  f.setStream({ broadcastIds: ["fed-video", "zeon-video"], streamType: "unlisted" });
  await f.bridge.accept(f.message("test-command", "!say hello", TEST));
  await f.bridge.tick();
  f.advance(89999);
  await f.bridge.tick();
  await f.bridge.notifyPending();
  assert.equal(notices.length, 0);
  f.advance(1);
  await f.bridge.tick();
  await f.bridge.notifyPending();
  assert.equal(notices.length, 1);
  assert.equal(notices[0][0], TEST);
  assert.equal(notices[0][2].replyTo, "test-command");
  assert.match(notices[0][1], /可能被 YouTube 審核攔截/);
  assert.match(notices[0][1], /同步延遲/);
  assert.equal(f.sends.length, 1);
});

test("observing a comment before a pending warning is sent suppresses the warning", async (t) => {
  let notices = 0;
  const f = await fixture(t, { notify: async () => { notices += 1; } });
  await f.bridge.accept(f.message());
  await f.bridge.tick();
  f.advance(90000);
  await f.bridge.tick();
  await f.bridge.observe("yt-1");
  await f.bridge.notifyPending();
  assert.equal(notices, 0);
  assert.equal((await f.stored())[0].status, "observed");
});

test("quota and ended-chat rejections do not generate moderation warnings; forbidden mentions permissions", async (t) => {
  const notices = [];
  let reason;
  const f = await fixture(t, {
    send: async () => { throw new YouTubeDeliveryError(reason, { outcome: "rejected", reason }); },
    notify: async (...args) => { notices.push(args); return { id: { _serialized: "notice" } }; },
  });
  for (reason of ["quotaExceeded", "liveChatEnded", "liveChatDisabled", "forbidden"]) {
    await f.bridge.accept(f.message(reason));
    await f.bridge.tick();
    await f.bridge.notifyPending();
  }
  assert.equal(notices.length, 1);
  assert.match(notices[0][1], /可能涉及審核或發佈權限/);
  assert.equal(notices[0][2].replyTo, "forbidden");
});

test("warnings wait for WhatsApp to reconnect and slow delivery does not block YouTube work", async (t) => {
  let ready = false;
  let finishNotice;
  let beginNotice;
  const noticeStarted = new Promise((resolve) => { beginNotice = resolve; });
  const f = await fixture(t, {
    canNotify: () => ready,
    notify: () => new Promise((resolve) => { finishNotice = resolve; beginNotice(); }),
  });
  await f.bridge.accept(f.message());
  await f.bridge.tick();
  f.advance(90000);
  await f.bridge.tick();
  await f.bridge.notifyPending();
  assert.equal((await f.stored())[0].notification, undefined);
  ready = true;
  const notifying = f.bridge.notifyPending();
  await noticeStarted;
  await f.bridge.accept(f.message("next"));
  await f.bridge.tick();
  assert.equal(f.sends.length, 2);
  finishNotice({ id: { _serialized: "notice" } });
  await notifying;
});

test("old warnings expire, and old journals can still quote the original command ID", async (t) => {
  const notices = [];
  const f = await fixture(t, {
    notify: async (...args) => { notices.push(args); return { id: { _serialized: "notice" } }; },
  });
  await f.bridge.accept(f.message("old"));
  await f.bridge.tick();
  f.advance(600000);
  await f.bridge.tick();
  await f.bridge.notifyPending();
  assert.equal(notices.length, 0);
  assert.equal((await f.stored())[0].notification.status, "expired");

  await f.bridge.accept(f.message("legacy"));
  await f.bridge.tick();
  f.advance(90000);
  await f.bridge.tick();
  const records = await f.stored();
  delete records[1].whatsappMessageId;
  delete records[1].senderJid;
  await writeFile(f.bridge.file, JSON.stringify({ version: 1, records }));
  const restarted = new WhatsAppYouTubeBridge(f.options);
  await restarted.notifyPending();
  assert.equal(notices.length, 1);
  assert.equal(notices[0][2].replyTo, "legacy");
});

test("ambiguous notification failures and interrupted notices are not repeated after restart", async (t) => {
  let attempts = 0;
  const f = await fixture(t, {
    notify: async () => { attempts += 1; throw new Error("connection lost after send"); },
  });
  await f.bridge.accept(f.message());
  await f.bridge.tick();
  f.advance(90000);
  await f.bridge.tick();
  await f.bridge.notifyPending();
  assert.equal((await f.stored())[0].notification.status, "uncertain");
  const restarted = new WhatsAppYouTubeBridge(f.options);
  await restarted.notifyPending();
  assert.equal(attempts, 1);

  const records = await f.stored();
  records[0].notification.status = "sending";
  await writeFile(f.bridge.file, JSON.stringify({ version: 1, records }));
  const interrupted = new WhatsAppYouTubeBridge(f.options);
  await interrupted.notifyPending();
  assert.equal(attempts, 1);
  assert.equal((await f.stored())[0].notification.status, "uncertain");
});

test("notification persistence failures cannot cause duplicate warnings", async (t) => {
  let attempts = 0;
  const f = await fixture(t, { notify: async () => {
    attempts += 1;
    return { id: { _serialized: "notice" } };
  } });
  await f.bridge.accept(f.message());
  await f.bridge.tick();
  f.advance(90000);
  await f.bridge.tick();
  const save = f.bridge._save.bind(f.bridge);
  f.bridge._save = async () => { throw new Error("disk full"); };
  await assert.rejects(f.bridge.notifyPending(), /disk full/);
  assert.equal(attempts, 0);
  f.bridge._save = async (records) => {
    if (records[0].notification?.status === "sent") throw new Error("disk full");
    return save(records);
  };
  await assert.rejects(f.bridge.notifyPending(), /disk full/);
  assert.equal(attempts, 1);
  assert.equal((await f.stored())[0].notification.status, "sending");
  const restarted = new WhatsAppYouTubeBridge(f.options);
  await restarted.notifyPending();
  assert.equal(attempts, 1);
});
