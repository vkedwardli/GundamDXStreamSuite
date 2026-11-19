import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import vm from "node:vm";
import { withTimeout } from "./shutdown.js";

test("overlay shutdown awaits Windows taskkill, propagates failures, and permits retry", async () => {
  const child = new EventEmitter();
  child.pid = 123;
  let finish;
  let kills = 0;
  const imports = {
    "fs/promises": { default: {} }, path: { default: path, join: path.join },
    os: { default: { platform: () => "win32" } },
    child_process: {
      spawn: () => child,
      exec: (command, options, callback) => {
        assert.equal(command, "taskkill /pid 123 /f /t");
        assert.equal(options.timeout, 5000);
        kills++;
        finish = callback;
      },
    },
    util: { promisify }, "node:timers/promises": { scheduler: {} },
    "./config.js": { isDev: true }, "./shutdown.js": { withTimeout },
    "./chatService.js": { setupLiveChatForFaction() {}, startLiveChatAndViewerCount() {} },
  };
  const context = vm.createContext({ console: { log() {}, error() {} } });
  const module = new vm.SourceTextModule(await readFile(new URL("./systemUtils.js", import.meta.url), "utf8"), { context });
  await module.link(specifier => {
    const values = imports[specifier];
    assert.ok(values, specifier);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  module.namespace.startOverlay();
  let settled = false;
  const stopping = module.namespace.stopOverlay().finally(() => { settled = true; });
  assert.equal(settled, false);
  finish(new Error("Access denied"));
  await assert.rejects(stopping, /Access denied/);
  const retry = module.namespace.stopOverlay();
  assert.equal(kills, 2);
  finish(null, "", "");
  await retry;
  await module.namespace.stopOverlay();
  assert.equal(kills, 2);
});
