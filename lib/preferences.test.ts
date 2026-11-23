import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyProviderPreferences,
  enabledProviders,
  normalizePreferences,
} from "./preferences";
import { mergeSummary } from "./summary";

test("preferences keep a full, ordered, deduplicated provider list", () => {
  const defaults = normalizePreferences(undefined);
  assert.deepEqual(defaults.providers.map((p) => p.id), ["codex", "claude", "pi", "cursor", "opencode", "devin"]);
  assert.deepEqual(enabledProviders(defaults), ["codex", "claude", "pi"]);
  assert.equal(defaults.cursorDatabasePath, "");
  assert.deepEqual(defaults.claudeDirs, ["~/.claude"]);

  const stored = normalizePreferences({
    providers: [
      { id: "pi", enabled: false },
      { id: "nope", enabled: true },
      { id: "claude", enabled: true },
      { id: "pi", enabled: true },
      { id: "codex", enabled: "yes" },
    ],
    cursorDatabasePath: "  ~/state.vscdb ",
  });
  assert.deepEqual(stored.providers, [
    { id: "pi", enabled: false },
    { id: "claude", enabled: true },
    { id: "codex", enabled: true },
    { id: "cursor", enabled: false },
    { id: "opencode", enabled: false },
    { id: "devin", enabled: false },
  ]);
  assert.equal(stored.cursorDatabasePath, "~/state.vscdb");
  assert.deepEqual(stored.claudeDirs, ["~/.claude"]);
});

test("Claude directories are trimmed, unique, and never empty", () => {
  assert.deepEqual(
    normalizePreferences({ claudeDirs: [" ~/.claude ", "~/.claude-work/", "~/.claude", "", 4, "/"] }).claudeDirs,
    ["~/.claude", "~/.claude-work", "/"],
  );
  assert.deepEqual(normalizePreferences({ claudeDirs: [] }).claudeDirs, ["~/.claude"]);
});

test("usage output keeps only enabled providers in the chosen order", () => {
  const merged = mergeSummary({
    readAt: "", timeZone: "UTC", sinceDay: "2026-11-01", untilDay: "2026-11-01",
    buckets: [], sources: [], scanDurationMs: 0, sessions: 0,
    pricing: { status: "unavailable", source: "", fetchedAt: null, knownModels: 0 },
  });
  const visible = applyProviderPreferences(merged, ["pi", "devin", "codex"]);
  assert.deepEqual(visible.providers.map((p) => p.provider), ["pi", "devin", "codex"]);
});
