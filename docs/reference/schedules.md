# Named-agent schedules

`summon --schedule summary` is a read-only view of unfinished runs, due jobs and their last
recorded deferral, upcoming jobs and paused jobs. It omits prompts and completion evidence,
shows at most 20 items per section with total counts, and identifies the machine-local time zone.
Use `--schedule list` for all records and `--schedule run <id>` for a run's authoritative scope.
The existing rest gate now identifies the unfinished run or due schedule blocking readiness;
reading diagnostics does not resolve it. Team Window processes need a restart after activation
to load the improved rest diagnostics. No checkpoint migration is required by these CLI additions.

Agents can create, pause and resume their own interval jobs without operator approval.
The operator can manage any registered owner's jobs. From a named session or the operator
terminal in the intended team, use PowerShell (agents use their own name as owner):

```powershell
$job = @{ owner = 'reviewer'; title = 'Review new commits'; everyMinutes = 120; prompt = 'Review new commits in the explicitly agreed repositories; report evidence without changing files.' }
summon --schedule create ($job | ConvertTo-Json -Compress)
summon --schedule list
summon --schedule pause <schedule-id>
summon --schedule resume <schedule-id>
```

To change only future instructions, read the current prompt with `--schedule list`, then use
`summon --schedule update-prompt <schedule-id> <json>`. The JSON contains exactly
`expectedPrompt` (the prompt you just read) and `prompt` (the replacement, 1–8000 characters).
For literal multiline text, author that JSON as a UTF-8 file and replace `<json>` with
`--body-file <path>`. Only the owner or operator can update it; a concurrent prompt change
refuses the write, so read it again before retrying. The schedule keeps its identity, owner,
title, cadence, due date, enabled state and deferral. Existing run prompts and results remain
unchanged; only subsequently dispatched runs receive the replacement instructions. This command
does not dispatch work or restart a session. The replacement must stay within authorized scope.

Use an existing registered owner and a prompt containing the complete authorized scope. No
schedules are installed by default. A running Team Window checks due work every two seconds;
only its own running, awake agent with an explicit idle status is eligible. Busy, needs-user,
hibernated, unknown-status, and external-terminal sessions wait. Ordinary stopped sessions also
wait; sessions explicitly stopped through Zzz can resume for scheduled work as described below.
Closing the window or halting communications stops dispatch. Each named team has
independent storage. Restart the full Team Window to load scheduler implementation updates.

Missed intervals coalesce into one run. The next interval starts at dispatch, and a schedule
cannot dispatch another run until its preceding run is explicitly complete or failed. Durable
claims prevent competing processes from sending the same occurrence twice. Mail goes only to
the recorded owner; each provider's launch receiver delivers its notice. Kilo and Grok use only
the terminal owned by this Team Window. This does not create a provider-native cron job.

The owner verifies the authoritative prompt with `summon --schedule run <run-id>`, then records
`summon --schedule complete <run-id> "evidence"` or `summon --schedule fail <run-id> "reason"`.
Only the owner or operator can resolve it. Reading mail, acknowledging a checkpoint, or
archiving a request never marks a run complete. Final evidence cannot be overwritten.

Interrupted delivery becomes `uncertain`, blocks the next occurrence, and reports an error.
Inspect the owner's delivery and work evidence before resolving it; do not blindly repeat the
task. A terminal-notification error can leave durable mail in `delivered` state. Pausing a
schedule prevents future dispatch but does not cancel delivered work. Listing schedules shows
the persisted history; agents can list only their own jobs and runs. Uncertain runs are never
automatically retried, and this first version does not offer calendar/cron expressions or a GUI
schedule editor.
`summon --schedule list` also exposes a due schedule's last recorded `deferred` reason,
original `dueAt`, and `observedAt` (epoch milliseconds when that reason was first recorded).
Reasons distinguish busy/needs-user or missing activity, a session not running in this window,
notification pause/head-down, hibernation, communications pause and an unfinished prior run.
The explanation updates when the reason changes and clears on dispatch or schedule pause/resume.
It reflects the last scheduler evaluation that changed the reason, not a live availability promise;
a stopped Team Window cannot refresh it. Deferral never advances the due date or completes work.
