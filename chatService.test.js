// Run with node --experimental-vm-modules --test chatService.test.js.
// All external services are stubbed; these tests never send WhatsApp or play audio.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { createMessage } from "./messageService.js";

const startup = Date.parse("2026-11-17T22:23:00+08:00");
const source = await readFile(new URL("./chatService.js", import.meta.url), "utf8");

async function fixture(options = {}) {
  let now = startup;
  const sends = [], speech = [], messages = [], observed = [];
  class Clock extends Date { static now() { return now; } }
  class LiveChat extends EventEmitter {
    constructor({ liveId }) { super(); this.liveId = liveId; options.onReader?.(this); }
    async start() {
      await options.startReader?.(this);
      this.emit("start", this.liveId);
      return true;
    }
    stop() { options.onStopReader?.(this); this.emit("end"); }
  }
  const Faction = { FEDERATION: { value: "federation" }, ZEON: { value: "zeon" } };
  const megaphone = { enabled: true, icon: "🔊", gossip: "💁", anchor: "🎤" };
  const internalEvents = new EventEmitter();
  internalEvents.on("youtubeChatMessageObserved", id => observed.push(id));
  const imports = {
    "youtube-chat": { LiveChat },
    "node:timers/promises": { scheduler: { wait: options.wait || (async () => {}) } },
    "./config.js": { Faction, Megaphone: { ENABLED: megaphone },
      TTSModel: { AZURE_AI: "azure" }, MODERATION_FILTERS: {} },
    "./ttsService.js": { textToSpeech: value => speech.push(value) },
    "./youtubeService.js": { getViewerCount: options.getViewerCount || (async () => 0) },
    "./systemUtils.js": { getRandomDelay: () => 0 },
    "./messageService.js": { createMessage },
    "./serverSetup.js": { internalEvents },
    "./whatsapp.js": { sendTextToDXGroup: (...args) => sends.push(args),
      WA_PUBLIC_GROUP_ID: "public@g.us", WA_TEST_GROUP_ID: "test@g.us" },
  };
  const context = vm.createContext({ Date: Clock,
    console: { log() {}, error() {} }, setInterval: options.setInterval || setInterval, clearInterval });
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => {
    const values = imports[specifier];
    assert.ok(values, `Unexpected real import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const io = { emit: (event, message) => {
    if (event === "message") messages.push(message);
    options.onEmit?.(event, message);
  } };
  return { sends, speech, messages, observed,
    advance: value => { now = value; },
    start: (broadcastId = "fed-video", faction = Faction.FEDERATION) =>
      module.namespace.setupLiveChatForFaction({ broadcastId, faction, io }),
    startZeon: () => module.namespace.setupLiveChatForFaction({
      broadcastId: "zeon-video", faction: Faction.ZEON, io }),
    stop: () => module.namespace.stopLiveChatAndViewerCount(),
    startBoth: () => module.namespace.startLiveChatAndViewerCount({ broadcastIds: ["fed-video", "zeon-video"], io }),
    mute: enabled => module.namespace.updateMegaphoneState({ ...megaphone, enabled }),
  };
}

function chat(id, timestamp = startup + 60000, text = "!say 測試留言") {
  return { id, timestamp: String(timestamp * 1000),
    author: { name: "Test viewer", thumbnail: { url: "" } }, message: [{ text }] };
}

test("live comments forward and speak once; repeated polling still confirms the source ID", async () => {
  const f = await fixture();
  f.advance(startup + 60000);
  const reader = await f.start();
  const message = chat("new");
  reader.emit("chat", message);
  reader.emit("chat", message);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0][0], "🔵 Test viewer: 🔊 測試留言");
  assert.equal(f.speech.length, 1);
  assert.equal(f.speech[0].messageId, f.messages[0].id);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].tts, true);
  assert.deepEqual(f.observed, ["new", "new"]);
});

test("1:48 AM restart refreshes 30 old comments without resending or repeating speech", async () => {
  const f = await fixture();
  const original = await f.start();
  const history = Array.from({ length: 30 }, (_, i) =>
    chat(`old-${i}`, startup + 120000 + i * 1000, `!say Message ${i}`));
  for (const message of history) {
    f.advance(Number(message.timestamp) / 1000);
    original.emit("chat", message);
  }
  f.advance(Date.parse("2026-11-18T01:43:00+08:00"));
  original.emit("chat", chat("recent", Date.parse("2026-11-18T01:43:00+08:00"), "Recent comment"));
  assert.equal(f.sends.length, 31);
  assert.equal(f.speech.length, 30);
  f.advance(Date.parse("2026-11-18T01:48:00+08:00"));
  const restarted = await f.start();
  for (const message of history) restarted.emit("chat", message);
  assert.equal(f.messages.length, 61, "history still refreshes the HTML");
  assert.ok(f.messages.slice(31).every(message => message.tts === false));
  assert.equal(f.sends.length, 31, "no repeat WhatsApp sends");
  assert.equal(f.speech.length, 30, "no repeat TTS jobs");

  // An unseen comment from a polling gap must still be handled, even if older
  // than the new reader. Do not move the timestamp cutoff to every reconnect.
  restarted.emit("chat", chat("missed", Date.parse("2026-11-18T01:47:00+08:00")));
  assert.equal(f.sends.length, 32);
  assert.equal(f.speech.length, 31);
});

test("stop/start refreshes recent history but retains protection for WhatsApp and TTS", async () => {
  const f = await fixture();
  f.advance(startup + 60000);
  const first = await f.start();
  first.emit("chat", chat("recent"));
  f.stop();
  f.advance(startup + 120000);
  const second = await f.start();
  second.emit("chat", chat("recent"));
  assert.equal(f.messages.length, 2);
  assert.equal(f.messages[1].tts, false);
  assert.equal(f.sends.length, 1);
  assert.equal(f.speech.length, 1);
});

for (const [format, encode] of [
  ["microseconds", value => String(value * 1000)],
  ["milliseconds", value => value],
  ["ISO", value => new Date(value).toISOString()],
  ["Date", value => new Date(value)],
]) {
  test(`${format} timestamps allow old history in HTML without WhatsApp or TTS`, async () => {
    const f = await fixture();
    const reader = await f.start();
    reader.emit("chat", { ...chat("previous-session"), timestamp: encode(startup - 1000) });
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].timestamp.getTime(), startup - 1000);
    assert.equal(f.messages[0].tts, false);
    assert.equal(f.sends.length, 0);
    assert.equal(f.speech.length, 0);
    assert.deepEqual(f.observed, ["previous-session"]);
    f.advance(startup + 60000);
    reader.emit("chat", { ...chat("live"), timestamp: encode(startup + 60000) });
    assert.equal(f.sends.length, 1);
    assert.equal(f.speech.length, 1);
  });
}

test("source IDs distinguish identical comments and survive changed renderer metadata", async () => {
  const f = await fixture();
  f.advance(startup + 60000);
  const reader = await f.start();
  reader.emit("chat", chat("first"));
  reader.emit("chat", chat("second"));
  assert.equal(f.sends.length, 2, "distinct IDs are distinct comments even with equal text/time");
  const restarted = await f.start();
  restarted.emit("chat", chat("first", startup + 61000, "!say Updated renderer text"));
  assert.equal(f.messages.length, 3);
  assert.equal(f.messages[2].tts, false);
  assert.equal(f.sends.length, 2);
  assert.equal(f.speech.length, 2);
});

test("broadcasts have independent duplicate protection", async () => {
  const f = await fixture();
  f.advance(startup + 60000);
  const fed = await f.start();
  const zeon = await f.startZeon();
  fed.emit("chat", chat("same-id"));
  zeon.emit("chat", chat("same-id"));
  assert.equal(f.sends.length, 2);
  assert.ok(f.sends[0][0].startsWith("🔵"));
  assert.ok(f.sends[1][0].startsWith("🔴"));
  assert.equal(f.speech.length, 2);
});

test("comments without an ID use original text and timestamp to suppress replay", async () => {
  const f = await fixture();
  f.advance(startup + 60000);
  const first = await f.start();
  first.emit("chat", chat(undefined));
  f.stop();
  const second = await f.start();
  second.emit("chat", chat(undefined));
  assert.equal(f.messages.length, 2);
  assert.equal(f.messages[1].tts, false);
  assert.equal(f.sends.length, 1);
  assert.equal(f.speech.length, 1);
});

test("unmuting does not speak a previously handled muted comment", async () => {
  const f = await fixture();
  f.advance(startup + 60000);
  f.mute(false);
  const first = await f.start();
  first.emit("chat", chat("muted"));
  f.mute(true);
  f.stop();
  const second = await f.start();
  second.emit("chat", chat("muted"));
  assert.equal(f.sends.length, 1);
  assert.equal(f.speech.length, 0);
  assert.equal(f.messages[1].tts, false);
  second.emit("chat", chat("new"));
  assert.equal(f.sends.length, 2);
  assert.equal(f.speech.length, 1);
});

test("in-flight responses from replaced or stopped readers cannot trigger sends or speech", async () => {
  const f = await fixture();
  f.advance(startup + 60000);
  const previous = await f.start();
  const current = await f.start();
  previous.emit("chat", chat("late-old-reader"));
  f.stop();
  current.emit("chat", chat("late-stopped-reader"));
  assert.equal(f.sends.length, 0);
  assert.equal(f.speech.length, 0);
  assert.equal(f.messages.length, 0);
});

test("unverifiable timestamps can display but cannot trigger WhatsApp or TTS", async () => {
  const f = await fixture();
  const reader = await f.start();
  for (const timestamp of [undefined, "invalid"]) {
    reader.emit("chat", { ...chat(String(timestamp)), timestamp });
  }
  assert.equal(f.messages.length, 2);
  assert.ok(f.messages.every(message => message.tts === false));
  assert.equal(f.sends.length, 0);
  assert.equal(f.speech.length, 0);
});

test("Stop cancels a pending chat setup retry", async () => {
  let release;
  const readers = [];
  const f = await fixture({ onReader: reader => readers.push(reader),
    startReader: async () => { throw new Error("offline"); },
    wait: () => new Promise(resolve => { release = resolve; }) });
  const starting = f.startBoth();
  await new Promise(setImmediate);
  f.stop();
  release();
  await starting;
  assert.equal(readers.length, 2, "no new readers are created after Stop");
});

test("readers finishing startup after Stop are stopped again and cannot start viewer polling", async () => {
  const finish = [], stopped = [];
  let intervals = 0;
  const f = await fixture({ startReader: () => new Promise(resolve => finish.push(resolve)),
    onStopReader: reader => stopped.push(reader), setInterval: () => { intervals++; } });
  const starting = f.startBoth();
  f.stop();
  finish.forEach(resolve => resolve());
  await starting;
  assert.equal(stopped.length, 4, "both late readers are stopped again");
  assert.equal(intervals, 0);
});

test("viewer responses arriving after Stop cannot restore stale counts", async () => {
  const finish = [], counts = [];
  const f = await fixture({ getViewerCount: () => new Promise(resolve => finish.push(resolve)),
    setInterval: () => null,
    onEmit: (event, value) => { if (event === "totalviewers") counts.push(value); } });
  await f.startBoth();
  f.stop();
  finish.forEach(resolve => resolve(5));
  await new Promise(setImmediate);
  assert.deepEqual(counts, []);
});
