import assert from "node:assert/strict";
import { test } from "node:test";
import { applyProjectCatalog, catalogFromBbProjects } from "./projects";
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
