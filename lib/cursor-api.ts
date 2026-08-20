import { createHash } from "node:crypto";

import type { UsageRecord } from "./types";

const CURSOR_USAGE_URL =
  "https://cursor.com/api/dashboard/get-filtered-usage-events";
const PAGE_SIZE = 1_000;
const MAX_PAGES = 200;

interface CursorTokenUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheWriteTokens?: unknown;
  cacheReadTokens?: unknown;
  totalCents?: unknown;
}

interface CursorUsageEvent {
  timestamp?: unknown;
  model?: unknown;
  kind?: unknown;
  tokenUsage?: unknown;
  chargedCents?: unknown;
  usageBasedCosts?: unknown;
  id?: unknown;
  requestId?: unknown;
  usageEventId?: unknown;
  [key: string]: unknown;
}

interface CursorUsageResponse {
  totalUsageEventsCount?: unknown;
  usageEventsDisplay?: unknown;
}

export interface CursorFetchResult {
  records: UsageRecord[];
  status: "ok" | "partial" | "failed";
  message: string | null;
  fetchedEvents: number;
  reportedEvents: number | null;
}

function safeInteger(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value)
      : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nonNegativeCents(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function eventKey(event: CursorUsageEvent): string {
  const explicit = [event.id, event.usageEventId, event.requestId].find(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  if (explicit) return `cursor:${explicit}`;

  const stable = JSON.stringify({
    timestamp: event.timestamp,
    model: event.model,
    kind: event.kind,
    tokenUsage: event.tokenUsage,
    chargedCents: event.chargedCents,
    usageBasedCosts: event.usageBasedCosts,
  });
  return `cursor:${createHash("sha256").update(stable).digest("hex")}`;
}

export function parseCursorEvent(value: unknown): UsageRecord | null {
  const event = objectValue(value) as CursorUsageEvent | null;
  if (!event) return null;
  const time = timestampMs(event.timestamp);
  const modelValue = typeof event.model === "string" ? event.model.trim() : "";
  const usage = objectValue(event.tokenUsage) as CursorTokenUsage | null;
  if (time === null) return null;

  const totals = {
    uncachedInputTokens: safeInteger(usage?.inputTokens),
    cachedInputTokens: safeInteger(usage?.cacheReadTokens),
    cacheCreationTokens: safeInteger(usage?.cacheWriteTokens),
    outputTokens: safeInteger(usage?.outputTokens),
    reasoningTokens: 0,
  };

  const chargedCents = nonNegativeCents(event.chargedCents);
  const tokenCents = nonNegativeCents(usage?.totalCents);
  const reportedCostUsd =
    chargedCents !== null
      ? chargedCents / 100
      : tokenCents !== null
      ? tokenCents / 100
      : null;
  const hasTokens =
    totals.uncachedInputTokens +
      totals.cachedInputTokens +
      totals.cacheCreationTokens +
      totals.outputTokens >
    0;
  if (!hasTokens && reportedCostUsd === null) return null;

  return {
    provider: "cursor",
    timestampMs: time,
    model: modelValue || "unknown",
    sessionId: "",
    projectPath: "",
    totals,
    reportedCostUsd,
    dedupeKey: eventKey(event),
  };
}

function parseResponse(value: unknown): {
  total: number | null;
  events: unknown[];
} | null {
  const response = objectValue(value) as CursorUsageResponse | null;
  if (!response || !Array.isArray(response.usageEventsDisplay)) return null;
  const totalValue = response.totalUsageEventsCount;
  const parsedTotal =
    typeof totalValue === "number"
      ? totalValue
      : typeof totalValue === "string" && /^\d+$/.test(totalValue.trim())
      ? Number(totalValue)
      : NaN;
  const total =
    Number.isSafeInteger(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null;
  return { total, events: response.usageEventsDisplay };
}

export async function fetchCursorUsage(options: {
  cookie: string;
  startDateMs: number;
  endDateMs: number;
  fetchImpl?: typeof fetch;
}): Promise<CursorFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  let reportedEvents: number | null = null;
  let skippedEvents = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let response: Response;
    try {
      response = await fetchImpl(CURSOR_USAGE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `WorkosCursorSessionToken=${options.cookie}`,
          origin: "https://cursor.com",
        },
        body: JSON.stringify({
          startDate: String(options.startDateMs),
          endDate: String(options.endDateMs),
          page,
          pageSize: PAGE_SIZE,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return {
        records,
        status: records.length > 0 ? "partial" : "failed",
        message: "Cursor usage could not be reached.",
        fetchedEvents: records.length,
        reportedEvents,
      };
    }

    if (!response.ok) {
      return {
        records,
        status: records.length > 0 ? "partial" : "failed",
        message: `Cursor usage returned HTTP ${response.status}.`,
        fetchedEvents: records.length,
        reportedEvents,
      };
    }

    let parsed: { total: number | null; events: unknown[] } | null;
    try {
      parsed = parseResponse(await response.json());
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      return {
        records,
        status: records.length > 0 ? "partial" : "failed",
        message: "Cursor usage returned an unrecognized response.",
        fetchedEvents: records.length,
        reportedEvents,
      };
    }

    reportedEvents = parsed.total;
    for (let index = 0; index < parsed.events.length; index += 1) {
      const record = parseCursorEvent(parsed.events[index]);
      if (!record) {
        skippedEvents += 1;
        continue;
      }
      if (record.dedupeKey === null || seen.has(record.dedupeKey)) {
        continue;
      }
      seen.add(record.dedupeKey);
      records.push(record);
    }

    const reportedCountSatisfied =
      reportedEvents !== null && records.length >= reportedEvents;
    const shortPage = parsed.events.length < PAGE_SIZE;
    if (reportedCountSatisfied) {
      return {
        records,
        status: "ok",
        message: null,
        fetchedEvents: seen.size,
        reportedEvents,
      };
    }

    if (parsed.events.length === 0) {
      return {
        records,
        status:
          page === 1 && reportedEvents === null && skippedEvents === 0
            ? "ok"
            : "partial",
        message:
          page === 1 && reportedEvents === null && skippedEvents === 0
            ? null
            : "Cursor usage returned an incomplete event page.",
        fetchedEvents: records.length,
        reportedEvents,
      };
    }

    if (shortPage && skippedEvents === 0 && reportedEvents === null) {
      return {
        records,
        status: "ok",
        message: null,
        fetchedEvents: records.length,
        reportedEvents,
      };
    }

    if (
      shortPage &&
      reportedEvents !== null &&
      records.length < reportedEvents
    ) {
      return {
        records,
        status: "partial",
        message: "Cursor usage did not include all reported events.",
        fetchedEvents: records.length,
        reportedEvents,
      };
    }
  }

  return {
    records,
    status: "partial",
    message: "Cursor usage exceeded the pagination safety limit.",
    fetchedEvents: records.length,
    reportedEvents,
  };
}
