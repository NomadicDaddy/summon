# summon

Open a named Claude Code or Codex session in a fresh terminal window. Claude is the default.

```sh
bun install
bun link

summon carl
summon carl --using codex
```

The first call creates `~/.agent/carl.json` and starts a new provider session. Later calls resume
the most recently used session for that provider. Each record contains the display name, persistent
notes, working directory, and provider-specific session history.

Add context or change the working directory when summoning:

```sh
summon carl --note "Owns the release checklist"
summon carl --cwd /path/to/project
```

Use `--same-window` when a separate terminal is not wanted. New windows are supported through
Windows Terminal, macOS Terminal, and common Linux terminal emulators.

Codex session IDs are captured when the Codex process exits. Claude session IDs are generated and
stored before launch, because Claude Code accepts an explicit `--session-id`.

## Development

```sh
bun run smoke:qc
```
