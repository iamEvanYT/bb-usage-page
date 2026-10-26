import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { makeWindow } from "./format";
import { LITELLM_RATES_URL } from "./pricing";
import { UsageScanner } from "./scan";
import { pruneScanCache, type ScanCache } from "./scan-cache";

test("session costs stay separate within a project and survive cached window slices", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "usage-threads-test-"));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(home, { recursive: true, force: true });
  });
  t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  t.mock.method(globalThis, "fetch", async () => Response.json({
    "test-model": { input_cost_per_token: 0.01, output_cost_per_token: 0.02 },
  }));
  const now = new Date("2026-10-26T12:00:00Z");
  const transcriptDir = path.join(home, ".claude", "projects", "test");
  await mkdir(transcriptDir, { recursive: true });
  for (const [id, sessionId, costUSD, timestamp] of [
    ["a", "expensive", 5, "2026-10-25T12:00:00Z"],
    ["b", "cheap", 1, now.toISOString()],
    ["c", "expensive", 3, now.toISOString()],
  ] as const) {
    await appendFile(path.join(transcriptDir, "test.jsonl"), JSON.stringify({
      type: "assistant", timestamp, sessionId, costUSD, cwd: "/work/project",
      message: { id, model: "test-model", usage: { input_tokens: 10, output_tokens: 2 } },
    }) + "\n");
  }
  await appendFile(path.join(transcriptDir, "test.jsonl"), [
    { type: "custom-title", sessionId: "expensive", customTitle: "Long running task" },
    { type: "ai-title", sessionId: "expensive", aiTitle: "Automatic title" },
    { type: "ai-title", sessionId: "cheap", aiTitle: "Quick task" },
  ].map((meta) => JSON.stringify(meta)).join("\n") + "\n");
  const dataDir = path.join(home, "cache");
  const input = { ...makeWindow(7, now, "UTC"), cursor: { enabled: false } };
  const scanner = new UsageScanner({ dataDir });
  const first = await scanner.readSummary(input);
  assert.deepEqual(first.merged.threads.map((r) => [r.sessionId, r.costUsd]), [["expensive", 8], ["cheap", 1]]);
  assert.deepEqual(first.merged.threads.map((r) => r.title), ["Long running task", "Quick task"]);
  assert.equal(first.merged.projects.length, 1);
  assert.equal(first.merged.projects[0].costUsd, 9);
  await scanner.flush();
  const restarted = new UsageScanner({ dataDir });
  const cached = await restarted.readSummary(input);
  assert.deepEqual(cached.merged.threads, first.merged.threads);
  assert.equal(cached.stats.filesParsed, 0);
  const day = await restarted.readSummary({ ...input, sinceDay: "2026-10-26" });
  assert.deepEqual(day.merged.threads.map((r) => [r.sessionId, r.costUsd]), [["expensive", 3], ["cheap", 1]]);
  assert.equal(day.merged.costUsd, 4);
  assert.equal(day.merged.threads[0].costShare, 0.75);
  await restarted.flush();
});

test("pruning retains live/restored transcripts but removes deleted and expired files", () => {
  const entry = (mtimeMs: number, ctimeMs: number) => ({
    size: 1, mtimeMs, ctimeMs, provider: "codex" as const, records: [],
  });
  const cache: ScanCache = new Map([
    ["/sessions/live", entry(1, 1)],
    ["/offline/restored", entry(1, 200)],
    ["/offline/expired", entry(1, 1)],
    ["/sessions/deleted", entry(200, 200)],
  ]);
  assert.equal(pruneScanCache(cache, {
    livePaths: new Set(["/sessions/live"]),
    walkedRoots: ["/sessions"],
    retentionCutoffMs: 100,
  }), 2);
  assert.deepEqual([...cache.keys()], ["/sessions/live", "/offline/restored"]);
});

test("local changes retain file caches and reuse Cursor until its own cache expires", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "usage-scan-test-"));
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(home, { recursive: true, force: true });
  });
  t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const dataDir = path.join(home, "cache");
  const transcriptDir = path.join(home, ".claude", "projects", "test");
  await mkdir(transcriptDir, { recursive: true });
  const databasePath = path.join(home, "cursor.sqlite");
  const database = new DatabaseSync(databasePath);
  const payload = Buffer.from(JSON.stringify({ sub: "test|user", exp: now / 1000 + 86400 })).toString("base64url");
  database.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)");
  database.prepare("INSERT INTO ItemTable VALUES (?, ?)").run("cursorAuth/accessToken", `header.${payload}.signature`);
  database.close();

  let cursorFetches = 0;
  let cursorFails = false;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url) === LITELLM_RATES_URL) {
      return Response.json({ "test-model": { input_cost_per_token: 0.01, output_cost_per_token: 0.02 } });
    }
    assert.equal(String(url), "https://cursor.com/api/dashboard/get-filtered-usage-events");
    cursorFetches++;
    if (cursorFails) return new Response(null, { status: 503 });
    return Response.json({
      totalUsageEventsCount: 1,
      usageEventsDisplay: [{ id: "cursor-event", timestamp: now, model: "test-model", chargedCents: 100, tokenUsage: { inputTokens: 10, outputTokens: 2 } }],
    });
  });

  let rowId = 0;
  const addUsage = async (file: string) => appendFile(file, JSON.stringify({
    type: "assistant", timestamp: new Date(now).toISOString(), sessionId: "test-session", costUSD: 2,
    message: { id: String(++rowId), model: "test-model", usage: { input_tokens: 10, output_tokens: 2 } },
  }) + "\n");
  const restored = path.join(transcriptDir, "restored.jsonl");
  const active = path.join(transcriptDir, "active.jsonl");
  await addUsage(restored);
  await addUsage(active);
  const old = new Date(now - 120 * 86400_000);
  await utimes(restored, old, old);

  const input = { ...makeWindow(30, new Date(now), "UTC"), cursor: { enabled: true, databasePath } };
  let scanner = new UsageScanner({ dataDir });
  const first = await scanner.readSummary(input);
  assert.equal(first.stats.filesParsed, 2);
  assert.equal(first.merged.costUsd, 5);
  assert.equal(cursorFetches, 1);
  const originalCursor = first.merged.providers.find((row) => row.provider === "cursor");

  now += 16_000;
  await addUsage(active);
  const changed = await scanner.readSummary(input);
  assert.equal(changed.stats.filesParsed, 1);
  assert.equal(changed.stats.fileHits, 1);
  assert.equal(changed.merged.costUsd, 7);
  assert.equal(cursorFetches, 1);
  assert.equal(changed.merged.providers.find((row) => row.provider === "cursor")?.totalTokens, originalCursor?.totalTokens);
  assert.equal(changed.merged.providers.find((row) => row.provider === "cursor")?.costUsd, 1);

  // A process restart must retain both the restored file and Cursor's fetch time.
  now += 16_000;
  await addUsage(active);
  scanner = new UsageScanner({ dataDir });
  const restarted = await scanner.readSummary(input);
  assert.equal(restarted.stats.filesParsed, 1);
  assert.equal(restarted.stats.fileHits, 1);
  assert.equal(restarted.merged.costUsd, 9);
  assert.equal(cursorFetches, 1);

  const forced = await scanner.readSummary({ ...input, force: true });
  assert.equal(forced.stats.filesParsed, 2);
  assert.equal(forced.merged.costUsd, 9);
  assert.equal(cursorFetches, 2);

  // Local scans must not slide Cursor's 15-minute fetch TTL forward.
  now += 15 * 60_000;
  const expired = await scanner.readSummary(input);
  assert.equal(expired.stats.filesParsed, 0);
  assert.equal(cursorFetches, 3);
  assert.equal(expired.merged.costUsd, 9);

  await scanner.readSummary({ ...input, timeZone: "Europe/London" });
  assert.equal(cursorFetches, 4);
  await scanner.readSummary(input);
  assert.equal(cursorFetches, 5);
  await scanner.readSummary({ ...input, sinceDay: makeWindow(91, new Date(now), "UTC").sinceDay });
  assert.equal(cursorFetches, 6);

  const disabled = await scanner.readSummary({ ...input, cursor: { enabled: false } });
  assert.equal(disabled.merged.providers.find((row) => row.provider === "cursor")?.costUsd, 0);
  assert.equal(cursorFetches, 6);

  cursorFails = true;
  const failed = await scanner.readSummary(input);
  assert.equal(failed.merged.sources.find((source) => source.provider === "cursor")?.status, "failed");
  cursorFails = false;
  const recovered = await scanner.readSummary(input);
  assert.equal(cursorFetches, 8);
  assert.equal(recovered.merged.costUsd, 9);
  await scanner.flush();
});

test("OpenCode v1 and v2 rows dedupe by message id and pick up new writes", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "usage-opencode-test-"));
  const xdg = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (xdg !== undefined) process.env.XDG_DATA_HOME = xdg;
    await rm(home, { recursive: true, force: true });
  });
  t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => Response.json({
    "test-model": { input_cost_per_token: 0.01, output_cost_per_token: 0.02 },
  }));

  const dataDir = path.join(home, ".local", "share", "opencode");
  await mkdir(dataDir, { recursive: true });
  const database = new DatabaseSync(path.join(dataDir, "opencode.db"));
  database.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
    INSERT INTO session VALUES ('ses_1', '/work/app');
    INSERT INTO session_v2 VALUES ('ses_1', '/work/app');
  `);
  const v1 = (id: string, data: object) =>
    database.prepare("INSERT INTO message VALUES (?, 'ses_1', ?, ?)").run(id, now, JSON.stringify({ role: "assistant", ...data }));
  const v2 = (id: string, data: object) =>
    database.prepare("INSERT INTO session_message VALUES (?, 'ses_1', 'assistant', ?, ?)").run(id, now, JSON.stringify(data));
  const tokens = { input: 10, output: 5, reasoning: 2, cache: { read: 100, write: 0 } };
  // Mirrored in both layouts: counted once.
  v1("msg_a", { modelID: "test-model", cost: 1.5, tokens });
  v2("msg_a", { model: { id: "test-model" }, cost: 1.5, tokens });
  // v2 only, zero reported cost: priced from model rates (10 * 0.01 + 5 * 0.02).
  v2("msg_b", { model: { id: "test-model" }, cost: 0, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } });
  // No tokens: ignored.
  v1("msg_c", { modelID: "test-model", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });

  const scanner = new UsageScanner({ dataDir: path.join(home, "cache") });
  const input = { ...makeWindow(30, new Date(now), "UTC"), cursor: { enabled: false } };
  const first = await scanner.readSummary(input);
  const opencode = first.merged.providers.find((row) => row.provider === "opencode");
  assert.equal(opencode?.records, 2);
  assert.ok(Math.abs((opencode?.costUsd ?? 0) - 1.7) < 1e-9);
  assert.equal(first.merged.projects.find((row) => row.projectPath === "/work/app")?.records, 2);
  assert.equal(first.merged.reasoningTokens, 2);
  assert.equal(first.merged.sources.find((source) => source.provider === "opencode")?.status, "ok");

  // A new write changes the db fingerprint, so the next walk re-reads it.
  v2("msg_d", { model: { id: "test-model" }, cost: 1, tokens });
  database.close();
  const forced = await scanner.readSummary({ ...input, force: true });
  assert.equal(forced.merged.providers.find((row) => row.provider === "opencode")?.records, 3);
  await scanner.flush();
});
