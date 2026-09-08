# Changelog

Notable changes to summon are recorded here using Keep a Changelog categories and semantic versions.

## [0.2.0] - 2026-09-08

### Added

- Each name now saves its chosen CLI. Register a Codex name with `--using codex`, then resume it
  with just `summon <name>`. New names still default to Claude.

### Changed

- **Breaking:** agent records now require `version: 2`, one `provider`, and a single session list.
  Version 1 records are rejected without being rewritten. Back up old records and follow the
  [record conversion instructions](README.md#record-format); split names that contain both providers'
  histories into separate records.
- `--using` cannot switch an existing name to a different CLI. A conflicting choice fails before
  changing notes, the working directory, or session history. Use another name for the other CLI.
- Sessions opened in a new terminal use the CLI saved in the named record, just like
  `--same-window` sessions.

### Security

- The internal session runner validates names and rejects path traversal and extra provider
  arguments before opening a record or launching a CLI.

## [0.1.0] - 2026-09-02

### Added

- Named Claude Code and Codex sessions with persistent notes, saved working directories, and
  separate provider histories in `~/.agent/`.
- New-terminal and same-window launches, with saved session IDs used to resume conversations.
