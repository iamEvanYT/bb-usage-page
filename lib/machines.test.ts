import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MachineCollector, mergeSourceReports, type MachineInfo } from "./machines";
import { testBucket, testScan, testWindow } from "./test-fixtures";
import type { UsageProviderKind } from "./types";

test("offline machines fall back to their last scan, persisted across restarts", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "usage-machines-test-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const machines: MachineInfo[] = [
    { id: "mac", name: "Mac", local: true, connected: true },
    { id: "pc", name: "PC", local: false, connected: true },
  ];
  let remoteCalls = 0;
  let remoteFails = false;
  const deps = {
    dataDir,
    listMachines: async () => machines.map((machine) => ({ ...machine })),
    scanLocal: async () => testScan([testBucket("2026-10-02", "claude", "a", 1)]),
    scanRemote: async () => {
      remoteCalls += 1;
      if (remoteFails) throw new Error("worker crashed");
      return testScan([testBucket("2026-10-03", "codex", "b", 2)], 42);
    },
  };
  const request = {
    ...testWindow,
    force: false,
    providers: ["claude", "codex"] as UsageProviderKind[],
    claudeDirs: ["~/.claude"],
  };

  const collector = new MachineCollector(deps);
  const first = await collector.collect(request, {});
  assert.deepEqual(first.machines.map((m) => m.status), ["ok", "ok"]);
  assert.equal(remoteCalls, 1);

  // Within the hot TTL the remote result is reused.
  await collector.collect(request, {});
  assert.equal(remoteCalls, 1);

  // Unselected machines are not scanned but still report cached totals.
  const skipped = await collector.collect({ ...request, force: true }, { excludeMachineIds: ["pc"] });
  assert.equal(remoteCalls, 1);
  assert.equal(skipped.machines[1].status, "skipped");
  assert.equal(skipped.parts.find((part) => part.machineId === "pc")?.selected, false);

  // A fresh collector (server restart) with the machine offline uses the disk copy.
  machines[1].connected = false;
  const restarted = new MachineCollector(deps);
  const offline = await restarted.collect(request, {});
  assert.equal(offline.machines[1].status, "stale");
  assert.equal(offline.machines[1].scannedAt, new Date(42).toISOString());
  assert.equal(offline.parts.length, 2);

  // A failing worker also falls back, with its error as the message.
  machines[1].connected = true;
  remoteFails = true;
  const failed = await restarted.collect({ ...request, force: true }, {});
  assert.equal(failed.machines[1].status, "stale");
  assert.match(failed.machines[1].message ?? "", /worker crashed/);

  // Removing the machine from bb forgets it.
  machines.pop();
  const removed = await restarted.collect(request, {});
  assert.equal(removed.machines.length, 1);
  machines.push({ id: "pc", name: "PC", local: false, connected: false });
  const gone = await new MachineCollector(deps).collect(request, {});
  assert.equal(gone.machines[1].status, "unavailable");
});

test("source reports are labeled per machine and unreachable machines are flagged", () => {
  const empty = { claude: [], codex: [], pi: [], cursor: [], opencode: [], devin: [] };
  const merged = mergeSourceReports(["~/.claude", "~/.claude-work"], [
    {
      machine: { id: "mac", name: "Mac", local: true, connected: true },
      report: {
        detected: { ...empty, claude: ["~/.claude/projects"] },
        claudeDirs: [
          { path: "~/.claude", found: true },
          { path: "~/.claude-work", found: false },
        ],
      },
    },
    {
      machine: { id: "pc", name: "PC", local: false, connected: true },
      report: {
        detected: { ...empty, devin: ["~\\AppData\\Roaming\\devin\\cli\\sessions.db"] },
        claudeDirs: [
          { path: "~/.claude", found: false },
          { path: "~/.claude-work", found: true },
        ],
      },
    },
    { machine: { id: "nas", name: "NAS", local: false, connected: false }, report: null },
  ]);
  assert.deepEqual(merged.detected.claude, [{ machine: "Mac", path: "~/.claude/projects" }]);
  assert.deepEqual(merged.detected.devin, [
    { machine: "PC", path: "~\\AppData\\Roaming\\devin\\cli\\sessions.db" },
  ]);
  assert.deepEqual(merged.claudeDirs.map((dir) => dir.found), [true, true]);
  assert.deepEqual(merged.machines, [
    { name: "Mac", checked: true },
    { name: "PC", checked: true },
    { name: "NAS", checked: false },
  ]);
});
