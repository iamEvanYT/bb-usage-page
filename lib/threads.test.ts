import assert from "node:assert/strict";
import { test } from "node:test";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { applyThreadCatalog, ThreadResolver } from "./threads";
import type { ThreadTotals } from "./types";

function row(sessionId: string, costUsd = 1): ThreadTotals {
  return {
    provider: "codex", sessionId, title: sessionId, threadId: null,
    projectPath: "/shared/project", costUsd, totalTokens: 10, records: 1, costShare: costUsd / 10,
  };
}

test("thread totals merge resumed sessions, retain unmatched usage, and sort by cost", () => {
  const rows = [row("first", 2), row("resumed", 3), row("outside", 4)];
  const result = applyThreadCatalog(rows, new Map([
    ["codex\0first", { id: "thr_one", title: "One thread" }],
    ["codex\0resumed", { id: "thr_one", title: "One thread" }],
  ]));
  assert.deepEqual(result.map((r) => [r.title, r.costUsd, r.totalTokens, r.records, r.costShare]), [
    ["One thread", 5, 20, 2, 0.5], ["outside", 4, 10, 1, 0.4],
  ]);
  assert.equal(result[0].threadId, "thr_one");
  assert.equal(result[1].threadId, null);
  assert.equal(rows[0].costUsd, 2);
});

test("exact identity matching includes archives, handles aliases and ambiguity, and reads new events", async () => {
  let updatedAt = 1;
  const calls: Array<{ threadId: string; afterSeq: string }> = [];
  const bb = { sdk: { threads: {
    list: async ({ archived }: { archived: boolean }) => archived
      ? [{ id: "thr_archive", providerId: "claude-code", title: "Archived", deletedAt: null, updatedAt, status: "idle" }]
      : ["thr_one", "thr_two"].map((id) => ({
          id, providerId: "codex", title: id, deletedAt: null, updatedAt, status: "idle",
        })),
    events: { list: async ({ threadId, afterSeq, limit }: { threadId: string; afterSeq: string; limit: string }) => {
      assert.equal(limit, "100");
      calls.push({ threadId, afterSeq });
      return [
        { seq: 1, type: "thread/identity", data: { providerThreadId: "shared" } },
        ...(threadId === "thr_one"
          ? [{ seq: 2, type: "turn/started", data: { providerThreadId: "first" } },
             ...(updatedAt === 2 ? [{ seq: 3, type: "thread/identity", data: { providerThreadId: "resumed" } }] : [])]
          : []),
      ].filter((event) => event.seq > Number(afterSeq));
    } },
  } } } as unknown as BbPluginApi;
  const resolver = new ThreadResolver();
  const rows = [row("shared"), row("first"), row("resumed"), { ...row("shared"), provider: "claude" as const }];
  const first = await resolver.resolve(bb, rows);
  assert.equal(first.find((r) => r.provider === "codex" && r.sessionId === "shared")?.threadId, null);
  assert.equal(first.find((r) => r.sessionId === "first")?.threadId, "thr_one");
  assert.equal(first.find((r) => r.provider === "claude")?.title, "Archived");
  const count = calls.length;
  await resolver.resolve(bb, rows);
  assert.equal(calls.length, count);
  updatedAt = 2;
  const resumed = await resolver.resolve(bb, rows);
  assert.equal(resumed.find((r) => r.threadId === "thr_one")?.costUsd, 2);
  assert.ok(calls.slice(count).some((call) => call.threadId === "thr_one" && call.afterSeq === "2"));
});
