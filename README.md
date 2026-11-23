# Usage

A [bb](https://github.com/get-bb/bb) plugin that shows Claude Code, Codex, Pi,
Cursor, OpenCode, and Devin usage and estimated API cost — inspired by
[t3code](https://github.com/pingdotgg/t3code)'s Usage page.

Requires bb `>= 0.50`. Git installs need `npm` on PATH.

## Install

```bash
bb plugin install https://github.com/iamEvanYT/bb-usage-page
```

That tracks `main`. Pin a branch, tag, or commit with:

```bash
bb plugin install git:https://github.com/iamEvanYT/bb-usage-page.git@main
```

From a local checkout:

```bash
bb plugin install .
```

Open **Usage** in the bb sidebar, or run:

```bash
bb usage show [--days 7|30|90] [--force]
```

## Features

- Sidebar **Usage** panel with 7 / 30 / 90 day windows
- Turn providers on or off and drag them into the order you want under bb
  Settings → Plugins → Usage → Providers. Disabled providers are not read at all
- Provider split (Codex, Claude Code, Pi, Cursor, OpenCode, Devin), daily chart, and model /
  project / threads / day breakdown
- Threads rank sessions by cost and link to matching bb threads, including archived threads. Other Claude sessions use their saved title when available, with session IDs as a fallback; Cursor remains an account-level row
- Project rows map to bb projects when possible; personal `env_*` workspaces link to their thread; `~/Documents/Codex/*` chats merge into **Unassociated Codex chats**; unmatched folders stay as their own rows
- Durable on-disk caches — only re-parse transcripts whose size/mtime changed
- 7 / 30 / 90 day switches slice a warm 90-day base (no re-scan)
- Cursor dashboard results are reused for 15 minutes and are invalidated when the auth database path changes

## Settings

bb Settings → Plugins → Usage → Providers lists every provider with the data
it found on this machine. Claude Code, Codex, and Pi are on by default; Cursor,
OpenCode, and Devin start off. Each row has a switch and a drag handle; the handle
also moves with the arrow keys, Home, and End. The Usage page, chart, legend,
and Day table follow that order. At least one provider has to stay on, and
**Reset to defaults** restores the original order and switches.

Claude Code has a **Directories** list under its row. It starts with
`~/.claude`; add another config directory, such as the `CLAUDE_CONFIG_DIR`
of a second account, and its `projects` folder is scanned too. A path that already
ends in `projects` is read as is. Directories without a projects folder are
flagged in the list. `CLAUDE_CONFIG_DIR` and `~/.claude.backup` are no longer
scanned automatically, so add them here if you rely on them.

Preferences are stored in the plugin's bb key-value storage. Earlier versions
kept the Cursor switch and auth path in declarative plugin settings; bb hides
those values once the descriptors are gone, so turn Cursor on again in the
Providers list after upgrading.

## Data sources

Transcripts are read from the machine running the bb server, not from enrolled
remote hosts.

| Provider     | Transcripts                                               | Cost                          |
| ------------ | --------------------------------------------------------- | ----------------------------- |
| Codex        | `~/.codex/sessions/**/*.jsonl` (or `CODEX_HOME`)          | LiteLLM model rates           |
| Claude Code  | `<dir>/projects/**/*.jsonl` for each configured directory (default `~/.claude`) | Transcript `costUSD` or rates |
| Pi           | `~/.bb/pi-bridge-sessions`, `~/.pi/agent/sessions`        | `message.usage.cost.total`    |
| Cursor       | Cursor dashboard API using local desktop auth             | Cursor-reported cents         |
| OpenCode     | `~/.local/share/opencode/opencode*.db` (or `XDG_DATA_HOME`) | Reported `cost`, else LiteLLM rates |
| Devin        | `~/.local/share/devin/cli/sessions.db` (`%APPDATA%\devin\cli` on Windows) | LiteLLM model rates |

Cursor support is opt-in; turn it on in the Providers list. It reads the
Cursor desktop `state.vscdb` database in read-only mode and derives a
short-lived dashboard cookie in memory; the access token is not persisted by
this plugin. Cursor usage is account-level, so it cannot be attributed to
individual projects or sessions. The dashboard API is an undocumented web
endpoint and may change independently of the plugin.

OpenCode is read from its SQLite database in read-only mode (both the v1
`message` and v2 `session_message` layouts; messages mirrored in both are
counted once). Messages that log a cost of 0 — free or subscription-backed
models — are priced from LiteLLM model rates instead.

Devin CLI sessions are read from `sessions.db` in read-only mode. Each
assistant turn's token metrics are counted once per request id, so turns that
compaction re-saves are not billed again. Devin model names drop their effort
suffix before pricing and keep `-priority` (`gpt-5-5-high-priority` becomes
`gpt-5.5-priority`), which is priced at LiteLLM's priority-tier rates. Internal models such
as `swe-2` and `compactor` have no public rate and show as unpriced tokens.

## On-disk cache

All durable state lives in this plugin's bb storage directory,
`<bb data dir>/plugins/usage-page/` (`~/.bb/plugins/usage-page/` by default):

| File                    | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `usage-scan-cache.json` | Per-transcript parse cache (records keyed by path + size + mtime) |
| `usage-base-cache.json` | Aggregated 90-day buckets/sessions for instant window slices     |
| `usage-model-rates.json`| Cached LiteLLM pricing table                                     |

Refresh / `--force` deletes the scan + base caches and re-reads transcripts.
Normal scans retain restored transcripts selected by ctime or in-window usage.
Local transcript changes reuse successful Cursor usage for up to 15 minutes,
provided the requested window, time zone, auth path, and pricing still match.
Refresh / `--force` also fetches Cursor usage again.

## Develop

```bash
npm install
bb plugin install .
bb plugin dev
npm run typecheck
```

`dist/` is a local build artifact (gitignored). Git installs build from source.

## Notes

- Costs are **raw API-equivalent** estimates, not subscription invoices.
- `<synthetic>` Claude transcript rows are ignored (local/non-billed).
- After the first scan, unchanged loads are fingerprint hits (no re-parse / no re-aggregate).
- In-memory window slices stay instant; a short hot TTL avoids filesystem walks on day toggles.

## License

MIT
