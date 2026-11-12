import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildWeatherMessage, nwsHeatIndexCelsius } from "./hkoWeather.js";

const now = new Date("2026-11-10T02:00:00Z");
const reports = {
  difference: "日期時間,自動氣象站,差別\n202611101000,天文台,-2.1",
  current: {
    temperature: { recordTime: "2026-11-10T10:00:00+08:00", data: [{ place: "香港天文台", value: 23 }] },
    humidity: { recordTime: "2026-11-10T10:00:00+08:00", data: [{ place: "香港天文台", value: 70 }] },
  },
  forecast: { weatherForecast: [{ forecastDate: "20261110", forecastMintemp: { value: 20 },
    forecastMaxtemp: { value: 26 }, forecastWeather: "天晴乾燥。", PSR: "低" }] },
  visibility: { data: [["202611101000", "中環", "35 公里"], ["202611101000", "赤鱲角", "50 公里"]] },
  warnings: { WFIRE: { name: "火災危險警告", actionCode: "ISSUE" }, CANCELLED: { name: "已取消", actionCode: "CANCEL" } },
};
function fetcher(data) {
  return async url => {
    const key = url.includes(".csv") ? "difference" : url.includes("rhrread") ? "current"
      : url.includes("fnd") ? "forecast" : url.includes("flw") ? "localForecast"
      : url.includes("LTMV") ? "visibility" : "warnings";
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
  assert.ok(message.includes("🌡️ 現時 23°C（天文台）\n🌡️ 體感溫度約 23.1°C\n📈"));
});

test("NWS heat index uses the mild-weather formula and regression with humidity adjustments", () => {
  const fahrenheit = celsius => celsius * 9 / 5 + 32;
  const celsius = f => (f - 32) * 5 / 9;
  const cases = [
    [73.4, 70, 73.565], // Simple estimate averaged with temperature, below 80 F.
    [90, 70, 105.9220206], // Full Rothfusz regression.
    [100, 10, 94.122482662], // Low humidity adjustment.
    [85, 90, 101.7808036], // High humidity adjustment.
  ];
  for (const [t, rh, expected] of cases) {
    assert.ok(Math.abs(fahrenheit(nwsHeatIndexCelsius(celsius(t), rh)) - expected) < 0.00001, `${t} F / ${rh}%`);
  }
  for (const [t, rh] of [[null, 70], [23, null], [NaN, 70], [Infinity, 70], [23, -1], [23, 101]]) {
    assert.equal(nwsHeatIndexCelsius(t, rh), null);
  }
});

test("missing, stale, invalid, or other-station humidity omits only the feels-like line", async () => {
  const valid = reports.current.humidity;
  for (const humidity of [undefined, { ...valid, recordTime: "2026-11-09T10:00:00+08:00" },
    { ...valid, data: [{ place: "香港天文台", value: "N/A" }] },
    { ...valid, data: [{ place: "香港天文台", value: 101 }] },
    { ...valid, data: [{ place: "其他氣象站", value: 70 }] }]) {
    const message = await buildWeatherMessage({ now, logger,
      fetchImpl: fetcher({ ...reports, current: { ...reports.current, humidity } }) });
    assert.match(message, /現時 23°C/);
    assert.ok(!message.includes("體感溫度"));
  }
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

test("noon edition uses the noon heading and retains the feels-like temperature", async () => {
  const message = await buildWeatherMessage({ now, fetchImpl: fetcher(reports), logger, edition: "noon" });
  assert.ok(message.startsWith("🌤️ *香港中午天氣｜11月10日*"));
  assert.ok(message.includes("🌡️ 現時 23°C（天文台）\n🌡️ 體感溫度約 23.1°C"));
  assert.ok(!message.includes("早晨"));
});

const noon = new Date("2026-11-10T12:00:00+08:00");
const localForecast = { updateTime: "2026-11-10T10:45:00+08:00",
  forecastPeriod: "本港地區今日天氣預測", forecastDesc: "部分時間有陽光及乾燥。" };
const tomorrowForecast = { weatherForecast: [{ forecastDate: "20261111",
  forecastMintemp: { value: 29 }, forecastMaxtemp: { value: 32 },
  forecastWeather: "明日有雨。", PSR: "高" }] };

test("noon rollover uses the saved same-day range and PSR with the latest local description", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hko-forecast-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await buildWeatherMessage({ now, fetchImpl: fetcher(reports), logger, forecastCacheDirectory: directory });
  const message = await buildWeatherMessage({ now: noon, edition: "noon", logger,
    forecastCacheDirectory: directory, fetchImpl: fetcher({ ...reports, forecast: tomorrowForecast, localForecast }) });
  assert.ok(message.includes("📈 今日預測 20–26°C（早前預報）"));
  assert.ok(message.includes("☁️ 部分時間有陽光及乾燥。"));
  assert.ok(message.includes("🌧️ 顯著降雨概率：低（早前預報）"));
  assert.ok(!message.includes("29–32"));
  assert.ok(!message.includes("明日有雨"));
});

test("a noon start with no saved forecast shows today's local description and explicit missing fields", async () => {
  const errors = [];
  const message = await buildWeatherMessage({ now: noon, edition: "noon",
    logger: { error: (...args) => errors.push(args.join(" ")) },
    fetchImpl: fetcher({ ...reports, forecast: tomorrowForecast, localForecast }) });
  assert.ok(message.includes("📈 今日氣溫預測：暫未有資料"));
  assert.ok(message.includes("☁️ 部分時間有陽光及乾燥。"));
  assert.ok(message.includes("🌧️ 顯著降雨概率：暫未有資料"));
  assert.ok(errors.some(line => line.includes("no matching nine-day entry")));
});

test("11:45 afternoon-and-tonight local bulletin remains usable at noon", async () => {
  const message = await buildWeatherMessage({ now: noon, logger,
    fetchImpl: fetcher({ ...reports, forecast: tomorrowForecast, localForecast: {
      updateTime: "2026-11-10T11:45:00+08:00", forecastPeriod: "本港地區下午及今晚天氣預測",
      forecastDesc: "下午大致天晴及乾燥，今晚漸轉多雲。" } }) });
  assert.ok(message.includes("☁️ 下午大致天晴及乾燥，今晚漸轉多雲。"));
});

test("wrong-day, stale, and corrupt forecast caches are not shown as today's forecast", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hko-forecast-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const forecast = reports.forecast.weatherForecast[0];
  for (const content of ["not JSON", JSON.stringify({ savedAt: now.toISOString(), forecast: { ...forecast, forecastDate: "20261109" } }),
    JSON.stringify({ savedAt: "2026-11-08T10:00:00+08:00", forecast })]) {
    await writeFile(path.join(directory, "20261110.json"), content);
    const message = await buildWeatherMessage({ now: noon, logger, forecastCacheDirectory: directory,
      fetchImpl: fetcher({ ...reports, forecast: tomorrowForecast, localForecast }) });
    assert.ok(message.includes("今日氣溫預測：暫未有資料"));
    assert.ok(!message.includes("早前預報"));
  }
});

test("stale or tomorrow-only local bulletins cannot replace today's description", async () => {
  for (const bulletin of [
    { ...localForecast, updateTime: "2026-11-09T23:59:00+08:00" },
    { ...localForecast, forecastPeriod: "本港地區今晚及明日天氣預測" },
  ]) {
    const message = await buildWeatherMessage({ now: noon, logger,
      fetchImpl: fetcher({ ...reports, forecast: tomorrowForecast, localForecast: bulletin }) });
    assert.ok(message.includes("☁️ 今日天氣預測：暫未有資料"));
  }
});
