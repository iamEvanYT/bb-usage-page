const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

export function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trim(value / 1e12)}T`;
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return formatCount(value);
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatPercent(share: number, digits = 1): string {
  return `${(share * 100).toFixed(digits)}%`;
}

export function formatDayShort(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (year === undefined || month === undefined || dayOfMonth === undefined) {
    return day;
  }
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[month - 1] ?? ""} ${dayOfMonth}`;
}

export function enumerateDays(
  sinceDay: string,
  untilDay: string,
): readonly string[] {
  const days: string[] = [];
  if (!isValidDay(sinceDay) || !isValidDay(untilDay) || sinceDay > untilDay) {
    return days;
  }
  const [year = 0, month = 1, dayOfMonth = 1] = sinceDay
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const cursor = new Date(Date.UTC(year, month - 1, dayOfMonth));
  while (true) {
    const day = cursor.toISOString().slice(0, 10);
    if (day > untilDay) break;
    days.push(day);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

const validatedTimeZones = new Map<string, boolean>();

export function isValidTimeZone(timeZone: string): boolean {
  const cached = validatedTimeZones.get(timeZone);
  if (cached !== undefined) return cached;
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    validatedTimeZones.set(timeZone, true);
    return true;
  } catch {
    validatedTimeZones.set(timeZone, false);
    return false;
  }
}

let defaultTimeZone: string | null = null;

export function resolveTimeZone(timeZone: string | undefined): string {
  if (timeZone && isValidTimeZone(timeZone)) return timeZone;
  if (!defaultTimeZone) {
    defaultTimeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
  return defaultTimeZone;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Reused per timezone — constructing Intl.DateTimeFormat per call is very slow. */
export function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(timeZone);
  if (formatter) return formatter;
  const zone = resolveTimeZone(timeZone);
  formatter = dayFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(zone, formatter);
  }
  if (timeZone !== zone) dayFormatters.set(timeZone, formatter);
  return formatter;
}

/** Civil-date window in `timeZone` (inclusive). */
export function makeWindow(
  days: number,
  now = new Date(),
  timeZone = resolveTimeZone(undefined),
): { sinceDay: string; untilDay: string; timeZone: string } {
  const zone = resolveTimeZone(timeZone);
  const untilDay = dayFormatter(zone).format(now);
  const [year = 0, month = 1, dayOfMonth = 1] = untilDay
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  // Subtract calendar days on the civil date itself (not wall-clock ms).
  const start = new Date(Date.UTC(year, month - 1, dayOfMonth));
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return {
    sinceDay: start.toISOString().slice(0, 10),
    untilDay,
    timeZone: zone,
  };
}

export function dayInTimeZone(timestampMs: number, timeZone: string): string {
  return dayFormatter(timeZone).format(new Date(timestampMs));
}

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallClockFormatters.get(timeZone);
  if (formatter) return formatter;
  formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  wallClockFormatters.set(timeZone, formatter);
  return formatter;
}

function civilDayAfter(day: string): string {
  const [year = 0, month = 1, dayOfMonth = 1] = day
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const next = new Date(Date.UTC(year, month - 1, dayOfMonth));
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** Convert a civil date/time in an IANA zone to its UTC instant. */
function localDateTimeMs(
  day: string,
  timeZone: string,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number {
  const [year = 0, month = 1, dayOfMonth = 1] = day
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const wallMs = Date.UTC(
    year,
    month - 1,
    dayOfMonth,
    hour,
    minute,
    second,
    millisecond,
  );
  let candidate = wallMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = wallClockFormatter(timeZone).formatToParts(
      new Date(candidate),
    );
    const values = new Map(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number.parseInt(part.value, 10)]),
    );
    const formattedWallMs = Date.UTC(
      values.get("year") ?? year,
      (values.get("month") ?? month) - 1,
      values.get("day") ?? dayOfMonth,
      values.get("hour") ?? hour,
      values.get("minute") ?? minute,
      values.get("second") ?? second,
      0,
    );
    const next = wallMs - (formattedWallMs - candidate);
    if (next === candidate) return candidate;
    candidate = next;
  }
  return candidate;
}

export function localDayStartMs(day: string, timeZone: string): number {
  return localDateTimeMs(day, timeZone, 0, 0, 0, 0);
}

export function localDayEndMs(day: string, timeZone: string): number {
  return localDayStartMs(civilDayAfter(day), timeZone) - 1;
}

export function assertValidWindow(input: {
  sinceDay: string;
  untilDay: string;
  timeZone: string;
}): void {
  if (!isValidDay(input.sinceDay) || !isValidDay(input.untilDay)) {
    throw new Error("sinceDay and untilDay must be valid YYYY-MM-DD dates");
  }
  if (input.sinceDay > input.untilDay) {
    throw new Error("sinceDay must be on or before untilDay");
  }
  if (!isValidTimeZone(input.timeZone)) {
    throw new Error(`Invalid timeZone: ${input.timeZone}`);
  }
}
