# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-11-23

### Added

- Multi-machine usage. Every bb machine scans its own transcripts and
  databases through the plugin's host worker, and the server merges them.
- Machine picker on the Usage page with per-machine cost, checkboxes, and
  **Select all**. Unchecked machines are remembered per browser; new machines
  are included automatically.
- Offline machines show their last successful scan with a notice and its age.
- `bb usage show` lists each machine's total.
- Settings → Providers shows where data was found on each machine.

### Changed

- Requires bb 0.50 or later. The plugin now uses the `@get-bb/plugin-sdk`
  npm package instead of vendored SDK declarations.
- A session found on two machines (for example a synced transcript folder) is
  counted once.
- The Usage page fits phone screens: header controls stay on one row with
  short window labels, the machine picker opens as a bottom sheet, wide tables
  drop secondary columns, and controls get larger touch targets.
- The daily chart draws at its real width, so axis labels stay readable, and
  a tap or drag shows that day's values on touch screens.
- Settings → Providers lists each detected location on its own line, with
  its machine name.

### Fixed

- Windows: transcript roots, cache pruning, `~\` paths, and Claude Code's
  `C--Users-...` project folder encoding are handled.
- Project rows match bb projects for Windows paths, case-insensitively, and
  `Documents\Codex` chats on Windows merge into **Unassociated Codex chats**.
- Unit tests no longer read the real `%APPDATA%` Devin database or assume POSIX
  paths, so the suite passes on Windows.

## [1.3.0] - 2026-11-19

### Added

- Cursor usage tracking, read from the Cursor dashboard and reused for 15 minutes.
- OpenCode usage tracking (v1 and v2 databases, deduplicated by message id).
- Devin usage tracking.
- Threads breakdown that shows cost per session, with session titles.
- Providers list in bb Settings → Plugins → Usage → Providers to turn
  providers on or off and reorder them. Disabled providers are not read.
- Directories list for Claude Code, so additional config directories (such as
  a second account's `CLAUDE_CONFIG_DIR`) can be scanned.
- `npm test` script that runs the test suites under Node.

### Changed

- Only Claude Code, Codex, and Pi are on by default; Cursor, OpenCode, and
  Devin start off.
- `CLAUDE_CONFIG_DIR` and `~/.claude.backup` are no longer scanned
  automatically. Add them to the Claude Code Directories list if needed.
- Provider preferences are stored in the plugin's bb key-value storage. The
  Cursor switch and auth path from earlier declarative settings are not
  carried over, so turn Cursor on again after upgrading.
- Caches moved from `~/.bb/plugins/usage/` (the plugin's old id, which can
  belong to a different plugin) to its own bb storage directory,
  `<bb data dir>/plugins/usage-page/`, and follow a non-default bb data
  directory. The first load after upgrading rebuilds them. The old files in
  `~/.bb/plugins/usage/` (`usage-scan-cache.json`, `usage-base-cache.json`,
  `usage-model-rates.json`) can be deleted.
- Scans are quicker.

### Fixed

- Projects stayed visible after switching to the Models list.
- Devin priority-tier requests are priced at priority-tier rates.

## [1.2.0] - 2026-08-17

### Changed

- Renamed the package to `bb-plugin-usage-page`, so the plugin id is now
  `usage-page`. The sidebar panel is still titled **Usage**.

## [1.1.0] - 2026-08-15

No changes since 1.0.1; version bump only.

## [1.0.1] - 2026-08-15

### Added

- Project breakdown that groups spend by workspace, merging checkout and
  worktree sessions for the same bb project, naming personal env workspaces
  after their thread, and folding unassociated Codex home chats together.
- MIT license and repository metadata for installing from Git.

### Changed

- Durable 90-day base summary; only changed transcripts are re-parsed, so
  7 / 30 / 90 day switches are instant.
- Removed the "transcripts not found" banners.

### Fixed

- Forked Codex history was counted as new spend.
- A stale usage window could stay on screen after the date range changed.
- Hardened the usage RPC and CLI, the scan cache, and transcript pricing.
- The loading skeleton flickered on cached window switches; it now appears only
  if the new range is still pending after 30 ms.

## [1.0.0] - 2026-08-11

### Added

- Initial release: Usage dashboard for Claude Code, Codex, and Pi with
  estimated API cost.

[Unreleased]: https://github.com/iamEvanYT/bb-usage-page/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/iamEvanYT/bb-usage-page/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/iamEvanYT/bb-usage-page/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/iamEvanYT/bb-usage-page/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/iamEvanYT/bb-usage-page/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/iamEvanYT/bb-usage-page/compare/79eec05...v1.0.1
[1.0.0]: https://github.com/iamEvanYT/bb-usage-page/commit/79eec05
