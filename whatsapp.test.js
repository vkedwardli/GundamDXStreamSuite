import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.WA_DISABLE_AUTO_START = "1";

const { WacliClient, isSendDelegateAvailable } = await import("./whatsapp.js");

const TEST_GROUP_ID = "120363000000000000@g.us";

function testClient() {
  return new WacliClient({
    binary: "unused",
    storeDir: "/unused",
    allowedGroupIds: [TEST_GROUP_ID],
  });
}

test("maps a wacli webhook to the existing whatsapp-web.js message shape", async () => {
  const client = testClient();
  let replyCall;
  client.sendMessage = async (...args) => {
    replyCall = args;
    return { id: { _serialized: "reply-id" } };
  };

  const received = once(client, "message");
  client._handleWebhookMessage({
    Chat: TEST_GROUP_ID,
    ID: "incoming-id",
    SenderJID: "85290000000@s.whatsapp.net",
    Timestamp: "2026-07-17T12:00:00Z",
    FromMe: false,
    Text: "!fed hello",
    PushName: "Tester",
  });

  const [message] = await received;
  assert.equal(message.from, TEST_GROUP_ID);
  assert.equal(message.body, "!fed hello");
  assert.equal(message.id._serialized, "incoming-id");
  assert.equal(message.timestamp, 1784289600);
  assert.deepEqual(await message.getContact(), {
    id: { _serialized: "85290000000@s.whatsapp.net" },
    pushname: "Tester",
  });

  await message.reply("pong");
  assert.deepEqual(replyCall, [
    TEST_GROUP_ID,
    "pong",
    {
      replyTo: "incoming-id",
      replyToSender: "85290000000@s.whatsapp.net",
    },
  ]);
});

test("does not re-emit outgoing, edited, revoked, or duplicate live events", () => {
  const client = testClient();
  let messages = 0;
  client.on("message", () => {
    messages += 1;
  });
  const base = {
    Chat: TEST_GROUP_ID,
    ID: "message-id",
    SenderJID: "85290000000@s.whatsapp.net",
    Text: "hello",
  };

  client._handleWebhookMessage({ ...base, FromMe: true });
  client._handleWebhookMessage({ ...base, ID: "edited", Edited: true });
  client._handleWebhookMessage({ ...base, ID: "revoked", Revoked: true });
  client._handleWebhookMessage({
    ...base,
    Chat: "120363999999999999@g.us",
    ID: "other-group",
  });
  client._handleWebhookMessage(base);
  client._handleWebhookMessage(base);
  assert.equal(messages, 1);
});

test("does not let a provisional empty event consume the completed text payload", () => {
  const client = testClient();
  const bodies = [];
  client.on("message", (message) => {
    bodies.push(message.body);
  });
  const base = {
    Chat: TEST_GROUP_ID,
    ID: "hydrated-message-id",
    SenderJID: "85290000000@s.whatsapp.net",
  };

  client._handleWebhookMessage({ ...base, Text: "" });
  client._handleWebhookMessage({ ...base, Text: "" });
  client._handleWebhookMessage({ ...base, Text: "!zeon 今日應該都有" });
  client._handleWebhookMessage({ ...base, Text: "!zeon 今日應該都有" });

  assert.deepEqual(bodies, ["!zeon 今日應該都有"]);
});

test("allows a media-only event to be enriched with text once", () => {
  const client = testClient();
  const bodies = [];
  client.on("message", (message) => {
    bodies.push(message.body);
  });
  const base = {
    Chat: TEST_GROUP_ID,
    ID: "media-message-id",
    SenderJID: "85290000000@s.whatsapp.net",
    Media: { Type: "image" },
  };

  client._handleWebhookMessage({ ...base, Text: "" });
  client._handleWebhookMessage({ ...base, Text: "!fed caption" });
  client._handleWebhookMessage({ ...base, Text: "!fed caption" });

  assert.deepEqual(bodies, ["", "!fed caption"]);
});

test("delegates sends and replies to wacli while preserving ACK shape", async () => {
  const client = testClient();
  client.waitUntilReady = async () => {};
  let command;
  client._runJSON = async (args) => {
    command = args;
    return {
      sent: true,
      to: TEST_GROUP_ID,
      id: "outgoing-id",
    };
  };

  const acknowledged = once(client, "message_ack");
  const message = await client.sendMessage(
    TEST_GROUP_ID,
    "hello",
    { replyTo: "quoted-id", replyToSender: "85290000000@s.whatsapp.net" },
  );
  const [ackMessage, ack] = await acknowledged;

  assert.deepEqual(command, [
    "send",
    "text",
    "--to",
    TEST_GROUP_ID,
    "--message",
    "hello",
    "--reply-to",
    "quoted-id",
    "--reply-to-sender",
    "85290000000@s.whatsapp.net",
  ]);
  assert.equal(message.id._serialized, "outgoing-id");
  assert.equal(message.ack, 1);
  assert.equal(ackMessage, message);
  assert.equal(ack, 1);
});

test("rejects direct recipients and unconfigured groups before invoking wacli", async () => {
  const client = testClient();
  client.waitUntilReady = async () => {
    throw new Error("wacli should not be reached");
  };

  await assert.rejects(
    client.sendMessage("85290000000@s.whatsapp.net", "hello"),
    /restricted to configured group IDs/,
  );
  await assert.rejects(
    client.sendMessage("120363999999999999@g.us", "hello"),
    /is not an allowed target/,
  );
});

test("retries a locked first stream announcement before sending the second link", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = testClient();
  let readinessChecks = 0;
  client.waitUntilReady = async () => { readinessChecks += 1; };
  const commands = [];
  const acknowledgements = [];
  client.on("message_ack", (message) => acknowledgements.push(message.body));
  client._runJSON = async (args) => {
    commands.push(args);
    if (commands.length <= 2) {
      throw new Error('wacli send text failed (exit 1). {"success":false,"error":"store is locked (another wacli is running?)"}');
    }
    return { sent: true, id: `message-${commands.length}` };
  };
  const links = ["https://youtu.be/federation", "https://youtu.be/zeon"];
  const sending = (async () => {
    for (const link of links) await client.sendMessage(TEST_GROUP_ID, link);
  })();

  await new Promise(setImmediate);
  assert.equal(commands.length, 1);
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.equal(commands.length, 2);
  t.mock.timers.tick(2000);
  await sending;

  assert.equal(commands.length, 4);
  assert.deepEqual(commands[0], commands[1]);
  assert.deepEqual(commands[1], commands[2]);
  assert.deepEqual(acknowledgements, links);
  assert.equal(readinessChecks, 4);
});

test("stops retrying persistent store locks and reports failure without an ACK", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = testClient();
  client.waitUntilReady = async () => {};
  let attempts = 0;
  let acknowledgements = 0;
  client.on("message_ack", () => { acknowledgements += 1; });
  client._runJSON = async () => {
    attempts += 1;
    throw new Error("store is locked (another wacli is running?)");
  };
  const rejected = assert.rejects(
    client.sendMessage(TEST_GROUP_ID, "stream link"),
    /store is locked/,
  );

  for (const retryDelay of [1000, 2000, 4000, 8000, 8000]) {
    await new Promise(setImmediate);
    t.mock.timers.tick(retryDelay);
  }
  await rejected;
  assert.equal(attempts, 6);
  assert.equal(acknowledgements, 0);
});

test("does not retry ambiguous send failures that could duplicate a delivered message", async () => {
  const client = testClient();
  client.waitUntilReady = async () => {};
  let attempts = 0;
  client._runJSON = async () => {
    attempts += 1;
    throw new Error("connection closed while waiting for acknowledgement");
  };

  await assert.rejects(
    client.sendMessage(TEST_GROUP_ID, "stream link"),
    /connection closed/,
  );
  assert.equal(attempts, 1);
});

test("shutdown cancels a pending store-lock retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = testClient();
  client.waitUntilReady = async () => {};
  let attempts = 0;
  client._runJSON = async () => {
    attempts += 1;
    throw new Error("store is locked");
  };
  const rejected = assert.rejects(
    client.sendMessage(TEST_GROUP_ID, "stream link"),
    /client was closed/,
  );

  await new Promise(setImmediate);
  await client.destroy();
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(attempts, 1);
});

test("restores ready state after a wacli disconnect and reconnect", async () => {
  const client = testClient();
  const state = {
    active: true,
    connected: false,
    connectionGeneration: 0,
    error: "",
  };
  let readinessChecks = 0;
  client._markReadyWhenSendDelegateAvailable = async (
    currentState,
    _firstReady,
    generation,
  ) => {
    readinessChecks += 1;
    if (currentState.connectionGeneration !== generation) return;
    client.ready = true;
    client.emit("ready");
  };

  const firstReady = once(client, "ready");
  client._handleSyncEvent({ event: "connected" }, state, null);
  await firstReady;
  assert.equal(client.ready, true);

  const disconnected = once(client, "disconnected");
  client._handleSyncEvent({ event: "disconnected" }, state, null);
  await disconnected;
  assert.equal(client.ready, false);

  const reconnected = once(client, "ready");
  client._handleSyncEvent({ event: "connected" }, state, null);
  await reconnected;
  assert.equal(client.ready, true);
  assert.equal(readinessChecks, 2);
});

test("recognizes a Windows wacli send delegate by its socket path", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wacli-windows-ready-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const delegatePath = path.join(directory, ".send.sock");

  assert.equal(await isSendDelegateAvailable(delegatePath, "win32"), false);
  await writeFile(delegatePath, "");
  assert.equal(await isSendDelegateAvailable(delegatePath, "win32"), true);
});

test("removes a stale Windows send delegate after wacli releases the store", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wacli-windows-stale-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const delegatePath = path.join(directory, ".send.sock");
  await writeFile(delegatePath, "");
  const client = new WacliClient({
    binary: "unused",
    storeDir: directory,
    platform: "win32",
    allowedGroupIds: [TEST_GROUP_ID],
  });

  const recovered = await client._recoverStaleWindowsDelegate(
    new Error(`${delegatePath} exists and is not a socket`),
  );

  assert.equal(recovered, true);
  assert.equal(await isSendDelegateAvailable(delegatePath, "win32"), false);
});

test("cleans up the Windows send delegate after client shutdown", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wacli-windows-stop-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const delegatePath = path.join(directory, ".send.sock");
  await writeFile(delegatePath, "");
  const client = new WacliClient({
    binary: "unused",
    storeDir: directory,
    platform: "win32",
    allowedGroupIds: [TEST_GROUP_ID],
  });

  assert.equal(await client._removeWindowsDelegateAfterShutdown(), true);
  assert.equal(await isSendDelegateAvailable(delegatePath, "win32"), false);
});

test("accepts only correctly signed localhost webhook payloads", async (t) => {
  const client = testClient();
  await client._startWebhookServer();
  t.after(() => client.destroy());

  const payload = Buffer.from(
    JSON.stringify({
      Chat: TEST_GROUP_ID,
      ID: "signed-id",
      SenderJID: "85290000000@s.whatsapp.net",
      FromMe: false,
      Text: "signed",
    }),
  );
  const signature = `sha256=${createHmac("sha256", client._webhookSecret)
    .update(payload)
    .digest("hex")}`;
  const received = once(client, "message");

  const statusCode = await postWebhook(client._webhookURL, payload, signature);
  const [message] = await received;
  assert.equal(statusCode, 204);
  assert.equal(message.body, "signed");

  const rejected = await postWebhook(client._webhookURL, payload, "sha256=bad");
  assert.equal(rejected, 401);
});

function postWebhook(url, body, signature) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
          "X-Wacli-Signature": signature,
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

test("webhook acknowledgement waits for durable receipt and failed receipts can be redelivered", async (t) => {
  const client = testClient();
  await client._startWebhookServer();
  t.after(() => client.destroy());
  const payload = Buffer.from(JSON.stringify({
    Chat: TEST_GROUP_ID, ID: "durable-id", Text: "!say hello",
    SenderJID: "sender@s.whatsapp.net",
  }));
  const signature = `sha256=${createHmac("sha256", client._webhookSecret).update(payload).digest("hex")}`;
  let emitted = 0;
  client.on("message", () => { emitted += 1; });
  client.setMessageHandler(async () => { throw new Error("disk full"); });
  assert.equal(await postWebhook(client._webhookURL, payload, signature), 503);
  assert.equal(emitted, 0);

  let persist;
  let started;
  const handlerStarted = new Promise((resolve) => { started = resolve; });
  client.setMessageHandler(() => new Promise((resolve) => {
    persist = resolve;
    started();
  }));
  let acknowledged = false;
  const posting = postWebhook(client._webhookURL, payload, signature).then((status) => {
    acknowledged = true;
    return status;
  });
  await handlerStarted;
  await new Promise(setImmediate);
  assert.equal(acknowledged, false);
  assert.equal(emitted, 0);
  persist();
  assert.equal(await posting, 204);
  assert.equal(emitted, 1);
});

test("initial sync network failures recover without an outgoing message", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = testClient();
  const errors = [];
  client.on("error", (error) => errors.push(error));
  client._authStatus = async () => ({ authenticated: true });
  let attempts = 0;
  const firstReady = { settled: false };
  client._runSyncProcess = async () => {
    if (++attempts === 1) return { connected: false, error: new Error("DNS lookup failed") };
    client._destroying = true; // End the simulated loop once a second connection is attempted.
    return { connected: true, error: null };
  };
  const syncing = client._runSyncLoop(firstReady);
  await new Promise(setImmediate);
  assert.equal(attempts, 1);
  t.mock.timers.tick(1000);
  await syncing;
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
  assert.equal(firstReady.settled, false);
});

test("send readiness timeout includes the initial connection wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = testClient();
  client.initialize = () => new Promise(() => {});
  const rejected = assert.rejects(client.waitUntilReady(1000), /send timeout/);
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(client.listenerCount("ready"), 0);
});
