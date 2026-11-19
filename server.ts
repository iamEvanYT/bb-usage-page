import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

import { isValidTimeZone, makeWindow } from "./lib/format";
import { USAGE_DATA_DIR } from "./lib/plugin-data";
import {
  applyProviderPreferences,
  enabledProviders,
  normalizePreferences,
  PREFERENCES_CHANNEL,
  PREFERENCES_KEY,
  type UsagePreferences,
} from "./lib/preferences";
import {
  applyEnvironmentThreads,
  applyProjectCatalog,
  catalogFromBbProjects,
  environmentIdFromProjectRow,
  finalizeProjectRows,
} from "./lib/projects";
import {
  mergedUsageSchema,
  preferencesViewSchema,
  usagePreferencesSchema,
} from "./lib/rpc-schema";
import { claudeDirStatus, detectProviderSources, UsageScanner } from "./lib/scan";
import { ThreadResolver } from "./lib/threads";
import type { MergedUsage, ProjectTotals, UsageProviderKind } from "./lib/types";

function displayPath(path: string): string {
  const home = NodeOS.homedir();
  return path === home || path.startsWith(`${home}${NodePath.sep}`)
    ? `~${path.slice(home.length)}`
    : path;
}

const USAGE_COMMAND = "bb usage show [--days 7|30|90] [--force]";

const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return (
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === value
      );
    },
    { message: "Invalid calendar date" },
  );

export const rpcContract = defineRpcContract({
  getUsage: {
    input: z
      .object({
        timeZone: z
          .string()
          .min(1)
          .refine((value) => isValidTimeZone(value), {
            message: "Invalid IANA time zone",
          }),
        sinceDay: daySchema,
        untilDay: daySchema,
        force: z.boolean().optional(),
        includeThreads: z.boolean().optional(),
      })
      .strict()
      .refine((value) => value.sinceDay <= value.untilDay, {
        message: "sinceDay must be on or before untilDay",
        path: ["sinceDay"],
      }),
    output: mergedUsageSchema,
  },
  getPreferences: {
    input: z.object({}).strict().optional(),
    output: preferencesViewSchema,
  },
  setPreferences: {
    input: usagePreferencesSchema,
    output: usagePreferencesSchema,
  },
  resetPreferences: {
    input: z.object({}).strict().optional(),
    output: usagePreferencesSchema,
  },
});

type UsageCliOptions =
  | { days: 7 | 30 | 90; force: boolean }
  | { error: string };

function parseCliOptions(argv: readonly string[]): UsageCliOptions {
  if (argv[0] !== "show") {
    return { error: `Expected \"show\". Usage: ${USAGE_COMMAND}` };
  }

  let days: 7 | 30 | 90 = 30;
  let force = false;
  let sawDays = false;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--days") {
      const value = argv[i + 1];
      if (
        sawDays ||
        value === undefined ||
        !["7", "30", "90"].includes(value)
      ) {
        return {
          error: `--days must be specified once as 7, 30, or 90. Usage: ${USAGE_COMMAND}`,
        };
      }
      days = Number(value) as 7 | 30 | 90;
      sawDays = true;
      i += 1;
    } else if (arg === "--force") {
      if (force) {
        return { error: `--force must not be repeated. Usage: ${USAGE_COMMAND}` };
      }
      force = true;
    } else {
      return { error: `Unknown argument: ${arg}. Usage: ${USAGE_COMMAND}` };
    }
  }

  return { days, force };
}

async function attachEnvironmentThreads(
  bb: BbPluginApi,
  rows: ProjectTotals[],
): Promise<ProjectTotals[]> {
  const envIds = [
    ...new Set(
      rows
        .map((row) => environmentIdFromProjectRow(row))
        .filter((id): id is string => id !== null),
    ),
  ];
  if (envIds.length === 0) return rows;

  const projectIds = new Set<string>();
  await Promise.all(
    envIds.map(async (environmentId) => {
      try {
        const environment = await bb.sdk.environments.get({ environmentId });
        projectIds.add(environment.projectId);
      } catch {
        // Destroyed environments stay unlabeled.
      }
    }),
  );
  if (projectIds.size === 0) return applyEnvironmentThreads(rows, new Map());

  const threadsByEnv = new Map<
    string,
    { threadId: string; title: string; attention: number; archived: boolean }
  >();
  await Promise.all(
    [...projectIds].map(async (projectId) => {
      try {
        const listed = await listProjectThreads(bb, projectId);
        for (const thread of listed) {
          if (!thread.environmentId || thread.deletedAt !== null) continue;
          const title = thread.title || thread.titleFallback;
          if (!title) continue;
          const next = {
            threadId: thread.id,
            title,
            attention: thread.latestAttentionAt,
            archived: thread.archivedAt !== null,
          };
          const current = threadsByEnv.get(thread.environmentId);
          if (current && !isPreferredThread(next, current)) continue;
          threadsByEnv.set(thread.environmentId, next);
        }
      } catch {
        // Thread list failures must not blank Model / Day / Project.
      }
    }),
  );

  return applyEnvironmentThreads(rows, threadsByEnv);
}

const THREAD_PAGE_SIZE = 200;
const THREAD_PAGE_CAP = 2000;

async function listProjectThreads(
  bb: BbPluginApi,
  projectId: string,
) {
  const out: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>> = [];
  for (const archived of [false, true] as const) {
    let offset = 0;
    while (offset < THREAD_PAGE_CAP) {
      const page = await bb.sdk.threads.list({
        projectId,
        includeHidden: true,
        ...(archived ? { archived: true } : {}),
        limit: THREAD_PAGE_SIZE,
        offset,
      });
      out.push(...page);
      if (page.length < THREAD_PAGE_SIZE) break;
      offset += page.length;
    }
  }
  return out;
}

function isPreferredThread(
  next: { archived: boolean; attention: number },
  current: { archived: boolean; attention: number },
): boolean {
  if (next.archived !== current.archived) return !next.archived;
  return next.attention > current.attention;
}

export default async function plugin(bb: BbPluginApi) {
  const scanner = new UsageScanner({
    dataDir: USAGE_DATA_DIR,
    log: (message) => bb.log.info(message),
  });
  const threadResolver = new ThreadResolver();

  let preferencesCache: Promise<UsagePreferences> | null = null;

  function preferences(): Promise<UsagePreferences> {
    preferencesCache ??= bb.storage.kv
      .get<unknown>(PREFERENCES_KEY)
      .then(normalizePreferences)
      .catch((error) => {
        preferencesCache = null;
        throw error;
      });
    return preferencesCache;
  }

  async function scanOptions() {
    const current = await preferences();
    const providers = enabledProviders(current);
    return {
      providers,
      claudeDirs: current.claudeDirs,
      cursor: {
        enabled: providers.includes("cursor"),
        databasePath: current.cursorDatabasePath || undefined,
      },
    };
  }

  async function resolveUsage(
    merged: MergedUsage,
    providers: readonly UsageProviderKind[],
    includeThreads = false,
  ): Promise<MergedUsage> {
    merged = applyProviderPreferences(merged, providers);
    let catalog: ReturnType<typeof catalogFromBbProjects> = [];
    try {
      catalog = catalogFromBbProjects(
        await bb.sdk.projects.list({ includePersonal: true }),
      );
    } catch {
      // Folder-name merge still runs without a live project list.
    }
    const projects = applyProjectCatalog(merged.projects, catalog);
    let threads = merged.threads;
    if (includeThreads) {
      try {
        threads = await threadResolver.resolve(bb, threads);
      } catch (error) {
        // Session IDs remain usable when the bb thread catalog is unavailable.
        bb.log.warn(`Thread usage titles unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      ...merged,
      threads,
      projects: finalizeProjectRows(
        await attachEnvironmentThreads(bb, projects),
        merged.costUsd,
      ),
    };
  }

  bb.rpc.register(rpcContract, {
    async getUsage({ sinceDay, untilDay, timeZone, force, includeThreads }) {
      const options = await scanOptions();
      const { merged } = await scanner.readSummary({
        sinceDay,
        untilDay,
        timeZone,
        force: force === true,
        ...options,
      });
      return resolveUsage(merged, options.providers, includeThreads);
    },
    async getPreferences() {
      const current = await preferences();
      const [detected, claudeDirs] = await Promise.all([
        detectProviderSources({
          cursorDatabasePath: current.cursorDatabasePath,
          claudeDirs: current.claudeDirs,
        }),
        claudeDirStatus(current.claudeDirs),
      ]);
      return {
        preferences: current,
        claudeDirs,
        detected: Object.fromEntries(
          Object.entries(detected).map(([provider, paths]) => [
            provider,
            paths.map(displayPath),
          ]),
        ) as typeof detected,
      };
    },
    async setPreferences(input) {
      const next = normalizePreferences(input);
      if (enabledProviders(next).length === 0) {
        throw new Error("Keep at least one provider enabled.");
      }
      await bb.storage.kv.set(PREFERENCES_KEY, next);
      preferencesCache = Promise.resolve(next);
      bb.realtime.publish(PREFERENCES_CHANNEL, null);
      return next;
    },
    async resetPreferences() {
      await bb.storage.kv.delete(PREFERENCES_KEY);
      const next = normalizePreferences(null);
      preferencesCache = Promise.resolve(next);
      bb.realtime.publish(PREFERENCES_CHANNEL, null);
      return next;
    },
  });

  bb.onDispose(() => scanner.flush());

  bb.cli.register({
    name: "usage",
    summary: "Show Claude / Codex / Pi / Cursor / OpenCode / Devin usage totals",
    commands: [
      {
        name: "show",
        summary: "Print usage for a window (default 30 days)",
        usage: "bb usage show [--days 7|30|90] [--force]",
      },
    ],
    async run(argv) {
      const options = parseCliOptions(argv);
      if ("error" in options) {
        return { exitCode: 2, stderr: `${options.error}\n` };
      }
      const { sinceDay, untilDay, timeZone } = makeWindow(options.days);
      const scan = await scanOptions();
      const { merged: scanned } = await scanner.readSummary({
        sinceDay,
        untilDay,
        timeZone,
        force: options.force,
        ...scan,
      });
      const merged = await resolveUsage(scanned, scan.providers);
      const cursorSource = merged.sources.find(
        (source) => source.provider === "cursor",
      );
      const cursorWarning =
        cursorSource && cursorSource.status !== "ok"
          ? `Warning: Cursor usage is ${cursorSource.status}: ${
              cursorSource.message || "source unavailable."
            }`
          : null;

      const cacheLabel = merged.cache.summaryHit
        ? "summary cache"
        : `${merged.cache.fileHits} file hits / ${merged.cache.filesParsed} parsed`;

      const lines = [
        `Usage ${sinceDay} to ${untilDay}`,
        `Raw token cost: $${merged.costUsd.toFixed(2)}`,
        ...(cursorWarning ? [cursorWarning] : []),
        ...merged.providers.map(
          (provider) =>
            `  ${provider.provider}: $${provider.costUsd.toFixed(2)} (${provider.totalTokens} tokens)`,
        ),
        ...(merged.projects.length > 0
          ? [
              "Projects:",
              ...merged.projects.map(
                (project) =>
                  `  ${project.project}: $${project.costUsd.toFixed(2)} (${project.totalTokens} tokens)`,
              ),
            ]
          : []),
        `Sessions: ${merged.sessions}`,
        `Scan: ${merged.scanDurationMs}ms · ${cacheLabel} · pricing ${merged.pricing.status}`,
      ];
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    },
  });
}
