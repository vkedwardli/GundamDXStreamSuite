import assert from "node:assert/strict";
import test from "node:test";
import { createYouTubeChatSender } from "./youtubeChatDelivery.js";

function fixture({ lookupError, insertError, response = { data: { id: "comment-id" } }, video } = {}) {
  const requests = [];
  const youtube = {
    videos: { list: async (...args) => {
      requests.push(["lookup", ...args]);
      if (lookupError) throw lookupError;
      return { data: { items: video === null ? [] : [video || {
        liveStreamingDetails: { activeLiveChatId: "chat-id" },
      }] } };
    } },
    liveChatMessages: { insert: async (...args) => {
      requests.push(["insert", ...args]);
      if (insertError) throw insertError;
      return response;
    } },
  };
  return { sender: createYouTubeChatSender(youtube), requests };
}

function apiError(status, reason, headers = {}) {
  return Object.assign(new Error(reason || `HTTP ${status}`), {
    response: { status, headers, data: { error: { errors: reason ? [{ reason }] : [] } } },
  });
}

test("returns the accepted ID, preserves content, and disables automatic HTTP retries", async () => {
  const { sender, requests } = fixture();
  assert.deepEqual(await sender.send("video", "!say 自殺 !:Tester"), {
    id: "comment-id", liveChatId: "chat-id",
  });
  assert.equal(requests[1][1].resource.snippet.textMessageDetails.messageText, "!say 自殺 !:Tester");
  assert.deepEqual(requests.map((request) => request[2]), [
    { retry: false, timeout: 15000 }, { retry: false, timeout: 15000 },
  ]);
});

for (const [status, reason] of [
  [400, "messageTextInvalid"], [403, "forbidden"], [403, "liveChatDisabled"],
  [403, "liveChatEnded"], [404, "liveChatNotFound"], [403, "quotaExceeded"],
]) {
  test(`does not retry rejection ${reason}`, async () => {
    const { sender, requests } = fixture({ insertError: apiError(status, reason) });
    await assert.rejects(sender.send("video", "自殺"), (error) =>
      error.outcome === "rejected" && error.reason === reason);
    assert.equal(requests.filter(([type]) => type === "insert").length, 1);
  });
}

test("rate limiting is retryable and preserves Retry-After", async () => {
  const { sender } = fixture({ insertError: apiError(403, "rateLimitExceeded", { "retry-after": "12" }) });
  await assert.rejects(sender.send("video", "hello"), (error) =>
    error.outcome === "retry" && error.retryAfterMs === 12000);
});

for (const error of [apiError(500, "backendError"), apiError(503), apiError(408),
  Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
  Object.assign(new Error("reset"), { code: "ECONNRESET" })]) {
  test(`insertion ${error.message} has an uncertain outcome`, async () => {
    const { sender } = fixture({ insertError: error });
    await assert.rejects(sender.send("video", "hello"), { outcome: "uncertain" });
  });
}

test("lookup failures and connection establishment failures are safe to retry", async () => {
  const { sender, requests } = fixture({ lookupError: apiError(503) });
  await assert.rejects(sender.send("video", "hello"), { outcome: "retry" });
  assert.equal(requests.length, 1);
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]) {
    const next = fixture({ insertError: Object.assign(new Error(code), { code }) });
    await assert.rejects(next.sender.send("video", "hello"), { outcome: "retry" });
  }
});

test("missing comment ID is uncertain even with a successful HTTP response", async () => {
  const { sender } = fixture({ response: { data: {} } });
  await assert.rejects(sender.send("video", "hello"), { outcome: "uncertain" });
});

test("a not-yet-ready chat can retry, but a missing or ended stream cannot", async () => {
  const waiting = fixture({ video: { liveStreamingDetails: {} } });
  await assert.rejects(waiting.sender.send("video", "hello"), { outcome: "retry" });
  for (const video of [null, { liveStreamingDetails: { actualEndTime: "2026-09-17" } }]) {
    const ended = fixture({ video });
    await assert.rejects(ended.sender.send("video", "hello"), { outcome: "rejected" });
  }
});
