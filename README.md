# Usage

A bb plugin that shows Claude Code, Codex, and Pi token usage and estimated
API cost — inspired by [t3code](https://github.com/pingdotgg/t3code)'s Usage
page.

## Features

- Sidebar **Usage** panel with 7 / 30 / 90 day windows
- Provider split (Codex, Claude Code, Pi), daily chart, model/day breakdown
- Durable scan cache — refresh reuses parsed transcripts unless files changed
- CLI: `bb usage show [--days 7|30|90] [--force]`

## Data sources

| Provider     | Transcripts                                              | Cost                         |
| ------------ | -------------------------------------------------------- | ---------------------------- |
| Codex        | `~/.codex/sessions/**/*.jsonl`                           | LiteLLM model rates          |
| Claude Code  | `~/.claude/projects/**/*.jsonl` (and `CLAUDE_CONFIG_DIR`) | Transcript `costUSD` or rates |
| Pi           | `~/.bb/pi-bridge-sessions`, `~/.pi/agent/sessions`       | `message.usage.cost.total`   |

Cache files live under `~/.bb/plugins/usage/`.

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
- Refresh / `--force` clears the durable parse cache and re-reads transcripts.
- Warm requests within ~10s reuse the last summary without walking the filesystem.
