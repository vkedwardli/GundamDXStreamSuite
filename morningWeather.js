import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildWeatherMessage, hkParts } from "./hkoWeather.js";

const dateKey = date => {
  const { year, month, day } = hkParts(date);
  return `${year}${month}${day}`;
};
const isMorning = date => {
  const hour = Number(hkParts(date).hour);
  return hour >= 6 && hour < 12;
};

// Startup-only: no next-day scheduling. All work runs independently of streaming.
export function startMorningWeather({ client, groupId, directory,
  startedAt = new Date(Date.now() - process.uptime() * 1000), now = () => new Date(),
  buildMessage = buildWeatherMessage, logger = console, pollMs = 30000 }) {
  const day = dateKey(startedAt);
  const prefix = `WhatsApp morning weather ${day}:`;
  const log = message => logger.log(`${prefix} ${message}`);
  if (!isMorning(startedAt)) {
    log("skipped; Node started outside 06:00–before 12:00 Hong Kong time.");
    return () => {};
  }
  if (!groupId?.endsWith("@g.us")) {
    logger.error(`${prefix} disabled; WA_PUBLIC_GROUP_ID is missing or invalid.`);
    return () => {};
  }

  const file = path.join(directory, `${day}.json`);
  let stopped = false;
  let busy = false;
  let waitingLogged = false;
  let nextFetchAt = 0;
  let timer;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    client.off("ready", tick);
  };
  const eligible = () => {
    const current = now();
    return !stopped && dateKey(current) === day && isMorning(current);
  };

  async function run() {
    if (!eligible()) {
      log("skipped; morning send window has ended.");
      stop();
      return;
    }
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      log(`skipped; daily record already exists (status=${saved.status || "unknown"}).`);
      stop();
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!client.ready) {
      if (!waitingLogged) log("waiting for WhatsApp readiness; streaming continues.");
      waitingLogged = true;
      return;
    }
    if (now().getTime() < nextFetchAt) return;
    log("fetching HKO weather.");
    let text;
    try {
      text = await buildMessage({ now: now(), logger });
    } catch (error) {
      nextFetchAt = now().getTime() + 5 * 60000;
      logger.error(`${prefix} HKO fetch failed; retrying in five minutes while before noon:`, error.message);
      return;
    }
    if (!eligible() || !client.ready) return;

    await mkdir(directory, { recursive: true });
    // Claim before dispatch. A restart during an uncertain send must not post
    // twice. Exclusive creation also prevents simultaneous processes claiming it.
    let handle;
    try { handle = await open(file, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      log("skipped; another attempt already claimed today.");
      stop();
      return;
    }
    const record = { day, groupId, status: "sending", attemptedAt: now().toISOString() };
    try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    if (!eligible() || !client.ready) {
      record.status = "skipped";
      await writeFile(file, JSON.stringify(record) + "\n", { flush: true });
      log("skipped; shutdown, noon, or disconnection occurred before dispatch.");
      stop();
      return;
    }
    stop();
    log("sending to the public group.");
    try {
      const sent = await client.sendMessage(groupId, text);
      if (!sent?.id?._serialized) throw new Error("WhatsApp returned no message ID");
      record.status = "sent";
      record.messageId = sent.id._serialized;
      record.sentAt = now().toISOString();
      log(`sent (message=${record.messageId}).`);
    } catch (error) {
      record.status = "uncertain";
      logger.error(`${prefix} send failed or delivery is uncertain; no automatic resend today:`, error.message);
    }
    await writeFile(`${file}.tmp`, JSON.stringify(record) + "\n", { mode: 0o600, flush: true });
    await rename(`${file}.tmp`, file);
  }

  function tick() {
    if (stopped || busy) return;
    busy = true;
    void run().catch(error => {
      logger.error(`${prefix} stopped after a persistence error:`, error.message);
      stop();
    }).finally(() => { busy = false; });
  }
  client.on("ready", tick);
  timer = setInterval(tick, pollMs);
  timer.unref?.();
  tick();
  return stop;
}
