import { PROVIDER_ORDER, type MergedUsage, type UsageProviderKind } from "./types";

export const PREFERENCES_KEY = "preferences";
/** Realtime channel published after preferences are saved. */
export const PREFERENCES_CHANNEL = "preferences";

export const DEFAULT_PROVIDER_ENABLED: Record<UsageProviderKind, boolean> = {
  codex: true,
  claude: true,
  pi: true,
  cursor: false,
  opencode: false,
  devin: false,
};

export const DEFAULT_CLAUDE_DIRS: readonly string[] = ["~/.claude"];
export const MAX_CLAUDE_DIRS = 16;

export interface ProviderPreference {
  id: UsageProviderKind;
  enabled: boolean;
}

export interface UsagePreferences {
  /** Every provider exactly once, in display order. */
  providers: ProviderPreference[];
  /** Override for Cursor's state.vscdb; "" uses the platform default. */
  cursorDatabasePath: string;
  /** Claude Code config directories; each one's `projects/` is scanned. */
  claudeDirs: string[];
}

function isProviderKind(value: unknown): value is UsageProviderKind {
  return PROVIDER_ORDER.includes(value as UsageProviderKind);
}

/**
 * Coerce any stored or submitted value into a complete preference set:
 * unknown ids are dropped, duplicates keep their first position, and
 * providers added in later versions append in default order with their
 * default state.
 */
export function normalizePreferences(raw: unknown): UsagePreferences {
  const stored = (typeof raw === "object" && raw !== null ? raw : {}) as {
    providers?: unknown;
    cursorDatabasePath?: unknown;
    claudeDirs?: unknown;
  };
  const providers: ProviderPreference[] = [];
  const seen = new Set<UsageProviderKind>();
  for (const entry of Array.isArray(stored.providers) ? stored.providers : []) {
    const { id, enabled } = (entry ?? {}) as { id?: unknown; enabled?: unknown };
    if (!isProviderKind(id) || seen.has(id)) continue;
    seen.add(id);
    providers.push({
      id,
      enabled: typeof enabled === "boolean" ? enabled : DEFAULT_PROVIDER_ENABLED[id],
    });
  }
  for (const id of PROVIDER_ORDER) {
    if (!seen.has(id)) providers.push({ id, enabled: DEFAULT_PROVIDER_ENABLED[id] });
  }
  const cursorDatabasePath =
    typeof stored.cursorDatabasePath === "string" ? stored.cursorDatabasePath.trim() : "";
  return { providers, cursorDatabasePath, claudeDirs: normalizeClaudeDirs(stored.claudeDirs) };
}

/** Trimmed, unique, non-empty; falls back to the default when none remain. */
export function normalizeClaudeDirs(raw: unknown): string[] {
  const dirs = [
    ...new Set(
      (Array.isArray(raw) ? raw : [])
        .filter((dir): dir is string => typeof dir === "string")
        .map((dir) => dir.trim().replace(/(.)[\\/]+$/u, "$1"))
        .filter(Boolean),
    ),
  ].slice(0, MAX_CLAUDE_DIRS);
  return dirs.length > 0 ? dirs : [...DEFAULT_CLAUDE_DIRS];
}

export function enabledProviders(
  preferences: UsagePreferences,
): UsageProviderKind[] {
  return preferences.providers
    .filter((provider) => provider.enabled)
    .map((provider) => provider.id);
}

export const DEFAULT_ENABLED_PROVIDERS = enabledProviders(normalizePreferences(null));

/** Keep only enabled providers, in the user's order. */
export function applyProviderPreferences(
  merged: MergedUsage,
  enabled: readonly UsageProviderKind[],
): MergedUsage {
  const rank = new Map(enabled.map((id, index) => [id, index]));
  const visible = (provider: UsageProviderKind) => rank.has(provider);
  return {
    ...merged,
    providers: merged.providers
      .filter((row) => visible(row.provider))
      .sort((a, b) => rank.get(a.provider)! - rank.get(b.provider)!),
    models: merged.models.filter((row) => visible(row.provider)),
    threads: merged.threads.filter((row) => visible(row.provider)),
    sources: merged.sources.filter((row) => visible(row.provider)),
  };
}
