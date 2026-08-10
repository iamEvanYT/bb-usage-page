import { useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";
import { ReloadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { rpcContract } from "../../server";
import type { MergedUsage, UsageChartMetric } from "../../lib/types";
import { PROVIDER_ORDER } from "../../lib/types";
import {
  enumerateDays,
  formatCount,
  formatDayShort,
  formatPercent,
  formatTokens,
  formatUsd,
  makeWindow,
} from "../../lib/format";
import { PROVIDER_COLOR, PROVIDER_LABEL, ProviderMark } from "./providers";
import { UsageChartLegend, UsageProviderChart } from "./usage-chart";

const WINDOW_OPTIONS = [
  { days: 7 as const, label: "7 days" },
  { days: 30 as const, label: "30 days" },
  { days: 90 as const, label: "90 days" },
];

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function UsagePage() {
  const rpc = useRpc<typeof rpcContract>();
  const [windowDays, setWindowDays] = useState<7 | 30 | 90>(30);
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const [breakdown, setBreakdown] = useState<"model" | "day">("model");
  const [merged, setMerged] = useState<MergedUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const hasLoadedRef = useRef(false);
  const forceRefreshRef = useRef(false);

  const window = useMemo(() => makeWindow(windowDays), [windowDays]);

  useEffect(() => {
    let cancelled = false;
    const force = forceRefreshRef.current;
    forceRefreshRef.current = false;
    if (hasLoadedRef.current) setRefreshing(true);
    else setLoading(true);
    setError(null);
    void rpc
      .call("getUsage", {
        timeZone: window.timeZone,
        sinceDay: window.sinceDay,
        untilDay: window.untilDay,
        force,
      })
      .then((result) => {
        if (!cancelled) {
          hasLoadedRef.current = true;
          setMerged(result);
          setLoading(false);
          setRefreshing(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, reloadKey, window.sinceDay, window.timeZone, window.untilDay, windowDays]);

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );

  const orderedProviders = useMemo(() => {
    if (!merged) return [];
    return [...merged.providers].sort((a, b) =>
      metric === "cost" ? b.costUsd - a.costUsd : b.totalTokens - a.totalTokens,
    );
  }, [merged, metric]);

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
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            {formatDayShort(window.sinceDay)} to {formatDayShort(window.untilDay)}
          </p>
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-border">
              {WINDOW_OPTIONS.map((option) => (
                <button
                  key={option.days}
                  type="button"
                  onClick={() => setWindowDays(option.days)}
                  className={cn(
                    "cursor-pointer px-3 py-1.5 text-xs",
                    option.days === windowDays
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                forceRefreshRef.current = true;
                setReloadKey((value) => value + 1);
              }}
              aria-label="Refresh usage"
              disabled={refreshing}
              className={cn(
                "cursor-pointer rounded-md border border-border p-2 text-muted-foreground hover:text-foreground disabled:opacity-50",
                refreshing && "animate-spin",
              )}
            >
              <HugeiconsIcon icon={ReloadIcon} size={14} />
            </button>
          </div>
        </div>

        {loading ? (
          <UsageSkeleton />
        ) : error ? (
          <div className="rounded-md border border-destructive/40 px-4 py-3 text-sm text-destructive">
            Failed to load usage: {error}
          </div>
        ) : merged ? (
          <>
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
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-foreground">
                    Daily {metric === "tokens" ? "processed tokens" : "cost"}
                  </h2>
                  <div className="flex items-center gap-4">
                    <div className="flex overflow-hidden rounded-md border border-border">
                      {(["cost", "tokens"] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setMetric(option)}
                          className={cn(
                            "cursor-pointer px-2.5 py-1 text-[10px] tracking-wide uppercase",
                            option === metric
                              ? "bg-muted text-foreground"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                    <UsageChartLegend />
                  </div>
                </div>
                <UsageProviderChart
                  days={days}
                  daily={merged.daily}
                  metric={metric}
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
                label="Cache savings"
                value={formatUsd(merged.costQuality.cacheSavingsUsd)}
                detail="vs full (uncached) input rates"
              />
            </section>

            <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-medium text-foreground">
                    Breakdown
                  </h2>
                  <div className="flex overflow-hidden rounded-md border border-border">
                    {(["model", "day"] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setBreakdown(option)}
                        className={cn(
                          "cursor-pointer px-2.5 py-1 text-[10px] tracking-wide uppercase",
                          option === breakdown
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>

                {breakdown === "model" ? (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="py-2 font-normal">Model</th>
                        <th className="py-2 text-right font-normal">Cost</th>
                        <th className="py-2 text-right font-normal">Share</th>
                        <th className="py-2 text-right font-normal">Tokens</th>
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
                                  className="size-3.5"
                                />
                                {model.model}
                              </span>
                            </td>
                            <td className="py-2 text-right text-foreground tabular-nums">
                              {formatUsd(model.costUsd)}
                            </td>
                            <td className="py-2 text-right text-muted-foreground tabular-nums">
                              {formatPercent(model.costShare)}
                            </td>
                            <td className="py-2 text-right text-muted-foreground tabular-nums">
                              {formatTokens(model.totalTokens)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="py-2 font-normal">Day</th>
                        {PROVIDER_ORDER.map((provider) => (
                          <th key={provider} className="py-2 text-right font-normal">
                            {PROVIDER_LABEL[provider]}
                          </th>
                        ))}
                        <th className="py-2 text-right font-normal">Total</th>
                        <th className="py-2 text-right font-normal">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentDays.length === 0 ? (
                        <tr>
                          <td
                            colSpan={6}
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
                            {PROVIDER_ORDER.map((provider) => (
                              <td
                                key={provider}
                                className="py-2 text-right text-muted-foreground tabular-nums"
                              >
                                {formatUsd(day.byProvider[provider]?.costUsd ?? 0)}
                              </td>
                            ))}
                            <td className="py-2 text-right text-foreground tabular-nums">
                              {formatUsd(day.costUsd)}
                            </td>
                            <td className="py-2 text-right text-muted-foreground tabular-nums">
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

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="flex flex-col gap-0.5 bg-background px-4 py-3">
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

const SKELETON_BAR_HEIGHTS = [34, 58, 41, 72, 22, 12, 49, 63, 80, 38, 55, 26, 44, 67];

function UsageSkeleton() {
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
          {PROVIDER_ORDER.map((provider) => (
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
          <div className="flex h-56 items-end gap-1 pl-16">
            {SKELETON_BAR_HEIGHTS.map((height) => (
              <div
                key={height}
                className="flex-1 rounded-sm bg-muted"
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
        </div>
      </section>
      <section className="grid grid-cols-2 gap-px border-y border-border bg-border md:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="bg-background px-4 py-3">
            <div className="mb-2 h-3 w-20 rounded-sm bg-muted" />
            <div className="mb-1 h-5 w-16 rounded-sm bg-muted" />
            <div className="h-3 w-28 rounded-sm bg-muted" />
          </div>
        ))}
      </section>
    </>
  );
}
