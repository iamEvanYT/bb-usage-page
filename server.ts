import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { formatAge, isValidTimeZone, makeWindow } from "./lib/format";
import { hostContract, machineProviders } from "./lib/host-contract";
import {
  MachineCollector,
  mergeSourceReports,
  type MachineInfo,
} from "./lib/machines";
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
import { reportSources, UsageScanner } from "./lib/scan";
import { combineScans, mergeSummary } from "./lib/summary";
import { ThreadResolver } from "./lib/threads";
import type { MergedUsage, ProjectTotals, UsageProviderKind } from "./lib/types";

const USAGE_COMMAND = "bb usage show [--days 7|30|90] [--force]";
/** A first scan of a large transcript folder on another machine can be slow. */
const REMOTE_SCAN_TIMEOUT_MS = 5 * 60_000;
const REMOTE_DETECT_TIMEOUT_MS = 15_000;
/** Host lifecycle phases with no machine behind them any more. */
const GONE_HOST_PHASES = new Set(["destroyed", "removing"]);

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
        /**
         * bb machine ids to leave out. Exclusions (not inclusions) keep newly
         * enrolled machines counted by default.
         */
        excludeMachineIds: z.array(z.string().min(1).max(200)).max(256).optional(),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Lists every bb machine, the server's own first. Without a host list (or
 * before the server's daemon enrolls) only the server's machine is listed.
 */
function machineLister(bb: BbPluginApi): () => Promise<MachineInfo[]> {
  let primaryHostId: Promise<string | null> | null = null;
  return async () => {
    primaryHostId ??= bb.sdk.system
      .config()
      .then((config) => config.primaryHostId)
      .catch(() => {
        primaryHostId = null; // Ask again next time.
        return null;
      });
    const localId = await primaryHostId;
    let hosts: Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>> = [];
    try {
      hosts = await bb.sdk.hosts.list();
    } catch (error) {
      bb.log.warn(`bb machine list unavailable: ${errorMessage(error)}`);
    }
    const remote = hosts
      .filter((host) => host.id !== localId && !GONE_HOST_PHASES.has(host.lifecycle.phase))
      .map((host) => ({
        id: host.id,
        name: host.name,
        local: false,
        connected: host.status === "connected",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const local: MachineInfo = {
      id: localId ?? "local",
      name: hosts.find((host) => host.id === localId)?.name ?? NodeOS.hostname(),
      local: true,
      connected: true,
    };
    return [local, ...remote];
  };
}

function cliReport(merged: MergedUsage): string {
  const cursorSource = merged.sources.find((source) => source.provider === "cursor");
  const cursorWarning =
    cursorSource && cursorSource.status !== "ok"
      ? `Warning: Cursor usage is ${cursorSource.status}: ${
          cursorSource.message || "source unavailable."
        }`
      : null;
  const cacheLabel = merged.cache.summaryHit
    ? "summary cache"
    : `${merged.cache.fileHits} file hits / ${merged.cache.filesParsed} parsed`;
  const machineState = (machine: MergedUsage["machines"][number]) =>
    machine.status === "ok"
      ? `scanned ${formatAge(machine.scannedAt)}`
      : machine.status === "stale"
        ? `unreachable, last scanned ${formatAge(machine.scannedAt)}`
        : "unavailable";
  const machineLines =
    merged.machines.length > 1
      ? [
          "Machines:",
          ...merged.machines.map(
            (machine) =>
              `  ${machine.name}${machine.local ? " (bb server)" : ""}: $${machine.costUsd.toFixed(2)} (${machine.totalTokens} tokens) · ${machineState(machine)}`,
          ),
          ...merged.machines.flatMap((machine) =>
            machine.message ? [`Warning: ${machine.name}: ${machine.message}`] : [],
          ),
        ]
      : [];

  const lines = [
    `Usage ${merged.sinceDay} to ${merged.untilDay}`,
    `Raw token cost: $${merged.costUsd.toFixed(2)}`,
    ...(cursorWarning ? [cursorWarning] : []),
    ...merged.providers.map(
      (provider) =>
        `  ${provider.provider}: $${provider.costUsd.toFixed(2)} (${provider.totalTokens} tokens)`,
    ),
    ...machineLines,
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
  return `${lines.join("\n")}\n`;
}

export default async function plugin(bb: BbPluginApi) {
  // The SDK has no plugin-directory accessor, but bb keeps the plugin database
  // at <bb data dir>/plugins/<plugin id>/data.db. Keeping the JSON caches next
  // to it puts them in this plugin's own directory and respects a non-default
  // bb data dir. Opening the database creates an empty data.db as a side effect.
  const dataDir = NodePath.dirname(bb.storage.database().name);
  const log = (message: string) => bb.log.info(message);
  const scanner = new UsageScanner({ dataDir, log });
  const threadResolver = new ThreadResolver();
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  const listMachines = machineLister(bb);

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

  const collector = new MachineCollector({
    dataDir,
    log,
    listMachines,
    async scanLocal(request) {
      const current = await preferences();
      return scanner.readScan({
        ...request,
        cursor: {
          enabled: request.providers.includes("cursor"),
          databasePath: current.cursorDatabasePath || undefined,
        },
      });
    },
    scanRemote(hostId, request) {
      return hostClient.call(
        "scan",
        {
          sinceDay: request.sinceDay,
          untilDay: request.untilDay,
          timeZone: request.timeZone,
          force: request.force,
          providers: machineProviders(request.providers),
          claudeDirs: [...request.claudeDirs],
        },
        { hostId, timeoutMs: REMOTE_SCAN_TIMEOUT_MS },
      );
    },
  });

  /** Scan every selected machine and merge them into one usage summary. */
  async function readUsage(input: {
    sinceDay: string;
    untilDay: string;
    timeZone: string;
    force: boolean;
    includeThreads?: boolean;
    excludeMachineIds?: readonly string[];
  }): Promise<MergedUsage> {
    const started = Date.now();
    const current = await preferences();
    const providers = enabledProviders(current);
    const { parts, machines } = await collector.collect(
      {
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        timeZone: input.timeZone,
        force: input.force,
        providers,
        claudeDirs: current.claudeDirs,
      },
      { excludeMachineIds: input.excludeMachineIds },
    );
    const combined = combineScans(parts, input, {
      scanDurationMs: Date.now() - started,
      providers,
    });
    return resolveUsage(
      {
        ...mergeSummary(combined.summary),
        cache: combined.cache,
        machines: machines.map((machine) => ({
          ...machine,
          ...(combined.totalsByMachine.get(machine.id) ?? { costUsd: 0, totalTokens: 0 }),
        })),
      },
      providers,
      input.includeThreads === true,
    );
  }

  async function resolveUsage(
    merged: MergedUsage,
    providers: readonly UsageProviderKind[],
    includeThreads: boolean,
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
        bb.log.warn(`Thread usage titles unavailable: ${errorMessage(error)}`);
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

  /** Where each provider's data was found, on every reachable machine. */
  async function reportSourcesEverywhere(current: UsagePreferences) {
    const machines = await listMachines();
    const reports = await Promise.all(
      machines.map(async (machine) => {
        if (machine.local) {
          const report = await reportSources({
            claudeDirs: current.claudeDirs,
            cursor: { databasePath: current.cursorDatabasePath },
          });
          return { machine, report };
        }
        if (!machine.connected) return { machine, report: null };
        try {
          const report = await hostClient.call(
            "detect",
            { claudeDirs: current.claudeDirs },
            { hostId: machine.id, timeoutMs: REMOTE_DETECT_TIMEOUT_MS },
          );
          return { machine, report };
        } catch (error) {
          log(`usage source detection failed on ${machine.name}: ${errorMessage(error)}`);
          return { machine, report: null };
        }
      }),
    );
    return mergeSourceReports(current.claudeDirs, reports);
  }

  bb.rpc.register(rpcContract, {
    getUsage({ force, ...input }) {
      return readUsage({ ...input, force: force === true });
    },
    async getPreferences() {
      const current = await preferences();
      return { preferences: current, ...(await reportSourcesEverywhere(current)) };
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

  bb.onDispose(async () => {
    await Promise.all([scanner.flush(), collector.flush()]);
  });

  bb.cli.register({
    name: "usage",
    summary: "Show Claude / Codex / Pi / Cursor / OpenCode / Devin usage totals",
    commands: [
      {
        name: "show",
        summary: "Print usage for a window (default 30 days) across every bb machine",
        usage: USAGE_COMMAND,
      },
    ],
    async run(argv) {
      const options = parseCliOptions(argv);
      if ("error" in options) {
        return { exitCode: 2, stderr: `${options.error}\n` };
      }
      const merged = await readUsage({
        ...makeWindow(options.days),
        force: options.force,
      });
      return { exitCode: 0, stdout: cliReport(merged) };
    },
  });
}
