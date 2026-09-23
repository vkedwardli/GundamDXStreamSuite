// Run with: node --experimental-vm-modules --test score.test.js
// Load the real score logic without starting OBS, WhatsApp, OCR, or the server.
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

async function fixture(args = [], { directory, fileSystem = fs } = {}) {
  const broadcasts = [];
  const errors = [];
  const factions = {
    FEDERATION: { value: "federation", displayName: "連邦" },
    ZEON: { value: "zeon", displayName: "自護" },
  };
  const noop = () => {};
  const imports = {
    "tesseract.js": { default: {}, PSM: {} },
    stream: { PassThrough: class {} },
    child_process: { spawn: () => assert.fail("Unexpected process spawn") },
    fs: { default: fileSystem },
    os: { default: {} },
    "./serverSetup.js": {
      io: { emit: (event, value) => broadcasts.push({ event, value }) },
      internalEvents: { emit: noop },
    },
    "timers/promises": { scheduler: {} },
    "./ttsService.js": { textToSpeech: noop },
    "./config.js": { Faction: factions, TTSModel: { AZURE_AI: "azure" } },
    "./obsService.js": { enableCam: noop, showZDXPopup: noop },
    "./messageService.js": { createMessage: value => value },
    "node:util": { parseArgs },
  };
  const context = vm.createContext({ URL, console: { log: noop, error: (...args) => errors.push(args) } });
  const source = await readFile(new URL("./score.js", import.meta.url), "utf8");
  const module = new vm.SourceTextModule(
    source + "\nexport { detectionBuffer, processBattleOutcome, streakRestoredAt, resetStreaks };",
    { context, initializeImportMeta(meta) {
      meta.url = pathToFileURL(path.join(directory || '/unused', 'score.js')).href;
    } },
  );
  await module.link(specifier => {
    const values = imports[specifier];
    assert.ok(values, `Unexpected real import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  module.namespace.restoreScoreFromArgs(args);
  return { ...module.namespace, factions, broadcasts, errors };
}

const plain = value => JSON.parse(JSON.stringify(value));
const resumed = ["--fed-score", "25", "--zeon-score=77", "--zeon-streak", "6"];

test("no startup options preserves the normal zero scores and streaks", async () => {
  const { gameState } = await fixture();
  assert.deepEqual(plain(gameState.totalWins), { federation: 0, zeon: 0 });
  assert.deepEqual(plain(gameState.streaks), { federation: 0, zeon: 0 });
  assert.equal(gameState.lastWinner, null);
  assert.equal(gameState.totalBattles, 0);
});

test("restored score is broadcast with its streak, winner, and a fresh inactivity window", async () => {
  const before = Date.now();
  const f = await fixture(resumed);
  assert.deepEqual(plain(f.gameState.totalWins), { federation: 25, zeon: 77 });
  assert.deepEqual(plain(f.gameState.streaks), { federation: 0, zeon: 6 });
  assert.equal(f.gameState.lastWinner, f.factions.ZEON);
  assert.equal(f.gameState.totalBattles, 102);
  assert.equal(f.gameState.totalDraws, 0);
  assert.ok(f.streakRestoredAt >= before && f.streakRestoredAt <= Date.now());
  assert.equal(f.gameState.lastOutcomeTime, 0, "restoring does not count as a battle");
  assert.equal(f.broadcasts.length, 0, "restoring does not announce a new win");
  f.broadcastGameState();
  assert.equal(f.broadcasts[0].event, "battleResult");
  assert.equal(f.broadcasts[0].value.state, f.gameState);
});

test("Federation can also resume a streak; omitted values are zero", async () => {
  const f = await fixture(["--fed-score=12", "--fed-streak=3"]);
  assert.deepEqual(plain(f.gameState.totalWins), { federation: 12, zeon: 0 });
  assert.deepEqual(plain(f.gameState.streaks), { federation: 3, zeon: 0 });
  assert.equal(f.gameState.lastWinner, f.factions.FEDERATION);
});

test("the first result after restart counts immediately and continues or resets the streak", async () => {
  for (const [areas, expectedWins, expectedStreaks, draws] of [
    [["Area1", "Area2"], { federation: 25, zeon: 78 }, { federation: 0, zeon: 7 }, 0],
    [["Area3", "Area4"], { federation: 26, zeon: 77 }, { federation: 1, zeon: 0 }, 0],
    [["Area1", "Area2", "Area3", "Area4"], { federation: 25, zeon: 77 }, { federation: 0, zeon: 0 }, 1],
  ]) {
    const f = await fixture(resumed);
    areas.forEach(area => f.detectionBuffer.add(area));
    f.processBattleOutcome();
    assert.deepEqual(plain(f.gameState.totalWins), expectedWins);
    assert.deepEqual(plain(f.gameState.streaks), expectedStreaks);
    assert.equal(f.gameState.totalBattles, 103);
    assert.equal(f.gameState.totalDraws, draws);
  }
});

test("invalid startup options fail before changing any scores", async () => {
  const f = await fixture();
  const initial = plain(f.gameState);
  for (const args of [
    ["--fed-score=-1"], ["--zeon-score", "2.5"], ["--fed-score", "hello"],
    ["--fed-score", ""], ["--zeon-streak"], ["--fed-socre", "25"],
    ["--fed-score", "9007199254740992"], ["--fed-score", "1e3"],
    ["--fed-score=9007199254740991", "--zeon-score=1"],
    ["--fed-score=2", "--fed-streak=3"], ["--zeon-score=2", "--zeon-streak=3"],
    ["--fed-score=3", "--zeon-score=6", "--fed-streak=3", "--zeon-streak=6"],
  ]) {
    assert.throws(() => f.restoreScoreFromArgs(args), undefined, args.join(" "));
    assert.deepEqual(plain(f.gameState), initial);
  }
});

async function scoreDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gdx-score-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readScore(directory) {
  return JSON.parse(await readFile(path.join(directory, "score.txt"), "utf8"));
}

test("deployment restart preserves the file until Live resumes and restores the full score", async (t) => {
  const directory = await scoreDirectory(t);
  const first = await fixture(resumed, { directory });
  first.prepareScoresForStream(false);
  first.detectionBuffer.add("Area1");
  first.detectionBuffer.add("Area2");
  first.processBattleOutcome();
  const saved = await readScore(directory);
  assert.deepEqual(saved.totalWins, { federation: 25, zeon: 78 });
  assert.deepEqual(saved.streaks, { federation: 0, zeon: 7 });
  assert.equal(saved.totalBattles, 103);
  assert.ok(Number.isFinite(Date.parse(saved.savedAt)));
  assert.match(saved.savedAtLocal, /GMT/);

  // Simulate a new Node process. An overlay connecting before Live must not
  // destroy the on-disk snapshot by broadcasting its initial zero state.
  const second = await fixture([], { directory });
  second.broadcastGameState();
  assert.deepEqual(await readScore(directory), saved);
  assert.equal(second.gameState.totalWins.zeon, 0);
  second.prepareScoresForStream(true);
  assert.deepEqual(plain(second.gameState.totalWins), saved.totalWins);
  assert.deepEqual(plain(second.gameState.streaks), saved.streaks);
  assert.equal(second.gameState.lastWinner, second.factions.ZEON);
  assert.equal(second.gameState.totalBattles, 103);
  assert.equal(second.gameState.lastOutcomeTime, saved.lastOutcomeTime);

  // The same still-visible result must remain within the original cooldown.
  second.detectionBuffer.add("Area1");
  second.detectionBuffer.add("Area2");
  second.processBattleOutcome();
  assert.equal(second.gameState.totalWins.zeon, 78);
});

test("a fresh OBS stream skips old saved scores, while CLI values override a resume", async (t) => {
  const directory = await scoreDirectory(t);
  const old = await fixture(resumed, { directory });
  old.prepareScoresForStream(false);
  const fresh = await fixture([], { directory });
  fresh.prepareScoresForStream(false);
  assert.deepEqual((await readScore(directory)).totalWins, { zeon: 0, federation: 0 });

  const manual = await fixture(["--fed-score=12", "--fed-streak=3"], { directory });
  manual.prepareScoresForStream(true);
  assert.equal(manual.gameState.totalWins.federation, 12);
  assert.equal((await readScore(directory)).streaks.federation, 3);
});

test("draws and streak resets are saved and survive a restart", async (t) => {
  const directory = await scoreDirectory(t);
  const first = await fixture(resumed, { directory });
  first.prepareScoresForStream(false);
  ["Area1", "Area2", "Area3", "Area4"].forEach(area => first.detectionBuffer.add(area));
  first.processBattleOutcome();
  const second = await fixture([], { directory });
  second.prepareScoresForStream(true);
  assert.equal(second.gameState.totalDraws, 1);
  assert.equal(second.gameState.totalBattles, 103);
  assert.deepEqual(plain(second.gameState.streaks), { federation: 0, zeon: 0 });
  assert.equal(second.gameState.lastWinner, null);

  const third = await fixture(resumed, { directory });
  third.prepareScoresForStream(true);
  third.resetStreaks("prolonged inactivity");
  const fourth = await fixture([], { directory });
  fourth.prepareScoresForStream(true);
  assert.deepEqual(plain(fourth.gameState.totalWins), { federation: 25, zeon: 77 });
  assert.deepEqual(plain(fourth.gameState.streaks), { federation: 0, zeon: 0 });
});

test("resume happens once and missing/invalid files do not interrupt the stream", async (t) => {
  const directory = await scoreDirectory(t);
  const first = await fixture(resumed, { directory });
  first.prepareScoresForStream(false);
  const saved = await readScore(directory);
  const live = await fixture([], { directory });
  live.prepareScoresForStream(true);
  live.gameState.totalWins.federation += 1;
  live.prepareScoresForStream(true);
  assert.equal(live.gameState.totalWins.federation, 26, "must not reload an older snapshot");

  for (const content of ["{broken", JSON.stringify({ ...saved, streaks: { federation: 99, zeon: 6 } })]) {
    await writeFile(path.join(directory, "score.txt"), content);
    const invalid = await fixture([], { directory });
    invalid.prepareScoresForStream(true);
    assert.equal(invalid.errors.length, 1);
    assert.equal(invalid.gameState.totalWins.zeon, 0);
  }
  await rm(path.join(directory, "score.txt"));
  const missing = await fixture([], { directory });
  missing.prepareScoresForStream(true);
  assert.equal(missing.errors.length, 0);
  assert.equal((await readScore(directory)).totalBattles, 0);
});

test("a failed replacement keeps the previous snapshot and retries on the next broadcast", async (t) => {
  const directory = await scoreDirectory(t);
  const first = await fixture(resumed, { directory });
  first.prepareScoresForStream(false);
  const saved = await readScore(directory);
  let failRename = true;
  const second = await fixture([], { directory, fileSystem: {
    ...fs,
    renameSync: (...args) => { if (failRename) throw new Error("file temporarily locked"); fs.renameSync(...args); },
  } });
  second.prepareScoresForStream(true);
  second.resetStreaks("prolonged inactivity");
  assert.deepEqual(await readScore(directory), saved);
  assert.ok(second.errors.length > 0);
  failRename = false;
  second.broadcastGameState();
  assert.deepEqual((await readScore(directory)).streaks, { federation: 0, zeon: 0 });
});

test("OBS's actual streaming status selects restore before recognition starts", async (t) => {
  const directory = await scoreDirectory(t);
  const saved = await fixture(resumed, { directory });
  saved.prepareScoresForStream(false);
  const snapshot = await readFile(path.join(directory, "score.txt"), "utf8");
  for (const outputActive of [true, false]) {
    await writeFile(path.join(directory, "score.txt"), snapshot);
    const score = await fixture([], { directory });
    const calls = [];
    const noop = () => {};
    const imports = {
      "obs-websocket-js": { OBSWebSocket: class {
        identified = true;
        async call(request) { calls.push(request); return { outputActive }; }
      } },
      child_process: { exec: () => assert.fail("Unexpected external command") },
      "node:timers/promises": { scheduler: {} },
      path: { default: path }, os: { default: os },
      "./config.js": { obsDir: "unused", obsPath: "unused", OBS_PASSWORD: "unused" },
      "./score.js": {
        prepareScoresForStream: score.prepareScoresForStream,
        startRecognizeBattleResults: async () => {
          calls.push("recognition");
          assert.equal(score.gameState.totalWins.zeon, outputActive ? 77 : 0);
          assert.equal(score.gameState.streaks.zeon, outputActive ? 6 : 0);
        },
        stopRecognizeBattleResults: async () => calls.push("cleanup"),
      },
      "./serverSetup.js": { io: { emit: noop } },
    };
    const context = vm.createContext({ console: { log: noop, error: noop } });
    const module = new vm.SourceTextModule(await readFile(new URL("./obsService.js", import.meta.url), "utf8"), { context });
    await module.link(specifier => {
      const values = imports[specifier];
      assert.ok(values, `Unexpected real import: ${specifier}`);
      return new vm.SyntheticModule(Object.keys(values), function () {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      }, { context });
    });
    await module.evaluate();
    await module.namespace.startOBSStreamingAndRecognition(noop, true);
    assert.deepEqual(calls, outputActive
      ? ["GetStreamStatus", "recognition"]
      : ["GetStreamStatus", "StartStream", "StartVirtualCam", "recognition"]);
  }
});
