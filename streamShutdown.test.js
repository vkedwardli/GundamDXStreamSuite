import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { fixture } from "./streamTestFixture.js";

for (const state of [false, null]) {
  test(`Stop always cleans local services when OBS state is ${state}`, async () => {
    const f = await fixture({ state });
    const result = await f.stop();
    assert.equal(result.complete, true);
    for (const step of ["stop-chat", "clear-cache", "stop-overlay", "stop-obs-ocr", "close-obs"]) {
      assert.ok(f.calls.includes(step), step);
    }
    assert.ok(!f.calls.includes("speech"));
    assert.equal(f.events.find(event => event.name === "isStreaming").payload.isStreaming, false);
  });
}

test("one failed cleanup cannot skip remaining cleanup or process close", async () => {
  for (const options of [{ failChat: true }, { failOBS: true }]) {
    const f = await fixture(options);
    const result = await f.stop();
    assert.equal(result.streamStopped, true);
    assert.equal(result.complete, false);
    assert.ok(f.calls.includes("clear-cache"));
    assert.ok(f.calls.includes("stop-overlay"));
    assert.ok(f.calls.includes("stop-obs-ocr"));
    assert.ok(f.calls.includes("close-obs"));
  }
});

test("an unconfirmed stop reports unknown, blocks starting, and allows retry", async () => {
  const options = { closed: false };
  const f = await fixture(options);
  assert.equal((await f.stop()).complete, false);
  const status = f.events.find(event => event.name === "isStreaming").payload;
  assert.equal(status.isStreaming, null);
  assert.equal(status.shutdownIncomplete, true);
  await f.start();
  assert.ok(!f.calls.includes("launch"));
  options.closed = true;
  assert.equal((await f.stop()).complete, true);
  const last = f.events.filter(event => event.name === "isStreaming").at(-1).payload;
  assert.equal(last.isStreaming, false);
  assert.equal(last.shutdownIncomplete, false);
});

test("a stopped stream with OBS still running reports incomplete process cleanup", async () => {
  const f = await fixture({ streamStopped: true, closed: false });
  const result = await f.stop();
  assert.equal(result.streamStopped, true);
  assert.equal(result.complete, false);
  const status = f.events.find(event => event.name === "isStreaming").payload;
  assert.equal(status.isStreaming, false);
  assert.equal(status.shutdownIncomplete, true);
});

test("repeated Stop requests share cleanup and await process exit before reporting success", async () => {
  let finishClose;
  const f = await fixture({ close: () => new Promise(resolve => { finishClose = resolve; }) });
  const first = f.stop();
  const second = f.stop();
  assert.equal(first, second);
  await new Promise(setImmediate);
  assert.equal(f.calls.filter(call => call === "stop-obs-ocr").length, 1);
  assert.ok(!f.events.some(event => event.name === "isStreaming"));
  await f.start();
  assert.ok(!f.calls.includes("launch"));
  finishClose(true);
  assert.equal((await first).complete, true);
});

test("a failed or stalled farewell cannot prevent shutdown", async () => {
  for (const speech of [async () => { throw new Error("speech failed"); }, () => new Promise(() => {})]) {
    const f = await fixture({ state: true, speech });
    assert.equal((await f.stop()).complete, true);
    assert.ok(f.calls.includes("speech"));
    assert.ok(f.calls.includes("stop-obs-ocr"));
    assert.ok(f.calls.includes("close-obs"));
  }
});

test("Stop cancels delayed chat startup and clears the WhatsApp bridge's active stream", async () => {
  let release;
  const f = await fixture({ wait: ms => ms === 15000 ? new Promise(resolve => { release = resolve; }) : Promise.resolve() });
  const starting = f.start();
  await new Promise(setImmediate);
  assert.equal(f.streamState().broadcastIds.length, 2);
  assert.ok(f.calls.includes("start-ocr"));
  assert.equal((await f.stop()).complete, true);
  assert.equal(f.streamState().broadcastIds.length, 0);
  assert.equal(f.streamState().streamType, null);
  release();
  await starting;
  assert.ok(!f.calls.includes("start-chat"));
});

test("control buttons allow retrying an incomplete shutdown and block Start", async () => {
  const html = await readFile(new URL("./control.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("function updateButtonStates"), html.indexOf("// Show confirmation dialog"));
  const buttons = { stopStreamingBtn: { disabled: true }, startPublicBtn: { disabled: false },
    startUnlistedBtn: { disabled: false } };
  vm.runInNewContext(source + "\nupdateButtonStates({ isStreaming: null, shutdownIncomplete: true });", buttons);
  assert.equal(buttons.stopStreamingBtn.disabled, false);
  assert.equal(buttons.startPublicBtn.disabled, true);
  assert.equal(buttons.startUnlistedBtn.disabled, true);
});
