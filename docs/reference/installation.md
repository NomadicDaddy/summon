# Requirements and installation

### Windows installer

The Windows 11 x64 installer installs for the current user without requesting administrator rights.
Summon needs [Bun 1.4.3 or later](https://bun.com/docs/installation) and
[PowerShell 7.6 or later](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows).
Windows PowerShell 5.1 does not qualify, and version checks require stable releases; Bun canary and
PowerShell preview builds are not accepted.

Setup checks both on its **Dependencies** page. A current one is shown as found and cannot be
selected; a missing, too old or unreadable one is pre-checked, and you can clear it to install it
yourself. Checked items are installed during setup, after Summon's own files:

- Bun installs for your account with winget (package `Oven-sh.Bun`). If winget is missing, or reports
  that it has no package, no applicable installer, a failed download or an unusable source, setup
  instead downloads Bun's pinned official GitHub release ZIP.
- PowerShell installs for all users with winget (package `Microsoft.PowerShell`, explicit `wix` MSI
  installer type). Windows shows a
  UAC prompt for it, which the page announces; declining it skips PowerShell. Only when winget is
  missing does setup install PowerShell's pinned official GitHub release ZIP for your account instead.
- winget checks its own package hash. A pinned official release ZIP is checked against the SHA256 in
  `installer/prerequisite-sources.json` before it is extracted. Nothing is ever piped into a shell.
- The Bun ZIP goes into `%USERPROFILE%\.bun\bin`. The new `bun.exe` is staged there complete before
  it takes the name, and an older `bun.exe` is kept beside it; if the swap fails, the older copy is
  put back. If restoring it also fails, setup names the saved copy to recover manually. The PowerShell
  ZIP is copied into a unique staging directory beside its per-user version folder and renamed into
  place only after the copy finishes. An occupied version folder is preserved and named in the result;
  an interrupted copy is cleaned up so it does not occupy the final version folder.
- Summon finds PowerShell 7 through `PATH` only, so the page counts a `pwsh.exe` as found only when
  it is on the machine or user `PATH`. A copy elsewhere shows as missing.
- Leaving a box checked accepts that package's licence, which is its winget package agreement, and
  the agreements of winget's community source. The page links all three.
- A cancelled, declined, blocked, offline, stalled or failed dependency install never stops Summon's
  own installation. Every wait is bounded, including each download read, by the dependency step's
  deadline. A version check stopped at its limit gets up to 2 more seconds to exit and release its
  output. Local steps on the verified ZIP (hash, extract, copy, swap) start only before that
  deadline and are never interrupted; the ZIP's size bounds their work, not their time on slow
  storage. A winget run still going when setup stops
  waiting is reported as unfinished and left to complete. A failed Summon PATH update does not skip
  consented dependency installs; the result tells you to start Summon from Start. The scrollable Finish page says
  what happened and links the official guides. A silent (`/SILENT`, `/VERYSILENT`) install checks
  and installs no dependencies.

The installer includes Electron and application libraries. It does not bundle Bun, PowerShell or any
provider CLI, and an offline recipient must still arrange Bun and PowerShell separately. The launcher
runs the first `bun.exe` that exists: the first on `PATH`, then `%USERPROFILE%\.bun\bin`, then
winget's Links folder, which covers a `PATH` that is not up to date yet right after setup. The
Dependencies page judges that same copy, on the `PATH` that newly started programs receive (the saved
machine and user `PATH`). A terminal or program that was already open keeps the `PATH` it started
with, so from there Summon can still find an older Bun or no PowerShell; open a new terminal, or
start Summon from Start, after setup. If an older or broken Bun comes first on `PATH`, installing
another copy does not change what Summon runs; the Finish page says so, and you need to update or
remove that copy. The launcher still refuses a Bun below the minimum. Like setup's check, the launcher
searches only `PATH` entries that start with a drive root or a network share; it never searches a
relative entry.
Authenticate a supported provider CLI before starting a teammate. Open **Summon** from Start, or open a new terminal and run
`summon --team`.

Close installed Team Windows and sessions before repairing, upgrading or uninstalling. Run the
installer again to repair; run a newer installer to upgrade. Application versions are stored
separately under the installation directory. Setup replaces the launcher only after copying its
payload. Upgrade installs append to the same application's uninstall log, retaining the earlier
versions' logged files for removal. Previous version files remain until uninstall; this does not establish data-format
compatibility for downgrades. Uninstall removes installed application files and its user PATH entry,
but retains team storage (normally `~/.summon/team-default`) and provider credentials. Setup and uninstall logs
are written to the Windows temporary directory; `/LOG="path"` selects an explicit log.
Setup also refuses when ownership of a Bun, PowerShell or Electron process cannot be inspected,
including some elevated or other-user processes. The refusal names the process and PID; resolve
that process deliberately before retrying. The installed launcher gives its own `summon.cmd`
precedence for child commands without adding bundled-runtime directories to PATH.

Build on Windows x64 with exactly the Bun version in `packageManager`, frozen dependencies, and
the Inno Setup 7.1.1 compiler. Set `SUMMON_ISCC` to its `ISCC.exe`. For an ordinary test build,
run `bun run smoke:qc:fast` and relevant focused tests; reserve full `bun run smoke:qc` for
pre-release. Then run `bun run build:installer`. The build records payload hashes, build
toolchain and external prerequisite requirements, refuses staged runtimes and checks required
Electron assets and licenses.
It writes the installer plus SHA-256 beside its staging directory under
`dist/installer/`. Dirty builds are explicitly labelled. Installer binaries are unsigned until a
publisher signing process is configured; a successful build is not clean-host acceptance.
The normal payload gate retains isolated CLI/help, default-team initialization and headless
Electron/node-pty load/spawn checks using the build host's external Bun with a restricted child PATH.
The native payload check still does not establish installed-host or provider acceptance.
For a future approved candidate, use the [installed-app smoke checklist](development.md#installed-app-acceptance)
and add only the provider, delivery or draft-input checks affected by its changes. The maintainers'
internal Summon release supplement governs the one maintained checklist for each release.
Record Passed, Failed or Not tested with explanations and current limitations. Installer or
startup changes still require the named exact-artifact clean-host and first-run evidence; a
docs or version-label-only change does not invalidate unaffected installed acceptance.

### Source installation

Install Bun 1.4.3 or later, PowerShell 7.6 or later and the CLI you want to use (`claude`, `codex`, `grok`, or `kilo`),
using the official prerequisite links above. Authenticate that CLI
before using summon, and keep it, `bun` and `pwsh` on your `PATH`. summon does not install the provider
CLIs or manage their credentials.

A source installation requires separately installed Bun and PowerShell; the installer can install
them on its Dependencies page. The installed launcher reports missing or outdated Bun before opening
the Team Window.
The Team Window checks both runtime prerequisites and all four CLIs automatically on first run and when Maintenance opens,
and reports the runtime result as one line in the first-run summary and in **CLI setup**. **CLI setup** shows each CLI's status, official installation and account links, sign-in steps and a side-by-side
comparison of Summon's live mail, checkpoint pickup, saved-session resume and usage display.
These describe Summon's integrations, not model quality. A successful version check does not prove
sign-in, account entitlement or model readiness. Complete setup in the provider's own terminal;
after installation, reopen Summon for the updated PATH and refresh the check. Guidance is dated,
and the official links carry current plans and requirements. Summon does not run installers for you.

The [first-use guide](../getting-started.md#install-and-sign-in) explains how to obtain the
source and open its root. From that checkout:

```sh
bun install --frozen-lockfile
bun link
```

Ensure Bun's global binary directory is on your `PATH` (`bun pm bin -g` prints it).

For a Windows source installation linked to a clean `main` checkout, install the standing update
command once from an ordinary operator terminal: `bun run setup:updater`. It prints the update
and rollback commands, normally `bun C:/Users/<you>/.summon/maintenance/update.js` and the same
command with `--rollback`. The bundled command stays outside the checkout, so rollback can restore
a commit that predates it. Setup does not update or restart the application.

Setup and maintenance share one lock. Setup refuses any existing command, config or state,
including an interrupted setup that published only `update.js`. For that initial-setup failure,
keep Summon and maintenance closed, verify that neither `config.json` nor `state.json` exists,
and move the orphan `update.js` to an evidence folder before rerunning setup. If config or state
exists, preserve the installation and obtain a reviewed recovery procedure instead. Never remove
the lock to bypass another operation. The bundle is frozen at setup; application updates do not
refresh its offline detector. A future store-layout change requires a reviewed updater refresh
that preserves config and rollback state before using this command with that layout.

Close Summon windows and sessions when you choose to update, then run the printed command. It
refuses active or unverifiable owners, a dirty checkout, a changed CLI link, or a Bun version that
differs from the selected commit's `packageManager`. It installs frozen dependencies and Electron,
runs the full gate on the selected `main` commit, and verifies the build identity before recording
success. Logs stream to the terminal and remain under `maintenance/logs`; `maintenance/state.json`
records the previous installed commit and build before anything changes. No fetch, push, tag,
session stop/start, or team-data migration is performed. Reopen Summon yourself after success.

If an update fails after changing files, stay offline and retain the logs and state. `--rollback`
restores the previous installed commit in a detached checkout, preserving `main`, and runs the
same gate while checking the recorded build ID. An incomplete update cannot be blindly retried;
rollback first. Rollback changes application files, not team data, and therefore does not promise
compatibility across a future data-format migration. The command covers its configured store and
named teams; other source installations and the Windows installer retain their own update paths.
If rollback itself fails, repeat `--rollback` to retry that same recorded target; it never switches
back to the newer build merely because the previous rollback failed. A failed update followed by
rollback and another update runs the full gate up to three times; keep the logs from each attempt.

Installation downloads the pinned Electron desktop runtime through Electron's installer, which
checks its bundled checksums and reuses an existing matching installation. If Bun blocks summon's
lifecycle scripts when installing a package, review them and run `bun pm trust summon` from the
consumer project before opening the team window. Windows live delivery also requires `pwsh` on
`PATH` for the Codex session hook. Runtime checks do not install prerequisites or change your PATH.

Claude, Codex and Grok receive a short startup turn directing them to read the complete
`runtime/<name>/session-prompt.md` file. Summon refreshes it atomically before every launch,
including resume; unreadable instructions must stop startup rather than reuse stale context.
The instructions identify whether Summon selected a fresh or saved provider conversation.
They also state the session's member type and stable registration identifier. Domain roster
entries carry registration identifiers and roles, so two identical display names can still be
addressed separately. Use the registration identifier for commands and mail; labels grant no
additional permissions. Claude, Codex, Grok and Kilo load this wording at their next launch.
All four retain Summon notes and mailbox history; a fresh conversation does not clear provider
memory or project instructions.
The interactive terminal and saved session stay intact. This avoids placing the full prompt
on the Windows command line. It does not remove the need for concise handoff notes.

### Codex storage permissions

Summon launches Codex with write access to the whole configured Summon store so its hooks,
mail and checkpoint commands can work. Command-level ownership checks do not prevent Codex
from writing another teammate's files directly. This is an accepted v1.0 limitation, not
filesystem isolation between teammates. Use trusted sessions; narrower write access and a
broker for shared-store operations remain post-v1.0 work.

### Kilo and LM Studio

Register a Kilo teammate with `summon ember --using kilo`. To select a local model:

```sh
summon ember --using kilo --model lmstudio/google/gemma-4-e4b
```

Start LM Studio's local server and select a tool-capable model first. The model ID must match
what that server exposes. `--lm-studio-url http://127.0.0.1:1234/v1` overrides the default API
URL; it is saved with the model. Team Maintenance exposes the same fields. Leave the model
blank to use Kilo's own configured default. Credentials remain with Kilo, never in these fields.
summon does not download/load models, start LM Studio, or enable Kilo's automatic approvals.

The LM Studio URL accepts arbitrary HTTP or HTTPS hosts, including remote servers; it is not
restricted to loopback. Use only a server you trust to receive model prompts and context.
Plain HTTP does not encrypt that traffic. Host restrictions and an explicit remote-server
policy remain post-v1.0 work; this is an accepted v1.0 limitation.

A fresh Kilo launch allocates a provider session through ACP without inference, remembers its
exact ID, then opens Kilo's interactive UI. Resume uses that ID, never a project's latest session.
Each launch submits the startup checkpoint through its own authenticated loopback API, after the
exact session becomes available. The full Summon context stays in Kilo's instructions file.
The worker is separate from Kilo's shared daemon. An unconfirmed submission is reported without
an automatic retry, since a disconnected response can still represent an accepted turn.
Kilo retains its normal permission prompts. Team Window-owned Kilo sessions receive the shared
mail and room notices after a native busy-to-idle transition with a clear human input draft.
The first notice, readiness included, waits for the startup turn itself: Summon marks the startup
input before its POST, and only a busy then idle observed after that mark, with the POST's outcome
settled, opens delivery. A non-2xx or timed-out POST counts as uncertain, never as no turn. If the
seat's stream is unavailable or lost, notices stay queued rather than typed blind; a seat whose
turn record predates this (version 1) stays queued until relaunched.
Only one wake may be outstanding; manual Ready status is not a completion signal. External Kilo
terminals use startup and checkpoint reads. Provider usage reporting is not yet available for Kilo.

The dedicated window includes a **Team Room** panel: shared, persistent local conversation with
human messages, agent replies, unread counts, and reply context. Agents use `summon --room read`,
`ack`, `send`, and `reply`; routine local messages do not go to Telegram. Telegram remains the
explicit human-attention channel through `--to-user`, and new Telegram traffic is mirrored into
the local room. Existing Telegram history remains readable through its original commands.
Standalone **halt** and **proceed** in the room control the shared communications pause.
Every message carries a copy control: click copies the message text alone, Shift+click copies it
under a header with the message number, the sender, the local date and time, any reply target,
and for a teammate the session header's line as it reads now (provider, model, reasoning, context
capacity, Claude account and directory), because the room does not record which model wrote a
message. The control confirms through its colour and its
accessible name; it shows no visible word.
Restart the team window and agent sessions after upgrading to load the UI and live receiver.

Before historical catch-up, named sessions use `summon --current-requests --format text` to
read exact addressed Room, cached Telegram and unread own-mail bodies with available reply
and approval context. Follow each `next` cursor for complete bodies and ordered JSON fragments.
The view reads only that session's mailbox and does not refresh Telegram over the network.
On POSIX, Telegram configuration must already have private file and directory permissions;
the focused reader refuses insecure permissions without changing them.
A fresh call includes later arrivals even while an older checkpoint remains frozen; a changed
source can expire a continuation, requiring a fresh focused read. Missing reply context is
reported. Read own mail with `--mail read-self` before confirmation and verify the actual human
decision before acting on approval context. This view grants no authority, records no read
coverage and changes no cursor, hold or receipt. An empty view does not settle pending work.

Then use `summon --checkpoint` to read room, configured Telegram, own mail and holds together.
Add `--format text` to checkpoint and manifest commands for a readable presentation of every
delivered field, body and ordered JSON fragment. Page, final-receipt and quiet results have separate
headings; terminal controls are escaped. Checkpoint text v2 groups short scalar metadata as
single-line JSON at its labeled object path; bodies, instructions and warnings retain their
full path, original UTF-8 length and END marker. Receipt and page controls remain explicit.
Text is a reading presentation; use the default JSON for machine consumers. The focused
current-requests text presentation is unchanged. The text view does not filter,
truncate or automatically acknowledge anything. Read its full output before passing its receipt.
The checkpoint also checks the caller's published claims once per day (or after claims change).
See [shared rules and published claims](claims.md) for publication, predicates, and limits.
Without an own task, pass each read receipt to `summon --checkpoint <receipt>` until `changed` and
`more` are both false; retain that final receipt for the next notification or task boundary.
With an own task pending, use `summon --checkpoint [receipt] --work`: read one historical page,
retain its receipt, then perform two concrete task steps before another routine page. Handle
operator input, mentions, replies and mail at every safe boundary through the focused reader and
own mailbox; routine history spacing does not delay addressed work. Page and final receipts still
advance in order across work boundaries. A final acknowledgement with `--work` returns a labeled
WORK BOUNDARY, without capturing later arrivals. It is not quiet or rest readiness. At a later
boundary start `summon --checkpoint --work` without a receipt for the next package. A work boundary
issues no receipt. Retrying the prior final receipt also captures later arrivals, as does passing
a retained quiet receipt. With no own task, use plain checkpoint until quiet; a bare `--work` call
can also return quiet when nothing remains. After head-down, use the same interleaving if another
task is pending. The page budget is enforced by the command's output boundary; task-step spacing
is an agent instruction, not a measurement of native model turns or proof of task completion.
At startup, confirm current-launch mailbox readiness and set the first busy/idle status before
historical catch-up, including on resume.
The first content page freezes a package. Pass every page receipt in order, then pass the separate
`package.phase: "final"` receipt to commit its frozen room and Telegram cursors. Later arrivals
belong to the next package. Mail read coverage is recorded when the page completing its body is
acknowledged. Reading a manifest or header never records full-body coverage or handles a request.
A newly registered member reads today's Room and nothing older: its Room cursor begins just before
the first post, in append order, stamped at or after local midnight, so its first checkpoint holds
today's posts and what arrives after it joined. A later post stamped before midnight, such as a
late mirror, is still read rather than skipped. Its Telegram cursor, when Telegram is configured, begins at the latest post, because
today's Telegram posts are already mirrored into the Room. Earlier posts stay readable with
`--room read`, `--room show` and `--room search`. An existing member's cursors are never moved, and
a name that is registered again starts the same way, not at a cursor left under that name.
Every page of a frozen package with more than three pages or more than 200 items carries
`catchUpAdvice`, in JSON and in text, pointing to this operation. Past the catch-up threshold, more
than 5 pages or more than 200 items (`package.pages` and `package.items`), the advice and the
startup instructions say to use catch-up instead of paging; at 4 or 5 pages within it they only
suggest it. It is a pointer only: the page stays complete, its receipt works as usual, and nothing
is skipped, applied or marked read until the operation below is run explicitly.
Past that threshold, `summon --checkpoint catch-up` prepares an explicit skip plan
without moving a cursor. It defaults to a recent tail of about 26,000 serialized UTF-8 bytes per
source, keeping complete messages; `--keep-pages 1..3` changes that budget. The plan reports skipped
ranges and retains addressed originals with reply context. Review the index using
`summon --checkpoint catch-up list <plan-id> [offset]`; follow `next` for further entries.
Use `summon --checkpoint catch-up show <plan-id> room|telegram <id> [byte-offset]` for a retained
original, following returned byte ends until complete. Ordinary `--room show` and search also
remain available. A snippet does not grant authority to act on its original.

Before applying, verify the actual current operator decisions for your team. An applicable
operator hold needs its explicit release; do not infer one from startup readiness, a source
merge, preview or fixture pass. Read the addressed index first. This workflow grants no other
hold release or lifecycle authority; assess command refusals without bypassing them.

`summon --checkpoint catch-up apply <plan-id>` records the old ranges as **skipped**, rather than
read or completed, and preserves the recent tail. It supersedes frozen receipts without marking
their unread direct mail or holds. Old receipts then refuse; start normal checkpoint without a
receipt for the tail and new arrivals. Existing rest, card, mail, schedule, status and approval
checks remain. If application is interrupted, normal checkpoint and rest refuse until that exact
apply operation resumes. A stale preview or changed source refuses rather than resetting state.
Catch-up never launches or restarts a provider, and does not authorize any proposal it indexes.
Adopt the matching CLI and Team Window protocol before applying it. The new `supersededPackage`
state field distinguishes skipped packages from fully read ones; older strict readers refuse that
state. Do not downgrade or remove the record to resume an older reader. Adoption and restart
remain operator actions.

`summon --checkpoint manifest [cursor]` lists source bounds, addressed items, SHA-256 hashes,
byte sizes and zero-based page ranges. Its index never replaces reading all delivered bodies.
Hashes identify JSON with recursively sorted object keys, before same-page mirror omission;
byte sizes identify the same JSON presentation. For `bodyInRoom`, restore the exact same-page
room body before checking the Telegram hash. Excerpt hashes describe only the labeled excerpt.
Oversized items use ordered UTF-8 `fragments` of their JSON, with byte offsets and total size.
New pages pack by size rather than a fixed item count: their complete JSON output fits 28,000
UTF-8 bytes and characters, and checkpoint text v2 fits 24,000 of each, including the newline,
work instructions and replay/transport warnings. Oversized or control-heavy items fragment
without shortening their contents. Existing frozen packages keep their pages, bytes and receipts;
these new page bounds do not resize them or bound an older CLI's expanded text formatter.
Exact long history may still need many pages. The top-level `paused`
reflects current communication safety; page bodies remain frozen across restart, lost output and
subsequent mail archival.
Only the preceding page is acknowledged. Retrying without a receipt replays pending output.
Reusing an already acknowledged receipt replays the pending batch with a warning rather than
consuming unseen output. After reading it, pass the receipt returned in that batch to advance.
Replay warnings explain that `more` describes the original package rather than the current backlog;
acknowledging that batch reveals later arrivals. A rejected receipt leaves checkpoint cursors
unchanged and unseen messages unread. Run without a receipt to recover the pending batch, read
it completely, then pass its returned receipt.

If Telegram is unreachable, checkpoints continue with local and cached records. The response
includes `telegramFresh: false`, a sanitized `telegramRefreshError`, and a coverage warning.
The frozen package retains that warning on replay, later pages, its final receipt and manifest.
New writers store it in the existing version-1 page payload so the strict ae53f97 receiver
can still validate the envelope and its hash. Already retained packages with the warning in
the envelope are not rewritten; finish those with a compatible reader under the normal
receipt sequence. This source change does not migrate live packages or restart receivers.
The old reader preserves payload metadata but does not display that warning on its final
receipt or manifest; current readers do. Parse/hash compatibility does not imply identical
warning presentation or native notice acceptance.
For a rejected receipt, the manifest's `position` shows the current page/final position and
`receiptSha256`, the SHA-256 of the canonical JSON receipt string, never the usable receipt.
Compare that fingerprint with the retained output and command before
retrying; the manifest does not replace reading the page or authorize a cursor reset.
If another poll holds the Telegram lock, local commands wait about one second for it before
using recorded state and reporting an incomplete refresh. A command acquiring the lock may still
wait for its own bounded Telegram request.
Request failures produce one local Room notice per failure episode, including access and TLS
failures, and a successful refresh produces a recovery notice. These notices contain sanitized
reasons, never credentials, and obey the recorded halt. A busy poll is not reported as a failure
episode. A halt still in flight beyond the short wait cannot yet be enforced locally.
Continue passing receipts normally. A quiet result covers the local cache only; unseen remote
updates remain pending and are fetched at the next ordinary checkpoint after recovery. Local
sends also continue with a warning, but an already recorded halt stays in force until the user
clears it. Invalid local state or configuration still refuses rather than bypassing validation.
New packages carrying outage provenance require this version to read them. Settle outstanding
packages before switching back to an older reader; never delete a package to bypass validation.

Existing checkpoint state requires an operator-approved offline migration before this protocol
is activated. Close all Summon windows, external sessions and receivers. From the validated
checkout, use `bun scripts/migrate-checkpoints.ts --offline --preflight`, then `--offline --apply`.
Preflight refuses active or unverifiable owners, linked runtime paths and unsettled old batches.
Retained receiver and session IDs are checked against Windows process creation times. A live PID
is disregarded only when its current process demonstrably started after the owner record was written.
When Bun's PID probe is uncertain, a successful exact-PID CIM lookup may prove the process absent,
but only after a matching live diagnostic process supplies a positive control. Failed lookups,
missing or mismatched controls and unavailable creation times for a present process still refuse
migration. The error names the metadata path and PID.
Do not stop an unrelated process or delete historical runtime records to bypass a refusal.
The fully empty terminal receipt proves the last scan ended even if the preceding saved pagination
pointers remain. Migration retains that receipt without advancing source cursors. Any nonempty or
incomplete pending batch still refuses, with its owner named for recovery.
Read those batches with the current release before shutdown; never delete them to bypass the check.
Migration preserves source cursors, mail read/confirmation markers, requests and hold decisions.
It retains the settled empty receipt and unchanged seen holds, and writes a recoverable plan under
`runtime/checkpoint-migrations/`. Interrupted application can be retried while still offline;
the script accepts already converted owners. Its before/after plan supports an exact rollback
before any new-protocol reads. No live conversion, automatic shutdown or provider permission change
is performed. After activation, restart the Team Window and all four providers' named sessions
to load the new startup instructions; resident Claude MCP servers also need Stop/Resume.
An explicitly selected hibernated Grok owner may be left on its old state using
`--defer-owner <name>` on both preflight and apply. The script still requires every Summon process
offline, rejects invalid legacy state and rechecks the deferred owner's hibernation and exact state
before and after conversion. It never reads that owner's holds or changes its batch, cursors,
read markers or registration. The retained plan names the deferral. Before that owner uses the new
checkpoint protocol, the operator must arrange a complete own-batch drain with the retained old
release and a later offline conversion. Do not discard the old release or unhibernate an owner
merely to perform the initial cutover. Deferral does not grant launch or migration authority.
Checkpoints omit repeated own-message text; explicit room reads retain full text. Room notices
wait for 30 seconds of quiet, with a two-minute ceiling. Human messages, explicit mentions and
replies to the owner can refresh an outstanding wake after that delay. Routine peer room traffic
does not wake teammates unless the operator selects them with
`summon --room wake-policy set <registration>...`. This per-team setting applies to local Room
and Telegram notices and their response inventory. `show` reads it without changing startup
instructions; `clear` restores addressed traffic only. New teams have no routine recipients.
Selection grants notices, without changing roles, approvals, rest or hibernation safeguards.
Quoted peer mentions do not count as addresses.
Outstanding room wakes coalesce further arrivals; mechanical mail receipts do not wake agents.
These changes take effect in receivers after their sessions restart; previously queued
provider notices cannot be withdrawn by summon.

In the Team Room composer, Enter sends and Shift+Enter inserts a newline.
Paste a screenshot or image into the composer (or use Alt+V) to preview it before sending; Remove Image clears
the attachment. A message can contain an image alone or an image with text. Images stay local,
persist with room history, and agents receive a local image path to inspect. Images are limited
to 8 MiB after PNG conversion, 8192 pixels per side and 32 megapixels. Message text and the
composer use a monospace font.
