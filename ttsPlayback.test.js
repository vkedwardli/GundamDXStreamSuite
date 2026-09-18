import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { playCaptionAudio } from "./ttsPlayback.js";

function player(platform = "win32") {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const calls = [], starts = [];
  const done = playCaptionAudio("C:/temp/中文 folder/speech.mp3", duration => starts.push(duration), {
    platform,
    spawnProcess: (...args) => { calls.push(args); return child; },
  });
  return { child, calls, starts, done };
}

test("Windows reports native playback start once, after a complete marker", async () => {
  const { child, calls, starts, done } = player();
  assert.equal(calls[0][0], "powershell.exe");
  assert.equal(calls[0][2].env.GDX_TTS_AUDIO_FILE, "C:/temp/中文 folder/speech.mp3");
  assert.ok(!calls[0][1].includes("C:/temp/中文 folder/speech.mp3"));
  assert.equal(calls[0][2].shell, undefined);
  child.stdout.emit("data", Buffer.from("GDX_TTS_STAR"));
  assert.deepEqual(starts, []);
  child.stdout.emit("data", Buffer.from("TED:2700\r\nGDX_TTS_STARTED:2700\n"));
  assert.deepEqual(starts, [2700]);
  child.emit("close", 0);
  await done;
});

test("mpv converts seconds to milliseconds and keeps paths as separate arguments", async () => {
  const { child, calls, starts, done } = player("darwin");
  assert.equal(calls[0][0], "mpv");
  assert.deepEqual(calls[0][1].slice(-2), ["--", "C:/temp/中文 folder/speech.mp3"]);
  child.stdout.emit("data", "GDX_TTS_STARTED:2.712\n");
  child.emit("close", 0);
  await done;
  assert.deepEqual(starts, [2712]);
});

test("missing start, process failure, and missing executable fail instead of claiming playback", async () => {
  for (const failure of ["no-start", "exit", "spawn"]) {
    const { child, starts, done } = player();
    const rejected = assert.rejects(done);
    if (failure === "spawn") {
      child.emit("error", new Error("ENOENT"));
      child.stdout.emit("data", "GDX_TTS_STARTED:2700\n");
      child.emit("close", -1);
    } else {
      child.stderr.emit("data", "cannot open audio");
      child.emit("close", failure === "exit" ? 1 : 0);
    }
    await rejected;
    assert.deepEqual(starts, []);
  }
});
