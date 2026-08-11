# Usage

A bb plugin that shows Claude Code, Codex, and Pi token usage and estimated
API cost — inspired by [t3code](https://github.com/pingdotgg/t3code)'s Usage
page.

## Features

- Sidebar **Usage** panel with 7 / 30 / 90 day windows
- Provider split (Codex, Claude Code, Pi), daily chart, model/day breakdown
- Durable on-disk caches — only re-parse transcripts whose size/mtime changed
- 7 / 30 / 90 day switches slice a warm 90-day base (no re-scan)
- CLI: `bb usage show [--days 7|30|90] [--force]`

## Data sources

| Provider     | Transcripts                                              | Cost                         |
| ------------ | -------------------------------------------------------- | ---------------------------- |
| Codex        | `~/.codex/sessions/**/*.jsonl`                           | LiteLLM model rates          |
| Claude Code  | `~/.claude/projects/**/*.jsonl` (and `CLAUDE_CONFIG_DIR`) | Transcript `costUSD` or rates |
| Pi           | `~/.bb/pi-bridge-sessions`, `~/.pi/agent/sessions`       | `message.usage.cost.total`   |

## On-disk cache

All durable state lives under `~/.bb/plugins/usage/`:

| File | Purpose |
| ---- | ------- |
| `usage-scan-cache.json` | Per-transcript parse cache (records keyed by path + size + mtime) |
| `usage-base-cache.json` | Aggregated 90-day buckets/sessions for instant window slices |
| `usage-model-rates.json` | Cached LiteLLM pricing table |

Refresh / `--force` deletes the scan + base caches and re-reads transcripts.

## Install

Path installs build from source automatically:

```bash
bb plugin install .
```

For git/npm installs, commit (or publish) a fresh `dist/` from `npm run build`.
bb prefers `dist/` when present and the SDK major matches.

```bash
npm run build
bb plugin install git:<repo-url>@main
```

Open **Usage** in the bb sidebar, or run:

```bash
bb usage show --days 30
```

## Develop

```bash
npm install
bb plugin install .
bb plugin dev          # rebuild + reload on save
npm run typecheck
npm run build          # refresh dist/ before publishing
```

## Notes

- Costs are **raw API-equivalent** estimates, not subscription invoices.
- `<synthetic>` Claude transcript rows are ignored (local/non-billed).
- After the first scan, unchanged loads are fingerprint hits (no re-parse / no re-aggregate).
- In-memory window slices stay instant; a short hot TTL avoids filesystem walks on day toggles.
