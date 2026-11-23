import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import {
  AlertCircleIcon,
  Cancel01Icon,
  DragDropVerticalIcon,
  FolderIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { rpcContract } from "../../server";
import type { DetectedSource, MergedSourceReport } from "../../lib/machines";
import {
  MAX_CLAUDE_DIRS,
  normalizeClaudeDirs,
  type ProviderPreference,
  type UsagePreferences,
} from "../../lib/preferences";
import type { UsageProviderKind } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { PROVIDER_LABEL, ProviderMark } from "./providers";

type Detected = MergedSourceReport["detected"];
/** One line under a provider: a found location, or a hint when there is none. */
type SourceLine = { machine: string | null; text: string };
type DirStatus = ReadonlyMap<string, boolean>;
/** Where local data was looked for: one machine, every machine, or only reachable ones. */
type SearchScope = "single" | "all" | "reachable";

function notFoundLabel(provider: UsageProviderKind, scope: SearchScope): string {
  // Cursor's sign-in is only read on the machine running the bb server.
  if (provider === "cursor" || scope === "single") return "Not found on this machine";
  return scope === "all" ? "Not found on any machine" : "Not found on reachable machines";
}

const SETTLE_MS = 200;
const SETTLE_EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const RUBBER_BAND = 0.2;

const PROVIDER_HINT: Record<UsageProviderKind, string> = {
  claude: "Transcripts in each directory's projects folder",
  codex: "Sessions in ~/.codex/sessions",
  pi: "Sessions in ~/.pi and bb's Pi bridge",
  cursor: "Account usage from cursor.com",
  opencode: "OpenCode's local SQLite database",
  devin: "Devin CLI's local sessions.db",
};

export function ProviderSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [saved, setSaved] = useState<UsagePreferences | null>(null);
  const [draft, setDraft] = useState<UsagePreferences | null>(null);
  const [detected, setDetected] = useState<Detected | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<DirStatus | null>(null);
  const [searchScope, setSearchScope] = useState<SearchScope>("single");
  const [error, setError] = useState<string | null>(null);
  const saveSeq = useRef(0);

  const load = useCallback(async () => {
    try {
      const view = await rpc.call("getPreferences", {});
      setSaved(view.preferences);
      setDraft((current) => current ?? view.preferences);
      setDetected(view.detected);
      setClaudeStatus(new Map(view.claudeDirs.map((dir) => [dir.path, dir.found])));
      setSearchScope(
        view.machines.length <= 1
          ? "single"
          : view.machines.every((machine) => machine.checked)
            ? "all"
            : "reachable",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    (next: UsagePreferences, options?: { redetect?: boolean }) => {
      setDraft(next);
      setError(null);
      const seq = ++saveSeq.current;
      rpc
        .call("setPreferences", next)
        .then((result) => {
          if (seq !== saveSeq.current) return;
          setSaved(result);
          setDraft(result);
          if (options?.redetect) void load();
        })
        .catch((err: unknown) => {
          if (seq !== saveSeq.current) return;
          setDraft(saved);
          setError(
            `Couldn't save: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    },
    [load, rpc, saved],
  );

  const reset = () => {
    setError(null);
    const seq = ++saveSeq.current;
    rpc
      .call("resetPreferences", {})
      .then((result) => {
        if (seq !== saveSeq.current) return;
        setSaved(result);
        setDraft(result);
        void load();
      })
      .catch((err: unknown) => {
        if (seq !== saveSeq.current) return;
        setError(`Couldn't reset: ${err instanceof Error ? err.message : String(err)}`);
      });
  };

  if (!draft) {
    return error ? <ErrorNote message={error} /> : <ProviderListSkeleton />;
  }

  return (
    <div className="usage-page flex flex-col gap-2">
      <ProviderList
        preferences={draft}
        detected={detected}
        searchScope={searchScope}
        claudeStatus={claudeStatus}
        onChange={save}
        onReset={reset}
      />
      {error ? <ErrorNote message={error} /> : null}
    </div>
  );
}

function ProviderList({
  preferences,
  detected,
  searchScope,
  claudeStatus,
  onChange,
  onReset,
}: {
  preferences: UsagePreferences;
  detected: Detected | null;
  searchScope: SearchScope;
  claudeStatus: DirStatus | null;
  onChange: (next: UsagePreferences, options?: { redetect?: boolean }) => void;
  onReset: () => void;
}) {
  const items = preferences.providers;
  const enabledCount = items.filter((item) => item.enabled).length;
  const rowRefs = useRef(new Map<UsageProviderKind, HTMLLIElement>());
  const handleRefs = useRef(new Map<UsageProviderKind, HTMLButtonElement>());
  const [draggingId, setDraggingId] = useState<UsageProviderKind | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const focusAfterMove = useRef<UsageProviderKind | null>(null);
  const resetTransforms = useRef(false);
  const drag = useRef<{
    id: UsageProviderKind;
    pointerId: number;
    startY: number;
    from: number;
    to: number;
    rects: DOMRect[];
    ids: UsageProviderKind[];
    settling: boolean;
  } | null>(null);

  const commitOrder = useCallback(
    (from: number, to: number) => {
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setAnnouncement(
        `${PROVIDER_LABEL[moved.id]} moved to position ${to + 1} of ${next.length}.`,
      );
      onChange({ ...preferences, providers: next });
    },
    [items, onChange, preferences],
  );

  // Rows were offset with transforms while dragging; clear them before paint
  // once React has moved the DOM nodes into their new order.
  useLayoutEffect(() => {
    if (resetTransforms.current) {
      resetTransforms.current = false;
      for (const row of rowRefs.current.values()) {
        row.style.transition = "none";
        row.style.transform = "";
        void row.offsetHeight;
        row.style.transition = "";
      }
    }
    const focusId = focusAfterMove.current;
    if (focusId) {
      focusAfterMove.current = null;
      handleRefs.current.get(focusId)?.focus();
    }
  }, [items]);

  const offsetFor = (state: NonNullable<typeof drag.current>, to: number) => {
    const { rects, from } = state;
    if (to > from) return rects[to].bottom - rects[from].bottom;
    if (to < from) return rects[to].top - rects[from].top;
    return 0;
  };

  const onPointerDown = (
    id: UsageProviderKind,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const ids = items.map((item) => item.id);
    const from = ids.indexOf(id);
    drag.current = {
      id,
      pointerId: event.pointerId,
      startY: event.clientY,
      from,
      to: from,
      rects: ids.map((rowId) => rowRefs.current.get(rowId)!.getBoundingClientRect()),
      ids,
      settling: false,
    };
    document.body.style.cursor = "grabbing";
    setDraggingId(id);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.settling || event.pointerId !== state.pointerId) return;
    const { rects, from, ids } = state;
    const minDy = rects[0].top - rects[from].top;
    const maxDy = rects[rects.length - 1].bottom - rects[from].bottom;
    let dy = event.clientY - state.startY;
    if (dy < minDy) dy = minDy + (dy - minDy) * RUBBER_BAND;
    if (dy > maxDy) dy = maxDy + (dy - maxDy) * RUBBER_BAND;
    rowRefs.current.get(state.id)!.style.transform = `translate3d(0, ${dy}px, 0)`;

    const center = rects[from].top + rects[from].height / 2 + dy;
    let to = from;
    for (let i = from + 1; i < rects.length; i += 1) {
      if (center > rects[i].top + rects[i].height / 2) to = i;
    }
    for (let i = from - 1; i >= 0; i -= 1) {
      if (center < rects[i].top + rects[i].height / 2) to = i;
    }
    if (to === state.to) return;
    state.to = to;
    const shift = rects[from].height;
    ids.forEach((rowId, index) => {
      if (index === from) return;
      const offset =
        to > from && index > from && index <= to
          ? -shift
          : to < from && index < from && index >= to
            ? shift
            : 0;
      rowRefs.current.get(rowId)!.style.transform = offset
        ? `translate3d(0, ${offset}px, 0)`
        : "";
    });
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.settling || event.pointerId !== state.pointerId) return;
    state.settling = true;
    document.body.style.cursor = "";
    const row = rowRefs.current.get(state.id)!;
    const reduceMotion = globalThis.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    row.style.transition = reduceMotion
      ? "none"
      : `transform ${SETTLE_MS}ms ${SETTLE_EASE}`;
    row.style.transform = `translate3d(0, ${offsetFor(state, state.to)}px, 0)`;
    globalThis.setTimeout(
      () => {
        drag.current = null;
        setDraggingId(null);
        if (state.to === state.from) {
          row.style.transition = "";
          row.style.transform = "";
          return;
        }
        resetTransforms.current = true;
        commitOrder(state.from, state.to);
      },
      reduceMotion ? 0 : SETTLE_MS,
    );
  };

  const onHandleKeyDown = (
    id: UsageProviderKind,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    const from = items.findIndex((item) => item.id === id);
    const to =
      event.key === "ArrowUp"
        ? from - 1
        : event.key === "ArrowDown"
          ? from + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    if (to < 0 || to >= items.length || to === from) return;
    focusAfterMove.current = id;
    commitOrder(from, to);
  };

  const setEnabled = (id: UsageProviderKind, enabled: boolean) =>
    onChange({
      ...preferences,
      providers: items.map((item) => (item.id === id ? { ...item, enabled } : item)),
    });

  return (
    <>
      <ul className="overflow-hidden rounded-lg border border-border bg-card">
        {items.map((item, index) => (
          <ProviderRow
            key={item.id}
            item={item}
            first={index === 0}
            dragging={draggingId === item.id}
            shifting={draggingId !== null && draggingId !== item.id}
            detected={detected?.[item.id]}
            notFound={notFoundLabel(item.id, searchScope)}
            lockOn={item.enabled && enabledCount === 1}
            rowRef={(node) => {
              if (node) rowRefs.current.set(item.id, node);
              else rowRefs.current.delete(item.id);
            }}
            handleRef={(node) => {
              if (node) handleRefs.current.set(item.id, node);
              else handleRefs.current.delete(item.id);
            }}
            onPointerDown={(event) => onPointerDown(item.id, event)}
            onPointerMove={onPointerMove}
            onPointerEnd={onPointerEnd}
            onHandleKeyDown={(event) => onHandleKeyDown(item.id, event)}
            onEnabledChange={(enabled) => setEnabled(item.id, enabled)}
          >
            {item.id === "claude" ? (
              <ClaudeDirOptions
                dirs={preferences.claudeDirs}
                status={claudeStatus}
                onCommit={(claudeDirs) =>
                  onChange({ ...preferences, claudeDirs }, { redetect: true })
                }
              />
            ) : item.id === "cursor" ? (
              <CursorOptions
                value={preferences.cursorDatabasePath}
                onCommit={(cursorDatabasePath) =>
                  onChange({ ...preferences, cursorDatabasePath }, { redetect: true })
                }
              />
            ) : null}
          </ProviderRow>
        ))}
      </ul>
      <div className="flex items-start justify-between gap-4 px-0.5">
        <p
          id="usage-provider-reorder-hint"
          className="text-xs text-muted-foreground"
        >
          Drag the handle, or focus it and press the arrow keys, to change the
          order on the Usage page.
        </p>
        <button
          type="button"
          onClick={onReset}
          className="shrink-0 cursor-pointer text-xs text-muted-foreground underline-offset-2 transition-colors duration-150 hover:text-foreground hover:underline hover:duration-0 focus-visible:underline focus-visible:outline-none"
        >
          Reset to defaults
        </button>
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  );
}

function ProviderRow({
  item,
  first,
  dragging,
  shifting,
  detected,
  notFound,
  lockOn,
  rowRef,
  handleRef,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  onHandleKeyDown,
  onEnabledChange,
  children,
}: {
  item: ProviderPreference;
  first: boolean;
  dragging: boolean;
  shifting: boolean;
  detected: DetectedSource[] | undefined;
  notFound: string;
  lockOn: boolean;
  rowRef: (node: HTMLLIElement | null) => void;
  handleRef: (node: HTMLButtonElement | null) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerEnd: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onHandleKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onEnabledChange: (enabled: boolean) => void;
  children?: ReactNode;
}) {
  const label = PROVIDER_LABEL[item.id];
  const found = detected === undefined ? null : detected.length > 0;
  // One line per location, so every machine stays visible on narrow screens
  // instead of being cut off inside one joined line.
  const lines: SourceLine[] =
    detected === undefined
      ? [{ machine: null, text: PROVIDER_HINT[item.id] }]
      : found
        ? detected.map((source) => ({ machine: source.machine, text: source.path }))
        : [{ machine: null, text: `${notFound} · ${PROVIDER_HINT[item.id]}` }];

  return (
    <li
      ref={rowRef}
      className={cn(
        "relative bg-card",
        !first && "border-t border-border",
        dragging &&
          "z-10 rounded-md border-transparent shadow-lg ring-1 ring-border transition-shadow duration-150",
        shifting &&
          "transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
      )}
    >
      <div className="flex items-center gap-3 py-2.5 pr-3 pl-1.5">
        <button
          ref={handleRef}
          type="button"
          aria-label={`Reorder ${label}`}
          aria-describedby="usage-provider-reorder-hint"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onKeyDown={onHandleKeyDown}
          className={cn(
            "flex size-7 shrink-0 touch-none items-center justify-center rounded-md text-muted-foreground/60 transition-colors duration-150 hover:bg-state-hover hover:text-foreground hover:duration-0 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none max-md:pointer-coarse:size-10",
            dragging ? "cursor-grabbing text-foreground" : "cursor-grab",
          )}
        >
          <HugeiconsIcon icon={DragDropVerticalIcon} className="size-4" aria-hidden />
        </button>
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background transition-[opacity,filter] duration-150",
            !item.enabled && "opacity-50 grayscale",
          )}
        >
          <ProviderMark provider={item.id} className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "text-sm font-medium transition-colors duration-150",
              item.enabled ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          {lines.map((line) => (
            <span
              key={`${line.machine}\0${line.text}`}
              className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
              title={line.machine ? `${line.machine}: ${line.text}` : line.text}
            >
              {found !== null ? (
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    found ? "bg-emerald-500" : "bg-muted-foreground/40",
                  )}
                />
              ) : null}
              {line.machine ? (
                // The name gives way first so more of the path stays readable.
                <span className="max-w-[40%] shrink-0 truncate text-foreground/70">
                  {line.machine}
                </span>
              ) : null}
              <span className="min-w-0 truncate">{line.text}</span>
            </span>
          ))}
        </div>
        <Switch
          checked={item.enabled}
          disabled={lockOn}
          label={`Include ${label}`}
          title={lockOn ? "Keep at least one provider on" : undefined}
          onCheckedChange={onEnabledChange}
        />
      </div>
      {children ? <Expand open={item.enabled}>{children}</Expand> : null}
    </li>
  );
}

function Expand({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      <div className="min-h-0 overflow-hidden" inert={!open}>
        <div className="pr-3 pb-3 pl-[4.75rem]">{children}</div>
      </div>
    </div>
  );
}

function ClaudeDirOptions({
  dirs,
  status,
  onCommit,
}: {
  dirs: string[];
  status: DirStatus | null;
  onCommit: (dirs: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const full = dirs.length >= MAX_CLAUDE_DIRS;

  const add = () => {
    const [dir] = normalizeClaudeDirs([text]);
    if (!text.trim()) return;
    if (dirs.includes(dir)) {
      setProblem(`${dir} is already in the list.`);
      return;
    }
    onCommit([...dirs, dir]);
    setText("");
    setProblem(null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground">Directories</span>
      <ul className="overflow-hidden rounded-md border border-border bg-background">
        {dirs.map((dir, index) => {
          const found = status?.get(dir);
          return (
            <li
              key={dir}
              className={cn(
                "flex h-8 items-center gap-2 pr-1 pl-2.5",
                index > 0 && "border-t border-border",
              )}
            >
              <HugeiconsIcon
                icon={FolderIcon}
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
                title={dir}
              >
                {dir}
              </span>
              {found === false ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  No projects folder
                </span>
              ) : null}
              <button
                type="button"
                aria-label={`Stop scanning ${dir}`}
                title={dirs.length === 1 ? "Keep at least one directory" : undefined}
                disabled={dirs.length === 1}
                onClick={() => onCommit(dirs.filter((entry) => entry !== dir))}
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground hover:duration-0 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-30"
              >
                <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-1.5">
        <Input
          value={text}
          spellCheck={false}
          disabled={full}
          aria-label="Claude Code directory to add"
          placeholder="Path to another Claude Code config directory (e.g. ~/.claude-personal)"
          onChange={(event) => {
            setText(event.target.value);
            setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
            if (event.key === "Escape" && text) {
              event.stopPropagation();
              setText("");
            }
          }}
          className="h-8 font-mono text-xs placeholder:font-sans placeholder:text-muted-foreground/60"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={full || !text.trim()}
          onClick={add}
        >
          Add
        </Button>
      </div>
      {problem ? (
        <span role="alert" className="text-xs text-destructive">
          {problem}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">
          Add the config directory of each Claude Code account, such as the
          CLAUDE_CONFIG_DIR of a second account. Usage is read from its
          projects folder.
        </span>
      )}
    </div>
  );
}

function CursorOptions({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const next = text.trim();
    if (next !== value) onCommit(next);
  };
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground">
        Auth database
      </span>
      <Input
        value={text}
        spellCheck={false}
        placeholder="Platform default (Cursor's state.vscdb)"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape" && text !== value) {
            event.stopPropagation();
            setText(value);
          }
        }}
        className="h-8 font-mono text-xs"
      />
      <span className="text-xs text-muted-foreground">
        Read-only. The session token is derived in memory and never stored.
        Cursor usage is account-wide, so it has no project or thread rows.
      </span>
    </label>
  );
}

function Switch({
  checked,
  disabled,
  label,
  title,
  onCheckedChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  title?: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-foreground" : "bg-input",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
      <HugeiconsIcon icon={AlertCircleIcon} className="size-3.5 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

function ProviderListSkeleton() {
  return (
    <ul
      aria-busy
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <li
          key={index}
          className={cn(
            "flex items-center gap-3 py-2.5 pr-3 pl-1.5",
            index > 0 && "border-t border-border",
          )}
        >
          <span className="size-7 shrink-0" />
          <span className="size-8 shrink-0 rounded-md bg-muted" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="h-3.5 w-24 rounded-sm bg-muted" />
            <span className="h-3 w-48 rounded-sm bg-muted" />
          </span>
          <span className="h-[18px] w-8 rounded-full bg-muted" />
        </li>
      ))}
    </ul>
  );
}
