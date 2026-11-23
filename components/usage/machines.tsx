import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ArrowDown01Icon, ComputerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Drawer, DrawerContent, DrawerTitle } from "../ui/drawer";
import { useIsCompactViewport } from "../ui/hooks/use-compact-viewport";
import type { MachineSummary, UsageChartMetric } from "../../lib/types";
import { formatAge, formatTokens, formatUsd } from "../../lib/format";
import { cn } from "../../lib/utils";

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

/** Sizes for the desktop popover and the larger touch bottom sheet. */
const LIST_CLASSES = {
  popover: {
    header: "px-2 py-1.5",
    title: "text-xs",
    selectAll: "px-1.5 py-0.5 text-xs",
    row: "gap-2 px-2 py-1.5 text-sm",
    checkbox: "size-3.5",
    detail: "text-xs",
    footer: "px-2 pt-1.5 pb-1 text-xs",
  },
  sheet: {
    header: "px-4 py-2",
    title: "text-base",
    selectAll: "-mr-2 p-2 text-sm",
    row: "gap-3 px-4 py-3 text-base",
    checkbox: "size-5",
    detail: "text-sm",
    footer: "mx-4 pt-3 text-sm",
  },
} as const;

interface MachineListProps {
  machines: readonly MachineSummary[];
  excluded: ReadonlySet<string>;
  onChange: (excluded: string[]) => void;
  metric: UsageChartMetric;
  cursorIncluded: boolean;
  /** Prefix for element ids that tie notes to their checkboxes. */
  idPrefix: string;
  variant: keyof typeof LIST_CLASSES;
}

/** Checkbox rows with Select all, shared by the popover and the bottom sheet. */
function MachineList({
  machines,
  excluded,
  onChange,
  metric,
  cursorIncluded,
  idPrefix,
  variant,
}: MachineListProps) {
  const sizes = LIST_CLASSES[variant];
  const selectedCount = machines.filter((machine) => !excluded.has(machine.id)).length;
  const toggle = (id: string) => {
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Drop ids of machines that no longer exist so storage stays tidy.
    const known = new Set(machines.map((machine) => machine.id));
    onChange([...next].filter((entry) => known.has(entry)));
  };

  return (
    <>
      <div className={cn("flex items-center justify-between", sizes.header)}>
        <span className={cn("font-medium text-foreground", sizes.title)}>
          Machines
        </span>
        <button
          type="button"
          disabled={selectedCount === machines.length}
          onClick={() => onChange([])}
          className={cn(
            "cursor-pointer rounded-sm text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-40 disabled:hover:text-muted-foreground",
            sizes.selectAll,
          )}
        >
          Select all
        </button>
      </div>
      <ul className="flex flex-col">
        {machines.map((machine) => {
          const checked = !excluded.has(machine.id);
          const isLastChecked = checked && selectedCount === 1;
          const note = machineNote(machine);
          const noteId = `${idPrefix}-${machine.id}`;
          return (
            <li key={machine.id}>
              <label
                title={machine.message ?? undefined}
                className={cn(
                  "flex items-start rounded-sm",
                  sizes.row,
                  isLastChecked ? "cursor-default" : "cursor-pointer hover:bg-muted",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isLastChecked}
                  onChange={() => toggle(machine.id)}
                  aria-describedby={note ? noteId : undefined}
                  className={cn(
                    "mt-0.5 shrink-0 cursor-pointer accent-foreground disabled:cursor-default",
                    sizes.checkbox,
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-foreground">{machine.name}</span>
                  {machine.local ? (
                    <span className={cn("text-muted-foreground", sizes.detail)}>
                      Runs the bb server
                    </span>
                  ) : null}
                  {note ? (
                    <span
                      id={noteId}
                      className={cn(
                        sizes.detail,
                        checked && machine.status !== "skipped"
                          ? "text-amber-700 dark:text-amber-300"
                          : "text-muted-foreground",
                      )}
                    >
                      {note}
                    </span>
                  ) : null}
                </span>
                <span
                  className={cn("shrink-0 text-muted-foreground tabular-nums", sizes.detail)}
                >
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
        <p
          className={cn("border-t border-border text-muted-foreground", sizes.footer)}
        >
          Cursor usage is account-wide, so it counts whichever machines are selected.
        </p>
      ) : null}
    </>
  );
}

/**
 * Chooses which machines count. A popover on wide screens; a bottom sheet on
 * phone-sized screens, where an anchored popover would run off the edge.
 */
export function MachinePicker({
  machines,
  excluded,
  onChange,
  metric,
  cursorIncluded,
  className,
}: {
  machines: readonly MachineSummary[];
  excluded: readonly string[];
  onChange: (excluded: string[]) => void;
  metric: UsageChartMetric;
  cursorIncluded: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const compact = useIsCompactViewport();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const excludedSet = new Set(excluded);
  const selected = machines.filter((machine) => !excludedSet.has(machine.id));
  const attention = selected.some(
    (machine) => machine.status === "stale" || machine.status === "unavailable",
  );
  const label =
    selected.length === machines.length ? (
      <>
        <span className="sm:hidden">All</span>
        <span className="max-sm:hidden">All machines</span>
      </>
    ) : selected.length === 1 ? (
      selected[0]!.name
    ) : (
      `${selected.length} of ${machines.length}`
    );

  // Outside clicks and Escape close the desktop popover; the sheet handles its own.
  useEffect(() => {
    if (!open || compact) return;
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
  }, [open, compact]);

  const list = (
    <MachineList
      machines={machines}
      excluded={excludedSet}
      onChange={onChange}
      metric={metric}
      cursorIncluded={cursorIncluded}
      idPrefix={panelId}
      variant={compact ? "sheet" : "popover"}
    />
  );

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup={compact ? "dialog" : "true"}
        aria-expanded={open}
        aria-label={`Machines: ${selected.length === machines.length ? "all" : selected.map((machine) => machine.name).join(", ")}`}
        aria-controls={open && !compact ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground hover:text-foreground sm:max-w-56 max-md:pointer-coarse:h-10 max-md:pointer-coarse:text-sm"
      >
        <HugeiconsIcon icon={ComputerIcon} size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left text-foreground">{label}</span>
        {attention ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-amber-500"
            aria-label="A selected machine is showing older data"
          />
        ) : null}
        <HugeiconsIcon icon={ArrowDown01Icon} size={12} className="shrink-0" />
      </button>
      {compact ? (
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent aria-describedby={undefined}>
            <DrawerTitle className="sr-only">Machines to include</DrawerTitle>
            <div className="overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))]">
              {list}
            </div>
          </DrawerContent>
        </Drawer>
      ) : open ? (
        <div
          id={panelId}
          role="group"
          aria-label="Machines to include"
          className="absolute right-0 z-20 mt-1 w-80 rounded-md border border-border bg-background p-1 shadow-lg"
        >
          {list}
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
