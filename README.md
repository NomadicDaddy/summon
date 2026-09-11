# summon

Open a named Claude Code or Codex session in a fresh terminal window. Each name has one saved CLI
and its own conversation history.

## Requirements and installation

Install Bun 1.4 or later and the CLI you want to use (`claude` or `codex`). Authenticate that CLI
before using summon, and keep both it and `bun` on your `PATH`. summon does not install the provider
CLIs or manage their credentials.

From a downloaded source checkout:

```sh
bun install --frozen-lockfile
bun link
```

Ensure Bun's global binary directory is on your `PATH` (`bun pm bin -g` prints it).

## Usage

```sh
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

Windows requires `wt.exe` for a new window; macOS uses Terminal through `osascript`. On Linux,
summon looks for `x-terminal-emulator`, `gnome-terminal`, or `konsole`, and runs in the current
terminal if none is found. Use `--same-window` if a terminal launcher is unavailable.

Codex session IDs are captured when the Codex process exits. Claude session IDs are generated and
stored before launch, because Claude Code accepts an explicit `--session-id`.

Notes and session IDs are stored as plain JSON. Notes are sent to the selected provider as part of
the session prompt, so avoid putting credentials in them. Set `SUMMON_HOME` to change the record
directory. Codex session discovery reads `CODEX_HOME/sessions` (by default `~/.codex/sessions`).
Avoid starting multiple new Codex sessions in the same directory at once: discovery selects the
most recently modified matching session file after exit.

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

This checkout uses the hooks in `.githooks`. Commits scan staged additions for likely secrets and
private paths. Pushes prevent publishing aidd history to a configured remote and check screenshot
evidence for tagged releases when the tagged tree opts into that requirement.

Before packaging, run `bun run release:check`. Create the archive with `bun pm pack`; it contains
the TypeScript runtime, Bun installation guard, and public documentation. Bun is required at runtime.
The archive can be installed with `bun add -g ./summon-0.2.0.tgz`.
