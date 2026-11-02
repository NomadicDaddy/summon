# Usage

### Hibernation

The operator can use **Hibernate / Unhibernate** in the selected teammate's header,
`summon --hibernate <name>` / `summon --unhibernate <name>` in the operator terminal,
or the exact room messages `@name --hibernate` / `@name --unhibernate`.
Authenticated Telegram messages support the same addressed controls. Peer messages cannot
change this state. It persists across restarts until the operator explicitly releases it.

Hibernation asks the agent to wrap up, stop cyclic tasks and subagents, record unfinished work,
and end its turn. It blocks subsequent routine notifications, mentions, startup recovery,
direct launches and terminal input. Pending mail and room history remain unread; unhibernation
asks the session to checkpoint again. The roster shows **Hibernated**, and skipped mention wakes
are reported in the window. The session process and lock remain intact; **Stop** is still available
for a terminal owned by this window. Running-session ID changes remain prohibited.

This is cooperative dormancy, not process suspension: already queued provider input cannot be
withdrawn, and the agent must comply with the wrap-up instruction. Claude and Codex use their
session receivers; Grok and Kilo receive control through a Team Window-owned terminal. An external
Grok/Kilo terminal needs the operator to deliver the wrap-up instruction there. Updated receivers
require a user-controlled session restart; the new header requires reopening the Team Window.

The default registry is `~/.summon/team-default`; `SUMMON_HOME` selects an exact custom store.
Legacy data directly in `~/.summon`, a conflicting destination, or an incomplete layout causes
startup to refuse before initializing another team. Moving from `~/.agent` or the old flat store
requires the [separate offline plan](storage-layout.md#default-team-subfolder), verified backup
and compatible application entrypoints. Do not merge registries or move the whole teams base into
its own child. There is no automatic migration or fallback to either old location.

### Telegram team conversation

The bundled `summon-telegram` skill shares your existing private bot chat with the summon team.
No Telegram group or new bot is needed. Agents post with their name: `[alice] Build finished.`
Everyone reads the same conversation. Speak normally, name Alice when you want Alice, or ask for
what you need and let the teammate with the relevant expertise respond. No special prefixes are needed.
Teammates announce ownership, discuss competing claims, agree on one owner, and ask you if they cannot
agree. Casual conversation remains context rather than automatically becoming work.

Create `~/.summon/team-default/integrations/telegram.json` (or under `SUMMON_HOME`) locally with string
fields `botToken` and `chatId`. Use your Telegram bot token and the numeric destination chat ID.
Keep this credential file private and outside the repository. Teammate CLIs can still read it; see
the [credential and environment boundaries](../../SECURITY.md#known-boundaries). Start a chat with your bot in Telegram
before using it. `summon --telegram status` checks configuration without displaying credentials or
sending a message. Agents discover the skill through their startup instructions and `--skills status`.

On POSIX, configuration reads restrict this file to mode `0600` and its directory to `0700`, and
refuse linked files or directories. Windows continues to rely on the user profile's ACLs.

```sh
summon --telegram send 'bob: the API is ready'
summon --telegram reply 123 'Thanks, checking it now'
summon --telegram send --to-user 'Ready for your review.'
summon --telegram reply --to-user 123 'Yes, you can re-run now.'
summon --telegram read
summon --telegram ack 12
```

`read` fetches incoming messages and returns up to 20 events with sender identity, reply context,
and a `nextCursor`. Follow `more` with `read <nextCursor>`; after reading a page,
`ack <nextCursor>` saves that agent's position. Room history is shared; each agent's read position is
separate. Replies remain visible to everyone. The transport does not infer recipients or assign tasks;
agents coordinate using the conversation, their expertise, and the user's authority. Coordination is
conversational rather than an enforced task lock, so checking recent claims matters before work begins.

The operator can run `summon --telegram sync` for one incoming batch or `summon --telegram watch`
to collect continuously until Ctrl+C. Reads also sync, so a background process is optional.
Use this bot only with this summon registry: another consumer of Telegram updates can steal updates.
Only messages from the configured chat and allowed human sender IDs are imported. For the existing
private chat, its positive `chatId` identifies the allowed user automatically. Optional group use
requires `allowedUserIds` (an array of numeric strings) and bot permissions to read ordinary messages.
Bot messages, forwarded messages, anonymous posts, edits, and non-text attachments are not imported.

Messages addressed specifically to the human use `--to-user`, displaying a bold
`📣 FOR YOU · <agent>` heading. Everyone still reads them in the shared room, with the attention
marker preserved. Agents use it for direct answers, questions, decisions, and actionable updates;
ordinary teammate conversation keeps the usual name label.
Use `summon --room reply --to-user <localId> <text>` to keep a directed reply in its Team Room
thread. When the parent came from the configured Telegram chat, the phone message also replies
to that Telegram parent. Desk-only parents produce an unthreaded phone message. Local reply
links survive delayed mirror recovery; `--telegram reply` still takes a Telegram message ID.
When addressing both the human and teammates, agents send the human's part alone in its own
`--to-user` message. The teammates' part goes in a separate ordinary message, which may address
multiple teammates together.

Active receivers poll the shared room, sharing a two-second polling cadence, and notify their own
sessions when eligible unread conversation arrives. Codex resumes use the exact saved
thread; fresh Codex sessions bind their supplied identity with `summon --mail bind`. When the team's
Claude delivery setting is live, summon requests Claude's channel for configured Telegram or local-room
history. Claude requires its development-channel confirmation at every start. Checkpoint delivery
omits that prompt. The Team Window types readiness, mail and room notices into its owned Claude
terminal; the model reads their contents at checkpoints. Detached checkpoint-mode sessions read
at startup and checkpoints without pushed notices. Ordinary MCP tools remain available without
claiming the channel receiver. Delivery selection applies at the next launch. Its `room` tool supports reading and
acknowledging pages in either mode.
Restart existing sessions to load the updated receiver. Provider scheduling still determines when a
notice can be handled, so this is not a guaranteed interruption of an active tool. Grok and unavailable
adapters retain checkpoint reads. With the default-on Team Maintenance setting, an explicit `@name` or
`@all` can start stopped teammates; ordinary room activity does not start agents. `@all` starts
anyone only from a human or CLI post: an agent's `@all` still notifies every running teammate and
counts as addressed, but starts or resumes nobody, while an agent's explicit `@name` still starts
that teammate. Mail remains the place for
private or detailed work; do not post private mailbox content into the shared room.

`@online` and `@offline` address teammates by verified presence, the same verdict `summon --presence`
reports. The groups are resolved once, when the message is sent, and stored with it, so a delayed
delivery or a replay addresses the same members even after presence changes. `@online` takes the
teammates verified online and never starts anyone: a member who went offline before delivery is
skipped. `@offline` takes the teammates verified offline, and with the wake-on-mention setting they
start through the same path as an `@name`, so hibernation, rest and halt still apply. Only a human
or CLI post starts anyone this way: an agent's `@offline` still reaches the group's wake notices,
but launches nobody, so a teammate writing about the token can't start every stopped seat. A
teammate whose presence is unknown is in neither group, and the sender is never its own recipient.
When the sender's process snapshot can't see the sender itself, as inside a sandbox, every running
seat counts as unknown rather than offline, and a session the snapshot misses is offline only when
the system confirms its process is gone. In a post that stored a group, the token means that group,
not a teammate registered as `online` or `offline`; such a teammate is reached only if the stored
list selected it, or by mail and launch as usual. Older posts stored without groups keep the plain
name meaning. As with names, a group token inside a quote, inline code or a fenced block addresses
nobody, so write about them in code quotes, and `@onlineExtra` is not a group. Resolving a group
reads a process snapshot, so a post that names one can take about a second longer to send. The
resolved members are part of the delivered item, so checkpoint receipts and
their hashes cover them. A Team Window or session still running an earlier build reads such a post
as plain text, with no group behavior, until it is restarted on this build.

When another receiver is polling, routine reads use already saved conversation and background
receivers check again on their next tick. Poll contention is normal and does not produce an error.
Actual Telegram sends wait for a successful fresh control check before delivery. Local operations
attempt a refresh but may continue with the recorded halt/proceed state when the remote request
fails or polling is contended; they warn that unseen remote controls may be pending. Invalid local
state or an undrained backlog still refuses the send, and an already recorded halt remains in force.

`summon --telegram status` distinguishes a queued notice from acknowledged room reading. Notices
contain no message text and do not acknowledge or act on the conversation. An agent's own posts do
not wake it again. A failed or ambiguous notice is not repeatedly resent for the same batch in that
session; checkpoint reads remain available. A new human message, addressed mention, or reply to that
agent can refresh a pending notice; routine traffic stays coalesced until the reader catches up.
Receivers continue importing `halt` and `proceed` while communication is paused, without sending
mail or Telegram replies. Stopping a session stops its receiver; offline history remains durable.

Live acceptance on 2026-09-24 verified later room notices in idle disposable Codex and Claude
sessions: each read a unique test message and acknowledged its cursor. Tests used simulated Telegram
updates, not the user's bot or real teammates; Telegram API reads were verified separately in phase 1.
Local room history and the update cursor persist under `integrations/telegram-state`; replayed
updates do not create duplicate events. History is retained until you remove it, and survives agent
removal so messages sent to the team stay in the team conversation.

The command uses Telegram's [Bot API](https://core.telegram.org/bots/api#getupdates).
It sends plain text, disables link previews, and does not automatically retry uncertain deliveries.

### Claude wake limitation in 1.0

Summon releases a Claude terminal notice's own reservation when it proves that it refused to write
Enter after pasting, because readiness or the pane-input version changed. This is a narrow release,
not a retry: the original delivery outcome stays uncertain. A current native draft keeps its hold.
Summon's own paste mark clears only when that reservation received ordered native text-then-empty
reports and no newer human input changed the pane version. No terminal text is erased or resent.

A reservation can still remain without a subsequent native start when an Enter write throws,
submission is interrupted or uncertain, the notice used the live channel, or the required native
observations are missing. Those cases have no automatic recovery in this build; addressed work can
remain delayed until the operator intervenes. Native wake acceptance remains open, and the earlier
run-3 evidence remains inconclusive. The remaining limitation does not excuse a newly demonstrated
safe fix: the operator's acceptance is conditional on that boundary.

If a seat appears stuck with work waiting, record the local time, exact pane-header or status text,
and the loaded Window build before anyone types, pastes or clicks into that pane. Ask the operator
to preserve the affected launch's bounded turn and delivery metadata before choosing any recovery.
Only the affected owner or an explicitly authorized operator export may supply another seat's
metadata. Do not collect its mailbox, provider transcript, prompt text or credentials.

The turn trace records observed reservations, drafts, submissions, starts and completions. Delivery
diagnostics identify recorded call boundaries. A pane-input hold reason says only that Summon's
input tracker was set when that reason was written; its absence proves nothing. These instruments
do not always establish whether the provider received an Enter keystroke. Do not blindly resend a
notice, retry the work or press Enter as a recovery step: an uncertain earlier input could still
take effect. Capturing evidence grants no permission to release a hold, restart a session or bypass
an existing guard. The operator decides any recovery separately.

### Communication safety words

Send `halt` as a standalone message in your bot chat to pause Summon mail, local Room and Telegram
sends, and scheduled dispatch. Send `proceed` as a standalone message to resume. Matching ignores
case and surrounding whitespace; quoted, forwarded, bot, and unapproved-sender messages cannot
change the state.
Board saves and comments and Diary writes also refuse during the shared halt; reading continues.
You can also run `summon --comms halt`, `summon --comms proceed`, or `summon --comms status` in your
own terminal. Only the operator can change the pause; agent halt and proceed commands are refused.
Standalone `halt` and `proceed` in the Team Room also control it. New pauses record the operator,
channel and change time; older records without attribution do not identify who initiated them.
The Team Window shows an active halt above every tab, with its recorded actor and time. Its
Proceed button posts your own `proceed` in the Team Room. Hold Interruptions is a separate control
for notifications; it does not halt team communications.

Saying `halt` inside one agent's session stops that agent's sends. Use the operator's Team Room,
Telegram or terminal path to pause the whole team. Local operator checks rely on the preserved
`SUMMON_AGENT` session identity; they do not authenticate a separate operator credential or form
an operating-system security boundary.

The pause survives restarts and covers replies, confirmations, and automatic mail receipts. Reading
continues; suppressed receipts and blocked sends are not queued to burst out afterward. Existing mail
is retained. This stops communications, not ongoing project work. Messages already in flight cannot
be recalled. Enforcement covers summon commands, not arbitrary third-party tools or direct file edits.

With Telegram configured, sends first fetch pending human signals. Remote request failures warn
and allow local work using the recorded communication state, halt or proceed; a halt that has not
yet reached Summon cannot be enforced during the outage. An undrained backlog or invalid local state still refuses sends.
Actual Telegram sends still wait for the poll lock and require a successful refresh before
attempting delivery; the local fallback does not relax their remote checks.
Run the optional `--telegram watch` to observe signals continuously. A local halt cannot be
cleared by an older queued `proceed`; if issued in the
same timestamp second, send a fresh `proceed` afterward. The shared state uses the same local-account
trust model as summon: agents must not tamper with it or remove their identity to impersonate the operator.

### Agent commands

The bundled `summon-who` skill reports registered agents' observed session presence without launching
them. Find it with `summon --skills status`; its script runs from the source checkout or installed
package. It checks session locks, process identity, terminal or Electron team-window parent, and provider child. Older sessions,
`--same-window`, and provider wrappers may not be confirmed online; this report does not override
summon's duplicate-session protection.

Write-capable summon invocations synchronize teammate registration instructions at `~/.summon/team-default/AGENTS.md`
(or under `SUMMON_HOME`) with the bundled `templates/AGENTS.md.template`. Missing or different copies
are replaced; matching copies are left untouched. Point an already-running agent at this file to have
it register itself as a teammate. Keep agent-specific context in its own record and notes.

```sh
# Show registered agents without opening a session.
summon list

# Remove an inactive agent and its summon files.
summon --remove jimbo

# Copy an existing teammate's expertise, domain and notes to a new name. Sessions are not
# copied, and neither is domain authority - the new name starts owning nothing.
summon clone jimmy vera
summon clone jimmy vera --using codex

# Open a session for every registered agent (one tab each on Windows).
summon all

# Choose the CLI when registering a new name. New names default to Claude.
summon carl
summon jimmy
summon auden --using codex
summon <name> --using grok

# After that, just use the name.
summon carl
summon jimmy
summon auden
```

For an unknown name, summon asks whether to create it. Type `y` or `yes` to create
`~/.summon/team-default/<name>.json` and start a new session. Enter, any other answer, or closed input quits
without creating an agent. Existing names launch without this question. `list` is reserved for
listing agents, showing their provider, working directory, and domain when assigned, and `all`
is reserved for summoning every registered agent. `agents` and `team-window` are also reserved
for summon storage, and `operator`, in any letter case, names the human at the console; none of
these five names can be a teammate, whether created, cloned, added as the PM or entered in Team
Maintenance. Later calls use the registered
CLI and resume its most recently used session. Records contain the display name, CLI (`provider`),
expertise, working directory, and session history. Notes live beside the record in
`~/.summon/team-default/<name>.md`, and both reach the session prompt.

`summon --remove <name>` deletes that agent's registration, notes, mailbox (including archived
mail and approval holds), runtime state, and its scratch folders (`scratch/<name>` and
`scratch/shared/<name>`). It refuses running agents, and refuses a redirected scratch folder
without following it. If a scratch folder cannot be removed, the agent stays registered, the error
says which folders already went, and the removal can be run again. Provider-owned conversation
history and project files remain untouched. Removal is immediate; it does not ask for confirmation.
Messages the removed agent sent to other agents stay in those agents' inboxes and archives.

`--using` is only needed to select a CLI for a new name. It cannot switch an existing name to another
CLI: a conflicting choice fails without changing the record. Use a different name for another CLI.

Add context or change the working directory when summoning:

```sh
summon carl --note "Owns the release checklist"
summon carl --cwd /path/to/project
# Registering a new name with its expertise and domain (operator only).
summon vera --expertise "Knows the release process end to end" --domain "Release engineering"
# Changing a registered name's text: a checked edit that launches nothing.
summon carl --domain "Home network and storage" --revision <revision>
```

For a name that is already registered, `--expertise` and `--domain` go through the same checked
edit as `summon --registration edit` (below). It applies the caller rules, a required
`--revision`, the character checks, the stale check and the audit. A PM also needs `--decision`.
It prints the same report, and it never launches, wakes or stops the name. These two flags
combine only with `--revision` and `--decision` there.

A domain says what a name is the primary for. Each session is told its own domain and the
domains every other name claims, with one instruction: when work leads outside your domain,
stop, say what you found, name the session that owns it, and ask whether to summon them. A name
without a domain claims nothing and is left out of that list, so adopting this is per name and
costs nothing until you use it.

`summon all` registers nothing: it opens every registered name in name
order, with its saved CLI and working directory. A name whose record cannot be read or whose
working directory is gone is reported and skipped so the rest still open, and the command exits
nonzero for the shortfall.

On Windows, launches join one named Windows Terminal team window per `SUMMON_HOME`. Each agent
gets a tab labelled with its name and provider; application output cannot replace that label.
Switching tabs leaves the other agents running. `summon <name> --new-window` opens a separate
window, and `summon all --new-window` opens one window per agent. `--same-window` runs directly
in the current terminal and cannot be combined with `--new-window`.

Summoning a running name reports that it is already running and leaves its record, notes, and
session alone. This applies to `all`, separate windows, and `--same-window`. Select the existing
tab to return to that agent; summon does not automatically focus it yet. Each session owns an
atomic runtime lock, released on exit and recovered after a crash once its runner and provider
have stopped. Simultaneous terminal launches can briefly open an extra tab, but only one provider
starts. Sessions launched before this locking support need to be closed and summoned again to
be tracked. Windows Terminal controls close confirmation through its own settings; this is not yet
summon's custom team shutdown dialog. Existing separate windows are not moved into the team window.
macOS Terminal and Linux terminal launchers continue to open separate sessions as before.

### Editing expertise and domain without launching

The operator or the registered PM changes a registered name's expertise or domain with
`--registration`, which starts, wakes and stops nothing. `summon <name> --expertise/--domain
--revision` is the same edit with inline text.

```sh
# Read the current text and the revision an edit must name.
summon --registration show jimmy

# Change one or both fields from UTF-8 files. Omitted fields stay as they are.
summon --registration edit jimmy --revision <revision> --domain-file ./domain.txt
summon --registration edit jimmy --revision <revision> --expertise-file ./expertise.txt --clear-domain

# A PM first posts the exact edit for the operator's approval, then edits citing the Yes.
summon --registration request jimmy --revision <revision> --domain-file ./domain.txt
summon --registration edit jimmy --revision <revision> --domain-file ./domain.txt --decision <id of the Yes>

# List each audited edit and whether it applied.
summon --registration audit jimmy
```

- Only expertise and domain change. Every other flag is refused, including CLI, model, LM Studio
  URL, working directory, notes, sessions, name, member type, permissions and cover. Those stay with
  Team Maintenance.
- Text comes from files, so no shell quoting can alter it. Each field is trimmed, CRLF becomes LF,
  and the limit is 8000 characters. Control characters other than tab and line breaks are refused,
  and so are bidirectional controls. An empty file is refused: use `--clear-expertise` or
  `--clear-domain` to clear a field.
- The caller is the operator's terminal, or the current launch of a session registered as PM.
  Ordinary teammates, an earlier launch of the PM, and a missing session identity are refused.
  This is Summon's usual session identity, not OS authentication.
- A PM edit takes three steps: request, approve, edit.
    - **Request.** `summon --registration request` takes the same name and flags as `edit`, without
      `--decision`. It checks them exactly as `edit` would. It then posts an operator approval in the
      Team Room, posted by the PM. The approval names the teammate and shows each changed field's
      new text complete between delimiters, or `clear (empty)`. When the full text would not fit
      the room's 4096-character message limit, `request` first writes each new text to a
      write-once file named by its sha256 under `registration-proposals/` in the summon home. The
      question then gives that path, the character count, the sha256 and a bounded excerpt. The
      last line is a tag:
      `[registration-edit v1 target=<name> revision=<sha256> expertise=<sha256|clear|unchanged> domain=<sha256|clear|unchanged>]`.
    - **Approve.** The operator answers Yes or No in the room.
    - **Edit.** The PM runs the same `edit` with `--decision` set to the room id of that Yes.
- The decision must be the operator's Yes to an approval meeting three conditions:
    - it was posted by the PM making the edit (for an operator-cited decision, by a registered PM);
    - its whole text is exactly what `request` generates for this edit, so nothing can be added or
      removed;
    - any proposal file it points to still hashes to the tag.

    Every other reference is refused, and the error names the mismatch. That includes a plain
    message, a No, an answer to an ordinary question, an approved request about something else for
    the same teammate, a tag line added to other prose, a request posted by a peer or another PM, a
    tag for other text or another teammate, and a missing or altered proposal file.

- A teammate's name in the approval text is never enough, and there is no standing delegation:
  each edit needs its own approval.
- The operator edits without a decision and does not use `request`. A decision the operator does
  give is checked the same way. A decision is recorded exactly as given.
- PM targets, the PM itself included, are refused. Summon sets PM expertise and domain in code, so
  stored text there would have no effect.
- `--revision` covers both fields. If either field changes after you read it, through this command
  or a Team Maintenance save, the edit is refused, and the form checks the same revision. The
  update rereads the record under its lock, so session changes made at the same time are kept.
- The audit log is `audit/registration-text.jsonl` under the summon home, and it is append-only.
  It records each edit as intent and then commit:
    - An `intent` line comes first. It holds the id, actor, time, target, decision, and the old and
      new sha256 of each changed field. If it cannot be written, the record is not changed and the
      command fails.
    - The record is written next.
    - An `applied` line then names the same id.
    - The outcome comes from the write's own report, never from rereading the record.
    - If the write completed, `applied` follows. That holds even when releasing the record lock
      fails afterwards; the command then fails and says the record changed.
    - If the write failed before replacing the file, `not-applied` follows and the command fails.
    - If the outcome cannot be told, no outcome line is written, the intent stays unresolved, and
      the command says to run `summon --registration audit`.
    - If only the `applied` line fails, the command fails and says the record changed.
- `summon --registration audit [name]` shows each intent with a status: `applied`, `not-applied`,
  `applied-unmarked` or `unresolved`. `applied-unmarked` means there is no outcome line, but the
  record's current text has the intent's new hashes. `unresolved` means neither, as after a crash
  between the steps. An intent is never read as applied on its own. The operator and the PM may
  run it.

New text reaches the next startup prompt: the target's own, and the roster every other name reads
when it next launches. Running sessions keep the context they started with until they restart.
Summon does not inject the new text into a running session.

In startup prompts, a teammate's own expertise and domain sit between `[begin registered …]` and
`[end registered …]` markers keyed to a digest of the text, and each roster domain is quoted. The
markers make the boundary explicit. They are a formatting boundary, not a guarantee about how a
model behaves. A PM's expertise and domain are written by Summon, not registered, and are shown
without markers.
