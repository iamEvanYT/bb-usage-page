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
  const home = await mkdtemp("/private/tmp/usage-scan-test-");
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
