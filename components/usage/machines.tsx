import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowDown01Icon, ComputerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { MachineSummary, UsageChartMetric } from "../../lib/types";
import { formatAge, formatTokens, formatUsd } from "../../lib/format";

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const EXCLUDED_STORAGE_KEY = "bb-usage-page:excluded-machines";

function readExcludedMachines(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(EXCLUDED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string").slice(0, 256)
      : [];
  } catch {
    return [];
  }
}

function writeExcludedMachines(ids: readonly string[]): void {
  try {
    if (ids.length === 0) globalThis.localStorage?.removeItem(EXCLUDED_STORAGE_KEY);
    else globalThis.localStorage?.setItem(EXCLUDED_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Private mode or storage disabled: the choice lasts for this session.
  }
}

/**
 * Machines the viewer unchecked, remembered per browser. Exclusions (rather
 * than a selection) keep newly enrolled machines counted by default.
 */
export function useExcludedMachines(): [string[], (next: string[]) => void] {
  const [excluded, setExcluded] = useState(readExcludedMachines);
  const update = useCallback((next: string[]) => {
    writeExcludedMachines(next);
    setExcluded(next);
  }, []);
  return [excluded, update];
}

function machineNote(machine: MachineSummary): string | null {
  if (machine.status === "stale") {
    return `${machine.connected ? "Unreachable" : "Offline"} · last scanned ${formatAge(machine.scannedAt)}`;
  }
  if (machine.status === "unavailable") {
    return machine.connected ? "Couldn't be scanned" : "Offline · not scanned yet";
  }
  if (machine.status === "skipped" && !machine.connected) {
    return machine.scannedAt
      ? `Offline · last scanned ${formatAge(machine.scannedAt)}`
      : "Offline";
  }
  return null;
}

export function MachinePicker({
  machines,
  excluded,
  onChange,
  metric,
  cursorIncluded,
}: {
  machines: readonly MachineSummary[];
  excluded: readonly string[];
  onChange: (excluded: string[]) => void;
  metric: UsageChartMetric;
  cursorIncluded: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const excludedSet = new Set(excluded);
  const selectedCount = machines.filter((machine) => !excludedSet.has(machine.id)).length;
  const allSelected = selectedCount === machines.length;
  const attention = machines.some(
    (machine) =>
      !excludedSet.has(machine.id) &&
      (machine.status === "stale" || machine.status === "unavailable"),
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const toggle = (id: string) => {
    const next = new Set(excludedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Drop ids of machines that no longer exist so storage stays tidy.
    const known = new Set(machines.map((machine) => machine.id));
    onChange([...next].filter((entry) => known.has(entry)));
  };

  const label = allSelected
    ? "All machines"
    : selectedCount === 1
      ? machines.find((machine) => !excludedSet.has(machine.id))?.name ?? "1 machine"
      : `${selectedCount} of ${machines.length} machines`;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex max-w-56 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <HugeiconsIcon icon={ComputerIcon} size={14} className="shrink-0" />
        <span className="truncate text-foreground">{label}</span>
        {attention ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-amber-500"
            aria-label="A selected machine is showing older data"
          />
        ) : null}
        <HugeiconsIcon icon={ArrowDown01Icon} size={12} className="shrink-0" />
      </button>
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label="Machines to include"
          className="absolute right-0 z-20 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-background p-1 shadow-lg"
        >
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-xs font-medium text-foreground">Machines</span>
            <button
              type="button"
              disabled={allSelected}
              onClick={() => onChange([])}
              className="cursor-pointer rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:text-muted-foreground"
            >
              Select all
            </button>
          </div>
          <ul className="flex flex-col">
            {machines.map((machine) => {
              const checked = !excludedSet.has(machine.id);
              const isLastChecked = checked && selectedCount === 1;
              const note = machineNote(machine);
              return (
                <li key={machine.id}>
                  <label
                    title={machine.message ?? undefined}
                    className={cn(
                      "flex items-start gap-2 rounded-sm px-2 py-1.5 text-sm",
                      isLastChecked ? "cursor-default" : "cursor-pointer hover:bg-muted",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isLastChecked}
                      onChange={() => toggle(machine.id)}
                      aria-describedby={note ? `${panelId}-${machine.id}` : undefined}
                      className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-foreground disabled:cursor-default"
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-foreground">{machine.name}</span>
                      {machine.local ? (
                        <span className="text-xs text-muted-foreground">
                          Runs the bb server
                        </span>
                      ) : null}
                      {note ? (
                        <span
                          id={`${panelId}-${machine.id}`}
                          className={cn(
                            "text-xs",
                            checked && machine.status !== "skipped"
                              ? "text-amber-700 dark:text-amber-300"
                              : "text-muted-foreground",
                          )}
                        >
                          {note}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {machine.status === "unavailable" ||
                      (machine.status === "skipped" && machine.scannedAt === null)
                        ? "—"
                        : metric === "cost"
                          ? formatUsd(machine.costUsd)
                          : formatTokens(machine.totalTokens)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {cursorIncluded ? (
            <p className="border-t border-border px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
              Cursor usage is account-wide, so it counts whichever machines are selected.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A notice for each selected machine whose numbers are old or missing. */
export function MachineNotices({ machines }: { machines: readonly MachineSummary[] }) {
  return machines
    .filter(
      (machine) =>
        machine.selected && (machine.status === "stale" || machine.status === "unavailable"),
    )
    .map((machine) => (
      <div
        key={machine.id}
        role="status"
        className="rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
      >
        {machine.status === "stale"
          ? `${machine.name} ${machine.connected ? "couldn't be reached" : "is offline"}. Showing its last scan from ${formatAge(machine.scannedAt)}.`
          : `${machine.name} ${machine.connected ? "couldn't be scanned" : "is offline and hasn't been scanned yet"}, so its usage isn't included.`}
        {machine.connected && machine.message ? (
          <span className="mt-1 block text-xs opacity-80">{machine.message}</span>
        ) : null}
      </div>
    ));
}
