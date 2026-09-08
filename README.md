# summon

Open a named Claude Code or Codex session in a fresh terminal window. Each name has one saved CLI
and its own conversation history.

```sh
bun install
bun link

# Choose the CLI when registering a new name. New names default to Claude.
summon carl
summon jimmy
summon auden --using codex

# After that, just use the name.
summon carl
summon jimmy
summon auden
```

The first call creates `~/.agent/<name>.json` and starts a new session. Later calls use the registered
CLI and resume its most recently used session. Records contain the display name, CLI (`provider`),
persistent notes, working directory, and session history.

`--using` is only needed to select a CLI for a new name. It cannot switch an existing name to another
CLI: a conflicting choice fails without changing the record. Use a different name for another CLI.

Add context or change the working directory when summoning:

```sh
summon carl --note "Owns the release checklist"
summon carl --cwd /path/to/project
```

Use `--same-window` when a separate terminal is not wanted. New windows are supported through
Windows Terminal, macOS Terminal, and common Linux terminal emulators.

Codex session IDs are captured when the Codex process exits. Claude session IDs are generated and
stored before launch, because Claude Code accepts an explicit `--session-id`.

## Record format

Records use `version: 2`, a `provider` of `claude` or `codex`, and a single `sessions` array.
Version 1 records are rejected, not automatically assigned a CLI. To convert an old record, keep a
backup, choose its provider, set `version` to `2`, and replace the old sessions map with that provider's
session array. Preserve the other fields and every session entry. If both providers have history,
split them into separately named records before converting; do not discard either history.

## Development

```sh
bun run smoke:qc
```
