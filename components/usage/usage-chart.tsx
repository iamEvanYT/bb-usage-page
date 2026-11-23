import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type {
  DailyTotals,
  UsageChartMetric,
  UsageProviderKind,
} from "../../lib/types";
import { formatDayShort, formatTokens, formatUsd } from "../../lib/format";
import { cn } from "../../lib/utils";
import { PROVIDER_COLOR, PROVIDER_LABEL, ProviderMark } from "./providers";

/** Width assumed until the chart is measured. */
const DEFAULT_WIDTH = 960;
/** Charts narrower than this (phones) use the compact layout. */
const COMPACT_WIDTH = 480;
const PLOT_RIGHT = 8;
const PLOT_TOP = 8;
const PLOT_BOTTOM = 24;

interface ChartLayout {
  width: number;
  height: number;
  plotLeft: number;
  plotWidth: number;
  plotHeight: number;
}

/**
 * Chart geometry in real pixels for a chart `width` pixels wide. Narrow charts
 * are shorter, so the plot keeps a readable shape, and have a tighter axis
 * gutter.
 */
function chartLayout(width: number): ChartLayout {
  const compact = width < COMPACT_WIDTH;
  const height = compact ? 180 : 224;
  const plotLeft = compact ? 52 : 64;
  return {
    width,
    height,
    plotLeft,
    plotWidth: width - plotLeft - PLOT_RIGHT,
    plotHeight: height - PLOT_TOP - PLOT_BOTTOM,
  };
}

/** X position of day `index` of `count`, centered when there is only one. */
function xAt(layout: ChartLayout, index: number, count: number): number {
  return count <= 1
    ? layout.plotLeft + layout.plotWidth / 2
    : layout.plotLeft + (index / (count - 1)) * layout.plotWidth;
}

/**
 * Draw at the chart's real pixel width so axis labels stay at their CSS size
 * instead of shrinking with a scaled-down viewBox on narrow screens.
 */
function useChartLayout(): [RefObject<HTMLDivElement | null>, ChartLayout] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => chartLayout(width), [width]);
  return [ref, layout];
}

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

export function UsageChartLegend({
  providers,
  className,
}: {
  providers: readonly UsageProviderKind[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {providers.map((provider) => (
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
  providers,
}: {
  days: readonly string[];
  daily: readonly DailyTotals[];
  metric: UsageChartMetric;
  providers: readonly UsageProviderKind[];
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [containerRef, layout] = useChartLayout();
  const { width, height, plotLeft, plotWidth, plotHeight } = layout;

  useEffect(() => {
    setHoverIndex(null);
  }, [days, metric]);

  const byDay = useMemo(() => {
    const map = new Map<string, DailyTotals>();
    for (const entry of daily) map.set(entry.day, entry);
    return map;
  }, [daily]);

  const series = useMemo(() => {
    const columns = days.map((day) => {
      const entry = byDay.get(day);
      const bands = providers.map((provider) => ({
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
    const providerPaths = providers.map((provider) => {
      const points = columns.map((column, index) => {
        const value =
          column.bands.find((band) => band.provider === provider)?.value ?? 0;
        const x = xAt(layout, index, columns.length);
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
  }, [byDay, days, layout, metric, plotHeight, plotWidth, providers]);

  const labelIndexes =
    days.length <= 3
      ? days.map((_, index) => index)
      : [0, Math.floor((days.length - 1) / 2), days.length - 1];

  // One handler for mouse hover and touch scrubbing: the nearest day to the
  // pointer is highlighted. Touch keeps vertical page scrolling (pan-y).
  const pointToDay = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (days.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * width;
    const ratio = plotWidth <= 0 ? 0 : (x - plotLeft) / plotWidth;
    const index = Math.round(ratio * (days.length - 1));
    setHoverIndex(Math.min(Math.max(index, 0), days.length - 1));
  };

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        className="block touch-pan-y text-muted-foreground select-none"
        role="img"
        aria-label={`Daily ${metric === "cost" ? "cost" : "tokens"} chart`}
        onPointerDown={pointToDay}
        onPointerMove={pointToDay}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setHoverIndex(null);
        }}
      >
        {series.scale.ticks.map((tick) => {
          const y =
            PLOT_TOP +
            plotHeight -
            (series.scale.max === 0 ? 0 : (tick / series.scale.max) * plotHeight);
          return (
            <g key={tick}>
              <line
                x1={plotLeft}
                x2={width - PLOT_RIGHT}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.15}
              />
              <text
                x={plotLeft - 8}
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

        {hoverIndex !== null ? (
          <line
            x1={xAt(layout, hoverIndex, days.length)}
            x2={xAt(layout, hoverIndex, days.length)}
            y1={PLOT_TOP}
            y2={PLOT_TOP + plotHeight}
            stroke="currentColor"
            strokeOpacity={0.35}
          />
        ) : null}

        {labelIndexes.map((index) => {
          const day = days[index];
          if (!day) return null;
          // Edge labels anchor inward so they are not clipped.
          const anchor =
            days.length > 1 && index === 0
              ? "start"
              : days.length > 1 && index === days.length - 1
                ? "end"
                : "middle";
          return (
            <text
              key={`label-${day}`}
              x={xAt(layout, index, days.length)}
              y={height - 6}
              textAnchor={anchor}
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

const SKELETON_BAR_HEIGHTS = [34, 58, 41, 72, 22, 12, 49, 63, 80, 38, 55, 26, 44, 67];

/** Loading placeholder with the same size and axis gutter as the chart. */
export function UsageChartSkeleton() {
  const [containerRef, layout] = useChartLayout();
  return (
    <div
      ref={containerRef}
      className="flex items-end gap-1"
      style={{ height: layout.height, paddingLeft: layout.plotLeft, paddingBottom: PLOT_BOTTOM }}
    >
      {SKELETON_BAR_HEIGHTS.map((barHeight) => (
        <div
          key={barHeight}
          className="flex-1 rounded-sm bg-muted"
          style={{ height: `${barHeight}%` }}
        />
      ))}
    </div>
  );
}
