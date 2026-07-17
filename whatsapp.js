import { spawn } from "node:child_process";
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import { WA_PUBLIC_GROUP_ID, WA_TEST_GROUP_ID } from "./config.js";

export { WA_PUBLIC_GROUP_ID, WA_TEST_GROUP_ID };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINIMUM_WACLI_VERSION = [0, 12, 0];
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const READY_WAIT_TIMEOUT_MS = 60 * 1000;
const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SEEN_MESSAGES = 5000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveStoreDir() {
  const configuredRoot = process.env.WACLI_STORE_DIR?.trim();
  const storeRoot = configuredRoot
    ? path.resolve(__dirname, configuredRoot)
    : path.join(__dirname, ".wacli");
  const clientId = process.env.WA_CLIENT_ID?.trim();

  if (!clientId) return storeRoot;

  const safeClientId = clientId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(storeRoot, `session-${safeClientId}`);
}

function parseVersion(value) {
  const match = String(value).match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function commandErrorMessage(binary, description, code, stderr) {
  const detail = stderr.trim();
  return [
    `${binary} ${description} failed${code == null ? "" : ` (exit ${code})`}.`,
    detail,
  ]
    .filter(Boolean)
    .join(" ");
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject, settled: false };
}

function settleDeferred(deferred, method, value) {
  if (!deferred || deferred.settled) return;
  deferred.settled = true;
  deferred[method](value);
}

function createLineReader(onLine) {
  let buffered = "";
  return {
    push(chunk) {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      lines.forEach((line) => onLine(line));
    },
    end() {
      if (buffered) onLine(buffered);
      buffered = "";
    },
  };
}

function canConnectToSocket(socketPath) {
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function jidToString(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  const user = value.User ?? value.user;
  const server = value.Server ?? value.server;
  if (!user || !server) return "";

  const device = Number(value.Device ?? value.device ?? 0);
  return `${user}${device > 0 ? `:${device}` : ""}@${server}`;
}

function chatFromWacli(chat) {
  const jid = chat?.jid ?? chat?.JID ?? "";
  const kind = chat?.kind ?? chat?.Kind ?? "";
  return {
    id: { _serialized: jid },
    name: chat?.name ?? chat?.Name ?? jid,
    isGroup: kind === "group" || jid.endsWith("@g.us"),
  };
}

export class WacliClient extends EventEmitter {
  constructor({
    binary = process.env.WACLI_BIN?.trim() || "wacli",
    storeDir = resolveStoreDir(),
    allowedGroupIds = [WA_PUBLIC_GROUP_ID, WA_TEST_GROUP_ID],
  } = {}) {
    super();
    this.binary = binary;
    this.storeDir = storeDir;
    this.version = null;
    this.ready = false;
    this.allowedGroupIds = new Set(
      allowedGroupIds
        .map((groupId) => groupId?.trim())
        .filter((groupId) => groupId?.endsWith("@g.us")),
    );

    this._initializing = null;
    this._syncLoopPromise = null;
    this._syncProcess = null;
    this._authProcess = null;
    this._webhookServer = null;
    this._webhookURL = null;
    this._webhookSecret = null;
    this._firstReady = null;
    this._destroying = false;
    this._seenMessages = new Map();
  }

  async initialize() {
    if (this.ready) return this;
    if (this._initializing) return this._initializing;

    this._destroying = false;
    const initializing = this._initialize();
    this._initializing = initializing;

    try {
      return await initializing;
    } catch (error) {
      if (this._initializing === initializing) this._initializing = null;
      throw error;
    }
  }

  async _initialize() {
    await this._verifyBinary();
    await this._ensureAuthenticated();
    await this._startWebhookServer();

    this._firstReady = createDeferred();
    this._syncLoopPromise = this._runSyncLoop(this._firstReady).catch((error) => {
      settleDeferred(this._firstReady, "reject", error);
      if (!this._destroying) this.emit("error", error);
    });

    await this._firstReady.promise;
    return this;
  }

  async _verifyBinary() {
    let result;
    try {
      result = await this._runCommand(["version"], {
        description: "version",
        includeStore: false,
        timeoutMs: 15000,
      });
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(
          `wacli was not found (${this.binary}). Install openclaw/wacli v0.12.0 or newer, or set WACLI_BIN to the executable path.`,
          { cause: error },
        );
      }
      throw error;
    }

    const parsed = parseVersion(result.stdout);
    if (!parsed) {
      throw new Error(`Could not parse wacli version output: ${result.stdout.trim()}`);
    }
    if (compareVersions(parsed, MINIMUM_WACLI_VERSION) < 0) {
      throw new Error(
        `wacli ${parsed.join(".")} is too old; v${MINIMUM_WACLI_VERSION.join(".")} or newer is required.`,
      );
    }
    this.version = parsed.join(".");
  }

  _baseArgs({ events = false, json = false, readOnly = false } = {}) {
    const args = ["--store", this.storeDir];
    if (events) args.push("--events");
    if (json) args.push("--json");
    if (readOnly) args.push("--read-only");
    return args;
  }

  _spawn(args, options = {}) {
    return spawn(this.binary, args, {
      windowsHide: true,
      stdio: [options.inheritStdin ? "inherit" : "ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        WACLI_DEVICE_LABEL:
          process.env.WACLI_DEVICE_LABEL || "GundamDXStreamSuite",
      },
    });
  }

  async _runCommand(
    commandArgs,
    {
      description = commandArgs[0] ?? "command",
      includeStore = true,
      json = false,
      readOnly = false,
      timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    } = {},
  ) {
    const args = includeStore
      ? [...this._baseArgs({ json, readOnly }), ...commandArgs]
      : commandArgs;

    return new Promise((resolve, reject) => {
      const child = this._spawn(args);
      let stdout = "";
      let stderr = "";
      let completed = false;

      const timeout = setTimeout(() => {
        const error = new Error(
          `${this.binary} ${description} timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
        );
        completed = true;
        child.kill("SIGTERM");
        reject(error);
      }, timeoutMs);
      timeout.unref?.();

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        if (code !== 0) {
          reject(
            new Error(
              commandErrorMessage(this.binary, description, code, stderr),
            ),
          );
          return;
        }
        if (stderr.trim()) console.warn(stderr.trim());
        resolve({ stdout, stderr });
      });
    });
  }

  async _runJSON(commandArgs, options = {}) {
    const result = await this._runCommand(commandArgs, {
      ...options,
      json: true,
    });

    let envelope;
    try {
      envelope = JSON.parse(result.stdout.trim());
    } catch (error) {
      throw new Error(
        `${this.binary} returned invalid JSON for ${options.description ?? commandArgs[0]}.`,
        { cause: error },
      );
    }

    if (!envelope?.success) {
      throw new Error(envelope?.error || `${this.binary} command failed.`);
    }
    return envelope.data;
  }

  async _authStatus() {
    return this._runJSON(["auth", "status"], {
      description: "auth status",
      readOnly: true,
      timeoutMs: 15000,
    });
  }

  async _ensureAuthenticated() {
    const status = await this._authStatus();
    if (status?.authenticated) {
      this.emit("authenticated");
      return;
    }

    await this._runAuthentication();
    const authenticatedStatus = await this._authStatus();
    if (!authenticatedStatus?.authenticated) {
      throw new Error("wacli authentication finished without a linked account.");
    }
    this.emit("authenticated");
  }

  async _runAuthentication() {
    const args = [
      ...this._baseArgs({ events: true }),
      "auth",
      "--idle-exit",
      process.env.WACLI_AUTH_IDLE_EXIT?.trim() || "8s",
    ];

    await new Promise((resolve, reject) => {
      const child = this._spawn(args, { inheritStdin: true });
      this._authProcess = child;
      let completed = false;
      let eventError = "";

      const eventLines = createLineReader((line) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.event === "qr_code" && event.data?.code) {
            this.emit("qr", event.data.code);
          } else if (event.event === "connected") {
            console.log("WhatsApp linked; finishing wacli bootstrap sync...");
          } else if (event.event === "history_sync") {
            console.log(
              `WhatsApp bootstrap history: ${event.data?.conversations ?? 0} conversations.`,
            );
          } else if (event.event === "warning") {
            console.warn(event.data?.message || line);
          } else if (event.event === "error") {
            eventError = event.data?.message || line;
          }
        } catch {
          console.error(line);
        }
      });

      child.stdout.on("data", (chunk) => process.stdout.write(chunk));
      child.stderr.on("data", (chunk) => eventLines.push(chunk));
      child.once("error", (error) => {
        if (completed) return;
        completed = true;
        this._authProcess = null;
        reject(error);
      });
      child.once("close", (code) => {
        eventLines.end();
        this._authProcess = null;
        if (completed) return;
        completed = true;
        if (code !== 0) {
          reject(
            new Error(
              eventError ||
                commandErrorMessage(this.binary, "auth", code, ""),
            ),
          );
          return;
        }
        resolve();
      });
    });
  }

  async _startWebhookServer() {
    if (this._webhookServer) return;

    this._webhookSecret = randomBytes(32).toString("hex");
    const webhookPath = `/wacli/${randomBytes(24).toString("hex")}`;
    const server = http.createServer((request, response) => {
      if (request.method !== "POST" || request.url !== webhookPath) {
        response.writeHead(404).end();
        return;
      }

      const chunks = [];
      let bodyLength = 0;
      let tooLarge = false;
      request.on("data", (chunk) => {
        bodyLength += chunk.length;
        if (bodyLength > MAX_WEBHOOK_BODY_BYTES) {
          tooLarge = true;
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (tooLarge) {
          response.writeHead(413).end();
          return;
        }

        const body = Buffer.concat(chunks);
        if (!this._validWebhookSignature(request, body)) {
          response.writeHead(401).end();
          return;
        }

        let payload;
        try {
          payload = JSON.parse(body.toString("utf8"));
        } catch {
          response.writeHead(400).end();
          return;
        }

        response.writeHead(204).end();
        setImmediate(() => this._handleWebhookMessage(payload));
      });
      request.on("error", (error) => this.emit("error", error));
    });

    server.on("error", (error) => this.emit("error", error));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });

    const address = server.address();
    this._webhookServer = server;
    this._webhookURL = `http://127.0.0.1:${address.port}${webhookPath}`;
  }

  _validWebhookSignature(request, body) {
    const received = request.headers["x-wacli-signature"];
    if (typeof received !== "string") return false;

    const expected = `sha256=${createHmac("sha256", this._webhookSecret)
      .update(body)
      .digest("hex")}`;
    const receivedBuffer = Buffer.from(received);
    const expectedBuffer = Buffer.from(expected);
    return (
      receivedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(receivedBuffer, expectedBuffer)
    );
  }

  _rememberMessage(key) {
    if (this._seenMessages.has(key)) return false;
    this._seenMessages.set(key, Date.now());
    if (this._seenMessages.size > MAX_SEEN_MESSAGES) {
      const oldest = this._seenMessages.keys().next().value;
      this._seenMessages.delete(oldest);
    }
    return true;
  }

  _handleWebhookMessage(payload) {
    const from = jidToString(payload?.Chat);
    const messageId = String(payload?.ID ?? "").trim();
    const senderJID = String(payload?.SenderJID ?? "").trim();

    if (
      !from ||
      !messageId ||
      !this.allowedGroupIds.has(from) ||
      payload?.FromMe ||
      payload?.Edited ||
      payload?.Revoked ||
      payload?.ReactionToID ||
      payload?.Call
    ) {
      return;
    }
    if (!this._rememberMessage(`${from}:${messageId}`)) return;

    const message = {
      id: { _serialized: messageId },
      from,
      fromMe: false,
      author: senderJID,
      body: String(payload?.Text ?? ""),
      timestamp: Math.floor(
        (Date.parse(payload?.Timestamp) || Date.now()) / 1000,
      ),
      hasMedia: Boolean(payload?.Media),
      type: payload?.Media?.Type || "chat",
      reply: (text) =>
        this.sendMessage(from, text, {
          replyTo: messageId,
          replyToSender: senderJID,
        }),
      getContact: async () => ({
        id: { _serialized: senderJID },
        pushname: payload?.PushName || undefined,
      }),
      getChat: () => this.getChatById(from),
    };

    this.emit("message", message);
  }

  _handleSyncEvent(event, state, firstReady) {
    switch (event.event) {
      case "connected":
        state.connected = true;
        state.connectionGeneration += 1;
        this._markReadyWhenSendDelegateAvailable(
          state,
          firstReady,
          state.connectionGeneration,
        );
        break;
      case "disconnected":
        state.connectionGeneration += 1;
        if (this.ready) {
          this.ready = false;
          this.emit("disconnected", "wacli disconnected");
        }
        break;
      case "stream_replaced":
        console.warn("WhatsApp stream was replaced; wacli is reconnecting.");
        break;
      case "stale":
        console.warn(
          `WhatsApp keepalive became stale (${event.data?.idle_duration ?? "unknown"}); reconnecting.`,
        );
        break;
      case "reconnecting":
        console.log("WhatsApp reconnecting...");
        break;
      case "warning":
        console.warn(event.data?.message || JSON.stringify(event));
        break;
      case "error":
        state.error = event.data?.message || "wacli sync failed";
        break;
      default:
        break;
    }
  }

  async _markReadyWhenSendDelegateAvailable(
    state,
    firstReady,
    connectionGeneration,
  ) {
    const delegatePath = path.join(this.storeDir, ".send.sock");

    while (
      state.active &&
      !this._destroying &&
      state.connectionGeneration === connectionGeneration
    ) {
      if (await canConnectToSocket(delegatePath)) {
        if (
          !state.active ||
          this._destroying ||
          state.connectionGeneration !== connectionGeneration
        ) {
          return;
        }
        if (!this.ready) {
          this.ready = true;
          this.emit("ready");
        }
        settleDeferred(firstReady, "resolve", this);
        return;
      }
      await delay(100);
    }
  }

  async _runSyncProcess(firstReady) {
    const args = [
      ...this._baseArgs({ events: true }),
      "sync",
      "--follow",
      "--max-reconnect",
      "0",
      "--stale-threshold",
      process.env.WACLI_STALE_THRESHOLD?.trim() || "2m",
      "--refresh-contacts",
      "--refresh-groups",
      "--webhook",
      this._webhookURL,
      "--webhook-secret",
      this._webhookSecret,
      "--webhook-allow-private",
    ];

    return new Promise((resolve) => {
      const state = {
        active: true,
        connected: false,
        connectionGeneration: 0,
        error: "",
      };
      const child = this._spawn(args);
      this._syncProcess = child;
      let completed = false;
      let stdout = "";

      const eventLines = createLineReader((line) => {
        if (!line.trim()) return;
        try {
          this._handleSyncEvent(JSON.parse(line), state, firstReady);
        } catch {
          console.error(line);
        }
      });

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => eventLines.push(chunk));
      child.once("error", (error) => {
        if (completed) return;
        completed = true;
        state.active = false;
        this._syncProcess = null;
        resolve({ error, connected: state.connected });
      });
      child.once("close", (code, signal) => {
        eventLines.end();
        if (completed) return;
        completed = true;
        state.active = false;
        this._syncProcess = null;
        if (stdout.trim()) console.log(stdout.trim());
        const error =
          code === 0
            ? null
            : new Error(
                state.error ||
                  `${this.binary} sync exited with ${signal || `code ${code}`}.`,
              );
        resolve({ error, connected: state.connected });
      });
    });
  }

  async _runSyncLoop(firstReady) {
    let restartDelayMs = 1000;

    while (!this._destroying) {
      const result = await this._runSyncProcess(firstReady);
      if (this._destroying) return;

      if (this.ready) {
        this.ready = false;
        this.emit("disconnected", result.error?.message || "wacli sync stopped");
      }

      if (result.error) {
        if (!result.connected && !firstReady.settled) {
          settleDeferred(firstReady, "reject", result.error);
          return;
        }
        this.emit("error", result.error);
      }

      const status = await this._authStatus().catch(() => null);
      if (!status?.authenticated) {
        const reason = "The wacli linked-device session is no longer authenticated.";
        this.emit("auth_failure", reason);
        await this._ensureAuthenticated();
      }

      await delay(restartDelayMs);
      restartDelayMs = result.connected
        ? 1000
        : Math.min(restartDelayMs * 2, 30000);
    }
  }

  async waitUntilReady(timeoutMs = READY_WAIT_TIMEOUT_MS) {
    await this.initialize();
    if (this.ready) return;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("WhatsApp did not reconnect before the send timeout."));
      }, timeoutMs);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off("ready", onReady);
      };
      this.on("ready", onReady);
      if (this.ready) onReady();
    });
  }

  _assertAllowedGroup(groupId) {
    const normalized = String(groupId ?? "").trim();
    if (!normalized.endsWith("@g.us")) {
      throw new Error("WhatsApp sends are restricted to configured group IDs.");
    }
    if (!this.allowedGroupIds.has(normalized)) {
      throw new Error(`WhatsApp group ${normalized} is not an allowed target.`);
    }
    return normalized;
  }

  async sendMessage(to, text, options = {}) {
    const groupId = this._assertAllowedGroup(to);
    if (text == null || String(text).length === 0) {
      throw new Error("A WhatsApp message is required.");
    }

    await this.waitUntilReady();
    const args = ["send", "text", "--to", groupId, "--message", String(text)];
    if (options.replyTo) args.push("--reply-to", String(options.replyTo));
    if (options.replyToSender) {
      args.push("--reply-to-sender", String(options.replyToSender));
    }

    const sent = await this._runJSON(args, { description: "send text" });
    if (!sent?.sent || !sent?.id) {
      throw new Error("wacli did not return a WhatsApp message ID.");
    }

    const message = {
      id: { _serialized: sent.id },
      ack: 1,
      fromMe: true,
      to: sent.to || groupId,
      body: String(text),
    };
    queueMicrotask(() => this.emit("message_ack", message, 1));
    return message;
  }

  async sendChatState(to, state) {
    const groupId = this._assertAllowedGroup(to);
    await this.waitUntilReady();
    const command = state === "typing" ? "typing" : "paused";
    return this._runJSON(["presence", command, "--to", groupId], {
      description: `presence ${command}`,
    });
  }

  // sync --follow manages global available/unavailable presence itself.
  async sendPresenceAvailable() {
    await this.waitUntilReady();
    return true;
  }

  async sendPresenceUnavailable() {
    return true;
  }

  async getChats() {
    await this.waitUntilReady();
    const chats = await this._runJSON(["chats", "list", "--limit", "100000"], {
      description: "list chats",
      readOnly: true,
    });
    return (Array.isArray(chats) ? chats : []).map(chatFromWacli);
  }

  async getChatById(chatId) {
    const chats = await this.getChats();
    return chats.find((chat) => chat.id._serialized === chatId) ?? null;
  }

  async destroy() {
    if (this._destroying) return;
    this._destroying = true;
    this.ready = false;
    settleDeferred(
      this._firstReady,
      "reject",
      new Error("WhatsApp client was closed before it became ready."),
    );

    const children = [this._authProcess, this._syncProcess].filter(Boolean);
    children.forEach((child) => child.kill("SIGINT"));
    if (this._syncLoopPromise) {
      await Promise.race([this._syncLoopPromise, delay(5000)]).catch(() => {});
    }
    children.forEach((child) => {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    });

    if (this._webhookServer) {
      await new Promise((resolve) => this._webhookServer.close(resolve));
      this._webhookServer = null;
    }
  }
}

export const client = new WacliClient();

client.on("auth_failure", (message) => {
  console.error("WhatsApp Auth Failure:", message);
});

client.on("authenticated", () => {
  console.log("WhatsApp Authenticated");
});

client.on("ready", () => {
  console.log("WhatsApp Client is ready!");
});

client.on("qr", (qr) => {
  console.log("Scan this QR code in WhatsApp > Settings > Linked Devices:");
  qrcode.generate(qr, { small: true });
});

client.on("disconnected", (reason) => {
  console.error("WhatsApp Client disconnected:", reason);
});

client.on("error", (error) => {
  console.error("WhatsApp Client Error:", error);
});

let clientReadyPromise = null;

function ensureClientReady() {
  if (!clientReadyPromise) {
    const currentPromise = client.initialize();
    clientReadyPromise = currentPromise;
    currentPromise.catch(() => {
      if (clientReadyPromise === currentPromise) clientReadyPromise = null;
    });
  }
  return clientReadyPromise;
}

if (process.env.WA_DISABLE_AUTO_START !== "1") {
  const readyWarning = setTimeout(() => {
    if (!client.ready) {
      console.error(
        "WARNING: WhatsApp client has not become ready after 60 seconds. Scan the QR code if shown, then check `wacli doctor --connect` if it remains offline.",
      );
    }
  }, 60000);
  readyWarning.unref?.();

  ensureClientReady()
    .then(() => clearTimeout(readyWarning))
    .catch((error) => {
      clearTimeout(readyWarning);
      console.error("Failed to initialize WhatsApp through wacli:", error);
    });
}

// Send a text message to the target group.
export async function sendTextToDXGroup(
  message,
  {
    withTyping = false,
    typingDurationMs = 1800,
    pauseAfterMs = 800,
    groupId = WA_PUBLIC_GROUP_ID,
  } = {},
) {
  try {
    await ensureClientReady();

    if (!groupId?.endsWith("@g.us")) {
      throw new Error(`Invalid WhatsApp group ID: ${groupId}`);
    }

    if (withTyping) {
      try {
        await client.sendChatState(groupId, "typing");
        await delay(typingDurationMs);
      } catch (error) {
        console.warn("Could not send WhatsApp typing state:", error.message);
      }
    }

    let sentMessage;
    try {
      sentMessage = await client.sendMessage(groupId, message, {
        sendSeen: false,
        waitUntilMsgSent: true,
      });
    } finally {
      if (withTyping) {
        try {
          await client.sendChatState(groupId, "stop");
        } catch (error) {
          console.warn("Could not clear WhatsApp typing state:", error.message);
        }
      }
    }

    if (pauseAfterMs > 0) await delay(pauseAfterMs);
    console.log("WhatsApp message sent");
    return sentMessage;
  } catch (error) {
    console.error(`Failed to send WhatsApp message to ${groupId}:`, error);
    return null;
  }
}

let isShuttingDown = false;

async function shutdown(exitCode) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try {
    await client.destroy();
  } catch (error) {
    console.error("Failed to close WhatsApp client cleanly:", error);
  }
  process.exit(exitCode);
}

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.once("SIGINT", () => {
  shutdown(130);
});

process.once("SIGTERM", () => {
  shutdown(143);
});
