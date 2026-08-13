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
