# Usage

A [bb](https://github.com/get-bb/bb) plugin that shows Claude Code, Codex, Pi,
and Cursor usage and estimated API cost — inspired by
[t3code](https://github.com/pingdotgg/t3code)'s Usage page.

Requires bb `>= 0.36`. Git installs need `npm` on PATH.

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
- Provider split (Codex, Claude Code, Pi, Cursor), daily chart, and model /
  project / day breakdown
- Project rows map to bb projects when possible; personal `env_*` workspaces link to their thread; `~/Documents/Codex/*` chats merge into **Unassociated Codex chats**; unmatched folders stay as their own rows
- Durable on-disk caches — only re-parse transcripts whose size/mtime changed
- 7 / 30 / 90 day switches slice a warm 90-day base (no re-scan)
- Cursor dashboard results are reused for 15 minutes and are invalidated when the auth database path changes

## Data sources

Transcripts are read from the machine running the bb server, not from enrolled
remote hosts.

| Provider     | Transcripts                                               | Cost                          |
| ------------ | --------------------------------------------------------- | ----------------------------- |
| Codex        | `~/.codex/sessions/**/*.jsonl` (or `CODEX_HOME`)          | LiteLLM model rates           |
| Claude Code  | `~/.claude/projects/**/*.jsonl` (and `CLAUDE_CONFIG_DIR`) | Transcript `costUSD` or rates |
| Pi           | `~/.bb/pi-bridge-sessions`, `~/.pi/agent/sessions`        | `message.usage.cost.total`    |
| Cursor       | Cursor dashboard API using local desktop auth             | Cursor-reported cents         |

Cursor support is opt-in under bb Settings → Plugins → Usage. It reads the
Cursor desktop `state.vscdb` database in read-only mode and derives a
short-lived dashboard cookie in memory; the access token is not persisted by
this plugin. Cursor usage is account-level, so it cannot be attributed to
individual projects or sessions. The dashboard API is an undocumented web
endpoint and may change independently of the plugin.

## On-disk cache

All durable state lives under `~/.bb/plugins/usage/`:

| File                    | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `usage-scan-cache.json` | Per-transcript parse cache (records keyed by path + size + mtime) |
| `usage-base-cache.json` | Aggregated 90-day buckets/sessions for instant window slices     |
| `usage-model-rates.json`| Cached LiteLLM pricing table                                     |

Refresh / `--force` deletes the scan + base caches and re-reads transcripts.

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
