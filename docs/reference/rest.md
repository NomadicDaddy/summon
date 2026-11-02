# Ready to rest (Zzz)

Read `summon --session-history [--member name] [--limit 1..200] [--before id]` to compare the owning Team
Window's starts, stop requests, completed stops, exits and failed stops. Each entry identifies
the member, provider, launch nonce, owned PID and window start. A relaunch links its previous
owned launch nonce when known. Recorded causes distinguish operator, rest, mention, recovery,
unhibernate and window-close paths. An exit without a recorded cause remains unknown.

History is bounded to 2,000 transitions and 2 MiB under `logs/session-history.json`. The reader
discloses its retained count, oldest retained time and omitted matching entries. Follow `next`
with `--before` and the same member filter to read older retained events. An expired cursor refuses
the read. It reads without
updating the journal or initializing the store. Missing or damaged history does not establish that
no action happened. Persistence failure is reported, and existing evidence is preserved.
Shutdown drains pending writes even when a stop fails. Events before activation and hard crashes
cannot be reconstructed; lifecycle metadata does not prove terminal input or provider acceptance.

An agent explicitly confirms `summon --rest ready` after checking its known work. When nothing
refuses, the command sets the agent's own status to idle "Ready" and confirms rest, so a separate
`summon --status idle "Ready"` is unnecessary but harmless. A refusal leaves the status as it was,
including when the status changes while rest is being checked. An existing needs-user status
and its human-wait text are preserved byte-for-byte while rest is confirmed. That confirmation
is bound to the exact wait; changing the status or its text invalidates it. Rest does not approve
the pending proposal or remove its raised-hand/Room request. The status and confirmation are two
files; if saving confirmation fails, a caller changed to idle remains idle "Ready" without
confirmed rest, while a preserved human wait remains unchanged. The error is reported.
Summon refuses confirmation while Doing cards, unread work mail, due or unfinished scheduled
runs, or unread directly addressed room messages need attention.
Ready cards can remain after the owner checks their scope, including cards awaiting separate
approval. Confirming rest does not approve or complete those cards. Blocked, Backlog and Review
cards can remain too. This verifies the recorded queue, not completeness
of the agent's knowledge. `summon --rest cancel` withdraws consent; `--rest status` inspects it.
Status retains the confirmation's original `nonce` and identifies the latest recorded activity
launch separately as `currentLaunchNonce`. `confirmationIsCurrentLaunch` is false for an older
confirmation, or null when no activity launch is known. A true value only matches launch records;
it does not establish readiness, process liveness or permission to stop. Stop still revalidates
the exact confirmation and current work.

A confirmed, running teammate gets a keyboard-accessible **Zzz** button beside its roster row.
Only the operator clicking that button stops it, using the ordinary Stop Session operation.
Summon rechecks the displayed confirmation before stopping; a relaunch needs fresh consent.
Nothing infers confirmation or stops a session automatically. After ten minutes of idle
activity, Summon can send one question per idle episode asking the agent to review its cards,
mail and scheduled duties, even when those records currently prevent rest. The agent must
reconcile them before confirming readiness. Busy activity vetoes that question. So does
idle activity left by an earlier launch, and so does a provider turn that is still running, such
as a long tool call, even when the status says idle. Turn evidence that can't be read, or that
this launch hasn't recorded at all, counts as unknown and also holds the question back. The cost
is that a seat whose launch never writes a turn record never gets the idle question. For Codex the evidence is the bound thread's status
on the running daemon, so an unavailable daemon or an unbound launch holds it back too. After a
busy or unknown reading, the same member is checked again a minute later, not on every tick.

While confirmed ready, routine room notices stay queued without waking the model. Explicit
mentions (including @all), replies to the agent, unread actionable mail, changes to its cards or
approval decisions, and scheduled work clear readiness. A seat already stopped for rest resumes only
for what may start it: an agent's `@all` or `@offline` alone does not resume it. Fenced code,
blockquotes and quoted
mention examples do not count as direct addressing, and start or resume nobody. History and checkpoint cursors are preserved;
already-queued provider notices cannot be withdrawn.

Mail confirmations and receipts are bookkeeping: they remain unread and available for the next
ordinary read without ending confirmed rest or resuming a stopped member. Send new work as a
request or reply. Summon uses the message kind, without guessing intent from its prose.
Readiness notifications are delivered after the rest state lock is released. The roster observes
committed state; automatic wakes wait through contention, and Stop still revalidates consent.

If the operator stopped the session through Zzz, those events can resume its named session once
while the Team Window remains open. Hibernate and communication Halt block automatic wake.
Ordinary Stop is not newly made eligible for mail/card/schedule wake by this feature. An interrupted
wake attempt is reported for manual recovery rather than blindly repeated. Existing mention-based
wake behavior otherwise remains in place. No provider-native cron is created.

A failed Zzz stop marks rest as uncertain and removes the old confirmation from stop candidates.
Inspect the terminal and any remaining processes before requesting fresh rest consent. The failed
request retains its error; it is not recorded as a successful stop and cannot automatically resume.
Windows stop errors include the owned PID, taskkill exit status and bounded diagnostic output.

Stop Session, rest stops and window shutdown first try `/exit` for an owned Grok or Kilo session
reporting idle for its current launch, with no tracked human draft and a native idle observation.
Unknown or malformed observations use the existing forced stop. Claude and Codex retain forced
termination without synthetic input, even when idle: Enter could otherwise act on a Claude
overlay or Codex approval prompt. Busy and needs-user sessions keep
the existing Stop confirmation and forced termination. After submitting `/exit`, Summon waits
up to five seconds for the owned terminal to exit before forcing termination. Concurrent stop
requests share one operation, and terminal input and terminal notices are blocked while it runs.
This does not save unsaved work or prove provider shutdown hooks completed. Native exit acceptance
is still required for Claude, Codex, Grok and Kilo before adoption; restart the Team Window to
load the changed stop path.

Restart the full Team Window for the roster and wake logic. Existing Claude/Codex sessions also
need Stop/Resume to load receiver-side routine-notice suppression. CLI commands read source
immediately; Kilo/Grok use the Team Window's delivery path.
