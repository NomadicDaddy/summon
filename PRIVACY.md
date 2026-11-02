# Privacy

summon is local-first. It runs on your machine without a Summon account or a hosted coordination
service. Team records stay in your selected team store. Provider CLIs and optional integrations
make the network connections described below.

## No telemetry

summon does not send usage analytics, crash reports, or any telemetry to anyone. There is no
collection to opt out of because there is no collection.

## What is stored, and where

Summon's team data lives under your selected summon home, normally `~/.summon/team-default`:

- **Team records** - registered names, their CLI, working directory and profile.
- **Room** - the shared conversation, including any images pasted into it.
- **Board** - cards, owners, blockers, evidence and history.
- **Mail** - messages between named agents, and approval holds.
- **Diary** - what each teammate did and who it was for.
- **Notes and settings** - teammate notes, the operator notepad, macros and team preferences.
- **Work and runtime records** - schedules and outcomes, published claims, session bindings,
  checkpoint cursors, delivery diagnostics and observed provider metadata. Runtime data includes
  durable records, not just temporary files.

The [storage reference](docs/reference/storage-layout.md) describes these locations and their
preservation requirements. Provider credentials and conversation history have separate locations.

These are ordinary files. They are not encrypted at rest, and anything able to read your disk can
read them. Backups and mirrors of that directory carry them too.

Older Room messages move to `room/archive/` as the live history grows. Rotation does not delete
messages: old cursors, replies and question answers continue to use the archived history. Keep
those archives with `room/events.json` when backing up or restoring a team.

## What removing a teammate does and does not delete

Removing a teammate deletes that name's record, notes, icon, whole mailbox, runtime state, published
claims and claims report. Its schedules are paused and kept with their run history; reusing the name
does not resume them. Removal is done in the Team Window, under Maintenance, and the dialog offers
two modes: delete, or archive. Choosing archive copies the record, notes, icon, mailbox and claims
files into `archives/<name>-<id>/` first, and you type the teammate's name to confirm either way.
Archive leaves the member's scratch folders in place. Permanent deletion removes `scratch/<name>`
and `scratch/shared/<name>` too. If scratch cleanup fails, removal reports what it already removed
and keeps the registration for recovery; do not assume that a failed removal changed nothing.

**It does not touch the room, the Board or the Diary.** A removed teammate's messages, cards and
diary entries stay where they are, under a name that no longer exists, for as long as you keep those
files. Removal is not deletion of everything they wrote. Shared records can also carry reply,
approval and recovery context, so preserve a backup and plan any further cleanup deliberately.

**Conversation history is not among them.** Each CLI keeps its own, in its own location - Codex under
`$CODEX_HOME/sessions`, which is `~/.codex/sessions` unless you set `CODEX_HOME`, and the others
wherever that tool puts them. summon retains bindings and selected observations rather than a full
conversation archive. Its Codex compaction reader can read the bound rollout to select metadata;
it does not retain conversation bodies in those observations. Back up or clear provider history
through that provider's own locations and procedures.

## What leaves your machine

- **Your prompts and project content** go to whichever provider your chosen CLI talks to, on that
  CLI's terms and under that provider's privacy policy. Summon sends startup instructions and
  coordination messages into those sessions; it does not proxy model requests. Kilo's configured
  LM Studio endpoint can be a remote HTTP or HTTPS server, so choose it deliberately.
- **Telegram, if you enable it.** The optional bridge shares your existing private bot chat with the
  team. Explicit Telegram sends and human-directed Room sends go to Telegram; incoming chat
  messages are mirrored into the local Room. Ordinary local Room posts stay local. The bridge is
  off unless you configure it.
- **Provider metadata.** Integrations read session, model, turn and compaction metadata for status
  and delivery. The optional Codex usage read invokes its installed app-server protocol. Kilo
  metadata requests use its owned local worker. These reads are separate from Summon analytics.
- **Installation and updates.** Dependency installation downloads packages and runtimes from their
  package sources. The Windows installer can obtain Bun and PowerShell through winget or pinned
  official GitHub releases when you select them on its Dependencies page.

Summon's local provider bridges also use loopback connections on your machine. Running teammates
retain their CLI's network and filesystem access; Summon is not a network isolation boundary.

## Screenshots and transcripts

A screenshot of the team window shows real teammate names and real working directories, and a
transcript shows real work. Neither is scanned by anything before it is shared. Treat both as you
would any other working document.

## About this document

Reviewed 2026-10-30 against the 1.0.0 source candidate `b94061e`, including removal, team storage
and provider integration paths. This is a description of source behavior, not a packet capture or
fresh acceptance test of every provider. Each provider and Telegram has its own privacy policy.

Questions about anything in this document belong in [SUPPORT.md](SUPPORT.md), which has the routes
for them. A suspected vulnerability goes to [SECURITY.md](SECURITY.md) instead.
