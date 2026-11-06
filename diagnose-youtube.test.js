import assert from "node:assert/strict";
import test from "node:test";
import { inspectYouTubeChat } from "./diagnose-youtube.js";

test("diagnostic uses only read requests and compares the authorized channel to the stream", async () => {
  const youtube = {
    channels: { list: async (request) => {
      assert.equal(request.mine, true);
      return { data: { items: [{ id: "owner", snippet: { title: "Stream channel" } }] } };
    } },
    videos: { list: async (request) => {
      assert.equal(request.id, "PdYfjzdHR_g");
      return { data: { items: [{ id: request.id, snippet: { channelId: "owner" },
        liveStreamingDetails: { activeLiveChatId: "live-chat" },
      }] } };
    } },
  };
  const result = await inspectYouTubeChat(youtube, "PdYfjzdHR_g");
  assert.equal(result.authorizedChannelOwnsVideo, true);
  assert.equal(result.video.activeLiveChatId, "live-chat");
  assert.deepEqual(result.authorizedChannels, [{ id: "owner", title: "Stream channel" }]);
});

test("diagnostic reports partial failures without leaking the OAuth request", async () => {
  const result = await inspectYouTubeChat({
    channels: { list: async () => { throw Object.assign(new Error("invalid_grant"), {
      response: { status: 400, data: { error: "invalid_grant" } },
      config: { data: { refresh_token: "secret-token" } },
    }); } },
    videos: { list: async () => ({ data: { items: [] } }) },
  }, "PdYfjzdHR_g");
  assert.equal(result.channelLookupError.httpStatus, 400);
  assert.equal(result.channelLookupError.message, "invalid_grant");
  assert.equal(result.video, null);
  assert.equal(result.authorizedChannelOwnsVideo, undefined);
  assert.ok(!JSON.stringify(result).includes("secret-token"));
});
