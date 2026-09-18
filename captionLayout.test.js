import test from "node:test";
import assert from "node:assert/strict";
import { paginateCaption } from "./captionLayout.js";

const graphemes = new Intl.Segmenter("zh-Hant", { granularity: "grapheme" });
const measure = (text) => Array.from(graphemes.segment(text)).length;
const compact = (text) => text.replace(/\s/gu, "");

test("long captions keep all text, fit the width, and use at most two lines per page", () => {
  for (const text of [
    "唔響應夜賓分,睇死中秋無人流,黨鐵陽捧陰違",
    "宇宙世紀標準時間，而家係 凌晨一點正，聯邦 25勝，自護 77勝。報時訊號由 飛藝洋服 贊助播出",
    "Hello everybody, welcome to tonight's game!",
    "averylongunbrokenwordthatmustwrap",
    "這是一段完全沒有標點但是仍然需要換行分頁的廣東話留言",
    "第一行\n第二行\n第三行",
    "家庭👨‍👩‍👧‍👦支持🇭🇰選手👍🏽！大家繼續加油！",
  ]) {
    const pages = paginateCaption(text, measure, 10);
    assert.equal(compact(pages.flat().join("")), compact(text));
    assert.ok(pages.every(page => page.length <= 2));
    assert.ok(pages.flat().every(line => measure(line) <= 10));
  }
});

test("phrase boundaries and short captions remain readable", () => {
  assert.deepEqual(paginateCaption("一比一和波，唔洗救", measure, 8), [["一比一和波，", "唔洗救"]]);
  assert.deepEqual(paginateCaption("六六無窮", measure, 10), [["六六無窮"]]);
  assert.deepEqual(paginateCaption("hello world", measure, 8), [["hello", "world"]]);
  assert.deepEqual(paginateCaption("1234567890，下一句", measure, 10), [["123456789", "0，下一句"]]);
});

test("Unicode graphemes survive wrapping and empty input terminates", () => {
  assert.deepEqual(paginateCaption("👨‍👩‍👧‍👦🇭🇰👍🏽", measure, 1), [["👨‍👩‍👧‍👦", "🇭🇰"], ["👍🏽"]]);
  assert.deepEqual(paginateCaption(" \n ", measure, 10), [[""]]);
});
