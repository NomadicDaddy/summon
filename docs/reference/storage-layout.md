# Repository and team storage

The repository contains Summon's implementation. The team store contains the people, work and
conversation that implementation manages. Rebuilding or reinstalling the application does not
reconstruct a lost team store.

## Default-team subfolder

The current layout selects `~/.summon/team-default` for the ordinary default team and hides its
name in the window. Named teams remain siblings such as `~/.summon/team-testing`.
`SUMMON_TEAMS_HOME` sets the teams base; `SUMMON_HOME` selects an exact store. A standalone custom
store keeps that root. Selecting named teams from it requires an explicit teams base.

The base marker `.team-layout.json` is version 1, with `defaultTeam: "team-default"` and a
`state` of `pending` or `ready`. Fresh installations create the default directory and marker
under a lock. Startup refuses an unmarked existing default directory, old default-team files at
the base, an unsupported/pending marker, links, or a missing marked default directory. Read-only
CLI routes check the layout too. No startup path moves, merges, deletes or repairs existing data.
The marker fences new readers; an old executable does not understand it and must be retired
before the move. A selected standalone custom store does not silently acquire a parent layout.

An existing Team Window bundle must declare the same storage launch layout as its CLI. A stale
or missing build stamp refuses before Electron receives the new argument order. Rebuild the
bundle from the compatible checkout with `bun run build:team` before opening it. The command
does not replace an already running window or grant permission to close one.

| Old default location                                                             | New default location                          |
| -------------------------------------------------------------------------------- | --------------------------------------------- |
| Base member JSON, PNG and Markdown files                                         | Same filenames under `Base/team-default`      |
| Team-local mail, Room, Board, runtime, schedules, scratch, archives and settings | Same complete trees under `Base/team-default` |
| `Base/notepad/note.md`                                                           | `Base/team-default/notepad/note.md`           |
| Named `Base/team-*` stores and global `Base/maintenance`                         | Unchanged                                     |

This is the folder-only change approved in Room #16358. Member notes remain beside registrations,
and the operator pad remains `notepad/note.md`. Grouping notes and renaming the pad remain deferred.
The current registration validator already reserves `operator`; that is distinct from this
historical folder-migration scope. Provider credentials/conversation stores, repositories and worktrees do not
move. Unknown remnants remain unclassified until the operator's exact plan resolves them.

### Manual cutover and recovery

These are requirements for a separately approved operator plan, not permission or commands to run
against an existing store. This release supplies no automatic migration or resumable move tool.

1. Freeze an exact source/destination list, build pins and protected backup destination. Classify
   unknowns, destination collisions, links and hardlinks before proceeding. Preserve named teams
   and global maintenance. Do not copy every base entry into its own child.
2. Have owners report active absolute paths in their own notes, schedules, skills, working
   directories and external provider references. Approve exact repairs or stop. Historical
   messages and schedule run snapshots keep their original bytes. No blanket prefix replacement
   or scan of another member's private files is part of this source change.
3. Approve timing, shutdown and the source switch as one offline cutover. Where the global CLI
   links to the main checkout, a main merge immediately changes later CLI calls: it is adoption,
   even if the window has not restarted. Keep that checkout unchanged until the verified move
   below. Save drafts, settle genuine read receipts normally,
   close every affected window/session/receiver, prove their owned processes offline, and retire
   incompatible launch entrypoints. Do not invent acknowledgements or release holds to get quiet.
4. Back up the complete affected data, including Electron userData, frozen packages, read markers,
   approvals and delivery uncertainty, outside the moving trees. Verify bytes and permissions and
   rehearse a disposable restore. An unchecked copy is insufficient.
5. Mark the base `pending`, copy only the approved entries to `team-default`, verify bytes and
   permissions, and apply only the approved reference repairs. Retain the original dataset in
   the protected rollback location before removing its old active paths. A failed or interrupted
   copy stays closed for completion or restoration under that exact operator plan.
6. Verify no active legacy default data remains at the base. While readers remain closed, perform
   the approved exact main/source switch, install its matching window bundle and updater, and
   repair only the approved active root/base references. Verify these entrypoints before recording
   the version-1 `ready` marker and reopening the compatible window and resident receivers with
   new launch identities under the cutover's approval. Check notes, drafts, transport continuity
   and Claude, Codex, Grok and Kilo separately; an unavailable provider is an explicit gap, not a
   pass.

Before new readers write, failure restores the complete verified old dataset, old marker state
and matching application entrypoints while offline. After new writes, preserve both datasets
and obtain a new recovery decision; do not overwrite them with the old backup. The updated
standing updater checks the target package's `summonStorageLayout` before journaling or changing
the checkout. It refuses a new-layout target over legacy/unmarked existing default data, and
refuses a build that cannot read an already moved layout. Old updater bundles and
installer downgrade launchers cannot enforce that new check: replace/retire them in the approved
cutover. A source merge through a linked live entrypoint therefore requires that same offline
approval; a main-only go-ahead is insufficient. A marker or fixture pass grants no restart,
deletion or #13862 permission.

### Fresh initialization refusal and recovery

Two simultaneous first starts can encounter a pending marker while the initializer holds its
lock. Let that initializer finish, then invoke the command again; startup does not run an
automatic retry or recovery loop. A crash between its pending and ready writes remains refused.

For a verified brand-new installation only, an operator may approve a manual reset after all
readers are closed and the initializer's lock has settled. Preserve a copy of the exact marker
first. Check that the base has only the regular single-link version-1 pending marker and an
absent or empty, ordinary `team-default` directory; no named teams, maintenance, registrations, hidden data or
unknown entries may remain. Under that exact approval, remove only the empty directory and
pending marker, without recursion or force, then initialize again. Never delete a lock or infer
that pending data came from a fresh install. Anything else requires the full move/restore plan.
The interruption fixture proves refusal preserves bytes until its explicit empty-fixture reset;
it is not a live reset command or permission.

Storage paths must have ordinary directory ancestors. Redirected profiles and operating-system
links such as `/home` or `/tmp` can therefore be refused. Configure an ordinary canonical path
for the selected store and, when used, its explicit teams base before initialization; do not
remove an operating-system link or weaken the path checks. This limitation is separate from
migration.

## Historical storage inventory

This inventory was checked on October 6, 2026 against source `c7ba3a3`, the repository's top-level
entries and the default store's top-level metadata. Public registration fields were checked with
the production loader, using Morgan's known registration as a positive control. No other member's
notes, mailbox, runtime or private scratch contents were inspected. This is an audit, not a cleanup
plan: nothing in the live store was moved or deleted, and age or an unfamiliar name does not prove
that data is disposable.

## Repository root

The repository root is the checkout directory selected by the caller. Installed copies have their
own application path; they use the same separation between application files and team data.

| Folder          | Purpose and consumers                                                                                                                                             | Preservation                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/`          | TypeScript CLI, storage and provider adapters; `src/desktop/` holds the Electron main process, bridge and renderer. The CLI and Team Window consume these files.  | Tracked implementation; preserve through Git.                                                                                   |
| `scripts/`      | Build, validation, test isolation, installer and explicit offline migration tools, invoked by package scripts or the operator.                                    | Tracked tooling; a migration script's presence does not authorize running it.                                                   |
| `test/`         | Tests and disposable fixtures consumed by the native test runner.                                                                                                 | Tracked evidence; fixtures are distinct from live team data.                                                                    |
| `templates/`    | The `AGENTS.md.template` copied to the selected team store by `initializeStore`.                                                                                  | Tracked startup instructions; edit the source rather than relying on edits to the installed copy.                               |
| `skills/`       | Bundled Summon communication and coordination workflows included in startup instructions and distributions.                                                       | Tracked instructions, not session state.                                                                                        |
| `gallery/`      | Starter definitions and PNG avatars read by the Add teammate dialog; a chosen avatar is copied to the new member.                                                 | Tracked product assets.                                                                                                         |
| `gallery-src/`  | Editable SVG originals and their drawing guide.                                                                                                                   | Tracked design sources; excluded from the npm package's file list.                                                              |
| `docs/`         | Human guidance, including claims and Team Board workflows.                                                                                                        | Tracked documentation; npm's explicit package list includes selected guides, while the installer copies the directory.          |
| `installer/`    | Inno Setup definition and installer artwork used by `build:installer`.                                                                                            | Tracked packaging sources; preserve separately from generated installers.                                                       |
| `.githooks/`    | Static and staged-content checks used by local commit/push hooks.                                                                                                 | Tracked gates; hook setup is explicit.                                                                                          |
| `.github/`      | CI workflow.                                                                                                                                                      | Tracked automation.                                                                                                             |
| `.aidd/`        | Local project specifications, feature records and review evidence.                                                                                                | Ignored by this repository. Preserve needed records separately; Git does not back them up.                                      |
| `node_modules/` | Bun-installed dependencies, including native Electron and PTY components.                                                                                         | Generated and ignored. Reinstallation depends on available packages and runtimes; it does not restore team data.                |
| `dist/`         | Generated Team Window bundles and installer/toolchain output. `build:team` replaces its own `dist/team` output; installer builds use distinct output directories. | Generated and ignored. Preserve an exact tested artifact and its build identity when needed for acceptance or release evidence. |
| `.git/`         | Local history, branches, index and worktree administration. An auxiliary checkout uses a `.git` pointer file instead of this directory.                           | Repository administration, not a cache to remove during application cleanup.                                                    |

The root `package.json`, `bun.lock`, toolchain configuration, licence and notice files define the
build and distribution. `README.md`, `docs/CHANGELOG.md`, `CONTEXT.md` and policy documents are
tracked human records. Project planning lives in local `.aidd/features/` and `.aidd/roadmap.json`;
the removed root TODO/FUTURE source text and its clause mapping remain in the local migration
ledger and target feature notes. Local `AGENTS.md` and `*.tsbuildinfo` are ignored; the latter
is TypeScript build bookkeeping. Ignored files can still be copied by external backups.

## Selected team store

`storageRoot()` uses `SUMMON_HOME`, otherwise `team-default` under the teams base
(`SUMMON_TEAMS_HOME`, or the user's `.summon` directory). On Windows the base defaults to
`%USERPROFILE%/.summon`. `summon --team <team-name>` selects a separate `team-<name>`
directory under the configured teams base. Its registrations, room, settings and other state belong
to that team; these directories are not copies of the default team.

| Folder                      | Writers and readers                                                                                                                                              | What deletion would lose                                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mailboxes/`                | Mail send/read/confirmation/acknowledgement commands and receivers. Each owner has an inbox, archive and handling/approval state.                                | Durable requests, replies, read coverage and holds. Fully read receipt-kind mail archives automatically unless an approval hold is pending; other mail needs handling and acknowledgement. Never inspect another member's mailbox for cleanup.  |
| `attention/`                | `holdMessage` writes hold-ID references; operator attention commands resolve them to the owner's hold.                                                           | Approval discovery references. The decision and proposal also belong to mailbox state; deleting references is not an approval or a resolved request.                                                                                            |
| `board/`                    | Board commands/UI maintain `state.json`; history rotation retains older changes under `history/`.                                                                | Cards, ownership, evidence and human decision history. The archives remain part of history, not expendable overflow.                                                                                                                            |
| `diary/`                    | Diary commands/UI read and append the retained work record.                                                                                                      | Work and handoff history, including its room/card references. Re-importing may duplicate entries.                                                                                                                                               |
| `room/`                     | Local room commands/UI write events and images; rotation archives earlier conversation for the history reader.                                                   | Conversation, reply/approval context and image attachments. Current events alone do not reconstruct archived history.                                                                                                                           |
| `communications/`           | Operator or authenticated communication controls maintain the halt/proceed state; send gates read it.                                                            | The shared communication safety decision. Absence defaults to unpaused in current source, so deleting it changes behavior.                                                                                                                      |
| `integrations/`             | Telegram configuration and transport code maintain connection configuration, update cursors, history, mirror state and failure-notice episodes.                  | Connection settings and delivery/recovery evidence; deleting cursors can change replay behavior. Treat this directory as sensitive. Its contents were not inspected for this audit.                                                             |
| `settings/`                 | The operator changes `claude-delivery.json`, `operator-identity.json` and `room-wake.json`; Claude launch policy, identity display and wake selection read them. | Durable team policy: the delivery choice, operator display/alias identity and routine Room wake recipients. A missing `claude-delivery.json` means live mode for an existing team; deleting it can restore Claude's development-channel prompt. |
| `claims/`                   | Explicit publication writes claim documents; the checker records predicate results and notifies disputed claims.                                                 | Published contracts and their check evidence. A matching predicate is not proof that a recurring duty was performed.                                                                                                                            |
| `schedules/`                | Schedule commands/UI and dispatch maintain definitions and run outcomes in `state.json`.                                                                         | Durable due work, dispatch uncertainty and completion history. Removing it is not equivalent to pausing a schedule.                                                                                                                             |
| `notepad/`                  | The operator's Team Window reads and saves `note.md` with a revision check.                                                                                      | The human's saved note. Its unsaved recovery draft is separately held in the window's local storage.                                                                                                                                            |
| `runtime/`                  | Session/receiver, checkpoint, activity, rest, head-down, wake and window code maintain per-member and Team Window state.                                         | A mixture of live locks, durable cursors, frozen checkpoint packages, uncertain delivery evidence, model history, saved UI choices and unsaved drafts. It is **not** wholly disposable. See below.                                              |
| `scratch/`                  | Startup creates shared scratch; each member keeps work under its own folder and publishes handoffs under `shared/`.                                              | Working records and prepared recovery/handoff artifacts. “Scratch” describes its purpose, not permission to erase it. Project deliverables belong in their project.                                                                             |
| `team-demo/`, `team-first/` | Observed named-team directories; their source-defined consumers use the same store layout.                                                                       | Independent team state. Their contents and activity were not inspected; their names do not establish that they are disposable.                                                                                                                  |
| `operator/`                 | Present in the top-level snapshot; no storage-path writer/reader was identified in the checked current `src/` and `scripts/`.                                    | Unknown from this bounded audit. Contents and provenance were not inspected, so preserve it pending an operator decision.                                                                                                                       |

Two source-defined folders were not present in the default store's top-level snapshot:

- `archives/` is created by an explicit **Archive teammate** action. It preserves the selected
  registration, notes, avatar, mailbox and claims before removal; it does not preserve runtime
  locks as restorable state. This is a member archive, separate from room, Board and mail archives.
- `logs/runtime-faults/` is created when the updated Team Window first successfully retains a
  diagnostic. Four bounded segments retain occurrences; the reader groups repeats. Its absence
  before capture does not prove that earlier errors never happened.

Two more source-defined folders postdate that snapshot. `audit/` holds the append-only
`registration-text.jsonl` journal of expertise/domain edit intents and outcomes, read by
`summon --registration audit`. `registration-proposals/` holds write-once, content-addressed
copies of long field texts a PM's approval request quotes by hash and excerpt; the file's name is
the sha256 of its bytes, and the decision check requires the posted question byte for byte.

Compaction collectors introduced in 0.19.0 create `compactions/<slug>/` on the first retained
observation. Each immutable JSON record contains only provider/source, phase, first observation
time, available native time, first observing launch nonce, the event's deduplication basis
(native id or metadata fingerprint) and hashed event identity. The
`--compactions` reader is scoped to the named member; the operator names a member explicitly.
These records survive observer exit and are not rotated, evicted or included in member archival.
Deleting them loses after-the-fact observations and permits a resumed Codex backfill to be counted
again. Missing records do not establish absence of native compaction. No conversation bodies,
summaries, raw conversation identifiers or credentials belong in this directory.

The lifecycle history addition creates `logs/session-history.json` when an owning Team Window
first records a start or stop. `summon --session-history` reads its bounded, atomic journal of up
to 2,000 transitions (2 MiB), with read limits and older-page cursors. Launch nonces pair subsequent
owned sessions when known. It contains no terminal input or mail bodies and cannot reconstruct
events from before activation. Named members have a reader, not a lifecycle write endpoint.

Atomic writes and locks can also create short-lived pending/lock files. A leftover filename or PID
does not establish that its owner is dead. Offline migration checks include Windows process
creation-time identity; do not remove runtime evidence to bypass a refusal.

### Member files and shared instructions

| Root file                  | Purpose and consumers                                                                                                                                                                                                                       | Preservation                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<slug>.json`              | Canonical registration loaded by the CLI/roster: provider, working folder, expertise/domain, bindings and operator-granted controls.                                                                                                        | Durable identity. Creation and removal through Summon are operator-only; direct filesystem permissions remain a separate boundary.                              |
| `<slug>.md`                | Complete active notes included in startup prompts, limited to 16 KiB of UTF-8 text. Current registered launches edit or create their own notes through revision-checked `--notes` commands; profiles and note append paths also consume it. | Personal continuity. Preserve longer history in the owner's scratch archive; oversized files require compaction before launch. A missing notes file is allowed. |
| `<slug>.png`               | Optional avatar loaded by the roster, with an initials fallback.                                                                                                                                                                            | User/product artwork; lack of an avatar is not a broken registration.                                                                                           |
| `AGENTS.md`                | Installed instruction copy, synchronized from `templates/AGENTS.md.template` by normal CLI initialization.                                                                                                                                  | Regenerated instructions; local changes can be replaced by initialization.                                                                                      |
| `team-rules.md`            | Maintainer-curated directives read into provider startup prompts.                                                                                                                                                                           | Durable team policy. Submit changes to its maintainer rather than treating it as generated content.                                                             |
| `team-rules-provenance.md` | Sources and earned corrections matched to numbered team rules; validated at startup but omitted from provider prompts.                                                                                                                      | Durable policy evidence. Maintain it with the matching rules and validate the completed pair before launching.                                                  |

The snapshot contained 16 canonical, schema-valid registration files. Both `roger.json` (Codex)
and `roger.kilo.json` (Kilo) load as registrations and use the display name Roger. Dots are valid in
slugs: the latter is **not ignored as a backup**. They are two distinct registry identities and
explain two Roger domain entries in startup context. Whether the second should be retained or
retired needs its provenance and the operator's decision; this audit made no change.

Some registrations have no adjacent notes or avatar, which source explicitly tolerates. The
top-level file `Clipboard Text.txt` has no identified current source consumer. It was not opened,
and neither its contents nor its value are established by its name. No stale/orphan declaration
or deletion recommendation follows from these metadata observations.

### Why runtime data needs care

`runtime/<slug>/` includes receiver ownership, session locks/bindings/readiness, activity and rest
confirmations, checkpoint cursors and packages, wake delivery/error records, and model history.
These files have different lifetimes. Erasing them together can drop delivered-but-unread batches,
hide uncertain delivery or remove the evidence needed to distinguish a reused PID from its owner.

`grok-hook-lease.json` records this member's generated Grok hook ownership: session-lock nonce,
launch nonce, Grok home, storage root, content hash and publication phase. The next locked
session may remove only its recorded, unchanged hook after the previous runner and provider are
gone. Other owners, user edits and unrecorded hooks are preserved. A prepared record with an existing hook cannot
prove publication completed and requires inspection; deleting the record loses recovery evidence.
It contains no conversation text. Existing hooks from before ownership recording are not migrated
or swept automatically.

A moved lease retains the root used in its hook filename. For older leases without that field,
default-team recovery checks the current root and the former teams base, and removes a file only
when its exact recorded hash still matches. It does not search or delete unrecorded hooks. The
hook entry checks the storage layout and current session-lock/lease ownership before writing;
a resumed Grok conversation ID alone cannot authorize an obsolete launch. Missing turn state
does not create a runtime directory. Hook files targeting another checkout still execute that
checkout's code and require separate inspection or operator-approved retirement.

The `response-watchdog.json` record retains one current-launch response episode, exact source
targets, delivery outcome references, package-page progress and dismissal. Its five-minute
waiting state and ten-minute alert measure missing read coverage, not task completion or a
crashed provider. Rest, hibernation, head-down and communication pauses suspend observation.
Corrupt timing restarts the window with a diagnostic; deleting this file loses alert identity
and dismissal. It contains no prompt bodies and never authorizes input retry. Own mail status
exposes the record; the Team Window offers delivery detail and dismissal separately from
approvals. Dismissed alerts leave the sidebar; their diagnostic record remains in own mail
status. An alert tracks the targets that raised it, so newer work can begin its own episode
after those targets are satisfied. Explicitly archiving pending mail retires its watch without
creating read coverage. Unreadable watch state reports observation unavailable while the rest of
the member snapshot and mail status remain usable.

`response-watchdog-relay.json` journals one observed alert episode and its mail publication IDs,
exact diagnostic text and per-recipient progress. Recipients are registered `memberType: pm`
accounts selected when the alert is first relayed; their role is checked again before sending.
Each receives one alert and one resolution through ordinary mail, including while offline.
Each recipient has distinct message IDs so their read receipts remain distinct as well.
Read receipts and confirmations are transport state, not outstanding watchdog work.
Removing the PM role prevents further delivery. Newly added PMs join the next episode; if none
existed, an ongoing alert waits for a PM registration. PM owners themselves remain operator-visible
only, avoiding recursive alert mail. Dismissal does not clear an episode. Communication halt defers
publication, and a replaced launch is reported as ended, not read. Resolution requires a later
owner evaluator tick; a stopped receiver cannot report it until observation resumes.
Owner observation suspension also defers a pending resolution, including after launch replacement.
The observation state retains the last verified retired episode ID. A missing or damaged observation
file cannot prove retirement: the relay reports lost continuity, not a successful resolution.
An episode that ends before its alert was ever published sends neither stale alert nor clear.

The journal contains no monitored message bodies. Replay compares the saved publication with
inbox and archive content to survive a crash after publication, even if the PM already archived it.
Diagnostic mail identifies its episode, without the launch nonce retained privately in the journal.
On rollback to `37c9fdb` (0.21.4 before the relay), its strict observation schema rejects the new
`retiredEpisodeId` field. Its next evaluator tick restarts observation with a `state-reset`
diagnostic and fresh timing; unread work remains pending. A direct status read before that tick
reports observation unavailable. Later ticks retain the new episode normally. This is a one-time
loss of diagnostic timing and dismissal, not read confirmation or a reason to delete state.
The older build does not send relay updates; preserve the relay journal for later re-adoption.
Deleting the journal or its published mail loses that deduplication evidence. This relay never
retries provider input, starts a PM, releases approval or grants process-control authority.

A malformed, oversized or wrong-owner relay journal fails closed and remains intact; later ticks
do not repair or replace it. For recovery, the operator must first stop that owner's receiver under
separate shutdown authority, retain a protected copy of the exact journal, and have the maintainer
reconcile its publication IDs against the intended recipients' own reported mail evidence. Restore
the verified journal before restarting. If it cannot be reconstructed, the operator may explicitly
authorize quarantining that owner's file to a unique backup name and beginning a new observation;
this loses deduplication and may repeat an earlier alert. Never infer a clear from that recovery,
delete recipient mail, inspect another owner's private mailbox, or bypass shutdown approval.

Watchdog persistence failures use `response-watchdog-errors.json` as a pointer to the latest
episode under `response-watchdog-errors/<id>.json`. Episodes retain owner, observed launch and
failure/recovery times, never raw errors or message bodies. Earlier episodes remain in that
directory. These diagnostics do not add stages to `wake-errors.json`: the prior release can
continue reading its own error index while leaving watchdog records untouched during rollback.
Mail status exposes the latest failure and recovery; unreadable diagnostic files remain intact
and do not prevent ordinary mail status. Fresh launch nonces are required across version changes.

Hibernation delivery keeps each launch's revision marker and a name-level
`hibernation-last-control` value (`active` or `inactive`) under the same control lock. This records
the last attempted control, not merely the latest operator decision. It preserves an owed release
across transitions the session never heard, and prevents completed releases from replaying.
Uncertain attempts remain covered; definite pre-send failures restore the prior markers. Existing
revision-only history is interpreted conservatively until the last-control record is established.
Do not delete these records as a way to retry uncertain provider input.

Claude's native completion observer adds a launch-specific `.claude-turn` metadata record and
`.claude-mod/` generated plugin directory. They contain identifiers, ordering, draft/turn state and
the shipped observer source, without prompts, answers or tool bodies. The authenticated loopback
bridge's temporary bearer stays in memory/environment and is never written to these files. Closing
the owned launch invalidates its observation; retaining these files does not prove a live observer.

Launch-specific `.claude-model` and `.kilo-model` records hold observed model/context-capacity
metadata. Readers check the current launch and exact session; Kilo also matches the saved model.
These are capacity token counts, not usage, cost, prompts or replies. Claude records its observer
epoch so a replacement attachment cannot inherit the old observation.

`runtime/team-window/` is Electron's `userData` directory as well as Summon's window state. It
holds preferences, macros and mention progress alongside Electron storage and caches. The
operator notepad's unsaved recovery draft and last-seen markers use local storage here. The launch
wrapper also retains the five newest matching launch log files. Those logs are bounded evidence,
not a complete history of all banners or provider output. Deleting this directory wholesale loses
more than a cache.

The launch-phase publisher added in 0.14.0 refreshes `runtime/team-window/launch-status.json`.
This bounded public snapshot is consumed by `summon --launch-status`; it exposes only active
owned phases, their member/provider and observation times. The reader verifies the window process
identity and refuses stale evidence. It is distinct from private per-member runtime records and
contains no tasks, domains, mail or provider session IDs. Its absence is reported as unavailable,
without authorizing cleanup or implying that no member is launching.

**Archive teammate** and **Delete teammate** are explicit, guarded operations in `remove.ts`.
They check the session lock and redirected paths, retain the registration until cleanup succeeds,
pause that owner's schedules while retaining run history, and clear cover/delegation references.
An archive saves selected durable artifacts before removal; it is not a complete backup of every
room, Board, Diary or provider conversation. The audit does not invoke either operation.

## Historical audit impact and verification limits

The October 6 audit changed no writers, permissions, storage paths, retention, provider launch or
notification behavior. Claude, Codex, Grok and Kilo all use the selected team store. Their
provider-managed conversation and account locations are not inventoried here. No native provider
acceptance is claimed from that audit. The default-team source change and its separately approved
cutover requirements are described above; no live move or restart is authorized here.

The checked source includes `store.ts`, `init.ts`, `team-storage.ts`, `remove.ts`, `mailbox.ts`,
`mail-attention.ts`, `board.ts`/`board-history.ts`, `diary.ts`, room storage/image code,
`communication-state.ts`, Telegram storage paths, `claude-delivery.ts`, `claims.ts`, `schedules.ts`,
`notepad.ts`, session/checkpoint/wake paths, `team-settings.ts`, `team-window.ts` and build/package
definitions. Top-level metadata plus the production registration loader establish the observations
above; they do not establish private folder contents, complete backup coverage or safe deletion.
