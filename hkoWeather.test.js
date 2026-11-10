import assert from "node:assert/strict";
import test from "node:test";
import { buildWeatherMessage } from "./hkoWeather.js";

const now = new Date("2026-11-10T02:00:00Z");
const reports = {
  difference: "日期時間,自動氣象站,差別\n202611101000,天文台,-2.1",
  current: { temperature: { recordTime: "2026-11-10T10:00:00+08:00", data: [{ place: "香港天文台", value: 23 }] } },
  forecast: { weatherForecast: [{ forecastDate: "20261110", forecastMintemp: { value: 20 },
    forecastMaxtemp: { value: 26 }, forecastWeather: "天晴乾燥。", PSR: "低" }] },
  visibility: { data: [["202611101000", "中環", "35 公里"], ["202611101000", "赤鱲角", "50 公里"]] },
  warnings: { WFIRE: { name: "火災危險警告", actionCode: "ISSUE" }, CANCELLED: { name: "已取消", actionCode: "CANCEL" } },
};
function fetcher(data) {
  return async url => {
    const key = url.includes(".csv") ? "difference" : url.includes("rhrread") ? "current"
      : url.includes("fnd") ? "forecast" : url.includes("LTMV") ? "visibility" : "warnings";
    if (data[key] instanceof Error) throw data[key];
    return { ok: true, text: async () => data[key], json: async () => data[key] };
  };
}
const logger = { error() {} };

test("formats the supplied Cantonese brief with today's HKO data and Central visibility", async () => {
  const message = await buildWeatherMessage({ now, fetchImpl: fetcher(reports), logger });
  for (const expected of ["11月10日", "凍咗2.1°C", "現時 23°C", "20–26°C", "顯著降雨概率：低", "火災危險警告", "中環能見度達 35 km"]) {
    assert.ok(message.includes(expected), expected);
  }
  assert.ok(!message.includes("已取消"));
});

test("missing optional APIs produce a useful partial report without invented values", async () => {
  const message = await buildWeatherMessage({ now, fetchImpl: fetcher({ ...reports,
    difference: new Error("offline"), visibility: new Error("offline"), warnings: new Error("offline") }), logger });
  assert.match(message, /暫時未有同尋日/);
  assert.match(message, /現時 23/);
  assert.ok(!message.includes("能見度"));
});

test("stale observations and another day's forecast cannot masquerade as current weather", async () => {
  await assert.rejects(buildWeatherMessage({ now: new Date("2026-11-11T02:00:00Z"), fetchImpl: fetcher(reports), logger }), /No usable current/);
});

test("total API outage fails instead of sending an empty weather announcement", async () => {
  await assert.rejects(buildWeatherMessage({ now, fetchImpl: async () => { throw new Error("offline"); }, logger }), /All primary/);
});
