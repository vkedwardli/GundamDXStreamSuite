import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startMorningWeather } from "./morningWeather.js";

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "morning-weather-"));
  const client = new EventEmitter();
  const sent = [];
  const logs = [];
  client.ready = true;
  client.sendMessage = async (...args) => { sent.push(args); return { id: { _serialized: "weather-id" } }; };
  let current = new Date("2026-11-10T03:00:00Z"); // 11am HK, independent of host TZ
  const options = { client, directory, groupId: "public@g.us", startedAt: current,
    now: () => current, buildMessage: async () => "天氣報告", pollMs: 20,
    logger: { log: (...args) => logs.push(args.join(" ")), error: (...args) => logs.push(args.join(" ")) },
    ...overrides };
  const stops = [];
  const start = () => { const stop = startMorningWeather(options); stops.push(stop); return stop; };
  const record = async () => JSON.parse(await readFile(path.join(directory, "20261110.json"), "utf8").catch(() => "null"));
  t.after(async () => { stops.forEach(stop => stop()); await rm(directory, { recursive: true, force: true }); });
  return { options, client, sent, logs, start, record, setTime: time => { current = new Date(time); } };
}

test("before-noon startup waits for WhatsApp then sends once to public, including restart", async t => {
  const f = await fixture(t);
  f.client.ready = false;
  f.start();
  await until(() => f.logs.some(line => line.includes("waiting for WhatsApp")));
  assert.equal(f.sent.length, 0);
  f.client.ready = true;
  f.client.emit("ready");
  f.client.emit("ready");
  await until(async () => (await f.record())?.status === "sent");
  assert.deepEqual(f.sent, [["public@g.us", "天氣報告"]]);
  f.start();
  await until(() => f.logs.some(line => line.includes("daily record already exists")));
  assert.equal(f.sent.length, 1);
});

test("overnight, noon, and afternoon startups never fetch, send, or queue for 6am", async t => {
  for (const time of ["00:00:00", "01:00:00", "02:00:00", "05:59:59", "12:00:00", "18:00:00"]) {
    const startedAt = new Date(`2026-11-10T${time}+08:00`);
    const f = await fixture(t, { startedAt,
      buildMessage: () => assert.fail("outside the morning window must not fetch") });
    f.setTime(startedAt);
    f.start();
    assert.ok(f.logs.some(line => line.includes("started outside")));
    assert.equal(f.client.listenerCount("ready"), 0);
    f.setTime("2026-11-10T06:00:00+08:00");
    f.client.emit("ready");
    assert.equal(f.sent.length, 0);
    assert.equal(await f.record(), null);
  }
});

test("6am is included and 11:59:59am is still eligible in Hong Kong time", async t => {
  for (const time of ["06:00:00", "11:59:59"]) {
    const startedAt = new Date(`2026-11-10T${time}+08:00`);
    const f = await fixture(t, { startedAt });
    f.setTime(startedAt);
    f.start();
    await until(async () => (await f.record())?.status === "sent");
    assert.equal(f.sent.length, 1);
  }
});

test("a delayed login at noon or the next day does not send yesterday's announcement", async t => {
  for (const time of ["2026-11-10T04:00:00Z", "2026-11-11T01:00:00Z"]) {
    const f = await fixture(t);
    f.client.ready = false;
    f.start();
    await until(() => f.logs.some(line => line.includes("waiting for WhatsApp")));
    f.setTime(time);
    f.client.ready = true;
    f.client.emit("ready");
    await until(() => f.logs.some(line => line.includes("window has ended")));
    assert.equal(f.sent.length, 0);
  }
});

test("HKO failure leaves the daily slot available and retries in five minutes", async t => {
  const f = await fixture(t);
  let calls = 0;
  f.options.buildMessage = async () => { if (++calls === 1) throw new Error("HKO offline"); return "weather"; };
  f.start();
  await until(() => f.logs.some(line => line.includes("fetch failed")));
  assert.equal(await f.record(), null);
  f.setTime("2026-11-10T03:05:00Z");
  await until(async () => (await f.record())?.status === "sent");
  assert.equal(calls, 2);
});

test("uncertain sends are logged and never duplicated after restart", async t => {
  const f = await fixture(t);
  let calls = 0;
  f.client.sendMessage = async () => { calls++; throw new Error("connection lost after submission"); };
  f.start();
  await until(async () => (await f.record())?.status === "uncertain");
  f.start();
  await until(() => f.logs.some(line => line.includes("daily record already exists")));
  assert.equal(calls, 1);
  assert.ok(f.logs.some(line => line.includes("no automatic resend")));
});

test("concurrent startup attempts share one durable daily claim", async t => {
  const f = await fixture(t);
  f.start();
  f.start();
  await until(async () => (await f.record())?.status === "sent");
  assert.equal(f.sent.length, 1);
});

test("shutdown or noon during an HKO fetch prevents sending", async t => {
  for (const reason of ["shutdown", "noon"]) {
    const f = await fixture(t);
    let finish;
    f.options.buildMessage = () => new Promise(resolve => { finish = resolve; });
    const stop = f.start();
    await until(() => Boolean(finish));
    if (reason === "shutdown") stop();
    else f.setTime("2026-11-10T04:00:00Z");
    finish("weather");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.sent.length, 0);
    assert.equal(await f.record(), null);
  }
});
