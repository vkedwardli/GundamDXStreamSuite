// Run with: node --experimental-vm-modules --test ttsService.test.js
// Isolate the service from OBS/WhatsApp/server startup and external TTS requests.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as util from "node:util";
import * as timing from "./ttsTiming.js";

async function fixture({ generationFailure, playbackFailure, missingSrt, minimaxFailure, onPlayback } = {}) {
  const events = [], downloads = [], plays = [], delays = [];
  const context = vm.createContext({
    Buffer,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => { delays.push(ms); queueMicrotask(fn); },
  });
  const execFile = (command, args, options, callback) => {
    (async () => {
      const file = flag => args[args.indexOf(flag) + 1];
      const audioPath = file("--write-media");
      downloads.push({ command, args, options, audioPath, text: await fs.readFile(file("--file"), "utf8") });
      // Include a partial download when simulating failure, to verify cleanup.
      await fs.writeFile(audioPath, "fake MP3");
      if (generationFailure) throw new Error("network unavailable");
      if (!missingSrt) await fs.writeFile(file("--write-subtitles"), "1\n00:00:00,100 --> 00:00:02,500\n測試語音\n");
    })().then(() => callback(null, "", ""), callback);
  };
  const imports = {
    util,
    child_process: { execFile },
    "fs/promises": { default: fs },
    path, os,
    axios: { default: { post: async () => ({ status: 200, data: {
      base_resp: { status_code: minimaxFailure ? 1 : 0 }, data: { audio: "010203" },
    } }) } },
    bottleneck: { default: class { wrap(fn) { return fn; } } },
    "./serverSetup.js": { io: { emit: (name, payload) => events.push({ name, ...payload }) } },
    "./config.js": { TTSModel: { AZURE_AI: "azure" }, MINIMAX_GROUP_ID: "test", MINIMAX_API_KEY: "test" },
    "./ttsTiming.js": timing,
    "./ttsPlayback.js": { playCaptionAudio: async (audioPath, onStarted) => {
      plays.push(audioPath);
      await fs.access(audioPath);
      if (playbackFailure) throw new Error("player failed");
      onStarted(2700);
      await onPlayback?.();
    } },
  };
  const module = new vm.SourceTextModule(await fs.readFile(new URL("./ttsService.js", import.meta.url), "utf8"), { context });
  await module.link(specifier => {
    const values = imports[specifier];
    assert.ok(values, `Unexpected real import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return { speak: module.namespace.textToSpeech, video: module.namespace.queueMonitorVideo,
    isBusy: module.namespace.isPlaybackBusy,
    events, downloads, plays, delays };
}

const speech = { text: '一行留言 "quote" $literal & symbols', model: "azure", voiceID: "zh-HK-HiuMaanNeural" };
const plain = value => JSON.parse(JSON.stringify(value));

test("one Edge request per job, correlated lifecycle, serial playback, and temp cleanup", async () => {
  const f = await fixture();
  await Promise.all([f.speak({ ...speech, messageId: "first" }), f.speak({ ...speech, messageId: "second" })]);
  assert.deepEqual(f.events.map(e => `${e.name}:${e.messageId}`), [
    "tts_preparing:first", "tts_started:first", "tts_finished:first",
    "tts_preparing:second", "tts_started:second", "tts_finished:second",
  ]);
  assert.equal(f.downloads.length, 2);
  assert.notEqual(f.downloads[0].audioPath, f.downloads[1].audioPath);
  for (const download of f.downloads) {
    assert.equal(download.command, "edge-tts");
    assert.equal(download.text, speech.text);
    assert.equal(download.options.shell, undefined);
    assert.equal(path.dirname(path.dirname(download.audioPath)), os.tmpdir());
    await assert.rejects(fs.access(path.dirname(download.audioPath)), { code: "ENOENT" });
  }
  const start = f.events.find(e => e.name === "tts_started");
  assert.equal(start.durationMs, 2700);
  assert.deepEqual(plain(start.cues), [{ startMs: 100, endMs: 2500, text: "測試語音" }]);
  assert.deepEqual(f.delays, [6000, 6000]);
});

test("generation/player failures report failure and remove all partial temp files", async () => {
  for (const options of [{ generationFailure: true }, { playbackFailure: true }]) {
    const f = await fixture(options);
    await f.speak({ ...speech, messageId: "failed" });
    assert.equal(f.events.at(-1).status, "failed");
    assert.ok(!f.events.some(e => e.name === "tts_started"));
    await assert.rejects(fs.access(path.dirname(f.downloads[0].audioPath)), { code: "ENOENT" });
  }
});

test("missing subtitles still play audio and standalone speech keeps the old gap", async () => {
  const f = await fixture({ missingSrt: true });
  await f.speak(speech);
  assert.deepEqual(plain(f.events.find(e => e.name === "tts_started").cues), []);
  assert.equal(f.events.at(-1).status, "finished");
  assert.deepEqual(f.delays, [1500]);
});

test("MiniMax also supplies correlated playback events without Edge subtitles", async () => {
  const f = await fixture();
  await f.speak({ ...speech, model: "minimax", messageId: "mini" });
  assert.equal(f.downloads.length, 0);
  assert.equal(f.events.at(-1).status, "finished");
  assert.deepEqual(plain(f.events.find(e => e.name === "tts_started").cues), []);
  await assert.rejects(fs.access(path.dirname(f.plays[0])), { code: "ENOENT" });
});

test("monitor video waits for speech, then holds subsequent speech and clips until it ends", async () => {
  const speechStarted = Promise.withResolvers();
  const finishSpeech = Promise.withResolvers();
  const videoStarted = Promise.withResolvers();
  const finishVideo = Promise.withResolvers();
  const order = [];
  const f = await fixture({ onPlayback: async () => {
    order.push("speech");
    speechStarted.resolve();
    await finishSpeech.promise;
  } });
  assert.equal(f.isBusy(), false);
  const drained = f.speak({ ...speech, messageId: "first" });
  assert.equal(f.isBusy(), true, "speech preparation blocks immediate playback");
  await speechStarted.promise;
  assert.equal(f.isBusy(), true, "active speech blocks immediate playback");
  await f.video(async () => {
    order.push("video");
    videoStarted.resolve();
    await finishVideo.promise;
  });
  await f.speak({ ...speech, messageId: "second" });
  await f.video(async () => { order.push("second video"); });
  assert.deepEqual(order, ["speech"]);
  finishSpeech.resolve();
  await videoStarted.promise;
  assert.equal(f.isBusy(), true, "active video and waiting jobs block immediate playback");
  assert.deepEqual(order, ["speech", "video"]);
  assert.equal(f.downloads.length, 1, "later speech is not prepared over the video");
  assert.equal(f.events.at(-1).name, "tts_finished", "video has no fake speech events");
  finishVideo.resolve();
  await drained;
  assert.deepEqual(order, ["speech", "video", "speech", "second video"]);
  assert.equal(f.isBusy(), false);
});

test("a missing/disconnected/failed monitor does not block the rest of the speech queue", async () => {
  const f = await fixture();
  const drained = f.video(async () => { throw new Error("Monitor did not acknowledge playback"); });
  await f.speak({ ...speech, messageId: "after-video-failure" });
  await drained;
  assert.equal(f.plays.length, 1);
  assert.equal(f.events.at(-1).messageId, "after-video-failure");
  assert.equal(f.events.at(-1).status, "finished");
});
