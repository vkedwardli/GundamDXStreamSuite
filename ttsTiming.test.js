import test from "node:test";
import assert from "node:assert/strict";
import { parseSrt, captionPageTimes } from "./ttsTiming.js";

test("SRT accepts CRLF, sentence text, and overlapping cues; ignores invalid blocks", () => {
  assert.deepEqual(parseSrt("1\r\n00:00:00,100 --> 00:00:01,500\r\n第一句\r\n\r\n2\r\n00:00:01,400 --> 00:00:02,600\r\n第二句\r\n\r\nbad block"), [
    { startMs: 100, endMs: 1500, text: "第一句" },
    { startMs: 1400, endMs: 2600, text: "第二句" },
  ]);
  assert.deepEqual(parseSrt("1\n00:00:02,000 --> 00:00:01,000\ninvalid"), []);
});

test("page changes follow sentence timing, including silence between sentences", () => {
  assert.deepEqual(captionPageTimes([["甲乙"], ["丙丁"]], [
    { startMs: 100, endMs: 1000, text: "甲乙。" },
    { startMs: 2000, endMs: 4000, text: "丙丁。" },
  ], 4200), [0, 2000]);
  assert.deepEqual(captionPageTimes([["甲乙"], ["丙丁"]], [
    { startMs: 100, endMs: 4100, text: "甲乙丙丁" },
  ], 4200), [0, 2100]);
});

test("missing or overlapping timing remains ordered and inside the audio duration", () => {
  const pages = [["甲"], ["乙"], ["丙"], ["丁"]];
  assert.deepEqual(captionPageTimes(pages, [], 4000), [0, 1000, 2000, 3000]);
  const times = captionPageTimes(pages, [
    { startMs: 100, endMs: 2000, text: "甲乙" },
    { startMs: 800, endMs: 9000, text: "丙丁" },
  ], 4000);
  assert.ok(times.every((time, index) => time >= (times[index - 1] || 0) && time < 4000));
});
