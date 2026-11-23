import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { MACHINE_SCANS_CACHE_FILE, usageDataPath } from "./plugin-data";
import type { SourceReport } from "./scan";
import type { ScanPart } from "./summary";
import {
  PROVIDER_ORDER,
  type MachineScan,
  type MachineSummary,
  type UsageProviderKind,
} from "./types";

/** Reuse a remote machine's scan this long before asking it again. */
const REMOTE_HOT_TTL_MS = 15_000;
const MACHINE_SCANS_CACHE_VERSION = 1;

export interface MachineInfo {
  id: string;
  name: string;
  /** The machine running the bb server; scanned in-process. */
  local: boolean;
  connected: boolean;
}

export interface MachineScanRequest {
  sinceDay: string;
  untilDay: string;
  timeZone: string;
  force: boolean;
  providers: readonly UsageProviderKind[];
  claudeDirs: readonly string[];
}

export interface MachineCollectorDeps {
  dataDir: string;
  listMachines(): Promise<MachineInfo[]>;
  scanLocal(request: MachineScanRequest): Promise<MachineScan>;
  scanRemote(machineId: string, request: MachineScanRequest): Promise<MachineScan>;
  log?: (message: string) => void;
}

/** A machine's summary before its window totals are known. */
export type CollectedMachine = Omit<MachineSummary, "costUsd" | "totalTokens">;

export interface CollectResult {
  machines: CollectedMachine[];
  /** Scans to combine, the server's machine first. */
  parts: ScanPart[];
}

interface CachedScan {
  /** `requestKey` of the request that produced the scan. */
  key: string;
  fetchedAtMs: number;
  scan: MachineScan;
}

interface Collected {
  machine: CollectedMachine;
  part: ScanPart | null;
}

/** Settings that change what a scan contains, as opposed to how fresh it is. */
function requestKey(request: MachineScanRequest): string {
  return JSON.stringify([
    request.timeZone,
    request.providers.filter((provider) => provider !== "cursor").sort(),
    request.claudeDirs,
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scannedAt(scan: MachineScan | undefined): string | null {
  return scan ? new Date(scan.computedAtMs).toISOString() : null;
}

function isCachedScan(value: unknown): value is CachedScan {
  const entry = value as Partial<CachedScan> | null;
  return (
    typeof entry?.key === "string" &&
    typeof entry.fetchedAtMs === "number" &&
    Array.isArray(entry.scan?.buckets)
  );
}

/**
 * Collects one scan per bb machine: the server's own machine in-process and
 * every other machine through its host worker. The last scan from each
 * remote machine is kept in memory and on disk, so an offline machine still
 * contributes its most recent numbers.
 */
export class MachineCollector {
  private cache = new Map<string, CachedScan>();
  private loading: Promise<void> | null = null;
  private dirty = false;
  private inFlight = new Map<string, Promise<MachineScan>>();
  private readonly cachePath: string;

  constructor(private readonly deps: MachineCollectorDeps) {
    this.cachePath = usageDataPath(MACHINE_SCANS_CACHE_FILE, deps.dataDir);
  }

  async collect(
    request: MachineScanRequest,
    selection: { excludeMachineIds?: readonly string[] },
  ): Promise<CollectResult> {
    await this.ensureLoaded();
    const machines = await this.deps.listMachines();
    this.forgetRemovedMachines(machines);
    const excluded = new Set(selection.excludeMachineIds ?? []);
    const key = requestKey(request);

    const collected = await Promise.all(
      machines.map((machine) => {
        const selected = !excluded.has(machine.id);
        return machine.local
          ? this.collectLocal(machine, selected, request)
          : this.collectRemote(machine, selected, request, key);
      }),
    );
    await this.flush();

    const parts = collected.flatMap(({ part }) => (part ? [part] : []));
    return {
      machines: collected.map(({ machine }) => machine),
      // The server's machine carries pricing, which combineScans reads first.
      parts: parts.sort((a, b) => Number(b.carriesCursor) - Number(a.carriesCursor)),
    };
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await NodeFSP.mkdir(NodePath.dirname(this.cachePath), { recursive: true });
      await NodeFSP.writeFile(
        this.cachePath,
        JSON.stringify({
          version: MACHINE_SCANS_CACHE_VERSION,
          machines: Object.fromEntries(this.cache),
        }),
      );
    } catch (error) {
      this.dirty = true;
      this.deps.log?.(`could not persist machine scans: ${errorMessage(error)}`);
    }
  }

  /**
   * The server's machine is always read, selected or not: it also carries
   * Cursor's account-wide usage and the pricing table.
   */
  private async collectLocal(
    machine: MachineInfo,
    selected: boolean,
    request: MachineScanRequest,
  ): Promise<Collected> {
    const scan = await this.deps.scanLocal(request);
    return {
      machine: {
        ...machine,
        selected,
        status: selected ? "ok" : "skipped",
        scannedAt: scannedAt(scan),
        message: null,
      },
      part: { machineId: machine.id, machineName: machine.name, scan, selected, carriesCursor: true },
    };
  }

  private async collectRemote(
    machine: MachineInfo,
    selected: boolean,
    request: MachineScanRequest,
    key: string,
  ): Promise<Collected> {
    const cached = this.cache.get(machine.id);
    const result = (
      scan: MachineScan | undefined,
      status: MachineSummary["status"],
      message: string | null = null,
    ): Collected => ({
      machine: { ...machine, selected, status, scannedAt: scannedAt(scan), message },
      part: scan
        ? { machineId: machine.id, machineName: machine.name, scan, selected, carriesCursor: false }
        : null,
    });

    // Unselected machines are not scanned, but their last numbers still
    // show beside them in the picker.
    if (!selected) return result(cached?.scan, "skipped");

    const fresh =
      cached !== undefined &&
      machine.connected &&
      !request.force &&
      cached.key === key &&
      cached.scan.sinceDay <= request.sinceDay &&
      cached.scan.untilDay >= request.untilDay &&
      Date.now() - cached.fetchedAtMs < REMOTE_HOT_TTL_MS;
    if (fresh) return result(cached.scan, "ok");

    let failure = `${machine.name} is offline.`;
    if (machine.connected) {
      try {
        const scan = await this.scanRemote(machine.id, request, key);
        this.cache.set(machine.id, { key, fetchedAtMs: Date.now(), scan });
        this.dirty = true;
        return result(scan, "ok");
      } catch (error) {
        failure = errorMessage(error);
        this.deps.log?.(`usage scan failed on ${machine.name}: ${failure}`);
      }
    }

    if (!cached) return result(undefined, "unavailable", failure);
    const settingsNote =
      cached.key === key ? "" : " Its last scan used different settings.";
    return result(cached.scan, "stale", `${failure}${settingsNote}`);
  }

  /** Share one in-flight scan per machine and request between callers. */
  private scanRemote(
    machineId: string,
    request: MachineScanRequest,
    key: string,
  ): Promise<MachineScan> {
    const flightKey = `${machineId}\0${key}\0${request.force}`;
    let flight = this.inFlight.get(flightKey);
    if (!flight) {
      flight = this.deps
        .scanRemote(machineId, request)
        .finally(() => this.inFlight.delete(flightKey));
      this.inFlight.set(flightKey, flight);
    }
    return flight;
  }

  private forgetRemovedMachines(machines: readonly MachineInfo[]): void {
    const known = new Set(machines.map((machine) => machine.id));
    for (const id of this.cache.keys()) {
      if (known.has(id)) continue;
      this.cache.delete(id);
      this.dirty = true;
    }
  }

  private async ensureLoaded(): Promise<void> {
    this.loading ??= this.load();
    await this.loading;
  }

  private async load(): Promise<void> {
    let document: { version?: unknown; machines?: Record<string, unknown> };
    try {
      document = JSON.parse(await NodeFSP.readFile(this.cachePath, "utf8"));
    } catch {
      return; // No cache yet, or unreadable: machines are scanned again.
    }
    if (document.version !== MACHINE_SCANS_CACHE_VERSION) return;
    for (const [id, entry] of Object.entries(document.machines ?? {})) {
      if (isCachedScan(entry)) this.cache.set(id, entry);
    }
  }
}

/**
 * Combine each machine's source report for the settings page. Paths are
 * labeled with their machine when there is more than one; a Claude directory
 * counts as found when any machine has it. `null` marks an unreachable machine.
 */
export function mergeSourceReports(
  claudeDirs: readonly string[],
  reports: readonly { machine: MachineInfo; report: SourceReport | null }[],
): SourceReport & { machines: { name: string; checked: boolean }[] } {
  const label = (machine: MachineInfo, path: string) =>
    reports.length > 1 ? `${machine.name}: ${path}` : path;
  const found = new Set<string>();
  const detected = Object.fromEntries(
    PROVIDER_ORDER.map((provider) => [
      provider,
      reports.flatMap(({ machine, report }) =>
        (report?.detected[provider] ?? []).map((path) => label(machine, path)),
      ),
    ]),
  ) as SourceReport["detected"];
  for (const { report } of reports) {
    for (const dir of report?.claudeDirs ?? []) if (dir.found) found.add(dir.path);
  }
  return {
    detected,
    claudeDirs: claudeDirs.map((path) => ({ path, found: found.has(path) })),
    machines: reports.map(({ machine, report }) => ({
      name: machine.name,
      checked: report !== null,
    })),
  };
}
