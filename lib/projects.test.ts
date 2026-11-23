import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyProjectCatalog,
  catalogFromBbProjects,
  inferProjectPathFromTranscriptPath,
} from "./projects";
import type { ProjectTotals } from "./types";

test("paths resolving to the same BB project produce one breakdown row", () => {
  const row = (projectPath: string): ProjectTotals => ({
    project: projectPath.split("/").at(-1)!,
    projectPath,
    threadId: null,
    costUsd: 10,
    totalTokens: 100,
    records: 1,
    costShare: 0,
  });
  const catalog = catalogFromBbProjects([
    {
      id: "project-wren",
      name: "wren-v2",
      kind: "standard",
      sources: [{ path: "/workspace/wren-v2" }],
    },
  ]);

  const rows = applyProjectCatalog(
    [row("/workspace/wren-v2"), row("/workspace/wren-v2/src"), row("/other/wren-v2")],
    catalog,
  );

  assert.deepEqual(rows, [
    {
      project: "wren-v2",
      projectPath: "/workspace/wren-v2",
      threadId: null,
      costUsd: 30,
      totalTokens: 300,
      records: 3,
      costShare: 0,
    },
  ]);
});

test("Windows project paths from another machine merge with BB projects", () => {
  const row = (projectPath: string, costUsd: number): ProjectTotals => ({
    project: "",
    projectPath,
    threadId: null,
    costUsd,
    totalTokens: 1,
    records: 1,
    costShare: 0,
  });
  const catalog = catalogFromBbProjects([
    {
      id: "project-wren",
      name: "wren-v2",
      kind: "standard",
      sources: [{ path: "/workspace/wren-v2" }, { path: "C:\\Users\\me\\Developer\\wren" }],
    },
  ]);

  const rows = applyProjectCatalog(
    [
      row("/workspace/wren-v2", 1),
      row("c:\\users\\me\\developer\\wren\\src", 2),
      row("C:\\Users\\me\\Documents\\Codex\\chat-1", 4),
      row("D:\\scratch\\tool", 8),
    ],
    catalog,
  );

  assert.deepEqual(
    rows.map((entry) => [entry.project, entry.costUsd]),
    [
      ["wren-v2", 3],
      ["Unassociated Codex chats", 4],
      ["tool", 8],
    ],
  );
});

test("Claude's Windows folder encoding decodes to a drive path", () => {
  assert.equal(
    inferProjectPathFromTranscriptPath(
      "C:\\Users\\me\\.claude\\projects\\C--Users-me-Developer-app\\session.jsonl",
      "win32",
    ),
    "C:\\Users\\me\\Developer\\app",
  );
  // POSIX decoding normalizes with the running platform's path rules.
  if (process.platform !== "win32") {
    assert.equal(
      inferProjectPathFromTranscriptPath(
        "/home/me/.claude/projects/-home-me-app/session.jsonl",
        "linux",
      ),
      "/home/me/app",
    );
  }
});
