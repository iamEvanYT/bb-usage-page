import { useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { ReloadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { rpcContract } from "../../server";
import type {
  MergedUsage,
  UsageChartMetric,
  UsageProviderKind,
} from "../../lib/types";
import {
  DEFAULT_ENABLED_PROVIDERS,
  PREFERENCES_CHANNEL,
} from "../../lib/preferences";
import {
  enumerateDays,
  formatCount,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
} from "../../lib/format";
import { cn } from "../../lib/utils";
import { MachineNotices, MachinePicker, useExcludedMachines } from "./machines";
import { PROVIDER_COLOR, PROVIDER_LABEL, ProviderMark } from "./providers";
import { SegmentedControl, type SegmentedOption } from "./segmented-control";
import { UsageChartLegend, UsageChartSkeleton, UsageProviderChart } from "./usage-chart";

type WindowDays = 7 | 30 | 90;
type Breakdown = "model" | "project" | "thread" | "day";

const WINDOW_OPTIONS: SegmentedOption<WindowDays>[] = ([7, 30, 90] as const).map((days) => ({
  value: days,
  label: `${days} days`,
  compactLabel: `${days}d`,
}));
const METRIC_OPTIONS: SegmentedOption<UsageChartMetric>[] = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
];
const BREAKDOWN_OPTIONS: SegmentedOption<Breakdown>[] = [
  { value: "model", label: "Model" },
  { value: "project", label: "Project" },
  { value: "thread", label: "Threads" },
  { value: "day", label: "Day" },
];
/** Columns that only fit beside the name on wider screens. */
const WIDE_ONLY = "max-sm:hidden";
const NUMBER_CELL = "py-2 pl-3 text-right whitespace-nowrap tabular-nums";
const SKELETON_DELAY_MS = 30;

export function UsagePage() {
  const rpc = useRpc<typeof rpcContract>();
  const [windowDays, setWindowDays] = useState<WindowDays>(30);
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const [breakdown, setBreakdown] = useState<Breakdown>("model");
  const [merged, setMerged] = useState<MergedUsage | null>(null);
  const [excludedMachines, setExcludedMachines] = useExcludedMachines();
  const [threadsResolved, setThreadsResolved] = useState(false);
  const includeThreads = breakdown === "thread";
  const detailRows = includeThreads ? merged?.threads ?? [] : merged?.projects ?? [];
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showSkeleton, setShowSkeleton] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [windowVersion, setWindowVersion] = useState(0);
  const hasLoadedRef = useRef(false);
  const forceRefreshRef = useRef(false);

  useRealtime(PREFERENCES_CHANNEL, () => setReloadKey((value) => value + 1));

  const window = useMemo(() => makeWindow(windowDays), [windowDays, windowVersion]);
  const dataMatchesWindow =
    merged !== null &&
    merged.sinceDay === window.sinceDay &&
    merged.untilDay === window.untilDay &&
    merged.timeZone === window.timeZone;
  const waitingForData = !dataMatchesWindow && !error;

  useEffect(() => {
    if (!waitingForData) {
      setShowSkeleton(false);
      return;
    }
    const timeout = globalThis.setTimeout(
      () => setShowSkeleton(true),
      SKELETON_DELAY_MS,
    );
    return () => globalThis.clearTimeout(timeout);
  }, [waitingForData]);

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const force = forceRefreshRef.current;
    // Consume force for this request; if cleanup cancels before settle, put
    // it back so Strict Mode / rapid toggles still hard-refresh once.
    forceRefreshRef.current = false;
    if (hasLoadedRef.current) setRefreshing(true);
    if (includeThreads) setThreadsResolved(false);
    setError(null);
    void rpc
      .call("getUsage", {
        timeZone: window.timeZone,
        sinceDay: window.sinceDay,
        untilDay: window.untilDay,
        force,
        includeThreads,
        ...(excludedMachines.length > 0 ? { excludeMachineIds: excludedMachines } : {}),
      })
      .then((result) => {
        settled = true;
        if (!cancelled) {
          hasLoadedRef.current = true;
          setMerged(result);
          setThreadsResolved(includeThreads);
          setRefreshing(false);
        }
      })
      .catch((err: unknown) => {
        settled = true;
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setRefreshing(false);
        }
      });
    return () => {
      cancelled = true;
      if (force && !settled) forceRefreshRef.current = true;
    };
  }, [rpc, reloadKey, window.sinceDay, window.timeZone, window.untilDay, windowDays, includeThreads, excludedMachines]);

  // A remembered selection can leave nothing selected after machines are
  // removed or re-enrolled; fall back to every machine.
  useEffect(() => {
    if (merged?.machines.length && merged.machines.every((machine) => !machine.selected)) {
      setExcludedMachines([]);
    }
  }, [merged, setExcludedMachines]);

  useEffect(() => {
    const nextMidnight = new Date();
    nextMidnight.setHours(24, 0, 0, 0);
    const timeout = globalThis.setTimeout(
      () => setWindowVersion((version) => version + 1),
      Math.max(nextMidnight.getTime() - Date.now(), 1),
    );
    return () => globalThis.clearTimeout(timeout);
  }, [window.untilDay]);

  const days = useMemo(
    () => (merged ? enumerateDays(merged.sinceDay, merged.untilDay) : []),
    [merged],
  );

  // The server returns only enabled providers, already in the user's order.
  const providerKey = merged?.providers.map((row) => row.provider).join(",");
  const visibleProviders = useMemo<UsageProviderKind[]>(
    () =>
      providerKey === undefined
        ? DEFAULT_ENABLED_PROVIDERS
        : (providerKey.split(",").filter(Boolean) as UsageProviderKind[]),
    [providerKey],
  );
  const cursorSource = merged?.sources.find(
    (source) => source.provider === "cursor",
  );
  const cursorWarning =
    cursorSource && cursorSource.status !== "ok"
      ? cursorSource.message || `Cursor usage is ${cursorSource.status}.`
      : null;
  const orderedProviders = merged?.providers ?? [];
  const machines = merged?.machines ?? [];

  const recentDays = useMemo(
    () => (merged ? [...merged.daily].reverse().slice(0, 8) : []),
    [merged],
  );

  const activeDays = merged?.daily.filter((day) => day.totalTokens > 0).length ?? 0;
  const dailyAverage =
    !merged || activeDays === 0 ? 0 : merged.totalTokens / activeDays;
  const observedInput = merged
    ? merged.uncachedInputTokens + merged.cachedInputTokens
    : 0;
  const cachedShare =
    !merged || observedInput === 0
      ? 0
      : merged.cachedInputTokens / observedInput;

  return (
    <div className="usage-page h-full min-h-0 overflow-auto bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-5 sm:gap-8 sm:px-6 sm:py-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <p className="mr-auto text-sm text-muted-foreground">
            {formatDayShort(window.sinceDay)} to {formatDayShort(window.untilDay)}
          </p>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            {machines.length > 1 ? (
              <MachinePicker
                className="min-w-0 flex-1 sm:flex-none"
                machines={machines}
                excluded={excludedMachines}
                onChange={setExcludedMachines}
                metric={metric}
                cursorIncluded={visibleProviders.includes("cursor")}
              />
            ) : null}
            <SegmentedControl
              label="Time window"
              options={WINDOW_OPTIONS}
              value={windowDays}
              onChange={setWindowDays}
              stretchOnPhones={machines.length <= 1}
            />
            <button
              type="button"
              onClick={() => {
                forceRefreshRef.current = true;
                setReloadKey((value) => value + 1);
              }}
              aria-label="Refresh usage"
              disabled={refreshing}
              className={cn(
                "flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-50 max-md:pointer-coarse:size-10",
                refreshing && "animate-spin",
              )}
            >
              <HugeiconsIcon icon={ReloadIcon} size={14} />
            </button>
          </div>
        </div>

        {showSkeleton ? (
          <UsageSkeleton providers={visibleProviders} />
        ) : error ? (
          <div className="rounded-md border border-destructive/40 px-4 py-3 text-sm text-destructive">
            Failed to load usage: {error}
          </div>
        ) : merged ? (
          <>
            <MachineNotices machines={machines} />
            {cursorWarning ? (
              <div
                role="status"
                className="rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
              >
                Cursor usage is{" "}
                {cursorSource?.status === "partial"
                  ? "incomplete"
                  : "unavailable"}
                : {cursorWarning}
              </div>
            ) : null}
            <section className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-1">
                  <span className="text-xs tracking-wide text-muted-foreground uppercase">
                    {metric === "cost" ? "Raw token cost" : "Processed tokens"}
                  </span>
                  <span className="text-4xl font-semibold text-foreground tabular-nums">
                    {metric === "cost"
                      ? `${formatUsd(merged.costUsd)}*`
                      : formatTokens(merged.totalTokens)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {metric === "cost"
                      ? "* if billed at full API rate"
                      : `Input, cache reads and output across ${formatCount(merged.sessions)} sessions.`}
                  </span>
                </div>

                {orderedProviders.map((provider) => {
                  const share =
                    metric === "cost" ? provider.costShare : provider.tokenShare;
                  return (
                    <div key={provider.provider} className="flex flex-col gap-1.5">
                      <div className="flex items-baseline justify-between">
                        <span className="flex items-center gap-2 text-sm text-foreground">
                          <ProviderMark
                            provider={provider.provider}
                            className="size-4"
                          />
                          {PROVIDER_LABEL[provider.provider]}
                        </span>
                        <span className="text-sm text-foreground tabular-nums">
                          {metric === "cost"
                            ? formatUsd(provider.costUsd)
                            : formatTokens(provider.totalTokens)}
                        </span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full"
                          style={{
                            width: `${(share * 100).toFixed(1)}%`,
                            backgroundColor: PROVIDER_COLOR[provider.provider],
                          }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {metric === "cost"
                          ? `${formatPercent(share)} of cost · ${formatTokens(provider.totalTokens)} tokens`
                          : `${formatPercent(share)} of tokens · ${formatUsd(provider.costUsd)}`}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <h2 className="mr-auto text-sm font-medium text-foreground">
                    Daily {metric === "tokens" ? "processed tokens" : "cost"}
                  </h2>
                  <SegmentedControl
                    label="Chart metric"
                    size="sm"
                    options={METRIC_OPTIONS}
                    value={metric}
                    onChange={setMetric}
                  />
                  <UsageChartLegend
                    className="max-sm:order-last max-sm:w-full"
                    providers={visibleProviders}
                  />
                </div>
                <UsageProviderChart
                  days={days}
                  daily={merged.daily}
                  metric={metric}
                  providers={visibleProviders}
                />
              </div>
            </section>

            <section className="grid grid-cols-2 gap-px border-y border-border bg-border md:grid-cols-5">
              <Metric
                label="Processed tokens"
                value={formatTokens(merged.totalTokens)}
                detail={`${formatTokens(dailyAverage)} per active day`}
              />
              <Metric
                label="Cached input"
                value={formatTokens(merged.cachedInputTokens)}
                detail={`${formatPercent(cachedShare)} of observed input`}
              />
              <Metric
                label="Uncached input"
                value={formatTokens(merged.uncachedInputTokens)}
                detail={`${formatTokens(merged.cacheCreationTokens)} cache writes`}
              />
              <Metric
                label="Output"
                value={formatTokens(merged.outputTokens)}
                detail={`includes ${formatTokens(merged.reasoningTokens)} reasoning`}
              />
              <Metric
                className="max-md:col-span-2"
                label="Cache savings"
                value={formatUsd(merged.costQuality.cacheSavingsUsd)}
                detail="vs full (uncached) input rates"
              />
            </section>

            <section className="grid gap-6 sm:gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-foreground">
                    Breakdown
                  </h2>
                  <SegmentedControl
                    label="Breakdown"
                    size="sm"
                    options={BREAKDOWN_OPTIONS}
                    value={breakdown}
                    onChange={setBreakdown}
                  />
                </div>

                {breakdown === "model" ? (
                  <table key="model" className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="py-2 font-normal">Model</th>
                        <th className="py-2 pl-3 text-right font-normal">Cost</th>
                        <th className={cn("py-2 pl-3 text-right font-normal", WIDE_ONLY)}>Share</th>
                        <th className="py-2 pl-3 text-right font-normal">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {merged.models.length === 0 ? (
                        <tr>
                          <td
                            colSpan={4}
                            className="py-6 text-center text-muted-foreground"
                          >
                            No activity in this window.
                          </td>
                        </tr>
                      ) : (
                        merged.models.map((model) => (
                          <tr
                            key={`${model.provider}:${model.model}`}
                            className="border-b border-border/50"
                          >
                            <td className="py-2 text-foreground">
                              <span className="flex items-center gap-2">
                                <ProviderMark
                                  provider={model.provider}
                                  className="size-3.5 shrink-0"
                                />
                                <span className="min-w-0 [overflow-wrap:anywhere]">{model.model}</span>
                              </span>
                            </td>
                            <td className={cn(NUMBER_CELL, "text-foreground")}>
                              {formatUsd(model.costUsd)}
                            </td>
                            <td className={cn(NUMBER_CELL, "text-muted-foreground", WIDE_ONLY)}>
                              {formatPercent(model.costShare)}
                            </td>
                            <td className={cn(NUMBER_CELL, "text-muted-foreground")}>
                              {formatTokens(model.totalTokens)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                ) : breakdown === "project" || breakdown === "thread" ? (
                  <table key={breakdown} className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="py-2 font-normal">{includeThreads ? "Thread" : "Project"}</th>
                        <th className="py-2 pl-3 text-right font-normal">Cost</th>
                        <th className={cn("py-2 pl-3 text-right font-normal", WIDE_ONLY)}>Share</th>
                        <th className="py-2 pl-3 text-right font-normal">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(includeThreads && !threadsResolved) || detailRows.length === 0 ? (
                        <tr>
                          <td
                            colSpan={4}
                            className="py-6 text-center text-muted-foreground"
                          >
                            {includeThreads && !threadsResolved ? "Loading threads…" : "No activity in this window."}
                          </td>
                        </tr>
                      ) : (
                        detailRows.map((project) => (
                          <tr
                            key={"sessionId" in project
                              ? `${project.provider}:${project.sessionId}`
                              : `${project.projectPath}\0${project.project}`}
                            className="border-b border-border/50"
                          >
                            <td className="py-2 text-foreground">
                              <span className="flex items-center gap-2">
                                {"provider" in project ? <ProviderMark provider={project.provider} className="size-3.5 shrink-0" /> : null}
                                <ProjectLabel
                                  name={"title" in project ? project.title : project.project}
                                  path={project.projectPath}
                                  threadId={project.threadId}
                                />
                              </span>
                            </td>
                            <td className={cn(NUMBER_CELL, "text-foreground")}>
                              {formatUsd(project.costUsd)}
                            </td>
                            <td className={cn(NUMBER_CELL, "text-muted-foreground", WIDE_ONLY)}>
                              {formatPercent(project.costShare)}
                            </td>
                            <td className={cn(NUMBER_CELL, "text-muted-foreground")}>
                              {formatTokens(project.totalTokens)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                ) : (
                  <table key="day" className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="py-2 font-normal">Day</th>
                        {visibleProviders.map((provider) => (
                          <th key={provider} className={cn("py-2 pl-3 text-right font-normal", WIDE_ONLY)}>
                            {PROVIDER_LABEL[provider]}
                          </th>
                        ))}
                        <th className="py-2 pl-3 text-right font-normal">Total</th>
                        <th className="py-2 pl-3 text-right font-normal">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentDays.length === 0 ? (
                        <tr>
                          <td
                            colSpan={visibleProviders.length + 3}
                            className="py-6 text-center text-muted-foreground"
                          >
                            No activity in this window.
                          </td>
                        </tr>
                      ) : (
                        recentDays.map((day) => (
                          <tr key={day.day} className="border-b border-border/50">
                            <td className="py-2 text-foreground">
                              {formatDayShort(day.day)}
                            </td>
                            {visibleProviders.map((provider) => (
                              <td
                                key={provider}
                                className={cn(NUMBER_CELL, "text-muted-foreground", WIDE_ONLY)}
                              >
                                {formatUsd(day.byProvider[provider]?.costUsd ?? 0)}
                              </td>
                            ))}
                            <td className={cn(NUMBER_CELL, "text-foreground")}>
                              {formatUsd(day.costUsd)}
                            </td>
                            <td className={cn(NUMBER_CELL, "text-muted-foreground")}>
                              {formatTokens(day.totalTokens)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="flex flex-col gap-2 text-sm">
                <h2 className="text-sm font-medium text-foreground">Cost quality</h2>
                <QualityRow
                  label="Provider reported"
                  value={formatPercent(merged.costQuality.providerReportedShare)}
                />
                <QualityRow
                  label="Model priced"
                  value={formatPercent(merged.costQuality.modelPricedShare)}
                />
                <QualityRow
                  label="Unpriced"
                  value={formatPercent(merged.costQuality.unpricedShare)}
                />
                <QualityRow
                  label="Cache savings"
                  value={formatUsd(merged.costQuality.cacheSavingsUsd)}
                />
                <p className="pt-2 text-xs text-muted-foreground">
                  {merged.cache.summaryHit
                    ? `Cache hit in ${formatCount(merged.scanDurationMs)}ms`
                    : `Scanned in ${formatCount(merged.scanDurationMs)}ms · ${formatCount(merged.cache.fileHits)} cached files · ${formatCount(merged.cache.filesParsed)} parsed`}{" "}
                  · rates {merged.pricing.status}
                </p>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ProjectLabel({
  name,
  path,
  threadId,
}: {
  name: string;
  path: string;
  threadId: string | null;
}) {
  const navigate = useBbNavigate();
  if (!threadId) {
    return (
      <span title={path || undefined} className="min-w-0 [overflow-wrap:anywhere]">
        {name}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={path || undefined}
      onClick={() => navigate.toThread(threadId)}
      className="min-w-0 cursor-pointer text-left text-foreground underline decoration-dotted decoration-foreground/25 underline-offset-2 [overflow-wrap:anywhere]"
    >
      {name}
    </button>
  );
}

function Metric({
  label,
  value,
  detail,
  className,
}: {
  label: string;
  value: string;
  detail: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5 bg-background px-4 py-3", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg text-foreground tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

function QualityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function UsageSkeleton({
  providers,
}: {
  providers: readonly UsageProviderKind[];
}) {
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span className="text-xs tracking-wide text-muted-foreground uppercase">
              Raw token cost
            </span>
            <div className="my-1.5 h-8 w-36 rounded-sm bg-muted" />
            <div className="h-3 w-28 rounded-sm bg-muted" />
          </div>
          {providers.map((provider) => (
            <div key={provider} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm text-foreground">
                  <ProviderMark provider={provider} className="size-4" />
                  {PROVIDER_LABEL[provider]}
                </span>
                <div className="h-3.5 w-14 rounded-sm bg-muted" />
              </div>
              <div className="h-1 w-full rounded-full bg-muted" />
              <div className="h-3 w-36 rounded-sm bg-muted" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-3">
          <h2 className="py-1 text-sm font-medium text-foreground">Daily cost</h2>
          <UsageChartSkeleton />
        </div>
      </section>
      <section className="grid grid-cols-2 gap-px border-y border-border bg-border md:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className={cn("bg-background px-4 py-3", index === 4 && "max-md:col-span-2")}>
            <div className="mb-2 h-3 w-20 rounded-sm bg-muted" />
            <div className="mb-1 h-5 w-16 rounded-sm bg-muted" />
            <div className="h-3 w-28 rounded-sm bg-muted" />
          </div>
        ))}
      </section>
    </>
  );
}
