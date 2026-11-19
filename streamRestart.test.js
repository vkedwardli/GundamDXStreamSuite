import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { fixture } from "./streamTestFixture.js";

test("recovery restarts only OBS/OCR and preserves both broadcasts, chat, scores and stream type", async () => {
  for (const isPublic of [true, false]) {
    const f = await fixture({ state: true });
    await f.start(isPublic);
    const before = JSON.stringify(f.streamState());
    f.calls.length = 0;
    f.events.length = 0;
    assert.equal(await f.restart(), true);
    assert.deepEqual(f.calls, ["stop-obs-ocr", "close-obs", "launch", "start-ocr"]);
    assert.equal(JSON.stringify(f.streamState()), before);
    assert.equal(f.startOptions.at(-1).isPublic, isPublic);
    assert.equal(f.startOptions.at(-1).config.recovery, true);
    const status = f.events.filter(event => event.name === "isStreaming").at(-1).payload;
    assert.equal(status.isStreaming, true);
    assert.equal(status.restartIncomplete, false);
    assert.equal(status.restarting, false);
    // Recovery has no normal Stop cooldown: another recovery can run immediately.
    assert.equal(await f.restart(), true);
  }
});

test("simultaneous recovery requests coalesce and normal Start is locked", async () => {
  let finishClose;
  const f = await fixture({ state: true, close: () => new Promise(resolve => { finishClose = resolve; }) });
  await f.start();
  f.calls.length = 0;
  const first = f.restart();
  assert.equal(f.restart(), first);
  await new Promise(setImmediate);
  assert.equal(f.events.filter(event => event.name === "isStreaming").at(-1).payload.restarting, true);
  await f.start(false);
  assert.ok(!f.calls.includes("launch"));
  assert.equal(f.streamState().streamType, "public");
  finishClose(true);
  assert.equal(await first, true);
  assert.equal(f.calls.filter(call => call === "launch").length, 1);
});

test("a failed recovery keeps the original IDs and permits retry without creating broadcasts", async () => {
  for (const failure of ["close", "launch", "start", "ocr-stop"]) {
    const options = { state: true };
    const f = await fixture(options);
    await f.start();
    if (failure === "close") options.closed = false;
    if (failure === "launch") options.launch = async () => false;
    if (failure === "start") options.startOBS = async () => false;
    if (failure === "ocr-stop") options.recognitionStopped = false;
    f.calls.length = 0;
    assert.equal(await f.restart(), false);
    assert.equal(f.streamState().broadcastIds.length, 2);
    let status = f.events.filter(event => event.name === "isStreaming").at(-1).payload;
    assert.equal(status.restartIncomplete, true);
    assert.equal(status.canRestart, true);
    assert.equal(status.isStreaming, null);
    if (["close", "ocr-stop"].includes(failure)) assert.ok(!f.calls.includes("launch"));
    f.calls.length = 0;
    await f.start();
    assert.deepEqual(f.calls, []);
    // A partial restart can leave OBS stopped. Recovery must still be retryable.
    Object.assign(options, { state: false, closed: true, launch: async () => true,
      startOBS: async () => { options.state = true; return true; }, recognitionStopped: true });
    assert.equal(await f.restart(), true);
    assert.ok(!f.calls.includes("find-broadcasts"));
    status = f.events.filter(event => event.name === "isStreaming").at(-1).payload;
    assert.equal(status.restartIncomplete, false);
  }
});

test("recovery requires active OBS and both tracked broadcasts before stopping anything", async () => {
  const noSession = await fixture({ state: true });
  assert.equal(await noSession.restart(), false);
  assert.deepEqual(noSession.calls, []);
  for (const state of [false, null]) {
    const f = await fixture({ state });
    await f.start();
    f.calls.length = 0;
    assert.equal(await f.restart(), false);
    assert.deepEqual(f.calls, []);
  }
});

test("an OBS StopStream failure can recover once process exit is confirmed", async () => {
  const f = await fixture({ state: true, streamStopped: false, closed: true });
  await f.start();
  assert.equal(await f.restart(), true);
});

test("Stop during recovery cancels relaunch and performs full cleanup", async () => {
  let finishClose;
  const options = { state: true, close: () => new Promise(resolve => { finishClose = resolve; }) };
  const f = await fixture(options);
  await f.start();
  f.calls.length = 0;
  const recovering = f.restart();
  await new Promise(setImmediate);
  const stopping = f.stop();
  options.close = async () => true;
  finishClose(true);
  assert.equal(await recovering, false);
  assert.equal((await stopping).complete, true);
  assert.ok(!f.calls.includes("launch"));
  assert.ok(!f.calls.includes("start-ocr"));
  assert.ok(f.calls.includes("stop-chat"));
  assert.equal(f.streamState().broadcastIds.length, 0);
});

test("Stop waits for an in-flight OBS relaunch, then closes it without starting a stream", async () => {
  let finishLaunch;
  const options = { state: true };
  const f = await fixture(options);
  await f.start();
  f.calls.length = 0;
  options.launch = () => new Promise(resolve => { finishLaunch = resolve; });
  const recovering = f.restart();
  await new Promise(setImmediate);
  const stopping = f.stop();
  finishLaunch(true);
  assert.equal(await recovering, false);
  assert.equal((await stopping).complete, true);
  assert.ok(!f.calls.includes("start-ocr"));
  assert.equal(f.calls.filter(call => call === "close-obs").length, 2);
});

test("recovery waits for startup, retains its chat readers and invalidates the old idle callback", async () => {
  let releaseStartup;
  const f = await fixture({ state: true,
    wait: ms => ms === 15000 ? new Promise(resolve => { releaseStartup = resolve; }) : Promise.resolve() });
  const starting = f.start();
  await new Promise(setImmediate);
  const recovering = f.restart();
  await new Promise(setImmediate);
  assert.ok(!f.calls.includes("stop-obs-ocr"));
  releaseStartup();
  await starting;
  assert.equal(await recovering, true);
  assert.equal(f.calls.filter(call => call === "start-chat").length, 1);
  f.calls.length = 0;
  await f.idleCallbacks[0]();
  assert.deepEqual(f.calls, []);
  await f.idleCallbacks[1]();
  assert.ok(f.calls.includes("stop-chat"), "recovered OCR still has a working idle shutdown");
});

test("reconnected panels see the recovery lock and keep both QR URLs", async () => {
  let finishClose;
  const f = await fixture({ state: true, close: () => new Promise(resolve => { finishClose = resolve; }) });
  await f.start();
  const recovering = f.restart();
  await new Promise(setImmediate);
  const socket = new EventEmitter();
  socket.handshake = { auth: {} };
  const events = [];
  socket.on("isStreaming", payload => events.push(payload));
  socket.on("streamUrls", payload => events.push(payload));
  f.connect(socket);
  await new Promise(setImmediate);
  assert.equal(events[0].restarting, true);
  assert.equal(events[0].isStreaming, null);
  assert.equal(events[1].url1, "https://youtu.be/fed");
  finishClose(true);
  await recovering;
});

test("control panel locks stream buttons during recovery and offers retry after failure", async () => {
  const html = await readFile(new URL("./control.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("function updateButtonStates"), html.indexOf("// Show confirmation dialog"));
  const buttons = { stopStreamingBtn: {}, startPublicBtn: {}, startUnlistedBtn: {} };
  const context = vm.createContext(buttons);
  vm.runInContext(source + "\nupdateButtonStates({ restarting: true });", context);
  for (const button of [buttons.stopStreamingBtn, buttons.startPublicBtn, buttons.startUnlistedBtn]) {
    assert.equal(button.disabled, true);
  }
  vm.runInContext("updateButtonStates({ restartIncomplete: true, canRestart: true });", context);
  assert.equal(buttons.stopStreamingBtn.disabled, false);
  assert.equal(buttons.startPublicBtn.disabled, true);
  assert.equal(buttons.startUnlistedBtn.disabled, true);
  assert.equal(buttons.canRestartStream, true);
});

test("Stop dialog exposes 重開直播, emits one recovery request and keeps QR links", async () => {
  const html = await readFile(new URL("./control.html", import.meta.url), "utf8");
  const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, innerHTML: id, classList: { add() {}, remove() {} },
      listeners: {}, addEventListener(event, handler) { this.listeners[event] = handler; },
    });
    return elements.get(id);
  };
  const sends = [], handlers = {};
  const context = vm.createContext({
    io: () => ({ emit: name => sends.push(name), on: (name, handler) => { handlers[name] = handler; } }),
    document: { getElementById: element, addEventListener() {} },
  });
  vm.runInContext(source, context);
  handlers.isStreaming({ isStreaming: true, streamType: "public", canRestart: true });
  vm.runInContext("stopStreaming()", context);
  assert.equal(element("restartBtn").style.display, "inline-block");
  assert.equal(element("confirmBtn").textContent, "停播");
  sends.length = 0;
  element("restartBtn").listeners.click();
  element("restartBtn").listeners.click();
  assert.deepEqual(sends, ["restartStreaming"]);
  assert.equal(element("confirmDialog").style.display, "none");
  assert.equal(element("stopStreamingBtn").disabled, true);
  handlers.isStreaming({ isStreaming: null, restarting: true, streamType: "public" });
  assert.equal(element("qrCode1").innerHTML, "qrCode1");
  handlers.isStreaming({ isStreaming: null, restartIncomplete: true, canRestart: true, streamType: "public" });
  vm.runInContext("stopStreaming()", context);
  assert.equal(element("restartBtn").style.display, "inline-block");
  assert.equal(element("qrCode1").innerHTML, "qrCode1");
  vm.runInContext("hideConfirmDialog(); startUnlisted()", context);
  assert.equal(element("restartBtn").style.display, "none", "recovery is only offered in the Stop dialog");
});
