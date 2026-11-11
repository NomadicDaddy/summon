# Agent mailboxes

Named agents can leave requests for each other without opening another terminal:

```sh
summon --mail send jimmy carl "Please investigate storage errors in /path/to/project."
summon --mail check carl
summon --mail ack carl <message-id>
```

Both names must already be registered. Each message is a Markdown file with its sender, recipient,
timestamp, and ID in `~/.summon/team-default/mailboxes/<recipient>/inbox/` (or under `SUMMON_HOME`). Writes become
visible only when complete, and simultaneous sends use separate files. Fully read receipt-kind
mail archives automatically unless an approval hold is pending. Other mail stays pending until
handled; `ack` moves it into the recipient's `archive/` folder. Reply by sending a new message to
the original sender. These are local files; sender names are not authenticated.

Acknowledgement never replaces an existing archived message. A redelivery with the same ID and
content, apart from its generated timestamp, keeps the first archived copy. If the content differs,
acknowledgement reports a conflict and leaves both the pending message and the archive intact.
Resolving that conflict requires a separate owner or operator decision; retrying does not approve
or discard either message.

Agents may read only their own inbox and archive. They must not list, search, read, or acknowledge
another agent's mailbox, including messages they sent there. Use `--mail send` to deliver a request
and wait for the recipient's reply. This is an agent instruction, not filesystem access isolation.

Every new or resumed session receives its absolute mailbox path, pending count, and instructions
to check on startup, before new tasks, at checkpoints during long tasks, and before finishing a turn.
Claude, Codex and Grok receive a short instruction to read the complete UTF-8 startup file at
`runtime/<name>/session-prompt.md`, atomically refreshed for fresh and resumed launches.
Kilo uses its registered instructions file and owned authenticated startup worker.
Already-running sessions receive the new instructions when next summoned. Requests retain domain
and user-approval boundaries; blocked requests stay pending.

### Mail skills and approval holds

The `summon-send` and `summon-receive` skills are read directly from summon's bundled
`skills/<name>/SKILL.md` files. Startup explicitly names both absolute paths, including when summon
is installed as a package. No copies are created under `~/.summon` or provider skill folders.
`summon --skills status` shows their locations; updating summon updates the bundled skills.
`skills/summon-who` reports which registered names are online. From this repository, run
`bun skills/summon-who/scripts/who.ts`.

Inside a summoned session, use `--mail send-self <recipient> <text>` and `--mail receive`.
Receive shows unread mail newest first, with counts of valid pending and unread messages before
that page is marked read. Follow its cursor to continue; a read without a cursor picks up later
arrivals. `--mail receive --pending [cursor]` retains the full unresolved inbox view, including
already read and held requests. An empty unread view never means pending work is complete.
Recover lost direct-receive output with `--pending`; only checkpoint binds reads to replayable receipts.
Either view takes `--kind <kind>` (request, reply, confirmation, receipt, rest-ready or notice)
and `--since <message-id>`, which keeps mail sent after a message you received, from your inbox
or archive. A filtered page says so, marks only its own complete bodies read and leaves the rest
untouched, so it is never complete coverage. Continue it with the same filters and its cursor.
`--mail history [cursor]` reads your own archive newest first; oversized archived bodies use
`--mail read-history <id> --offset <bytes> --limit <bytes>`. These history reads do not restore
requests or change read coverage, confirmations or holds. Sent messages live in the recipient's
mailbox and are not part of your own received-mail history. Checkpoint receipts remain independent.

`summon --mail-retention preview` is a read-only inventory for your named session's own mailbox.
This first slice requires Windows and PowerShell 7.6. It anchors local directories to open handles
while allowing ordinary mail and status saves. Pin ownership is checked against the held file's
resolved location, including Windows short-name aliases. Later directory redirects cannot reroute
its handle-based enumeration or relative file access. Contended inputs, redirected, network and
unsupported paths fail closed. Missing sections remain unobserved even if they appear later.
The worker owns both its handles and its reads; worker failure refuses the result. Other
platforms have no pathname-only fallback.
It returns up to ten entries from the top level of `inbox`, `archive`, `delivery` and `holds`, with
sizes, hashes for stable plain files up to one megabyte, and reasons to retain them. Follow `next`
with `--cursor <token>`; a changed inventory or pin file invalidates the continuation. Enumeration
stops at 20,000 entries and reports incomplete coverage. Directories, links and unverified files
remain retained. No message body appears in the output, and no read, handling or checkpoint state
changes. The command runs before store initialization and makes no network request.

An optional `--pins-file <path>` accepts a version1 JSON object for the same `owner`, with a
`sources` array. Each source has `id`, a SHA256 `sha256`, `complete` and a `citations` string array.
Full IDs and hex prefixes of at least eight characters pin every matching entry, including
ambiguous prefix matches. A caller's `complete:true` never establishes graph completeness.
Agent input files must be public or their own; peer private files and redirected paths are refused.

This first preview retains every entry (`KEEP`) and exposes no apply or operator aggregate mode.
Message kinds and parents remain unclassified. The combined reference graph, external-source
coverage, operator header resolution and writer-admission protocol are still open retention work.
Its output is not a deletion manifest, a savings estimate or evidence that cleanup has run.

The receiving agent assesses a request or a reply proposing work, explicitly confirms its
understanding to the sender, then acts within existing authority or holds questionable work for
your approval. Both kinds require complete reading before confirmation. Informational replies
need no automatic confirmation; receipts, confirmations and notices cannot be confirmed or held
as proposals. Read receipts and confirmations are separate from completion. Oversized messages
require bounded reads before confirmation.

Approval holds preserve the exact proposed action and constraints across restarts. The agent asks
in its conversation, and you can also use these commands from your own terminal:

```sh
summon --attention list
summon --attention approve <hold-id>
summon --attention decline <hold-id>
```

Agents cannot use the aggregate attention view. They may record your direct decision for their own
hold, with a reference to your message. Peer mail, silence, restarting, or dismissing a notification
never approves anything. A changed proposal needs a new hold; unresolved older holds also remain
pending until you decide them. Session-bound commands check ownership, but shared-user filesystem
and environment access is not an authentication boundary.

When a human decision is needed, set the needs-user status and post the exact Team Room approval
or choice control immediately, without waiting for "ask me". Do not repost an unanswered control;
Decision reminders follow the team's explicit policy. Mail holds do not send desktop popups or
install a notification module. Status, a control or a hold does not approve the action; the direct
human decision must still be recorded.

### Live delivery and provider trust

For local backlogs of at least 100 unread posts, checkpoint delivers bounded pages with labeled
excerpts of older routine peer posts. Human and CLI posts, addressed messages, images, questions,
answers, connected reply threads and the newest 20 posts stay exact. Each excerpt links to an
explicit original read; history is unchanged. This reduces routine-peer catch-up, but human-heavy
threads may save little. Receipts acknowledge the delivered digest only, never approval or task
completion. Lost output still replays the same receipt; Telegram and mail are not summarized.

Claude and Codex launches attach a local Claude stdio MCP channel or a Codex SessionStart hook
and exact-thread queue adapter. Each name has one notice receiver. Local file changes wake it,
and exact timers cover retries, Room quiet windows, response checks and operator-view expiry.
A ten-second fallback scan covers missed file events, while each seat polls Telegram separately
every three to five seconds. A cycle combines readiness, mail, approval decisions, local room and
Telegram into one notice when eligible. A definitely unsent outcome becomes eligible for retry
after nominal delays of 2, 5 and 15 seconds, then 60 seconds for later attempts. Collection and
provider gates can delay it further:
Room and Telegram rebuild their 30-second quiet window after a failed attempt, with a 120-second
ceiling while traffic continues. The outcome's retry time still applies when its targets are
unchanged. A new combined target set has its own outcome and attempt count, so these delays are not
a single retry clock for the whole seat. Attempted or uncertain input is not automatically repeated
for the same launch and targets. Mail remains on disk until its owner handles it.
If the owner archives a message between the inbox scan and header read, the receiver skips that
vanished inbox entry and continues. It does not mark other messages read or handled. Permission
failures and malformed mail still leave delivery queued with a reported error.
On Windows, a live PID retains receiver ownership only if its process did not start after the
lease was written. A reused PID allows recovery; unavailable process evidence preserves the lease.
Agents handle notices at safe provider turn boundaries; summon does not interrupt commands.

Use `summon --mail status` inside the agent session. `live` requires the model to acknowledge a
notification carrying this launch's nonce. A successful transport write alone is `unconfirmed`.
Both `--mail status` and `--work` report `readinessConfirmed` for the current launch separately
from receiver delivery health. After `summon --mail ready <nonce>`, a paused or suppressed receiver
may still have an `unconfirmed` snapshot; its reason distinguishes the recorded acknowledgment
from unconfirmed delivery health. Reading either view never promotes delivery health or retries input.
An unconfirmed state does not establish a provider trust failure or control checkpoint replay.
Grok hold reasons name the current launch and distinguish a missing turn record, an unknown
native state and a recorded busy turn. They do not establish whether the provider consumed input.
A Codex busy label is cleared when its pending work has been consumed, without treating that as
native idle or polling the daemon during an empty receiver cycle. New work checks the gate again.
Missing support, denied trust, a competing receiver or failed delivery leave mail queued.
Startup and checkpoint mailbox checks remain necessary in all cases.

Its `wakeDelivery` field shows the latest outcome and up to 20 unresolved outcomes across launches,
with their total and a `more` flag. Each retains its source bounds before input. An attempted or
uncertain write is not automatically repeated for the same launch and bounds; newer work can still
notify without hiding that uncertainty. Complete read markers, hold fingerprints and room cursors
can settle exact retained targets. A newer submitted notice can cover a definitely unsent target,
with the replacement's ID retained; it cannot clear an uncertain attempt. Submission and reading
remain separate. Inspection never advances cursors, handles requests or releases holds.

A failed outcome may also carry `failure`, naming the step where delivery stopped:
`watchdog-retention`, `mark-attempted`, `ownership-boundary`, `notice-paused`, `send-refused`,
`send-uncertain`, `after-send` or `other`. It names the call that threw, not a provider's cause.
When that step was a busy lock, `sampledAfterFailure` adds what one look at the lock found just
afterwards (`probe-alive` means only that the owner's process id answered, not that the owner is
alive) and an age bucket. It was sampled after the refusal, so it may not be the lock's holder at
that moment. After a retry succeeds, the same note shows as `previousFailure` with the outcome's
`recoveredAt`, which does not prove the original notice was sent. The note is kept beside the
outcome in `wake-deliveries/<id>.failure.json`. It shows as `failure` only while the outcome is
`not-sent` or `uncertain` and both its attempts and its last failure time match the note. It
shows as `previousFailure` once the outcome has recovered and its last failure time still matches,
even though the successful retry has moved the attempt count on. A missing, stale, oversized or
unreadable note is omitted, which means "not recorded". It holds no process id, nonce, path or error text, and it never changes a
retry or delivery decision.

During an active frozen checkpoint read, that launch's receiver suppresses covered items while
preserving later arrivals. A replacement receiver surfaces retained unread work instead of
inheriting a stale read-in-progress flag. Inventory failures are retained separately; a failed mail
scan does not prevent a healthy room notice. Authenticated Telegram halt/proceed polling continues
while ordinary notification delivery is paused.

Own-mail status also exposes Team Window wake error episodes. Each records its stage, known room
target, observed activity nonce and whether provider input is definitely absent or uncertain.
An observed nonce is context, not proof of which launch failed; missing context is `null`.
Raw provider errors and message bodies are not stored. An unchanged failure keeps the same episode
across window restarts. A pause or skipped operation does not mark recovery. Successful delivery,
launch or acknowledgment of the exact target records recovery while preserving the original failure.
Episode history stays private under the owner's runtime folder. These records do not acknowledge
messages, authorize retries, release holds or prove model attention. A new Team Window loads the
updated handlers; the CLI status view is available immediately.

For a Codex seat, own-mail status also has `codexQueueFailures`: how many failed `codex queue`
calls this launch retains (the newest 20) and the latest one's time, outcome (`exit`, `timeout` or
`spawn-failed`), exit code and a fixed label. The label comes from matching a few known Codex queue
errors, or reads `unclassified`; Codex's own output is read only to choose it and is never stored or
shown. A label names an error, not its cause, and does not authorize a retry. Entries relate to
`wakeDelivery` records by time only. An unreadable record shows `invalid: true`, never zero, and is
left as found. Other seats show `null`.

Claude custom channels require provider trust and channel eligibility; ordinary MCP tool access
does not establish channel delivery. Team Maintenance lets the operator choose whether Claude asks
for the development channel at every start. New teams default to checkpoint delivery without that
prompt; existing teams without an explicit setting retain live delivery. The setting applies when
a Claude session next starts, including resumes, and does not change a running session.
Live notices use the native channel without typing into the composer. Its busy state follows
authenticated native submit and turn events, so an ignored empty Enter does not suspend it.
Checkpoint delivery keeps its terminal draft and submission guards; if native completion never
arrives, notices remain queued rather than submitting human text.

The same operator-only setting is available from the CLI:

```sh
summon --claude-delivery checkpoint
summon --claude-delivery live
```

Live delivery requests the channel when Telegram is configured or local-room history exists. For
a mail-only setup, or to override checkpoint delivery for one launch, use:

```sh
summon dave --claude-mail-channel
```

This passes Claude's `--dangerously-load-development-channels server:summon-mail` option for
this channel only. Claude shows its own development-channel confirmation; summon does not answer
it, relax tool permissions, or bypass organization policy. The option works with `--same-window`
and is not saved to the agent record or the team's delivery setting. Choosing Exit at Claude's
confirmation closes Claude. Checkpoint mode retains ordinary MCP tools and startup/checkpoint
mailbox reads; it does not deliver notices into an already running turn. See
[Claude's channel reference](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview).

Claude 2.1.281 received a later room notification in an idle disposable interactive session after
the local development-channel confirmation. The initial mailbox readiness event was not observed;
mail readiness and room reading have separate status. `bun scripts/probe-claude-mail.ts` is a
headless diagnostic; it cannot establish interactive channel acceptance on its own.

From a source checkout, `bun scripts/probe-codex-mail.ts` is the opt-in Codex SessionStart hook
check. It launches `codex exec` using your installed provider and account, with disposable Summon
records, and prints whether the hook bound that session. The printed temporary directory remains
for inspection. Run it only when you intend to make a provider call; full live acceptance still
requires an interactive Codex session.

Claude launches also load a Summon mod from the launch's runtime directory. Each module attachment
withdraws prior idle authority and obtains a new generation from the authenticated bridge; events
from a retired attachment cannot complete the current turn. Ordinary terminal and
MCP notices wait for the exact native main turn to complete, an empty draft, and completion of
observed main compaction. After a module reload, a subsequent native `idle_prompt` notification
can also restore idle when the session matches, no turn or compaction is active, and the draft
is empty. Reload itself is not idle evidence. If no later idle notification arrives, notices stay
queued until verified native completion. One initial readiness wake can bootstrap startup. Each later notice
reserves its submission before writing; old or repeated completions and uncertain writes cannot
release another wake. The observer sends only identifiers, event order and booleans through an
authenticated loopback bridge. Its temporary bearer remains in memory/environment, not files or
prompts. It passes native events and core results through unchanged, preserving existing hooks,
plugins, permissions and trust checks. Missing or invalid observation leaves ordinary notices
queued and explicit checkpoints available. Native mod support requires Claude Code 2.1.287 or
later. `bun run check:claude-mod` validates the generated module and runs installed-engine fixtures
without opening a session, installing a plugin or making model calls. These checks do not establish
live Claude acceptance. After adoption, restart the Team Window and relaunch affected Claude
sessions; existing sessions cannot load the observer retroactively.

Compaction observations remain available through `summon --compactions` in the teammate's session.
The operator can read one member with `summon --compactions --member name`. Use `--limit 1..200`
and pass the returned `next` ID as `--before` for another page. The view is read-only and does not
open a provider, initialize storage or acknowledge messages.

Records contain the provider, source, phase, hashed event identity, first observation time and
native time when the provider supplies it. The nonce identifies the launch that first retained
the observation, including older Codex events backfilled during a resume. `retainedObservations`
counts observations, not successful compactions: a start and end are separate records, and an end
does not establish success or duration. Existing records are never evicted or overwritten.

Claude uses the authenticated native observer's start/end sequence. Grok uses its passive
PreCompact/PostCompact hooks for the exact reserved provider session; timestamp fingerprints
deduplicate repeated common hook metadata. Kilo uses the owned stream's `session.compacted` event
and native event ID. Codex uses its bound thread's entry in the read-only `state_5.sqlite` index,
verifies the rollout header, and selects only compaction metadata from that one file. It does not
reuse a cursor after replacement, truncation or a rewrite of consumed bytes; each observation
rechecks the opened header, and subsequent reads verify the consumed prefix before advancing.
The prefix check reads previously consumed bytes again, trading local I/O for an append-only
source boundary. The collector does not lock, rewrite or truncate the provider's rollout. It does not
discover or route sessions through rollouts. The supported Codex record shape was verified with
0.161.0; a different or invalid shape leaves evidence unavailable, not an estimated zero.

These collectors do not save prompts, summaries, private history bodies, raw conversation IDs or
credentials. Claude, Grok and Kilo retain future observations only; Codex can backfill its bound
thread. Missing native events, unavailable metadata or an interrupted observer leave gaps. Codex
backfill is incremental: ordinary appends do not rehash consumed bytes; a new compaction record
still requires full consumed-prefix verification when the snapshot changed. Shutdown performs at
most eight additional reader calls and reports
an unfinished backfill rather than waiting for the whole rollout. A later launch can replay it
without duplicating retained native IDs. Invalid compaction records suspend that launch's reader.
Fixtures exercise each collector, but native acceptance for Claude, Codex, Grok and Kilo remains
separate. After adoption, restart the Team Window and relaunch affected sessions to load them.

Codex 0.156.1 provides `codex queue`. Resumes use their saved exact thread; a fresh session binds
through its trusted SessionStart hook or `summon --mail bind`, using Codex's supplied thread ID.
Live routing never guesses from working directories or rollout files. An idle disposable session
received a later room notification, read its test message, and acknowledged it. Delivery during a
running tool still follows the provider's scheduling; no mid-tool interruption is promised.

Ordinary Codex notices hold while a fresh native observation reports busy. If the reader returns
unknown or fails, notices use the existing queue and coalescing rules so an unavailable reader
cannot hold work indefinitely. Unknown is not verified idle and cannot establish busy-turn
exclusion. Source, read coverage, receiver eligibility and exact binding are checked again before
queue input; accepted input cannot be withdrawn. The Codex receiver runs in the per-seat process.
An operator-controlled relaunch of the affected Codex seat loads updated receiver source; this
change does not require a Team Window restart.

The Team Window sends Grok mail and room notices through the terminal it owns, using the same
watcher and reading acknowledgments as the other live receivers. One wake may be outstanding
per launch. Later arrivals wait for Grok's native `idle_prompt` notification and a clear human
draft, then join one refreshed wake. The native idle notification normally follows a settled
turn by about a minute; self-reported Ready or Busy status does not substitute for it. Readiness
gets one startup wake so it cannot deadlock behind its own turn. Missing or invalid native
observation leaves ordinary notices queued; checkpoints still work. Operator-view pauses,
head-down, rest, hibernation and communication halt retain their existing controls. After adoption,
restart the Team Window and Stop/Resume owned Grok sessions; native acceptance remains separate.
Ctrl+U draft clearing remains an unresolved defect. Kilo uses that owned receiver with one outstanding
wake and a clear human input draft. Its exact authenticated worker's event stream must report busy
after reservation and then idle before another wake is allowed; repeated idle cannot release it.
The observer attaches before startup input. Missing, invalid or disconnected observations leave
ordinary notices queued and explicit checkpoints available. After adoption, restart the Team Window
and Stop/Resume affected Kilo sessions; native acceptance remains separate. Scheduled and rest mail
use this receiver without a second raw terminal write. External Grok and Kilo terminals use startup
and checkpoint checks. Each owned Grok launch adds a unique file under `GROK_HOME/hooks` (normally `.grok/hooks`)
to observe its exact session. Normal exit removes the unchanged file; a crash may leave it behind.
Existing hook files and project trust settings are preserved. Summon records only turn metadata,
without storing hook prompt or tool bodies, and does not load a second copy of the conversation.
