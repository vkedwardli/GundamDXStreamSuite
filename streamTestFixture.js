import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { withTimeout } from "./shutdown.js";

export async function fixture(options = {}) {
  const calls = [], events = [], idleCallbacks = [], startOptions = [];
  const noop = () => {};
  let streamState;
  class Clock extends Date { getHours() { return 1; } }
  const client = new EventEmitter();
  Object.assign(client, { storeDir: "/unused", ready: true, setMessageHandler: noop, setShutdownHandler: noop });
  const values = {
    scheduler: { wait: options.wait || (async () => {}) }, schedule: { scheduleJob: noop }, path,
    WhatsAppYouTubeBridge: class { constructor(config) { streamState = config.getStreamState; } },
    createFusionCommandHandler: () => noop,
    Faction: { FEDERATION: { value: "fed" }, ZEON: { value: "zeon" } },
    Megaphone: { ENABLED: { enabled: true } }, TTSModel: {}, client,
    internalEvents: new EventEmitter(), installShutdownHandlers: noop,
    withTimeout: (operation, ms, description) => withTimeout(operation, 20, description),
    IsLiveStreaming: async () => options.state === true,
    getOBSStreamingState: async () => options.state ?? null,
    launchOBS: async () => { calls.push("launch"); return options.launch ? options.launch() : true; },
    checkLiveStreams: async () => { calls.push("find-broadcasts"); return ["fed", "zeon"]; },
    createScheduledLiveStream: async () => { throw new Error("Recovery must never create broadcasts"); },
    hideZDXPopup: async () => {},
    startOBSStreamingAndRecognition: async (idle, isPublic, isCurrent, config) => {
      calls.push("start-ocr"); idleCallbacks.push(idle); startOptions.push({ isPublic, config });
      return options.startOBS ? options.startOBS(isCurrent) : true;
    },
    startOverlay: () => { calls.push("start-overlay"); },
    startLiveChatAndViewerCount: () => { calls.push("start-chat"); },
    stopLiveChatAndViewerCount: () => {
      calls.push("stop-chat");
      if (options.failChat) throw new Error("chat stop failed");
    },
    clearLiveChatCache: () => { calls.push("clear-cache"); },
    stopOverlay: () => { calls.push("stop-overlay"); },
    stopOBSStreamingAndRecognition: async () => {
      calls.push("stop-obs-ocr");
      if (options.failOBS) throw new Error("OBS stop failed");
      return { streamStopped: options.streamStopped ?? false, recognitionStopped: options.recognitionStopped ?? true };
    },
    closeOBS: async () => {
      calls.push("close-obs");
      if (options.close) return options.close();
      return options.closed ?? true;
    },
    sendLiveChatMessage: async () => { calls.push("farewell-comment"); },
    textToSpeech: async () => {
      calls.push("speech");
      if (options.speech) return options.speech();
    },
  };
  const source = await readFile(new URL("./index.js", import.meta.url), "utf8");
  const globals = {};
  for (const match of source.replace(/\/\/[^\n]*/g, "").matchAll(/import\s+(\{[^}]*\}|\w+)\s+from\s+"([^"]+)"/g)) {
    const names = match[1].startsWith("{")
      ? match[1].slice(1, -1).split(",").map(name => name.trim()).filter(Boolean)
      : [match[1]];
    for (const name of names) {
      const [exported, alias = exported] = name.split(/\s+as\s+/);
      globals[alias] = values[exported] ?? noop;
    }
  }
  // Execute the real orchestration with injected services. A Script avoids
  // experimental SourceTextModule's native crashes in Node 22's test children.
  const context = vm.createContext({ ...globals, Date: Clock,
    console: { log: noop, error: noop }, setTimeout });
  const script = source.slice(0, source.indexOf("main().catch"))
    .replace(/import\s+(\{[^}]*\}|\w+)\s+from\s+"[^"]+";/g, "") +
    "\n({ startStreaming, stopStreaming, restartStreaming, handleClientConnection });";
  const service = new vm.Script(script, { filename: "index.js" }).runInContext(context);
  const io = { emit: (name, payload) => events.push({ name, payload }) };
  return { calls, events, streamState, idleCallbacks, startOptions,
    connect: socket => service.handleClientConnection(socket, io),
    start: (isPublic = true) => service.startStreaming({ isPublic, io }),
    stop: () => service.stopStreaming(io),
    restart: () => service.restartStreaming(io) };
}
