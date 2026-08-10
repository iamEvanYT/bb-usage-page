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

```bash
bb plugin install .
# or after publish:
# bb plugin install git:<repo-url>@main
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
npm run build          # writes dist/ for git/npm installs
```

## Notes

- Costs are **raw API-equivalent** estimates, not subscription invoices.
- `<synthetic>` Claude transcript rows are ignored (local/non-billed).
- `--force` re-aggregates the window but still skips re-parsing unchanged files.
