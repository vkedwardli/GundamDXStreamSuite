import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

// Stream the clip without buffering the whole file on the arcade PC. Byte
// ranges let the video decoder fetch metadata and media independently.
export async function serveVideoAsset(req, res, filePath) {
  try {
    const { size } = await stat(filePath);
    let start = 0;
    let end = size - 1;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      } else start = size;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
    }
    res.writeHead(range ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": size ? end - start + 1 : 0,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === "HEAD" || !size) {
      res.end();
      return;
    }
    const stream = createReadStream(filePath, { start, end });
    stream.on("error", (error) => res.destroy(error));
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    res.writeHead(error.code === "ENOENT" ? 404 : 500);
    res.end("Video unavailable");
  }
}
