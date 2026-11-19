import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import path from "node:path";
import { withTimeout } from "./shutdown.js";

// Mock OBS and process commands: never connect, stop a real stream, or kill OBS.
async function fixture(options = {}) {
  const calls = [], commands = [], errors = [], logs = [], scoreModes = [], waits = [];
  let clockMs = 0;
  class Clock extends Date { static now() { return clockMs; } }
  let running = options.running ?? true;
  let active = options.active ?? true;
  let cameraActive = options.cameraActive ?? false;
  class OBSWebSocket {
    identified = options.connected ?? false;
    async connect() {
      calls.push("connect");
      if (options.connect) await options.connect();
      this.identified = true;
    }
    async disconnect() {
      calls.push("disconnect");
      this.identified = false;
      if (options.disconnect) await options.disconnect();
    }
    async call(request) {
      calls.push(request);
      if (options.call) {
        const response = await options.call(request);
        if (response !== undefined) return response;
      }
      if (request === "GetStreamStatus") return { outputActive: active };
      if (request === "GetVirtualCamStatus") return { outputActive: cameraActive };
      if (request === "StopStream") active = false;
      if (request === "StartStream") active = true;
      if (request === "StopVirtualCam") cameraActive = false;
      if (request === "StartVirtualCam") cameraActive = true;
      return {};
    }
  }
  const imports = {
    "obs-websocket-js": { OBSWebSocket },
    child_process: { exec: (command, execOptions, callback) => {
      commands.push(command);
      assert.ok(execOptions.timeout > 0 && execOptions.timeout <= 10000);
      clockMs += options.commandDurationMs ?? 0;
      if (options.exec) return options.exec(command, callback);
      if (command.startsWith("tasklist")) {
        callback(null, running ? '"obs64.exe","123","Console","1","100 K"' : "INFO: No tasks are running.", "");
      } else {
        running = false;
        callback(null, "", "");
      }
    } },
    "node:timers/promises": { scheduler: { wait: async ms => {
      waits.push(ms);
      clockMs += ms;
      await options.wait?.(ms);
    } } },
    path: { default: path }, os: { default: { platform: () => "win32" } },
    "./config.js": { obsDir: "/unused", obsPath: "/unused/obs", OBS_PASSWORD: "test" },
    "./score.js": {
      startRecognizeBattleResults: async () => {
        calls.push("start-ocr");
        await options.startOCR?.();
      },
      prepareScoresForStream(resuming) { scoreModes.push(resuming); },
      stopRecognizeBattleResults: async () => {
        calls.push("stop-ocr");
        await options.stopOCR?.();
      },
    },
    "./serverSetup.js": { io: null },
    "./shutdown.js": { withTimeout: (operation, ms, label) =>
      withTimeout(operation, options.fastTimeout ? 10 : ms, label) },
  };
  const context = vm.createContext({ Date: Clock,
    console: { log: (...args) => logs.push(args.join(" ")), error: (...args) => errors.push(args.join(" ")) } });
  const module = new vm.SourceTextModule(await readFile(new URL("./obsService.js", import.meta.url), "utf8"), { context });
  await module.link(specifier => {
    const values = imports[specifier];
    assert.ok(values, specifier);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return { service: module.namespace, calls, commands, errors, logs, scoreModes, waits,
    elapsed: () => clockMs };
}

test("disconnected OBS is unknown; explicit stop reconnects, stops broadcasting, and cleans OCR", async () => {
  const f = await fixture();
  assert.equal(await f.service.getOBSStreamingState(), null);
  assert.equal(f.calls.length, 0);
  const result = await f.service.stopOBSStreamingAndRecognition();
  assert.equal(result.streamStopped, true);
  assert.equal(result.recognitionStopped, true);
  assert.equal(f.calls.filter(call => call === "connect").length, 1);
  assert.ok(f.calls.includes("StopStream"));
  assert.ok(f.calls.includes("StopVirtualCam"));
  assert.equal(f.calls[0], "stop-ocr", "local cleanup starts before remote work");
});

test("already-stopped OBS still cleans OCR and virtual camera", async () => {
  const f = await fixture({ connected: true, active: false });
  const result = await f.service.stopOBSStreamingAndRecognition();
  assert.equal(result.streamStopped, true);
  assert.equal(result.recognitionStopped, true);
  assert.ok(!f.calls.includes("StopStream"));
  assert.ok(f.calls.includes("StopVirtualCam"));
});

test("a rejected StopStream cannot prevent OCR and virtual camera cleanup", async () => {
  const f = await fixture({ connected: true, call: async request => {
    if (request === "StopStream") throw new Error("control connection lost");
  } });
  const result = await f.service.stopOBSStreamingAndRecognition();
  assert.equal(result.streamStopped, false);
  assert.equal(result.recognitionStopped, true);
  assert.ok(f.calls.includes("StopVirtualCam"));
});

test("a failed status query does not prevent an explicit StopStream request", async () => {
  let statuses = 0;
  const f = await fixture({ connected: true, call: async request => {
    if (request === "GetStreamStatus" && statuses++ === 0) throw new Error("status failed");
  } });
  assert.equal((await f.service.stopOBSStreamingAndRecognition()).streamStopped, true);
  assert.ok(f.calls.includes("StopStream"));
});

test("unreachable OBS and hung requests settle without blocking local cleanup", async () => {
  for (const options of [
    { connect: async () => { throw new Error("connection refused"); } },
    { connect: () => new Promise(() => {}), fastTimeout: true },
    { connected: true, call: request => request === "StopStream" ? new Promise(() => {}) : undefined,
      fastTimeout: true },
  ]) {
    const f = await fixture(options);
    const result = await f.service.stopOBSStreamingAndRecognition();
    assert.equal(result.streamStopped, false);
    assert.equal(result.recognitionStopped, true);
  }
});

test("OCR cleanup failure does not prevent stopping the stream", async () => {
  const f = await fixture({ connected: true, stopOCR: async () => { throw new Error("worker failed"); } });
  const result = await f.service.stopOBSStreamingAndRecognition();
  assert.equal(result.streamStopped, true);
  assert.equal(result.recognitionStopped, false);
});

test("simultaneous reconnect requests share one handshake", async () => {
  let release;
  const f = await fixture({ connect: () => new Promise(resolve => { release = resolve; }) });
  const first = f.service.obsConnect();
  const second = f.service.obsConnect();
  await new Promise(setImmediate);
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(f.calls.filter(call => call === "connect").length, 1);
});

test("closeOBS still closes the process after a disconnect failure and verifies exit", async () => {
  const f = await fixture({ connected: true, disconnect: async () => { throw new Error("socket failed"); } });
  assert.equal(await f.service.closeOBS(), true);
  assert.equal(f.commands.filter(command => command === "taskkill /im obs64.exe").length, 1);
  assert.equal(f.commands.filter(command => command.startsWith("tasklist")).length, 2);
});

test("closeOBS waits for the process command and does not claim success while OBS remains alive", async () => {
  let finishClose;
  const f = await fixture({ exec: (command, callback) => {
    if (command.startsWith("tasklist")) callback(null, '"obs64.exe","123"', "");
    else finishClose = callback;
  } });
  let settled = false;
  const closing = f.service.closeOBS().then(result => { settled = true; return result; });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  finishClose(new Error("Access denied"), "", "");
  assert.equal(await closing, false);
  assert.ok(f.errors.some(error => error.includes("exit was not confirmed")));
});

test("already-absent OBS is confirmed closed without running a kill command", async () => {
  const f = await fixture({ running: false });
  assert.equal(await f.service.closeOBS(), true);
  assert.equal(f.commands.length, 1);
});

test("a clean but slow OBS exit succeeds beyond the old two-second window", async () => {
  for (const exitAfterMs of [3500, 8500, 14000]) {
    let elapsed = 0, closeRequested = false;
    const f = await fixture({
      wait: ms => { elapsed += ms; },
      exec: (command, callback) => {
        if (command.startsWith("tasklist")) {
          callback(null, !closeRequested || elapsed < exitAfterMs
            ? '"obs64.exe","123","Console","1","100 K"' : "INFO: No tasks are running.", "");
        } else {
          closeRequested = true; // Window closes; process cleanup is still pending.
          callback(null, "SUCCESS: Sent termination signal to process 123.", "");
        }
      },
    });
    assert.equal(await f.service.closeOBS(), true);
    assert.ok(elapsed >= exitAfterMs && elapsed <= exitAfterMs + 500,
      "continue as soon as exit is observed, without a fixed 15-second delay");
    assert.equal(f.commands.filter(command => command === "taskkill /im obs64.exe").length, 1);
    assert.ok(f.logs.some(log => log.includes("PID(s): 123")));
    assert.ok(f.logs.some(log => log.includes("OBS process has exited")));
    assert.equal(f.errors.length, 0);
  }
});

test("a lingering OBS process still fails at the deadline and logs its PID", async () => {
  const f = await fixture({ exec: (command, callback) => {
    callback(null, command.startsWith("tasklist") ? '"obs64.exe","321"' : "SUCCESS", "");
  } });
  assert.equal(await f.service.closeOBS(), false);
  assert.equal(f.elapsed(), 15000);
  assert.ok(f.errors.some(error => error.includes("after 15.0s") && error.includes("321")));
  assert.ok(!f.commands.some(command => /\/f\b/i.test(command)), "do not force-kill a closing OBS");
});

test("slow process inspections count towards the exit deadline", async () => {
  const f = await fixture({ commandDurationMs: 2000, exec: (command, callback) => {
    callback(null, command.startsWith("tasklist") ? '"obs64.exe","321"' : "SUCCESS", "");
  } });
  assert.equal(await f.service.closeOBS(), false);
  // Initial inspection and close command take 4s before the 15s exit deadline.
  assert.equal(f.elapsed(), 19000);
  assert.ok(f.errors.some(error => error.includes("after 15.0s")));
});

test("a failed process query cannot be mistaken for a clean exit", async () => {
  let closeRequested = false;
  const f = await fixture({ exec: (command, callback) => {
    if (!command.startsWith("tasklist")) {
      closeRequested = true;
      callback(null, "SUCCESS", "");
    } else if (!closeRequested) {
      callback(null, '"obs64.exe","123"', "");
    } else {
      callback(new Error("tasklist timed out"), "", "");
    }
  } });
  assert.equal(await f.service.closeOBS(), false);
  assert.ok(f.errors.some(error => error.includes("tasklist timed out")));
  assert.ok(!f.logs.some(log => log.includes("OBS process has exited")));
});

test("an OCR startup completing after Stop is cleaned up again", async () => {
  let current = true;
  const f = await fixture({ connected: true, startOCR: async () => { current = false; } });
  await f.service.startOBSStreamingAndRecognition(() => {}, true, () => current);
  assert.ok(f.calls.includes("start-ocr"));
  assert.ok(f.calls.includes("stop-ocr"));
});

test("recovery starts and verifies stream and virtual camera before OCR, preserving scores", async () => {
  const f = await fixture({ connected: true, active: false });
  assert.equal(await f.service.startOBSStreamingAndRecognition(() => {}, true, () => true,
    { recovery: true }), true);
  assert.ok(f.calls.indexOf("StartStream") < f.calls.indexOf("StartVirtualCam"));
  assert.ok(f.calls.indexOf("GetVirtualCamStatus") < f.calls.indexOf("start-ocr"));
  assert.deepEqual(f.scoreModes, [true]);
});

test("recovery ensures virtual camera is active even if OBS automatically resumed streaming", async () => {
  for (const cameraActive of [true, false]) {
    const f = await fixture({ connected: true, active: true, cameraActive });
    assert.equal(await f.service.startOBSStreamingAndRecognition(() => {}, true, () => true,
      { recovery: true }), true);
    assert.ok(!f.calls.includes("StartStream"));
    assert.equal(f.calls.includes("StartVirtualCam"), !cameraActive);
  }
});

test("recovery does not report success or start OCR when an OBS output fails", async () => {
  for (const request of ["StartStream", "StartVirtualCam", "GetVirtualCamStatus"]) {
    const f = await fixture({ connected: true, active: false, call: async name => {
      if (name === request) throw new Error("output unavailable");
    } });
    assert.equal(await f.service.startOBSStreamingAndRecognition(() => {}, true, () => true,
      { recovery: true }), false);
    assert.ok(!f.calls.includes("start-ocr"));
    assert.ok(f.calls.includes("stop-ocr"));
  }
  const f = await fixture({ connected: true, active: false,
    call: request => request === "GetStreamStatus" ? { outputActive: false } : undefined });
  assert.equal(await f.service.startOBSStreamingAndRecognition(() => {}, true, () => true,
    { recovery: true }), false);
  assert.ok(!f.calls.includes("start-ocr"));
});

test("Stop waits for asynchronous OBS output shutdown before stopping the virtual camera", async () => {
  let stopping = false, polls = 0;
  const f = await fixture({ connected: true, call: request => {
    if (request === "StopStream") { stopping = true; return {}; }
    if (request === "GetStreamStatus") return { outputActive: !stopping || polls++ < 2 };
  } });
  assert.equal((await f.service.stopOBSStreamingAndRecognition()).streamStopped, true);
  assert.equal(polls, 3);
  assert.equal(f.calls.at(-1), "StopVirtualCam");
});
