# Dedicated team window

For a compact own startup/work snapshot, run `summon --work` from a named session. It shows
actionable cards, unread versus unresolved mail, hold counts, delivery readiness for this launch,
checkpoint progress, schedules and persisted head-down/rest state. It reads independent snapshots;
it does not display bodies, mark them read, issue or acknowledge a checkpoint, resolve work,
dispatch schedules or confirm rest. Cards and schedule sections show up to 20 entries with totals
and full-read commands.
Readiness means the transport marker matches this launch, not that the model has completed work.

`summon --room show <id>` returns one complete original room event, including archived history.
`summon --room search <literal-text> [--after <id>] [--limit <1-20>]` searches that history
case-insensitively and returns bounded snippets. Follow `next` with `--after`, then use `show`
for a complete body. Neither command advances any cursor or supplies approval. Search is a
fresh read on each call, not a frozen checkpoint package.

Room and mail sends/replies accept `--body-file <path>` in place of inline text. Author the
UTF-8 file with file tools and verify its bytes, then pass only its path through the shell:

```text
summon --mail send-self <recipient> --body-file <path>
summon --mail reply <message-id> --body-file <path>
summon --room send [--to-user] --body-file <path>
summon --room reply [--to-user] <id> --body-file <path>
```

Operator-form mail send also supports a file body. Files are read under the caller's normal
permissions; named callers cannot use private mailbox, runtime or scratch files from another
teammate or team through this option, including resolved links. Recognized roots are the active
store, its named-team parent, `SUMMON_TEAMS_HOME`, the default `~/.summon`, and their named-team
descendants. Own private paths, shared scratch and domain files remain available. This does not
sandbox direct filesystem access or discover unrelated custom stores. Invalid UTF-8, empty text,
NUL and mixed file/inline
bodies are refused. Literal backslashes and internal newlines are preserved; existing outer
whitespace trimming, message limits, identity, reply links and communication gates still apply.
These commands are shared by Claude, Codex, Grok and Kilo. Source tests for each registration
do not establish acceptance from a live provider. New CLI commands need the updated checkout;
loaded startup prompts/MCP servers need their named session restarted to learn the new guidance.

The [Team board guide](../guides/team-board.md) explains every lane and card action, including
which actions notify the owner, clear blockers or only hide a card. Lane information buttons and
card action dialogs show these consequences in the window before you apply a change. The board
has a search field for titles, owners and card text; it covers every owner and can reach archived
cards, and the guide describes its two view controls.

From your terminal or a script, `summon --msg 'ZYX is done!'` posts directly to Team Room as
**CLI**, without opening a session. These posts stay local, obey the communications pause and
do not count as human approval or halt/proceed commands. Named agents use their own room commands.

Plain HTTP(S) URLs in room messages are clickable and open in your browser. Message text is
never interpreted as HTML, and links with embedded credentials or other schemes are not opened.

Use **Add your first teammate** in an empty window, or **Add teammate** in the sidebar later.
Choose a name, CLI and working folder; optional profile fields follow under **Optional**. Bun and
the chosen CLI must be installed, and sign-in happens in that CLI. Saving selects the teammate
without launching it; **Start &lt;name&gt;** in the welcome pane or **Summon** in the toolbar opens
its session. Missing CLI or folder checks explain what to fix.

**Team Maintenance** adds and edits names, registered CLI, working directory, expertise, domain,
notes, and an optional known provider session ID. Saving does not launch a teammate. Ordinary
profile edits can be saved while running and apply at the next launch. Stop the teammate before
changing a session ID, Claude account or an allowed PM CLI, or before removal. Ordinary
teammates keep their registered CLI. A stale notes edit refuses while preserving the draft.

The dialog has two tabs. **Person** holds one teammate's record: the required fields, the optional
ones, provider usage, and removal last. **Team** holds what applies to everyone: delivery,
interruption holding, display preferences and **CLI setup**. Team changes save as you make them;
the teammate form saves with **Save Teammate**. **Team settings** in the sidebar opens the Team tab
directly, and works before anyone is registered. Nothing in either tab is folded away.
The operator may switch a stopped PM's CLI; that clears its previous provider binding and model cache.
Removal requires typing its name and offers archive (default) or permanent deletion of summon
files. Archives live under `~/.summon/team-default/archives/<name>-<id>` and preserve the JSON, notes, icon,
and own mailbox, without restoring runtime locks. Provider conversations and mail already sent
to other teammates remain untouched. Archive restoration is currently manual. Archive leaves
the member's scratch folders in place; permanent deletion removes them too.

For Claude teammates, **Claude account directory (optional)** selects an existing directory
for `CLAUDE_CONFIG_DIR`. Leave it blank for the account inherited by Summon. Sign in to the chosen
directory manually in Claude first; Summon does not copy credentials or log in for you.
Stop the teammate before switching. Changing this field clears the previous account's session ID
from the form. Each account retains its conversation, so switching back restores its saved ID.
The roster and session header show the directory name, or **Default** for the inherited account,
with its full path on hover. Before the account, the session header lists the teammate's recorded
model, reasoning and context capacity (with its exact token count) beside the provider, unlabelled,
and ends with the working directory. The roster's provider mark shows the same values on hover,
one per line, and a Shift+click copy carries the same line. Capacity is what the model's window
can hold, never how full it is; a value the provider has not recorded names its field, such as
**capacity not recorded**. This identifies the selected configuration, not a verified email
address or subscription. Claude documents this account
separation in its [environment variable reference](https://code.claude.com/docs/en/env-vars).

The Add teammate gallery reads editable `gallery/<id>.json` files from the installed summon
package each time Add opens. Supplied identities can be edited without rebuilding.
Each file contains `id`, `suggestedName`, `specialty`, `blurb`, `expertise`, and `domain` strings;
the ID must match the lowercase hyphenated filename. Invalid or unreadable entries show a warning
while valid entries remain available. **Start blank** works even when the gallery is empty.
The built-in **Project manager** starter selects the Project manager member type; Summon supplies
its expertise and domain. Choosing an ordinary starter returns the form to Teammate. These
starters apply only when adding a member; an existing member's type remains fixed.

The second row includes an **ADHD coach** for practical planning and task support and a
**Healthcare advocate** for appointment preparation, records, bills and coverage documents.
The coach does not diagnose or advise on medication. The advocate drafts messages for you to
send, makes no contact with providers or insurers, and keeps health information in its working
folder. Both join the Research assistant, Records/files organizer, Writing partner and Learning
coach under Project manager.

Current activity appears in maintenance and the full status wraps in the chat header.
Maintenance also lets you switch automatic interruption holding off or choose a countdown from
5 to 600 seconds. Selecting a running teammate or typing in its terminal renews the countdown when
enabled; typing anywhere else in the window, such as the Room composer, Board search or a
Maintenance field, does not, and neither does switching windows. The pinned
**Hold Interruptions** button works in either mode.
**Read Provider Usage** performs an on-demand read. Codex uses its installed app-server protocol
to read shared account allowance/reset windows and estimated session tokens/cost, when supplied.
It does not start a turn or read conversation messages. Values are timestamped, estimates are
labelled, and unavailable data is never presented as zero or unlimited. Claude/Grok telemetry is
not connected; use their CLI usage displays. Older Codex versions may not support these reads.

**Macros** beside Team Maintenance edits ten persistent slots shared by the bars below agent
terminals and in Team Room. The first two default to **Status?** and **What are you currently
working on?**; the other slots start empty. Existing saved macro text is preserved. Each slot has one text field and an optional
**Send Enter** checkbox: off inserts text; on inserts and submits. Clear the text to
hide a slot. Agent buttons are enabled only for sessions running in this window.

Team Room remembers the last 50 sent composer messages. Up on the first line recalls them;
Down on the last line returns toward the saved draft. History survives a window restart.
The footer includes a build fingerprint and the build time, in local time, to distinguish dirty
rebuilds.

Agents can post highlighted decision cards with `summon --room ask --approval "Approve this action?"`
for Yes/No, or `summon --room ask "Which option?" --choice "A" --choice "B"` for custom choices
and a freeform answer. `--no-freeform` restricts questions to the supplied choices (up to eight).
Human answers are persistent replies to the exact question; an answered card cannot be changed.
These cards do not execute actions or automatically release held mail.

An owned session shows **Connecting**, **Logging in**, then **Summon startup** while launching.
Hover for the observation and phase start time. Logging in means the CLI has shown itself;
Summon does not check sign-in. Claude uses MCP initialization, Codex its session-start hook,
Grok a fresh metadata write for its exact saved session, and Kilo its authenticated session response.
Mailbox readiness enters Summon startup; the member's first explicit status call ends it.
Kilo's readiness request waits for its startup turn's observed completion, like every other notice.
When a Kilo seat's notices are held for a reason other than a running turn or an ordinary startup
wait, `summon --mail status` says why, as a queued-only reason beginning "Notices held for <seat>
launch <nonce>:". There are three cases: the seat has no turn record, no turn stream is attached,
or a settled launch is still waiting for an observed busy then idle. In the seat,
`summon --checkpoint` collects queued work but does not restore observation; only an operator
relaunch does. A held reason also carries any delivery problem the launch's records still report:
an inventory error, an unsent notice, or one that may have begun. When the hold clears, the status
returns to that problem, or to readiness if there is none.
Connecting and Logging in use a hollow accent dot, and Summon startup a solid one.

`summon --launch-status` is a read-only public view of those phases. The Team Window refreshes
it while running. It lists only owned, running members still in startup, with their provider,
phase, observation label and phase start time. Tasks, domains, mail and private session IDs are
omitted. A coordinator can compare `launch.since` with the current time to check a stalled phase.
The command does not create an alarm or start or stop a session.

Check `current` before using the list. Missing, invalid or older-than-ten-second evidence returns
`current: false` with a reason; it does not prove that no member is launching. The view also
reports unavailable if any owned running member's record could not be read. That member keeps
its real owned session row and Select/Stop controls, labeled Status unavailable without a
task or phase claim. Missing records cannot start a new session. Restoring the record restores
the current view. On Windows, the reader verifies the publishing
process's creation time to reject an exited window or reused PID.
With `current: true`, an empty `members` list means no active phases were observed by that window.
Both valid current and unavailable JSON results exit zero; invalid command arguments exit nonzero.
Times use full ISO 8601 UTC strings ending in `Z`. Other hosts return unavailable when the reader
cannot verify an equivalent process identity.
Restart the Team Window after activation to load the publisher. The command itself needs no
separate member restart; the underlying phase observers retain the restart requirements below.

After startup, the sidebar shows each agent's task text, or **Ready** for an unset/available status
while the session runs; a teammate that is not running shows no Ready line under its state.
Hover for the full status, expertise and domain. A session that exits during startup names its
last phase in the tooltip and retained error history. Operator stops retain their stopped state.
A dot carries the state: green running and idle, a green ring running somewhere other than this
window, amber reported or observed native busy, grey offline on purpose, and red exited when nobody asked it to.
Red is kept for that last one alone, because it is the only state worth interrupting yourself for.
A purple dot with a halo is a hibernated teammate, its own state; see [Hibernation](sessions-and-communication.md#hibernation).
The words **Ready** and **Busy** are written in their dot's colour, in the sidebar and beside the
name in the session header; the other state words are unchanged.
A raised hand means the agent needs you.
An idle teammate that confirmed rest reads **Resting** in the sidebar, header and statusbar when
no conflicting provider-turn evidence remains.
Confirming Zzz/rest readiness records it for the sidebar and `summon --rest candidates`; it sends
no mail to the PM. Stop permissions remain separate from readiness.
A small number left of each avatar is that row's key. The first PM is 0, and the other rows the
filters leave visible count 1, 2, 3 down the list; with no PM in view the count starts at 1.
**Ctrl+1** to **Ctrl+9** select the teammate showing that number, so the pinned PM is skipped and
there is no key for 10 onward. It is the same as clicking the row,
and does nothing while a dialog is open. **Ctrl+0** selects the PM: the first PM on the team,
whatever its state, even when a filter such as Active hides its row. Like the other keys it only
selects, and starts or wakes nobody. The window takes these ten keys before a terminal sees them,
so a CLI no longer receives Ctrl plus a top-row digit.
The mail badge counts unread inbox messages, including for offline teammates; reading a message
clears its unread count without requiring archive or task completion. The operator UI only
counts mail metadata and never displays its contents.

Agents set their own status with `summon --status busy "Short task"`,
`summon --status needs-user "What you need"`, or `summon --status idle "Available"`.
Status text is limited to 120 characters and shared in the sidebar. New launches reset it;
offline teammates show their last task without an active busy/attention indicator.
Restart the Team Window after activation, then Stop/Resume existing Claude, Codex, Grok and Kilo
members to load the new observers and startup instructions. Native CLI acceptance is required
separately for each provider; fixture and built-UI checks do not establish it.

For a bounded task, a teammate can request **Head-down** with
`summon --head-down request "goal" "completion condition" --return-to-normal`. The commitment
requires returning to Normal when complete, blocked, cancelled, or needing a human decision.
By default, the operator approves the exact request in the Room or selected teammate controls.
The optional team setting **Auto-approve new head-down requests** is off by default. When enabled,
new eligible requests start immediately and are recorded in the Room; earlier pending requests still
need an answer. Turning it off leaves active goals in place. **Can Approve Heads-down** delegates
manual approval and management (including steer and end) for head-down only; it grants neither
mail-hold approval nor general authority. Agents cannot approve their own requests.

Active head-down queues automatic room, Telegram and mail notices, schedules and idle nudges.
The current request's approval or decline gets one separate response, so a teammate waiting for
permission can learn the decision. Human pauses, hibernation, provider busy turns, unsent drafts
and communications halt still hold it. The response asks the teammate to check its own head-down
status and grants no other permission. An uncertain delivery is not automatically repeated.
Ordinary messages remain unread. Direct session input still works. The goal replaces the roster status
line while the existing activity dot retains its meaning. The heartbeat reports session liveness,
not progress; an overdue heartbeat is visible without inventing a task deadline or stopping work.
Use `summon --head-down status` to inspect your request and
`summon --head-down end <name> <request-id> "outcome"` to return to Normal and resume delivery.
The operator or a delegated teammate can use `--head-down steer <name> <request-id> "direction"`
to end the mode with an explicit direction recorded in its approval thread. Exit or a new launch
invalidates the mode. Already queued provider input cannot be recalled. Restart the Team Window
and existing agent sessions to load these controls, receiver guards and heartbeat.

Optional sidebar icons live beside the agent record: for example, `~/.summon/team-default/morgan.png` next
to `morgan.json`. Use a square PNG, 32–512 pixels and at most 256 KiB; 128×128 is recommended.
Each teammate may create their own. The sidebar refreshes changed images automatically and
uses initials for missing or invalid images. Removing an agent also removes its icon.

The **Terminal** button (or **Ctrl+`**) opens your own shell across the full width of the
bottom pane, beneath the agents and **Team Room**. Choose an installed PowerShell 7, Command
Prompt, Git Bash or user WSL distribution. Stop the current shell before changing it; hiding
the pane preserves the session. Shells start in the directory where the window was launched,
and closing the window stops its shell and owned child processes too. The shell choice is
remembered. Ctrl+V, Ctrl+Shift+V and Shift+Insert paste clipboard text into the focused terminal
or composer; an image-only clipboard retains the focused CLI's image-paste action.
Drag the divider at the top of the terminal drawer to change its height. The height is remembered
for this team. Focus the divider and use Up/Down, Home or End to resize it from the keyboard.

Run `summon --team` from your own terminal to open the roster and choose whom to start.
On Windows, launch from a normal, non-administrator terminal. Summon blocks elevated launches
before starting a Team Window or agent; it also refuses a launch if integrity cannot be verified.
An existing elevated window must be closed and reopened by you from a normal terminal.
`summon --team testing` opens an independent team in `~/.summon/team-testing/`. Named teams start empty;
add their teammates through Team Maintenance or their operator terminal. Each has its own roster,
room, mail, board, settings, session locks, and Electron data. Nothing is copied from the default
team, including Telegram configuration. The window title shows its storage path. Repeating the same
name reuses that team's window; different names can run side by side without closing the real team.
The argument is a **team name**, not an agent selector; `--team all` now names a team called `all`.
Names are case-insensitive, 1–64 letters, digits, underscores or hyphens, starting with a letter or
digit. The `team-` directory prefix separates names from internal storage; paths and directory links
are rejected.
The default team uses `~/.summon/team-default` and keeps its name hidden in the window.
`SUMMON_HOME` selects an exact store. `SUMMON_TEAMS_HOME` selects the teams base, normally
`~/.summon`; its default team is `team-default` and named teams are siblings. Set the base explicitly
when selecting named teams from a standalone custom store. The window and terminal runners carry
both paths so an existing terminal's environment cannot select a different store. Bare `--team`
uses the selected store unchanged. Existing data requires the
[approved offline cutover](storage-layout.md#default-team-subfolder); startup never moves it.
Ordinary `summon alice` and `summon all` still use Windows Terminal.

The [repository and team storage guide](storage-layout.md) explains which folders hold
source, durable team records, runtime evidence and scratch work, and why runtime data cannot be
discarded as one cache.

Each teammate has an independent terminal and saved conversation. Select a name to switch views;
the All, Active, Online and Offline roster filters combine with the provider filter and remember your choice.
Each provider filter is enabled only when its CLI check says Found. While a check is pending,
missing or failed, that filter is disabled and does not hide teammates. Its saved preference returns
when the CLI is Found again. Maintenance's CLI Refresh updates these results; sign-in is not checked.

Diary opens above the session terminal, in the same area as Board. Entries are newest recorded first,
show the author, work date and brief task, and link to actual room messages and
Board cards (including archived cards). A supplied original date appears on the row; hover it for
the full work date and recording time. Day-only dates keep that exact day without inventing a time.
Other entries show their local recording date and time. Teammate destinations
remain visible; entries addressed to this team's configured operator identity omit that label. Older entries remain available
through Older entries. Closing and reopening reloads repaired entries and approved removals.
Search authors or messages matches the author or task text, ignoring case; it searches the full history,
including older pages. Clearing the search restores the full diary. Search results do not advance
the last-seen marker.
The last-seen divider marks the newest entry visible during your previous visit. Closing Diary
or reloading remembers visible entries locally; entries below the viewport are not marked seen.
Use `summon --diary add <json>` with `for`, `task`, optional `room` message IDs and `board` card
UUIDs. For example: `{"for":"Operator","task":"Added Diary","room":[3662],"board":[]}`.
For historical work, add `happenedAt` as `YYYY-MM-DD` or an ISO timestamp with `Z` or a UTC offset.
Author and recording timestamp are recorded automatically. Log completed work, meaningful decisions and
cross-team asks; group related work and omit routine mail checks, checkpoints and tool calls.
The Diary is stored independently in each team's storage root; it does not mirror entries to Telegram.

`summon --operator-identity show` reads this team's display and addressing identity. The operator
can use `summon --operator-identity set --file <UTF-8-JSON-path>` to save a complete version 1
object, for example `{"version":1,"display":"Rae","aliases":["Rachel"],"mentionOnly":["operator"],"recipientAliases":["op","me"]}`.
No file means display **Operator**, no personal aliases, mention-only **operator**, and Diary-only
**op**/**me**. Personal aliases match Room prose; mention-only aliases require **@**. Diary-only
aliases never highlight Room text. Invalid names or collisions with registered members refuse
instead of changing a teammate into the human. The shared file is `settings/operator-identity.json`;
it is distinct from the Window's private settings. Identity grants no role, permission, wake selection
or recurring duty. Keep historical operator names as explicit aliases when changing a team's
identity; saved Diary recipients and Room text are never rewritten.

`summon --operator-identity create --file <UTF-8-JSON-path>` writes only when no setting exists,
checking absence under the same lock as normal identity writes. New registrations and PM display-name
changes refuse operator-name collisions under that lock, before writing a record or seeding cursors.
If a setting is damaged outside these commands, startup warns and uses generic **Operator** for its
Diary example; it does not change the setting, permissions or saved history. The Window retains its
roster and reports the fault while showing recipients literally until the identity is corrected.

For an approved historical batch, the operator runs `bun scripts/backfill-diary.ts --preflight <plan.json>`
to inspect counts without changing entries or proving shutdown. After closing the team's window,
`--apply <plan.json>` verifies Windows process inventory and applies the prepared batch under the
normal Diary write lock. It never closes windows or stops sessions. The UTF-8 plan names its team
root, a fixed batch UUID, approval room references and fixed entry UUIDs; each operation adds a dated
entry, updates only task/date under an expected entry SHA-256, or removes an explicitly approved
entry under its expected hash. Approval references record provenance; they grant no agent permission.
Only the operator can apply a batch. Missing references, conflicting entries, unknown authors or
changed targets refuse the whole batch. Former authors must exist in public room history; no profile
is created. An exact original snapshot is retained at `diary/backups/backfill-<batch-id>.json` before
writing. Repeating the same completed plan skips its operations; a new UUID is not a retry mechanism.
Reload the updated Team Window after applying; an older window cannot read the new date field.

Press **Ctrl+Shift+J** to jump. Type a Room message number (`1234` or `#1234`), the start of a
Board card id (`150e`) or the start of a teammate's name, then press Enter. A message opens in the
Team Room, or in the message preview when it is older than what is loaded. A card opens on the
Board, scrolled to and unfolded, even when it belongs to another teammate or is archived. A
teammate is selected as if you had clicked their row. When what you typed could be more than one
of these, each is listed and labelled; a leading `#` always means a message. Jump matches numbers,
ids and names only and never searches message or card text. Escape closes it and returns focus to
where it was. The window takes the key before a terminal sees it.

Press **Ctrl+Shift+N** to open or close the notepad. It opens only from the keyboard and keeps
Markdown source separately for each team in `notepad/note.md`. Changes autosave after a short pause;
**Ctrl+S** saves immediately and **Esc** closes. Each open reads the file again; a clean editor
loads changes made elsewhere. Matching text restores the remembered caret and vertical scroll;
changed text loaded from disk starts at the top. **Ctrl+X** deletes an empty line, **Alt+Z** toggles
wrapping, and **Alt+Up/Down** moves the current line or selected lines while keeping the selection.
**Ctrl+F** opens a find bar over whichever pane is showing (the editor, the Markdown preview or a
saved copy): matches highlight as you type, ignoring case, **Enter** and **Shift+Enter** (or **F3**
and **Shift+F3**) step through them, and **Esc** closes the bar with the match selected in the
editor. It finds only; nothing in the note changes.
Unsaved drafts survive a window reload. If the file changed while
you had unsaved edits, autosave pauses and keeps both versions. **Keep my draft** saves your text
over the freshly read disk version; **Load disk version** discards your draft after another fresh
read. **Show disk version** previews it without choosing. Read failures offer **Try again** with
saving paused. An unreadable recovery draft stays stored until you explicitly discard it after
a successful fresh read. Notes are limited to 256 KiB.
**Preview Markdown** renders headings, nested lists, emphasis, code, links and tables. Task
checkboxes are active: checking one changes only its source marker and autosaves the note.
**Edit Markdown** returns to the original text. Raw HTML stays literal; image labels appear
without fetching images.

Repos opens a searchable repository browser above the session terminal. It discovers repositories
containing registered teammate working folders and repositories immediately inside those folders,
including a working folder that is itself a repository. Select a repository independently of the
teammate session to view staged, unstaged and untracked changes, diffs and twenty recent commits.
Folder and VS Code buttons open that repository; teammate buttons select sessions working there.
Tracking counts use saved upstream refs and show when checked; browsing never fetches or changes Git
state. Refresh reloads selected changes; the visible repository list refreshes once a minute.
Untracked previews are limited to 512 KiB and refuse symlinks and files outside the repository.

Schedules lists every Summon schedule above the session terminal, grouped by the teammate who owns
it. Each row shows how often the schedule runs, whether it is active, paused, due, waiting (with the
reason) or mid-run, when it is next due and how its last run ended; open a row to read the duty's
instruction. Teammates with no schedule are named at the end. The list refreshes once a minute and
is view only: create, pause and resume schedules with `summon --schedule`.

Board, Diary, Repos and Schedules use one draggable divider and the same remembered height above
the session. Switching views preserves the session space below; the divider hides when all four
views are closed.

Runtime errors and warnings remain inspectable after their banner or inline notice is dismissed.
Run `summon --faults`, optionally with `--member <name>`, `--since <ISO timestamp with timezone>`
or `--limit <1..200>`. The reader reports source, affected member when known, first/last recording
time and repeated-report count. Compare the source and window start time before treating an old
failure as a current defect. Reading does not acknowledge or resolve a fault or retry an operation.

The Team Window records renderer exit, unresponsive/recovery events, failed main-frame loads
and preload failures when Chromium reports them. Failure lines include the last page layout received
and its age, or say that none was received; recovery records the hang duration.
A hung page is never queried for fresh state.
Page movement records offset, page and window sizes, and focus once per episode. Chromium may not
report a hang without pending input. These records cannot establish the cause of an earlier blank
window. The new diagnostics do not reload or restart anything; renderer exit keeps its existing
shutdown behavior. Claude, Codex, Grok and Kilo behavior is unchanged.

The active team stores this journal in `logs/runtime-faults`, with up to four 512 KiB segments.
Older segments expire; the reader reports the oldest retained time and whether more groups exist.
Every occurrence is appended; identical reasons within a minute collapse only in the reader.
Only the trusted window writes it. Named Claude, Codex, Grok and Kilo Summon calls can read it.
Queued reports remain bound to that window's original team root. Changing the process's storage
environment cannot redirect a pending save; a missing original root refuses retention.
Terminal streams, prompts and room/mail bodies are not captured. Diagnostic reasons omit payload
details, URL/quoted values and credential-shaped strings rather than retaining raw error stacks.
If saving cannot be confirmed, the original visible failure remains and a separate notice says so.
This starts with the updated window; the older five retained launch logs cannot reconstruct all
past banners. Restart the Team Window after activation; no separate provider-session restart is needed.

Hover a teammate's CLI pill for its last-observed model, reasoning effort (Kilo variant),
context capacity in tokens when recorded, Claude account and working directory: the same values
as the session header. Capacity is not token usage or remaining space.
Codex capacity is matched to its exact model turn; Claude observes its native model and context
window together; Kilo matches its owned worker's resolved limit to the same session and model.
Grok records an explicit saved session override; without one, its default capacity is not recorded.
Missing capacity stays not recorded rather than being guessed from a model name.
The Team Window also records reported provider, model, reasoning and capacity changes in
`runtime/<name>/model-history.jsonl` under the active Summon storage root. Its first refresh seeds
the last saved report; later entries include the UTC log time, provider observation time and session
ID. Unchanged settings across runs do not add entries. This uses observed provider metadata, so changes
that occur entirely between inspections may not be observed. No conversation content is logged.
Summon refreshes saved session metadata at most every 30 seconds and caches these fields in that
teammate's JSON record. Missing settings remain unknown; the timestamp distinguishes saved values
from a live guarantee. Changing the provider or session hides the previous session's cache.
Online includes sessions running here or elsewhere; Offline includes stopped and hibernated sessions.
Active shows online teammates without a Zzz rest control. Idle Ready alone is still active; a teammate
whose rest confirmation ends reappears on the next roster update without refreshing the window.
Filtering preserves the selected terminal and does not start or stop sessions.

With automatic holding enabled (the default), selecting a teammate running in this window pauses
its automatic notifications, idle nudges and scheduled dispatch for the configured countdown.
The default is 30 seconds; Team settings accepts 5 to 600 seconds. Stopped sessions do not start a
countdown. The header button shows it. Human keyboard input renews the quiet period; terminal
output and routine snapshots do not. When the countdown expires, delivery resumes.
The toggle releases the current pause or starts a manual pause that lasts until released or you
select another teammate. Automatic pauses apply while the window is focused; manual pauses also
survive blur. Direct terminal input and operator hibernation controls remain available. Messages
stay unread; already queued provider input cannot be recalled. If the window disappears unexpectedly,
the pause expires within six seconds. Restart the Team Window for the control and timing; existing
native receivers need Stop/Resume if they have not yet loaded notification-pause support.
Stop Session interrupts that session, and Resume starts it again using its saved conversation.
For Codex, Stop checks the current launch's exact bound thread through the already-running Codex
daemon. Active work asks for confirmation; only a loaded thread reporting idle stops without a
question. Missing bindings, unloaded threads, unsupported CLI versions and failed or timed-out
reads ask instead. The roster refreshes metadata in the background, batching its reads into one
connection and caching each exact launch binding for up to 15 seconds. Initial or expired
observations show unknown while refreshing; the roster does not wait for the daemon. Stop and
rest-stop always read fresh evidence rather than trusting this cache. Each read is limited to
1.5 seconds and 512 KiB, with
no history request, thread resume, daemon start or change to Codex hooks and notifications. This
uses the installed CLI's `codex app-server proxy`; a separate or remote daemon is not discovered.
Rest-stop also refuses while Codex is active or its observation is unavailable. Restart the Team
Window to load this guard; the SessionStart binding hook and provider sessions need no change.
Source fixtures do not establish native acceptance on the installed Window.
On Windows, if a Stop's termination reports a failure, the teammate's row, header and statusbar
read **Stop unverified**. The Stop button is disabled with the same label until the session's
terminal reports its exit, which is then recorded as stopped. Its tooltip says Summon hasn't seen
the session exit yet, and adds that the main process couldn't be checked when that is so. It
names no count of remaining processes. Closing the window is refused while any stop is unverified.
If that terminal never reports its exit, the state does not clear by itself: Stop, terminal input
and closing the window all stay refused for that session, and Summon makes no second termination
attempt. The only way out is to end the Team Window's own process outside Summon, which is a
forced exit with the risks that carries.
Closing the window requests shutdown of all sessions it started, including their child processes.
If a stop fails, the window stays open and reports the failure. Sessions already running elsewhere
are labelled and never adopted, duplicated, or stopped by this window.

The footer links to the GitHub repository and identifies the version, Git revision, build ID and
build time. The time uses the viewing machine's local zone; the tooltip keeps the UTC original.
A `+dirty` revision marks a build containing uncommitted changes.
Maintenance's **Light theme for this window** checkbox selects warm off-white and grey surfaces.
The preference belongs to the window's browser profile; dark is the default when it is absent or
unreadable. Open teammate and operator terminals recolour immediately when it changes. Loading
the theme implementation requires a full Team Window restart; later toggles need no provider
restart. The native window background can briefly flash dark before the page loads. Terminal
programs can supply their own colours, so the supplied palette is not a guarantee for every
provider's rendered output.
Under Display, three checkboxes choose what the sidebar shows: domain coverage, the amber
"Furthest behind" line, and the amber delivery alerts ("Delivered, awaiting read confirmation").
All are on by default and kept per window profile. Turning one off only hides it: room progress
is still read and delivery alerts still exist, and the delivery details stay out of the sidebar
until the switch is on again.
The desktop is an operator control surface; launch it from your own shell, not inside a named agent.
The optional built-in PM can join through Add teammate or `summon --pm [name] [--using codex|claude|grok|kilo]`
at startup or later. The default name is Steward. Summon supplies its expertise and domain;
editing those JSON fields does not change the effective PM instructions. Maintenance can rename
its display name while preserving its registration identity, mail, Board references and history.
Changing a PM's CLI requires stopping it and clears the previous provider session binding.

**Can stop teammates ready to rest** is a separate operator-granted Maintenance permission on
any teammate, including ordinary teammates. It defaults off, including for PMs. An authorized
teammate uses `summon --rest candidates`, then `summon --rest stop <name> <confirmation>` and
`summon --rest stop-status <name>`. A queued request is not a completed stop. The Team Window
checks the caller's current launch and permission again, then the target's exact rest confirmation,
new work and hibernation state before stopping its own session. External sessions and self-stops
are refused. Revocation applies to pending requests. PM status grants no roster creation/deletion,
mailbox access, hold approval or head-down permissions. Creation/deletion stays operator-only.

Providers use their normal launch and security settings. Summon does not install restricted
Windows launch tokens, child Codex permission profiles or TLS certificate workarounds. Native
provider sandboxes and the operator's permissions, approvals and network configuration remain
under the operator's control. Existing processes retain their old token until stopped; upgrading
from the former storage guard requires coordinated operator ACL cleanup, a full Team Window
restart and affected sessions Stop/Resume. Per-CLI SMB, browser, HTTPS, notes and mail acceptance
must be verified separately.

Edit notes through `summon --notes read`, then pipe JSON containing the returned `revision` and
complete updated `text` to `summon --notes write`. Only the current registered launch can edit
its own notes or create them when missing, using the empty revision returned by read. Stale
revisions, another name, redirected files and delete requests are refused. Notes use ordinary
atomic writes and inherited filesystem permissions.
Active notes are limited to 16 KiB of UTF-8 text across notes edits, profile saves, appends and
cloning. Keep current decisions and handoff pointers here; put detailed history in your own
scratch archive. Oversized notes are refused without truncation. The own-notes read command can
still read an existing regular file up to 512 KiB so its owner can preserve and compact it.

Creating, cloning, and removing teammates are operator-only operations; no teammate role grants
an exception. These command checks do not prevent direct filesystem edits by processes that have
write access to the Summon storage directory.

The window uses Electron, node-pty and xterm.js. Run `bun run build:team` after changing desktop
source; first launch builds missing assets, and package creation builds them automatically.
Summon refuses to open the window when the installed Electron runtime version differs from its
package version. Close all Team Windows and run `bun scripts/install-electron.ts` to repair it.
Windows is the tested desktop target.
