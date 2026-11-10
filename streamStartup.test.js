// Run with node --experimental-vm-modules --test streamStartup.test.js
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { announceStreamLinks } from "./streamAnnouncements.js";

test("a stuck WhatsApp send cannot delay OCR, live chat, or streaming status", async () => {
  const calls = [];
  let finishSend;
  const noop = () => {};
  const faction = { FEDERATION: { value: "fed" }, ZEON: { value: "zeon" } };
  const client = new EventEmitter();
  Object.assign(client, { storeDir: "/unused", ready: true, setMessageHandler: noop, setShutdownHandler: noop });
  const values = {
    scheduler: { wait: async () => {} }, schedule: { scheduleJob: noop }, path,
    WhatsAppYouTubeBridge: class {}, createFusionCommandHandler: () => noop,
    Faction: faction, Megaphone: { ENABLED: {} }, TTSModel: {}, client,
    internalEvents: new EventEmitter(), installShutdownHandlers: noop,
    launchOBS: async () => true, checkLiveStreams: async () => [],
    createScheduledLiveStream: async ({ faction }) => ({ faction, broadcastId: faction.value }),
    updateVideoDetails: async () => {}, hideZDXPopup: async () => {},
    startOBSStreamingAndRecognition: async () => { calls.push("ocr"); },
    startLiveChatAndViewerCount: () => { calls.push("chat"); },
    announceStreamLinks,
    sendTextToDXGroup: () => { calls.push("send"); return new Promise(resolve => { finishSend = resolve; }); },
    WA_PUBLIC_GROUP_ID: "public", WA_TEST_GROUP_ID: "test",
  };
  const source = await readFile(new URL("./index.js", import.meta.url), "utf8");
  // Stub external services; execute the actual orchestration function.
  const imports = new Map();
  const uncommented = source.replace(/\/\/[^\n]*/g, "");
  for (const match of uncommented.matchAll(/import\s+(\{[^}]*\}|\w+)\s+from\s+"([^"]+)"/g)) {
    const names = match[1].startsWith("{")
      ? match[1].slice(1, -1).split(",").map(name => name.trim().split(/\s+as\s+/)[0]).filter(Boolean)
      : ["default"];
    imports.set(match[2], Object.fromEntries(names.map(name => [name,
      values[name === "default" ? match[1] : name] ?? noop])));
  }
  const context = vm.createContext({ console: { log: noop, error: noop }, setTimeout });
  const module = new vm.SourceTextModule(source.slice(0, source.indexOf("main().catch")) +
    "\nexport { startStreaming };", { context });
  await module.link(specifier => {
    const exports = imports.get(specifier);
    assert.ok(exports, specifier);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const started = module.namespace.startStreaming({ isPublic: true,
    io: { emit: event => { if (event === "isStreaming") calls.push("status"); } } });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["ocr", "status", "send", "chat"]);
  await started;
  client.ready = false;
  finishSend({});
});
