import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { serveVideoAsset } from "./videoAsset.js";

test("video responses support full downloads, decoder byte ranges, HEAD, and missing files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fusion-video-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "clip.mp4");
  await writeFile(file, "0123456789");
  async function request({ range, method = "GET", filePath = file } = {}) {
    const response = new PassThrough();
    response.writeHead = (status, headers = {}) => { response.status = status; response.headers = headers; };
    const chunks = [];
    response.on("data", (chunk) => chunks.push(chunk));
    const done = finished(response);
    await serveVideoAsset({ headers: { range }, method }, response, filePath);
    await done;
    return { status: response.status, headers: response.headers, body: Buffer.concat(chunks).toString() };
  }
  const full = await request();
  assert.equal(full.status, 200);
  assert.equal(full.body, "0123456789");
  assert.equal(full.headers["Content-Type"], "video/mp4");
  assert.equal(full.headers["Accept-Ranges"], "bytes");
  for (const [range, contentRange, body] of [
    ["bytes=2-5", "bytes 2-5/10", "2345"],
    ["bytes=7-", "bytes 7-9/10", "789"],
    ["bytes=-3", "bytes 7-9/10", "789"],
    ["bytes=7-999", "bytes 7-9/10", "789"],
  ]) {
    const result = await request({ range });
    assert.equal(result.status, 206);
    assert.equal(result.headers["Content-Range"], contentRange);
    assert.equal(result.headers["Content-Length"], body.length);
    assert.equal(result.body, body);
  }
  const head = await request({ method: "HEAD" });
  assert.equal(head.body, "");
  assert.equal(head.headers["Content-Length"], 10);
  for (const range of ["bytes=20-", "bytes=5-2", "bytes=-0", "bytes=-", "bytes=0-1,3-5"]) {
    const result = await request({ range });
    assert.equal(result.status, 416);
    assert.equal(result.headers["Content-Range"], "bytes */10");
  }
  assert.equal((await request({ filePath: join(directory, "missing.mp4") })).status, 404);
});
