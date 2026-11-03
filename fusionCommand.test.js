import test from "node:test";
import assert from "node:assert/strict";
import { createFusionCommandHandler } from "./fusionCommand.js";
import { OFFLINE_RESPONSES, parseWhatsAppCommand } from "./whatsappYouTubeBridge.js";

function fixture({ busy = false, playback } = {}) {
  let stream = { broadcastIds: ["fed", "zeon"], streamType: "public" };
  let plays = 0;
  const replies = [];
  const now = 1800000000000;
  const handle = createFusionCommandHandler({
    publicGroupId: "public", testGroupId: "test", getStreamState: () => stream,
    isPlaybackBusy: () => busy,
    play: () => { plays++; return playback; }, now: () => now, random: () => 0,
  });
  return {
    handle, replies, get plays() { return plays; },
    setStream(value) { stream = value; },
    message: (overrides = {}) => ({ from: "public", body: "!fusion", timestamp: now / 1000,
      reply: async (text) => replies.push(text),
      getContact: () => { throw new Error("Local effects must not look up contacts"); }, ...overrides }),
  };
}

test("fusion plays locally for the matching public/unlisted group", async () => {
  const f = fixture();
  await f.handle(f.message());
  await f.handle(f.message({ from: "test" }));
  assert.equal(f.plays, 1);
  f.setStream({ broadcastIds: ["fed", "zeon"], streamType: "unlisted" });
  await f.handle(f.message());
  await f.handle(f.message({ from: "test", body: " ！FUSION " }));
  assert.equal(f.plays, 2);
  assert.deepEqual(f.replies, ["去片!", "去片!"]);
  assert.equal(parseWhatsAppCommand("!fusion"), null, "not forwarded to YouTube");
});

test("fusion replies immediately with the queue status before playback finishes", async () => {
  for (const busy of [false, true]) {
    const playback = Promise.withResolvers();
    const f = fixture({ busy, playback: playback.promise });
    const handled = f.handle(f.message());
    assert.equal(f.plays, 1);
    assert.deepEqual(f.replies, [busy ? "準備去片" : "去片!"]);
    playback.resolve();
    await handled;
    assert.equal(f.replies.length, 1, "no second reply after playback");
  }
});

test("fusion ignores other groups, own messages, arguments, ordinary text, and stale sync history", async () => {
  const f = fixture();
  for (const override of [{ from: "unknown" }, { fromMe: true },
    { body: "!fusion extra" }, { body: "!fusion2" }, { body: "say !fusion" },
    { body: "!say hello" }, { timestamp: f.message().timestamp - 31 }, { timestamp: undefined }]) {
    await f.handle(f.message(override));
  }
  assert.equal(f.plays, 0);
  assert.deepEqual(f.replies, []);
});

test("fusion keeps the offline joke before the stream-visibility guard", async () => {
  const f = fixture();
  f.setStream({ broadcastIds: [], streamType: "unlisted" });
  await f.handle(f.message());
  assert.equal(f.plays, 0);
  assert.deepEqual(f.replies, [OFFLINE_RESPONSES[0]]);
});
