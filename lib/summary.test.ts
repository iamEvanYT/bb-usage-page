import assert from "node:assert/strict";
import { test } from "node:test";
import { combineScans, type ScanPart } from "./summary";
import { testBucket, testScan, testWindow } from "./test-fixtures";

test("selected machines merge; Cursor counts even when its machine is unselected", () => {
  const parts: ScanPart[] = [
    {
      machineId: "mac",
      machineName: "Mac",
      selected: false,
      carriesCursor: true,
      scan: testScan([
        testBucket("2026-10-02", "claude", "a", 10),
        testBucket("2026-10-02", "cursor", "", 7),
      ]),
    },
    {
      machineId: "pc",
      machineName: "PC",
      selected: true,
      carriesCursor: false,
      scan: testScan([
        testBucket("2026-10-03", "codex", "b", 2),
        // Outside the window.
        testBucket("2026-09-03", "codex", "c", 100),
      ]),
    },
  ];
  const combined = combineScans(parts, testWindow, { scanDurationMs: 0 });
  assert.deepEqual(
    combined.summary.buckets.map((entry) => [entry.provider, entry.costUsd]),
    [["cursor", 7], ["codex", 2]],
  );
  assert.equal(combined.summary.sessions, 1);
  // Per-machine totals cover unselected machines and leave Cursor out.
  assert.deepEqual(combined.totalsByMachine.get("mac"), { costUsd: 10, totalTokens: 10 });
  assert.deepEqual(combined.totalsByMachine.get("pc"), { costUsd: 2, totalTokens: 2 });
});

test("a session read on two machines counts once, keeping the fuller copy", () => {
  const parts: ScanPart[] = [
    {
      machineId: "mac",
      machineName: "Mac",
      selected: true,
      carriesCursor: true,
      scan: testScan([testBucket("2026-10-02", "claude", "shared", 4, 2)]),
    },
    {
      machineId: "pc",
      machineName: "PC",
      selected: true,
      carriesCursor: false,
      scan: testScan([
        testBucket("2026-10-02", "claude", "shared", 6, 3),
        testBucket("2026-10-02", "claude", "own", 1),
      ]),
    },
  ];
  const combined = combineScans(parts, testWindow, {
    scanDurationMs: 0,
    providers: ["claude"],
  });
  assert.deepEqual(
    combined.summary.buckets.map((entry) => [entry.sessionId, entry.costUsd]).sort(),
    [["own", 1], ["shared", 6]],
  );
  assert.equal(combined.summary.sessions, 2);
});

test("disabled providers in an older cached scan are not counted", () => {
  const combined = combineScans(
    [
      {
        machineId: "pc",
        machineName: "PC",
        selected: true,
        carriesCursor: false,
        scan: testScan([testBucket("2026-10-02", "pi", "x", 5), testBucket("2026-10-02", "codex", "y", 1)]),
      },
    ],
    testWindow,
    { scanDurationMs: 0, providers: ["codex"] },
  );
  assert.equal(combined.summary.buckets.length, 1);
  assert.equal(combined.summary.buckets[0].provider, "codex");
});
