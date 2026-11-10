import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installShutdownHandlers } from "./shutdown.js";

test("shutdown waits for WhatsApp after OCR stops, including repeated signals", async () => {
  const target = new EventEmitter();
  let release;
  let exits = 0;
  let cleanups = 0;
  const shutdown = installShutdownHandlers([
    async () => { cleanups++; },
    () => new Promise(resolve => { cleanups++; release = resolve; }),
  ], { target, exit: () => { exits++; } });
  target.emit("SIGINT");
  target.emit("SIGTERM");
  await new Promise(setImmediate);
  assert.equal(exits, 0);
  assert.equal(cleanups, 2);
  release();
  await shutdown(130);
  assert.equal(exits, 1);
});
