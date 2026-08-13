import { isIgnoredUsageModel } from "./pricing";
import type { UsageProviderKind, UsageRecord, UsageTokenTotals } from "./types";
import { totalTokens } from "./types";

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function mightCarryUsage(
  line: string,
  provider: UsageProviderKind,
): boolean {
  if (provider === "claude") return line.includes('"usage"');
  if (provider === "pi") return line.includes('"usage"') || line.includes('"cost"');
  return line.includes('"token_count"') || line.includes('"turn_context"') || line.includes('"session_meta"');
}

export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "assistant") return null;

  const message = record.message;
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;
  const usage = messageRecord.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null) return null;
  const model =
    typeof messageRecord.model === "string" ? messageRecord.model : "";
  if (model.length === 0 || isIgnoredUsageModel(model)) return null;

  const messageId =
    typeof messageRecord.id === "string" ? messageRecord.id : null;
  const requestId =
    typeof record.requestId === "string" ? record.requestId : null;
  const dedupeKey =
    messageId === null && requestId === null
      ? null
      : `${messageId ?? ""}:${requestId ?? ""}`;
  const cost = record.costUSD;

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
    totals: {
      uncachedInputTokens: int(usageRecord.input_tokens),
      cachedInputTokens: int(usageRecord.cache_read_input_tokens),
      cacheCreationTokens: int(usageRecord.cache_creation_input_tokens),
      outputTokens: int(usageRecord.output_tokens),
      reasoningTokens: 0,
    },
    reportedCostUsd:
      typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    dedupeKey,
  };
}

export interface CodexScanState {
  model: string;
  sessionId: string;
  lastUsageSignature: string | null;
  sawSessionMeta: boolean;
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

const FORK_COPY_MAX_GAP_MS = 1000;

/**
 * Forked / resumed rollouts and subagent thread_spawn copies copy parent
 * history into the new file. That history was already counted from the parent
 * rollout — suppress the leading burst so it is not double-counted (and not
 * attributed to the fork's wall-clock day).
 */
function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload.forked_from_id === "string") return true;
  const source = payload.source;
  if (typeof source !== "object" || source === null) return false;
  const subagent = (source as Record<string, unknown>).subagent;
  if (typeof subagent !== "object" || subagent === null) return false;
  const spawn = (subagent as Record<string, unknown>).thread_spawn;
  if (typeof spawn !== "object" || spawn === null) return false;
  return typeof (spawn as Record<string, unknown>).parent_thread_id === "string";
}

export function parseCodexLine(
  line: string,
  state: CodexScanState,
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;

  if (record.type === "session_meta") {
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    const id = payloadRecord.id ?? payloadRecord.session_id;
    if (typeof id === "string") state.sessionId = id;
    const metaTimestampMs = parseTimestampMs(record.timestamp);
    if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }

  if (record.type === "turn_context") {
    if (typeof payloadRecord.model === "string") state.model = payloadRecord.model;
    return null;
  }

  if (payloadRecord.type !== "token_count") return null;
  const info = payloadRecord.info;
  if (typeof info !== "object" || info === null) return null;
  const last = (info as Record<string, unknown>).last_token_usage;
  if (typeof last !== "object" || last === null) return null;
  const lastRecord = last as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null;

  const signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }

  const inputTokens = int(lastRecord.input_tokens);
  const cachedInputTokens = int(lastRecord.cached_input_tokens);
  const cacheCreationTokens = int(lastRecord.cache_write_input_tokens);
  const outputTokens = int(lastRecord.output_tokens);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: Math.max(
      0,
      inputTokens - cachedInputTokens - cacheCreationTokens,
    ),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(
      outputTokens,
      int(lastRecord.reasoning_output_tokens),
    ),
  };
  if (totalTokens(totals) === 0) return null;

  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    reportedCostUsd: null,
    dedupeKey: null,
  };
}

export function parsePiLine(
  line: string,
  sessionIdFallback: string,
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const message =
    record.type === "message" && typeof record.message === "object"
      ? (record.message as Record<string, unknown>)
      : record;

  if (message.role !== "assistant") return null;
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs =
    parseTimestampMs(record.timestamp) ??
    parseTimestampMs(record.createdAt) ??
    parseTimestampMs(message.timestamp);
  if (timestampMs === null) return null;

  const model =
    typeof message.model === "string"
      ? message.model
      : typeof record.model === "string"
        ? record.model
        : "";
  if (model.length === 0) return null;

  const input = int(usageRecord.input ?? usageRecord.input_tokens);
  const output = int(usageRecord.output ?? usageRecord.output_tokens);
  const cacheRead = int(
    usageRecord.cacheRead ?? usageRecord.cache_read_input_tokens,
  );
  const cacheWrite = int(
    usageRecord.cacheWrite ?? usageRecord.cache_creation_input_tokens,
  );
  const reasoning = int(
    usageRecord.reasoning ?? usageRecord.reasoning_output_tokens,
  );

  const totals: UsageTokenTotals = {
    uncachedInputTokens: Math.max(0, input),
    cachedInputTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: Math.min(output, reasoning),
  };
  if (totalTokens(totals) === 0) return null;

  let reportedCostUsd: number | null = null;
  const cost = usageRecord.cost;
  if (typeof cost === "number" && Number.isFinite(cost)) {
    reportedCostUsd = cost;
  } else if (typeof cost === "object" && cost !== null) {
    const total = (cost as Record<string, unknown>).total;
    if (typeof total === "number" && Number.isFinite(total)) {
      reportedCostUsd = total;
    }
  }

  const id =
    typeof record.id === "string"
      ? record.id
      : typeof message.id === "string"
        ? message.id
        : null;

  return {
    provider: "pi",
    timestampMs,
    model,
    sessionId:
      typeof record.sessionId === "string"
        ? record.sessionId
        : sessionIdFallback,
    totals,
    reportedCostUsd,
    dedupeKey: id,
  };
}
