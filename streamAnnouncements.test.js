import assert from "node:assert/strict";
import test from "node:test";
import { announceStreamLinks } from "./streamAnnouncements.js";

const options = { broadcastIds: ["fed", "zeon"], groupId: "test", isCurrent: () => true,
  isReady: () => true, logger: { log() {}, error() {} } };

test("offline WhatsApp skips announcements without waiting for QR login", async () => {
  await announceStreamLinks({ ...options, isReady: () => false,
    send: () => assert.fail("must not wait on login") });
});

test("a changed stream or lost session prevents the second link", async () => {
  for (const guard of ["isCurrent", "isReady"]) {
    let allowed = true;
    const sent = [];
    await announceStreamLinks({ ...options, [guard]: () => allowed,
      send: async text => { sent.push(text); allowed = false; return {}; } });
    assert.deepEqual(sent, ["https://youtu.be/fed"]);
  }
});
