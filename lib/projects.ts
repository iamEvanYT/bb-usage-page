import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { CURSOR_ACCOUNT_PROJECT_PATH, type ProjectTotals } from "./types";

const UNKNOWN_PROJECT_LABEL = "Unknown";
const CODEX_CHATS_LABEL = "Unassociated Codex chats";
const CODEX_CHATS_KEY = "\0codex-chats";
const ENV_ID_RE = /^env_[a-z0-9]+$/i;

interface ProjectCatalogEntry {
  id: string;
  name: string;
  kind: "personal" | "standard";
  paths: readonly string[];
}

function normalizeProjectPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) return "";
  const expanded =
    trimmed === "~"
      ? NodeOS.homedir()
      : trimmed.startsWith("~/")
        ? NodePath.join(NodeOS.homedir(), trimmed.slice(2))
        : trimmed;
  if (!NodePath.isAbsolute(expanded)) return "";
  const normalized = NodePath.normalize(expanded);
  if (normalized === "/") return "/";
  return normalized.replace(/\/+$/, "");
}

export function extractCwdFromLine(line: string): string {
  if (!line.includes('"cwd"')) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null) return "";
  const record = parsed as Record<string, unknown>;
  if (typeof record.cwd === "string") {
    return normalizeProjectPath(record.cwd);
  }
  const payload = record.payload;
  if (typeof payload === "object" && payload !== null) {
    const cwd = (payload as Record<string, unknown>).cwd;
    if (typeof cwd === "string") return normalizeProjectPath(cwd);
  }
  return "";
}

/**
 * Claude stores sessions under `.../projects/<dashed-cwd>/...`.
 * Pi stores them under `.../sessions/<dashed-cwd>/...`.
 * Dashed encoding is lossy for hyphenated folders — prefer transcript cwd.
 */
export function inferProjectPathFromTranscriptPath(filePath: string): string {
  const encoded =
    encodedDirAfterMarker(filePath, "projects") ||
    encodedDirAfterMarker(filePath, "sessions");
  if (encoded.length === 0 || !encoded.startsWith("-")) return "";
  return normalizeProjectPath(encoded.replaceAll("-", "/"));
}

function encodedDirAfterMarker(filePath: string, marker: string): string {
  const parts = filePath.split(NodePath.sep);
  const index = parts.lastIndexOf(marker);
  if (index === -1) return "";
  const encoded = parts[index + 1];
  if (!encoded || encoded.endsWith(".jsonl")) return "";
  return encoded;
}

export function fallbackProjectName(projectPath: string): string {
  if (projectPath === CURSOR_ACCOUNT_PROJECT_PATH) return "Cursor (account)";
  if (projectPath.length === 0) return UNKNOWN_PROJECT_LABEL;
  const base = NodePath.basename(projectPath);
  return base.length > 0 ? base : projectPath;
}

function pathEqualsOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function catalogFromBbProjects(
  projects: readonly {
    id: string;
    name: string;
    kind: string;
    sources: readonly { path: string }[];
  }[],
): ProjectCatalogEntry[] {
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    kind: project.kind === "personal" ? "personal" : "standard",
    paths: project.sources
      .map((source) => normalizeProjectPath(source.path))
      .filter((path) => path.length > 0),
  }));
}

function matchProjectCatalog(
  projectPath: string,
  catalog: readonly ProjectCatalogEntry[],
): ProjectCatalogEntry | null {
  if (projectPath.length === 0) return null;
  let best: ProjectCatalogEntry | null = null;
  let bestLength = -1;
  for (const project of catalog) {
    for (const path of project.paths) {
      if (!pathEqualsOrUnder(projectPath, path)) continue;
      // A personal project rooted at $HOME would swallow every local path.
      if (project.kind === "personal" && projectPath !== path) continue;
      if (path.length > bestLength) {
        best = project;
        bestLength = path.length;
      }
    }
  }
  return best;
}

function matchProjectByFolder(
  folder: string,
  catalog: readonly ProjectCatalogEntry[],
): ProjectCatalogEntry | null {
  if (folder.length === 0 || folder === UNKNOWN_PROJECT_LABEL) return null;
  if (ENV_ID_RE.test(folder)) return null;
  const hits = catalog.filter((project) => {
    if (project.kind !== "standard") return false;
    if (project.name === folder) return true;
    return project.paths.some((path) => NodePath.basename(path) === folder);
  });
  return hits.length === 1 ? hits[0] : null;
}

function addProjectTotals(target: ProjectTotals, row: ProjectTotals): void {
  target.costUsd += row.costUsd;
  target.totalTokens += row.totalTokens;
  target.records += row.records;
}

export function applyProjectCatalog(
  rows: readonly ProjectTotals[],
  catalog: readonly ProjectCatalogEntry[],
): ProjectTotals[] {
  const merged = new Map<string, ProjectTotals>();
  const codexRoot = normalizeProjectPath(
    NodePath.join(NodeOS.homedir(), "Documents", "Codex"),
  );

  for (const row of rows) {
    if (row.projectPath === CURSOR_ACCOUNT_PROJECT_PATH) {
      const existing = merged.get(CURSOR_ACCOUNT_PROJECT_PATH);
      if (existing) {
        addProjectTotals(existing, row);
      } else {
        merged.set(CURSOR_ACCOUNT_PROJECT_PATH, {
          ...row,
          project: "Cursor (account)",
          projectPath: CURSOR_ACCOUNT_PROJECT_PATH,
          threadId: null,
        });
      }
      continue;
    }
    if (codexRoot.length > 0 && pathEqualsOrUnder(row.projectPath, codexRoot)) {
      const existing = merged.get(CODEX_CHATS_KEY);
      if (existing) {
        addProjectTotals(existing, row);
        continue;
      }
      merged.set(CODEX_CHATS_KEY, {
        project: CODEX_CHATS_LABEL,
        projectPath: codexRoot,
        threadId: null,
        costUsd: row.costUsd,
        totalTokens: row.totalTokens,
        records: row.records,
        costShare: 0,
      });
      continue;
    }

    const folder = fallbackProjectName(row.projectPath);
    const match =
      matchProjectCatalog(row.projectPath, catalog) ??
      matchProjectByFolder(folder, catalog);
    const existing = merged.get(folder);
    if (existing) {
      addProjectTotals(existing, row);
      if (match) {
        existing.project = match.name;
        existing.projectPath = match.paths[0] ?? existing.projectPath;
      }
      continue;
    }
    merged.set(folder, {
      project: match?.name ?? folder,
      projectPath: match ? (match.paths[0] ?? row.projectPath) : row.projectPath,
      threadId: null,
      costUsd: row.costUsd,
      totalTokens: row.totalTokens,
      records: row.records,
      costShare: 0,
    });
  }

  return [...merged.values()];
}

function isBbManagedWorktreePath(projectPath: string): boolean {
  const parts = projectPath.split(NodePath.sep);
  const index = parts.lastIndexOf("worktrees");
  if (index <= 0 || parts[index - 1] !== ".bb") return false;
  return ENV_ID_RE.test(parts[index + 1] ?? "");
}

function environmentIdFromPersonalWorkspace(
  projectPath: string,
): string | null {
  const parts = projectPath.split(NodePath.sep);
  const index = parts.lastIndexOf("personal-workspaces");
  if (index === -1) return null;
  const id = parts[index + 1];
  return id && ENV_ID_RE.test(id) ? id : null;
}

export function environmentIdFromProjectRow(row: {
  project: string;
  projectPath: string;
}): string | null {
  if (isBbManagedWorktreePath(row.projectPath)) return null;
  const fromWorkspace = environmentIdFromPersonalWorkspace(row.projectPath);
  if (fromWorkspace) return fromWorkspace;
  if (ENV_ID_RE.test(row.project)) return row.project;
  const folder = fallbackProjectName(row.projectPath);
  return ENV_ID_RE.test(folder) ? folder : null;
}

export function applyEnvironmentThreads(
  rows: readonly ProjectTotals[],
  threadsByEnv: {
    get(environmentId: string): { threadId: string; title: string } | undefined;
  },
): ProjectTotals[] {
  return rows.map((row) => {
    const environmentId = environmentIdFromProjectRow(row);
    if (!environmentId) return row;
    const thread = threadsByEnv.get(environmentId);
    if (!thread) return row;
    return {
      ...row,
      project: thread.title,
      threadId: thread.threadId,
    };
  });
}

export function finalizeProjectRows(
  rows: readonly ProjectTotals[],
  totalCostUsd: number,
): ProjectTotals[] {
  return rows
    .map((row) => ({
      ...row,
      costShare: totalCostUsd === 0 ? 0 : row.costUsd / totalCostUsd,
    }))
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd ||
        b.totalTokens - a.totalTokens ||
        a.project.localeCompare(b.project),
    );
}
