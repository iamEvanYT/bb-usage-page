import { useMemo, useState } from "react";
import type { DailyTotals, UsageChartMetric, UsageProviderKind } from "../../lib/types";
import { PROVIDER_ORDER } from "../../lib/types";
import { formatDayShort, formatTokens, formatUsd } from "../../lib/format";
import { PROVIDER_COLOR, PROVIDER_LABEL, ProviderMark } from "./providers";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const PLOT_LEFT = 72;
const PLOT_RIGHT = 16;
const PLOT_TOP = 8;
const PLOT_BOTTOM = 28;

interface Point {
  x: number;
  y: number;
}

function niceScale(peak: number, count: number): { max: number; ticks: number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };
  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step =
    (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) *
    magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

function monotoneTangents(points: readonly Point[]): number[] {
  const count = points.length;
  if (count < 2) return [0];
  const slopes: number[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    const dx = points[i + 1]!.x - points[i]!.x;
    const dy = points[i + 1]!.y - points[i]!.y;
    slopes.push(dx === 0 ? 0 : dy / dx);
  }
  const tangents = Array.from({ length: count }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let i = 1; i < count - 1; i += 1) {
    const prev = slopes[i - 1] ?? 0;
    const next = slopes[i] ?? 0;
    tangents[i] = prev * next <= 0 ? 0 : (prev + next) / 2;
  }
  for (let i = 0; i < count - 1; i += 1) {
    const slope = slopes[i] ?? 0;
    if (slope === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = (tangents[i] ?? 0) / slope;
    const b = (tangents[i + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[i] = scale * a * slope;
      tangents[i + 1] = scale * b * slope;
    }
  }
  return tangents;
}

function curvePath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    return `M${points[0]!.x},${points[0]!.y}`;
  }
  const tangents = monotoneTangents(points);
  let path = `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    const dx = to.x - from.x;
    const c1x = from.x + dx / 3;
    const c1y = from.y + ((tangents[i] ?? 0) * dx) / 3;
    const c2x = to.x - dx / 3;
    const c2y = to.y - ((tangents[i + 1] ?? 0) * dx) / 3;
    path += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${to.x.toFixed(2)},${to.y.toFixed(2)}`;
  }
  return path;
}

function valueFor(
  daily: DailyTotals | undefined,
  provider: UsageProviderKind,
  metric: UsageChartMetric,
): number {
  const entry = daily?.byProvider[provider];
  if (!entry) return 0;
  return metric === "tokens" ? entry.totalTokens : entry.costUsd;
}

export function UsageChartLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      {PROVIDER_ORDER.map((provider) => (
        <span key={provider} className="flex items-center gap-1.5">
          <ProviderMark provider={provider} className="size-3.5" />
          {PROVIDER_LABEL[provider]}
        </span>
      ))}
    </div>
  );
}

export function UsageProviderChart({
  days,
  daily,
  metric,
}: {
  days: readonly string[];
  daily: readonly DailyTotals[];
  metric: UsageChartMetric;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const byDay = useMemo(() => {
    const map = new Map<string, DailyTotals>();
    for (const entry of daily) map.set(entry.day, entry);
    return map;
  }, [daily]);

  const plotWidth = VIEW_WIDTH - PLOT_LEFT - PLOT_RIGHT;
  const plotHeight = VIEW_HEIGHT - PLOT_TOP - PLOT_BOTTOM;

  const series = useMemo(() => {
    const columns = days.map((day) => {
      const entry = byDay.get(day);
      const bands = PROVIDER_ORDER.map((provider) => ({
        provider,
        value: valueFor(entry, provider, metric),
      }));
      return {
        day,
        bands,
        total: bands.reduce((sum, band) => sum + band.value, 0),
      };
    });
    const peak = columns.reduce((max, column) => {
      const columnPeak = column.bands.reduce(
        (inner, band) => Math.max(inner, band.value),
        0,
      );
      return Math.max(max, columnPeak);
    }, 0);
    const scale = niceScale(peak, 4);
    const providerPaths = PROVIDER_ORDER.map((provider) => {
      const points = columns.map((column, index) => {
        const value =
          column.bands.find((band) => band.provider === provider)?.value ?? 0;
        const x =
          columns.length <= 1
            ? PLOT_LEFT + plotWidth / 2
            : PLOT_LEFT + (index / (columns.length - 1)) * plotWidth;
        const y =
          PLOT_TOP +
          plotHeight -
          (scale.max === 0 ? 0 : (value / scale.max) * plotHeight);
        return { x, y, value };
      });
      const line = curvePath(points);
      const area =
        points.length === 0
          ? ""
          : `${line} L${points[points.length - 1]!.x.toFixed(2)},${(PLOT_TOP + plotHeight).toFixed(2)} L${points[0]!.x.toFixed(2)},${(PLOT_TOP + plotHeight).toFixed(2)} Z`;
      return { provider, line, area, points };
    });
    return { columns, scale, providerPaths };
  }, [byDay, days, metric, plotHeight, plotWidth]);

  const labelIndexes =
    days.length <= 3
      ? days.map((_, index) => index)
      : [0, Math.floor((days.length - 1) / 2), days.length - 1];

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        className="h-56 w-full text-muted-foreground"
        role="img"
        aria-label={`Daily ${metric === "cost" ? "cost" : "tokens"} chart`}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {series.scale.ticks.map((tick) => {
          const y =
            PLOT_TOP +
            plotHeight -
            (series.scale.max === 0 ? 0 : (tick / series.scale.max) * plotHeight);
          return (
            <g key={tick}>
              <line
                x1={PLOT_LEFT}
                x2={VIEW_WIDTH - PLOT_RIGHT}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.15}
              />
              <text
                x={PLOT_LEFT - 8}
                y={y + 3}
                textAnchor="end"
                className="fill-current text-[10px]"
              >
                {metric === "cost" ? formatUsd(tick) : formatTokens(tick)}
              </text>
            </g>
          );
        })}

        {series.providerPaths.map(({ provider, line, area }) => (
          <g key={provider}>
            <path d={area} fill={PROVIDER_COLOR[provider]} opacity={0.18} />
            <path
              d={line}
              fill="none"
              stroke={PROVIDER_COLOR[provider]}
              strokeWidth={2}
            />
          </g>
        ))}

        {days.map((day, index) => {
          const x =
            days.length <= 1
              ? PLOT_LEFT + plotWidth / 2
              : PLOT_LEFT + (index / (days.length - 1)) * plotWidth;
          return (
            <rect
              key={day}
              x={x - plotWidth / Math.max(days.length, 1) / 2}
              y={PLOT_TOP}
              width={Math.max(plotWidth / Math.max(days.length, 1), 8)}
              height={plotHeight}
              fill="transparent"
              onMouseEnter={() => setHoverIndex(index)}
            />
          );
        })}

        {hoverIndex !== null ? (
          <line
            x1={
              days.length <= 1
                ? PLOT_LEFT + plotWidth / 2
                : PLOT_LEFT + (hoverIndex / (days.length - 1)) * plotWidth
            }
            x2={
              days.length <= 1
                ? PLOT_LEFT + plotWidth / 2
                : PLOT_LEFT + (hoverIndex / (days.length - 1)) * plotWidth
            }
            y1={PLOT_TOP}
            y2={PLOT_TOP + plotHeight}
            stroke="currentColor"
            strokeOpacity={0.35}
          />
        ) : null}

        {labelIndexes.map((index) => {
          const day = days[index];
          if (!day) return null;
          const x =
            days.length <= 1
              ? PLOT_LEFT + plotWidth / 2
              : PLOT_LEFT + (index / (days.length - 1)) * plotWidth;
          return (
            <text
              key={`label-${day}`}
              x={x}
              y={VIEW_HEIGHT - 8}
              textAnchor="middle"
              className="fill-current text-[10px] uppercase tracking-wide"
            >
              {formatDayShort(day)}
            </text>
          );
        })}
      </svg>

      {hoverIndex !== null && series.columns[hoverIndex] ? (
        <div className="pointer-events-none absolute top-2 right-2 rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow-sm backdrop-blur">
          <div className="mb-1 font-medium text-foreground">
            {formatDayShort(series.columns[hoverIndex]!.day)}
          </div>
          {series.columns[hoverIndex]!.bands.map((band) => (
            <div
              key={band.provider}
              className="flex items-center justify-between gap-4 text-muted-foreground"
            >
              <span className="flex items-center gap-1.5">
                <ProviderMark provider={band.provider} className="size-3" />
                {PROVIDER_LABEL[band.provider]}
              </span>
              <span className="tabular-nums text-foreground">
                {metric === "cost"
                  ? formatUsd(band.value)
                  : formatTokens(band.value)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
