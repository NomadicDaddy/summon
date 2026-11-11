# Changelog

Notable changes to summon are recorded here using Keep a Changelog categories and semantic versions.

## [Unreleased]

### Added

- Running Kilo seats can show a timestamped provider-limit observation in the Team roster when the
  exact launch's completed session reports a validated zai-coding-plan HTTP 429 with code 1310. A
  later completed error-free result with stop, tool-calls or length finish clears it; unreadable
  observation is labelled. The diagnostic does not change process presence or turn state and takes
  no automatic provider action.
- Senders can check whether their own mail has a recorded complete read and when it occurred, without
  opening the recipient's mailbox. New complete reads no longer create a separate receipt message;
  pre-projection mail retains a retryable receipt path for interrupted legacy reads.

### Changed

- Corrected the manual's guidance on automatic receipt archival, optional head-down approval, and
  configurable interruption holds.
- Updated development dependency tooling to the approved fleet versions of Knip and typescript-eslint.
- Checkpoint output explains an incomplete Telegram refresh in detail on the first page, then uses
  a shorter cached-only warning on later pages and the final receipt. Every page retains the full
  refresh reason and `telegramFresh: false`; poll contention remains distinct from request failure.
- Receivers wake on local file changes and exact deadlines, with a ten-second missed-event
  fallback and per-seat three-to-five-second Telegram polling. Deadlines crossed during a cycle
  get a prompt follow-up.
- Fully read receipt-kind mail is archived automatically after read coverage is recorded by receive,
  read-self or checkpoint unless an approval hold is pending. Its exact body remains in own history;
  held and other substantive mail retains explicit handling.
- Mail reading byte-window and index helpers now live in smaller modules with the same public exports.

### Fixed

- A seat waiting for a human decision can confirm rest while its due schedule is deferred for that
  wait. The schedule remains due, and new due schedules or unfinished runs still interrupt rest.

## [1.0.4] - Internal build, unshipped, folded into 1.1.0

### Removed

- The old GitHub Pages workflow and standalone `site/` have been removed after the Summon page
  moved to beazley.org. This source change does not switch off Pages in repository settings.

## [1.0.3] - Internal build, unshipped, folded into 1.1.0

### Changed

- Team rules may now contain up to 10,000 characters while keeping the 40-line and provenance
  checks. Valid rules above that budget still load in full with a startup warning.

## [1.0.2] - Internal build, unshipped, folded into 1.1.0

### Fixed

- Published claims now accept a Windows target that mixes short and long spellings already present
  in the owner's configured and real directory paths, after proving the candidate owner prefix
  names that same directory. Unrelated aliases, links, outside targets and private paths remain
  refused.

## [1.0.1] - Internal build, unshipped, folded into 1.1.0

### Fixed

- Startup scratch expiry now reports old hard-linked files kept for safety in one concise line.
  Complete skip paths and reasons for the latest successful run are saved in the private store
  instead of being listed in the startup output. The 30-day cutoff and deletion safeguards are
  unchanged.

## [1.0.0] - 2026-10-31

### Changed

- Team rules can use stable rule numbers with their sources in the adjacent
  `team-rules-provenance.md`. Each number needs exactly one valid source; missing, duplicate and
  orphaned entries refuse startup. Only the rules enter provider prompts or count toward the
  existing budget. Rules with inline sources remain valid while the editor splits the files.

- Numeric version-order enforcement is temporarily removed by operator decision for the public
  1.0.0 normalization. A documented lower version now establishes the source baseline and can
  pass installed-source comparison. Source identity, ancestry, dated notes, same-version behavior
  checks and bundle integrity checks remain. Restoring numeric downgrade protection is tracked
  separately for after this normalization.

### Fixed

- Windows setup explicitly selects PowerShell's machine-wide MSI through winget. A failed Summon
  PATH update no longer skips checked dependencies, and an interrupted PowerShell ZIP copy stays
  out of the final version folder so setup can retry. Setup results and next steps are scrollable;
  uninstall reports PATH and interrupted-file cleanup failures without aborting logged removal.
- Release preflight recognizes the separately published mini-site and root privacy, security and
  support prose as documentation. Updating those files no longer requires an application version
  change. Runtime, bundled instructions and guard code retain their existing checks.
- First-use instructions now offer installer and source routes directly. Security and privacy
  guidance identifies the reviewed source candidate, the data retained during removal, provider
  metadata reads and optional network connections. The claims guide explains exact-store versus
  teams-base selection and links the offline cutover. Control guides consistently describe the
  local Room halt and failed-shutdown behavior. Mini-site setup copy follows the same requirements.
  These are documentation corrections, not new isolation guarantees or fresh native acceptance.
- Halt descriptions also name the existing Board and Diary write refusals. The Team Window
  reference identifies the footer's build ID alongside its version, revision and time.
- Human Enter and line breaks inside typed or pasted text cancel a pending Claude terminal
  notice release for the launch captured by that pane's receiver. A missing or malformed activity
  record cannot skip that submission for a captured pane. Only the current receiver can release
  its own withheld Enter; a retired receiver retains its reservation. Grok and Kilo submission
  behavior is unchanged. An uncaptured pane can still report a malformed-activity error.
- The claims guide now names the default store's real location for shared rules and published
  claims, `~/.summon/team-default/`, instead of the pre-0.31 flat `~/.summon` paths that stopped
  being read after the default team moved into its own folder. Following the corrected paths
  publishes files where the application actually reads them.
- The storage guide no longer says `storageRoot()` falls back to the user's `.summon` directory;
  the unconfigured default resolves to `team-default` under the teams base (`SUMMON_TEAMS_HOME`,
  otherwise the user's `.summon` directory), which is what its own default-team section already
  described.
- The storage guide's `settings/` inventory now covers all three operator-written files,
  `claude-delivery.json`, `operator-identity.json` and `room-wake.json`, and says what deleting
  each loses, instead of naming only the Claude delivery choice.
- The storage guide now lists the `audit/` and `registration-proposals/` store folders added on
  2026-10-15, alongside the other source-defined folders, and includes the `deduplication` field
  that every retained compaction record carries.
- The board guide now says a search matches a blocker by its recorded reason as well as by the
  name the card shows, matching what the board's search actually reads.
- The delivery guide now distinguishes an unsent outcome's retry delay from the Room and Telegram
  quiet windows and provider gates that can postpone its next attempt. It no longer promises an
  exact 2/5/15/60-second delivery cadence across every source. Retry behavior is unchanged.
- A Grok seat now reports the current launch's native turn hold instead of leaving an older
  delivery status visible. The report does not release the native turn or a human draft.
- A Codex seat drops a cached busy label once the work that caused it has been consumed. Empty
  receiver cycles still avoid native-daemon polling; fresh work checks the gate again.
- Claude terminal notices release their own reservation when Summon proves it withheld Enter
  after pasting. Native draft and human-input holds remain; only ordered native text-then-empty
  reports with no newer human input clear Summon's own paste mark. The uncertain notice is not retried.
- A Claude live-channel seat now reports its current native turn hold, as a terminal seat does.

### 1.0 release overview

This candidate prepares the first public release of the current Summon. The unpublished internal
1.0 development iterations are consolidated into this public 1.0.0 entry.
Final installer packaging and clean-host acceptance remain pending; this entry does not announce
publication. The 0.x entries below record development history. The earlier public prototype has no
supported upgrade path to this application.

- Open named Claude Code, Codex, Grok Build and Kilo sessions in the Team Window, with saved
  conversations, individual working directories and terminal panes. Provider CLIs, accounts,
  authentication and model access remain separate requirements.
- Coordinate work through the persistent Team Room, durable agent mail, replies, read receipts
  and an optional PM. Read and handled mail are separate states. Current-request views and
  receipt-bound checkpoint pages keep later arrivals separate from the batch being read.
- Keep registrations, notes, mail, approvals and schedules in a selected team store. The default
  store is `~/.summon/team-default`; named teams have their own roots. Board cards, macros and
  owner-managed schedules support ongoing work without turning a role label into permission.
- Use the persistent Notepad for plain text, Markdown preview, task checkboxes and Find. Revision
  checks preserve conflicting drafts. The Diary records attributed work with linked detail, and
  the Repos panel shows local changes and history without invoking repository-configured programs.
- Choose light or dark presentation, navigate teammates and message references by keyboard, and
  keep separately scoped account, model and reasoning settings. Observed provider state and
  registered preferences remain distinct.
- Use confirmation and ownership checks for session Stop and delegated rest-stop operations.
  Unknown provider turn state keeps confirmation or refusal in place; it does not count as idle.
  Draft, pause, halt, head-down and hibernation controls have separate delivery boundaries.
- Install on Windows 11 x64 for the current user. Install Bun 1.4.3 or later and PowerShell 7.6
  or later separately, along with a supported provider CLI. The installer includes Electron
  and application libraries; offline recipients must arrange prerequisites themselves.
  Uninstall retains team data, external prerequisites and provider credentials. Clean-host acceptance
  of the final installer remains pending the selected candidate.
- An explicitly configured standing updater checks local release source and preserves rollback
  information. It does not grant publication, automatic provider restarts or permission to resume
  uncertain delivery attempts.

### Configuration, migration and dependencies

- The earlier public prototype has no supported upgrade path. Development stores that predate
  the separate default-team folder follow the documented cutover; the current default is
  `~/.summon/team-default`. Team selection, provider account directories and external prerequisites
  must remain aligned with the installation being used.
- The Windows application requires Bun 1.4.3 or later and PowerShell 7.6 or later. The installer
  includes Electron 44.9.1 and application libraries with their notice material. Provider CLIs,
  accounts and model access are separate prerequisites. TypeScript remains pinned to 6.0.3 for
  development.
- The 0.x development history below retains the dependency updates, advisory fixes, configuration
  changes and breaking development migrations included since the older prototype. Its historical
  evidence does not establish final-installer or native-provider acceptance.

### Security boundaries

- Tool discovery uses qualified executable paths; repository inspection suppresses configured
  executable hooks, filters and programs. The Window accepts its privileged operations through
  trusted IPC and treats message text as data.
- New POSIX team and private configuration paths use restrictive permissions. Windows relies on
  the user profile's access controls. Command ownership, confirmation and launch checks remain
  application safeguards, with the shared-store and native-observation limits below.
- Summon's project license is FSL-1.1-ALv2. Third-party components retain their own licenses and
  notices. The incomplete security assessment and open licensing findings below remain visible.

### Known limitations

- **Public-site motion:** the brand mark and eyebrow decoration pulse continuously with the
  default motion preference. Reduced-motion preferences suppress them, but the page has no stop
  control. Ending these decorative pulses is deferred to 1.1.
- **Codex turn state:** this Windows setup has no functioning, measured Codex daemon path for
  busy/idle observation. Stop asks when the turn is unknown, and delegated rest-stop refuses it.
  Ordinary notices hold while a turn is measured busy; when its state is unknown, delivery falls
  back to the existing queue and coalescing rules. Unknown does not prove idle, so this fallback
  cannot guarantee busy-turn exclusion. Native busy-turn Stop and observer work remain deferred
  to 1.1. Source fixtures and a submitted notice alone do not establish automatic reading.
- **Unverified Stop that never settles:** when the terminal of a session marked **Stop unverified**
  never reports its exit, the state does not clear by itself. Stop and terminal input remain
  refused for that session, and the window refuses to close. Summon makes no second termination
  attempt. Ending the Team Window's own process from outside Summon is the only way out; that
  forced exit carries risks and does not prove that the session's process tree ended.
- **Codex unattended wake:** automatic wake after a turn is unverified and is an accepted 1.0
  limitation. In the reported incident, a waiting handoff and ping stayed unread until the
  operator explicitly told the Codex seat to continue; handling followed that instruction. The
  cause and historical loaded receiver remain unknown. Later queued turns have unresolved
  attribution. Native acceptance stays open for 1.1; this is no guarantee of unattended wake.
- **Claude stuck wake reservation:** a Claude seat can retain a wake reservation without a
  subsequent native start when submission remains uncertain. The proved pre-Enter terminal refusal
  is fixed above; an Enter write that throws, interruption after submission, a live-channel send,
  or missing native observations does not qualify for that release. These remaining cases have no
  automatic recovery in this build, and native wake acceptance remains open. Earlier run-3 evidence
  is still inconclusive. Diagnostics help record a recurrence; a missing hold reason proves no
  cause or delivery. Do not blindly retry or press Enter: the earlier input may take effect. See the
  [capture and recovery boundaries](reference/sessions-and-communication.md#claude-wake-limitation-in-10).
- **Kilo reasoning variants:** a registered variant applies to the startup turn at each launch
  and resume when the model advertises it. Later typed turns and notices use Kilo's in-memory
  choice for that model, loaded from a machine-wide saved pick. A choice saved by one seat can
  affect a seat launched later; already-running seats retain their loaded state. An in-session
  Default pick cannot reliably override a registered variant. Clearing the registered variant with
  `--variant default`
  leaves the session's stored variant or Kilo's own pick in effect; it does not guarantee the model
  default. The launch-local variant follow-up is deferred to 1.1 and depends on
  [Kilo issue 15470](https://github.com/Kilo-Org/kilocode/issues/15470).
- **Native wake evidence:** the measured wake/draft evidence is limited to Claude. That run
  demonstrated release after clearing the draft and same-turn handling of a second message;
  draft-only suppression remained inconclusive, and automatic wake after the turn was not
  demonstrated. Automatic post-turn wake, recovery controls and the remaining Codex/Kilo native
  rows are deferred to 1.1. Grok remains available with limits;
  full Grok support and acceptance are also deferred.
- **Unsigned installer:** 1.0 is planned to ship unsigned. It has no verified publisher signature
  and Windows may show an unrecognized-app warning. Signing is planned for 1.0.1; no signing
  capability is delivered by this release preparation.
- **Platforms:** Windows is the tested platform. macOS and Linux launch paths are implemented
  but untested.
- **Shared-store access:** Codex sessions receive filesystem write access to the configured
  Summon store. Command ownership checks do not provide operating-system isolation between
  teammates. Use trusted sessions.
- **LM Studio endpoints:** the configured URL can name a remote HTTP or HTTPS server. Summon
  does not restrict it to loopback. Use a trusted endpoint; plain HTTP does not encrypt prompts
  or context sent to it.
- **Schedule history:** finished runs remain in the active schedule file, and `--schedule list`
  prints the owner's full run history. Storage and output grow without a retention bound.
  This is an accepted 1.0 limit. Retention design is deferred to 1.1; unfinished runs and historical
  duty evidence must be preserved. No archive or automatic deletion is implemented.
- **Offline queue:** startup injection from `offline-queue.txt` is unimplemented and excluded
  from 1.0. Who may enqueue, which session receives a line, and how authority and replay are
  controlled remain undecided. Store text written by a teammate does not become user authority.
  Any later implementation requires a separate design decision.

The October audit review also leaves the following Medium and Low findings open for 1.1.
Shared-store access, remote LM Studio endpoints and public-site motion are described above.
The bundled-Bun licensing finding was closed after removal and verification of the retained
0.32.21 installer payload. That proof does not replace packaging checks for a later candidate.
The security assessment is incomplete.

| Area                      | Known issue                                                                                                                                                                            | Severity |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Claude mail               | The MCP mail reader rejects a continuation when both its filters and pending view are supplied.                                                                                        | Low      |
| Notepad                   | The optional Markdown preview adds about 195 KB to the initial renderer bundle.                                                                                                        | Medium   |
| Claims checks             | `checkClaim` keeps several independent predicates in one long dispatcher; simplifying it is maintainability work.                                                                      | Low      |
| Codex observations        | Compaction polling combines deeply nested framing and evidence-retention paths.                                                                                                        | Medium   |
| Provider models           | Model discovery combines four provider readers and observation precedence in one function.                                                                                             | Medium   |
| Profile editing           | `saveProfile` combines validation, cover resolution and locked persistence.                                                                                                            | Medium   |
| Roster snapshots          | `teamSnapshot` combines provider observations, failures and roster projection.                                                                                                         | Medium   |
| Board history             | Digest filenames identify idempotent archive writes; reads do not independently verify archived bytes against the filename. No live corruption was demonstrated.                       | Low      |
| Source exports            | Five module-local constants remain exported without consumers.                                                                                                                         | Low      |
| Window logs               | Launch logs have no byte bound. A successful launch keeps the newest five logs, including earlier failed launches; sustained failure-only growth remains a hardening concern.          | Low      |
| Registration history      | The small append-only edit audit has no archival policy or streaming reader. Recovery evidence must be preserved.                                                                      | Low      |
| Repository checks         | Required quality-gate enforcement on remote main remains unresolved. Local checks do not establish server-side protection.                                                             | Medium   |
| Join instructions         | The bundled teammate template still tells teammates to invoke the operator-only halt command.                                                                                          | Medium   |
| Deployment guide          | The runbook describes the removed storage guard and an outdated Room-rotation procedure.                                                                                               | Medium   |
| Claude MCP exports        | The entrypoint exports a factory that no other module consumes.                                                                                                                        | Low      |
| Installer notices         | The installer dependency closure includes `extract-zip` 1.0.5 without its required license material.                                                                                   | Medium   |
| Historical source archive | The retained 0.4.0 source archive has no stated project license. Public distribution requires its own terms and decision.                                                              | Medium   |
| Room pagination           | A sufficiently large valid group mention can stall pagination in both the Window and CLI readers.                                                                                      | Medium   |
| Scheduled dispatch        | Dispatch can accept idle activity left by a previous launch.                                                                                                                           | Medium   |
| Notes                     | An unreadable notes file can silently produce an empty startup handoff or clone.                                                                                                       | Medium   |
| Rest recovery             | Recovery can mistake a recycled PID for the original process.                                                                                                                          | Medium   |
| Shared mutation locks     | A recycled PID can prevent stale-lock recovery. Silent handling by some callers remains unverified.                                                                                    | Medium   |
| Removed registrations     | Their terminal panes can remain allocated until the Window closes.                                                                                                                     | Medium   |
| Claude bridge             | HTTP handling remains embedded in a long server-construction function.                                                                                                                 | Medium   |
| Mail reader               | Reading, byte bounds and delivery accounting share a module with little line-limit headroom.                                                                                           | Medium   |
| Maintenance setup         | Profile editing remains inside a setup coordinator near the file-size limit.                                                                                                           | Medium   |
| Registry                  | Record persistence shares a module with notes and session-history helpers.                                                                                                             | Medium   |
| Release verifier          | Version checks share a module with separable logic and little line-limit headroom.                                                                                                     | Medium   |
| Room setup                | Rendering, polling and composition remain in one large closure.                                                                                                                        | Medium   |
| Session launch            | Launch preparation remains inside a module near the file-size limit.                                                                                                                   | Medium   |
| Fault redaction           | Some credential-shaped test values and camel-case token assignments survive fault-journal redaction. No real credential disclosure was demonstrated.                                   | Medium   |
| Updater logs              | Rare maintenance attempts have no accumulated-byte policy. Logs are retained for recovery; no secret leak or current storage failure was demonstrated.                                 | Low      |
| Electron                  | Electron remains pinned to 44.9.1. The patch-currency finding is open; this review did not verify upstream patch notes. An update still needs dependency checks and native validation. | Medium   |
| Checkpoint history        | Validation is in place, but retained seen-message digests have no expiry policy.                                                                                                       | Low      |
| Archived Room history     | The live file is capped; consumers that read complete history still load all archive files.                                                                                            | Medium   |
| Dependency maintenance    | Dependency updates are not automated successfully for Bun packages and Actions.                                                                                                        | Medium   |
| Release workflow          | Tags and releases are cut manually under operator control; no automated release workflow is delivered.                                                                                 | Medium   |
| Integration checks        | Targeted DOM, IPC and help tests exist, but no general parity gate compares all these surfaces.                                                                                        | Low      |
| Launch preflight          | Provider launches do not warn about existing checkout changes.                                                                                                                         | Medium   |
| Renderer size             | The locally loaded renderer bundle is unminified and has no size gate.                                                                                                                 | Low      |
| Roster images             | Avatar reads are cached, but rows still rebuild image elements during roster refresh.                                                                                                  | Low      |
| Static checks             | Static quality steps rerun without caching. This affects development and maintenance check duration.                                                                                   | Medium   |
| Diary dependencies        | The Diary module imports Room and Board internals.                                                                                                                                     | Low      |
| Notice format             | The notice reader retains its old bare-integer parsing branch.                                                                                                                         | Low      |
| Maintenance field types   | Three helper assertions bypass select/textarea type distinctions.                                                                                                                      | Low      |

### Fixed

- The README now says what happens on Linux when no terminal launcher is found: `summon <name>`
  warns and runs the session in the current terminal, while `summon all` stops with an error and
  points to `--same-window`. Before, it said summon falls back to the current terminal in every
  case. It also states that Windows is the only tested platform, and that the macOS and Linux
  launch paths are implemented but untested. The claims guide's Bun example now shows the pinned
  1.4.3 instead of 1.4.2.

## [0.32.44] - 2026-10-30

### Fixed

- `--mail confirm` on mail that has already been acknowledged into the archive now refuses with
  what happened to it, instead of a raw inbox `ENOENT`: archived with no recorded confirmation,
  archived and already confirmed (naming that confirmation), or in neither the inbox nor the
  archive. The already-confirmed refusal names the existing confirmation; the other two explicitly
  say this command sent none. All three refuse the current confirmation and write nothing. Only the
  mailbox owner gets the archive diagnostic; who may read, confirm, acknowledge or hold mail is
  unchanged, and acknowledging still doesn't require a confirmation first.

## [0.32.43] - 2026-10-30

### Fixed

- A Claude seat whose notices are held because someone typed or pasted into its pane now says
  so in its mail status: recent input in the pane is holding notices, a backspace doesn't
  release it, and Enter, Ctrl+U, Ctrl+C or Escape twice can clear it. Before, the status kept
  whatever reason it last showed, such as an older "prompt holds a draft". It doesn't claim what
  the box contains. When notices are held and who may send them is unchanged, and Kilo seats still
  say nothing in this case.

## [0.32.42] - 2026-10-30

### Fixed

- `summon --checkpoint catch-up` no longer refuses when the Telegram refresh can't complete,
  because another session is refreshing or Telegram can't be reached. The plan now skips room
  history as before, holds the Telegram cursor where it is and skips nothing from Telegram. The
  preview says Telegram wasn't refreshed and that no remote coverage is claimed. Recorded Telegram
  messages still arrive through normal checkpoint pages. Every other catch-up check and refusal is
  unchanged.

## [0.32.41] - 2026-10-29

### Changed

- The Team Window's wake receiver no longer opens wake failure notes when it checks what earlier
  deliveries still say, which it does on every cycle. In 0.32.40 that check read up to 21 notes
  each time on the path the wake investigation is timing, though it only ever needed each
  outcome's state. `summon --mail status` still shows the failure notes. Delivery decisions are
  unchanged.

## [0.32.40] - 2026-10-29

### Changed

- When a wake notice fails to reach a seat, `summon --mail status` now says where it stopped:
  retaining the response record, marking the notice attempted, the receiver's ownership check,
  the automatic-notice gate, the send being refused, the send failing after input began, a step
  after the send went through, or another step. When the response record's lock was busy, it adds
  what a look at that lock found just afterwards and roughly how old the lock was. Before, every
  failure before input looked the same, so a seat that kept missing wakes left nothing to show
  which step refused (#27661). It is shown only while it belongs to the current failure, or as
  the previous failure after a retry succeeds. The note never holds a process id, launch nonce,
  path or error text, and it changes nothing about whether or when a notice is retried.

## [0.32.39] - 2026-10-29

### Fixed

- The Claude turn trace now records every write to the turn record. Before, it missed the
  launch's first record, a new observer attachment and an invalidation after the turn bridge
  lost its observer, so a trace could end on "idle" while the record had already been reset to
  detached. Each line now carries the attachment epoch, the draft flag and the compaction count.
- A trace line no longer reads "no phase change" for an event the record ignored. It names what
  happened: a completion for a turn the record does not hold, an idle prompt the record could not
  accept, or an event from an observer that is not attached.
- A trace write refused because the trace path is a folder or a link is now counted, and the
  count appears on the next line written, the same as a failed write.

## [0.32.38] - 2026-10-29

### Changed

- A Claude seat whose notices are held by its turn gate now says so in its own
  `summon --mail status`, naming the reason: no turn record, the turn hook not attached, a
  compaction, a prompt draft, a turn recorded as busy, or a turn that ended without a verified
  answer. Before, the wake cycle returned silently, so a seat could miss every wake for hours with
  nothing in its status to show why (#27661). Whether a notice is held does not change.
- Each Claude launch now keeps an append-only trace beside its turn record. It has one line for
  every hook observation and every write Summon makes to the record itself (a human Enter in the
  pane, or a notice reserved or rolled back): the phase and turn before and after, and what the
  reducer did with the event. The turn record is overwritten in place, so this trace is how a turn
  gate left stuck at busy can now be traced back to the event that stranded it.

## [0.32.37] - 2026-10-29

### Changed

- The Windows installer build now requires the Inno Setup 7.1.1 compiler instead of 7.1.0, and
  records 7.1.1 in the build manifest. A 7.1.0 compiler is refused with a message naming 7.1.1,
  and the build guide names 7.1.1.

## [0.32.36] - 2026-10-29

### Changed

- The Team Window's Board now always receives its card actions. The unused mode that drew cards
  with no action buttons is removed, so the Board's actions can no longer be dropped by leaving
  them out. The Board looks and behaves as before, and archived cards still offer no actions.

## [0.32.35] - 2026-10-29

### Fixed

- Corrected the security policy's obsolete claim that Codex has read-only team-store access.
  Current launches grant the whole selected store, and command-level checks do not isolate a
  process running as the same OS user. The startup-notes glossary now describes complete active
  notes and the 16 KiB UTF-8 limit rather than a truncated excerpt.
- Corrected the communication guide's refresh rule: actual Telegram sends require a successful
  remote check, while local operations can warn and use the recorded communication state during
  remote failure or contention. The storage guide now distinguishes the reserved `operator`
  registration name from the historical folder-migration scope.

## [0.32.34] - 2026-10-28

### Fixed

- A Board card action focused from the keyboard now draws its focus ring inside the button, so the
  ring no longer covers the edge of the button beside it now that the buttons sit 2 px apart.

## [0.32.33] - 2026-10-28

### Added

- The Windows installer now checks for Bun and PowerShell 7 on a new **Dependencies** page and can
  install them during setup. A current one is shown as found; a missing, too old or unreadable one
  is pre-checked and can be cleared. Bun installs for the user with winget, or from its pinned
  official GitHub release when winget is missing or has no package, installer or usable source for
  it. PowerShell installs for all users with winget, after the page announces the UAC prompt; only
  without winget is its pinned official release installed for the user instead. winget checks its
  own package hash, and a pinned official release is checked against its SHA256 before it is
  extracted. A new `bun.exe` is staged complete before it replaces one in Bun's folder; the older
  copy is kept beside it, or put back if the swap fails. PowerShell counts as found only on the
  machine or user PATH, where Summon looks for it. The page links each
  package's licence and winget's community source, and leaving a box checked accepts them.
- A cancelled, declined, blocked, offline, stalled or failed dependency install never stops
  Summon's own installation. Every wait, including each download read, is bounded by the dependency
  step's deadline, except up to 2 seconds for a stopped version check to exit; a local step on the
  verified ZIP that has started runs to completion. A winget
  run still going when setup stops waiting is reported as unfinished and left to complete. The
  Finish page reports each result and keeps the official guidance links. A silent install checks
  and installs no dependencies.
- The installed launcher also looks in Bun's per-user folder and winget's Links folder when PATH
  has no `bun.exe` yet, as right after setup. It runs the first copy that exists, first on PATH,
  and the Dependencies page judges that same copy on the saved PATH that newly started programs
  receive, so setup never calls Bun found when a newly started launcher would run an older or broken
  copy. Like setup, the launcher searches only fully qualified PATH
  entries, never a relative one. installed-launch still refuses a Bun below 1.4.3.
- Setup checks the PATH that newly started programs receive. A terminal that was already open keeps
  its old PATH, so the Finish page, the installation guide and installed-launch's refusal now say to
  open a new terminal or start Summon from Start after setup.

## [0.32.32] - 2026-10-28

### Fixed

- At 1440x900 with the Room closed, the Board's card action buttons no longer wrap onto an extra
  row in its 217 px lanes, so each lane's first card again clears the bottom of its row by more
  than a line. The gap between action buttons is 2 px instead of 3. The rendered Board tests now
  measure at exactly the viewport they ask for; they had been measuring one pixel wider and taller,
  which hid this wrap.

## [0.32.31] - 2026-10-28

### Fixed

- A path written with Windows 8.3 short names (for example a TEMP folder reached through the short
  form of a long user-folder name) is now treated as the folder it names. Published claims, the claims store,
  Codex compaction history and the standing updater's checkout check used to refuse such a path,
  or report it as unavailable, because its spelling differed from its real path.
- Links, junctions and redirected drives are still refused at every one of those checks, now on
  every component of the path as written, including folders above the claims store or Codex home.
  A path whose real location resolves to a different drive root, as a subst drive or a letter
  mapped to a network share usually does, is refused as before. This is not a guarantee that
  every kind of drive mapping is detected. A claim target outside the owner's folder is refused
  before anything on its path is read, and a protected folder reached through its short name is
  refused like the folder itself.
- A claim target must start with the owner's folder as configured or as its real path; short names
  are accepted for the folders below it. A target that spells the owner's folder itself in a
  different short form than the configured one is still refused, as before, without being read.
- The standing updater still refuses a configured checkout whose real path resolves to another
  drive root. Its installed link may live on any drive, as long as it points at that checkout.

## [0.32.30] - 2026-10-28

### Fixed

- A teammate waiting for head-down approval receives the decision even after approval starts
  queuing ordinary notices. The response names only its current request; human pauses, provider
  busy turns, unsent drafts and communications halt still hold it. An uncertain send is retained
  without an automatic repeat.

## [0.32.29] - 2026-10-28

### Fixed

- When Bun or PowerShell is missing, outdated or unchecked, the runtime line in CLI setup and on
  first run now names each one's official installation guide and says to reopen Summon after
  installing. It no longer points to the setup cards that 0.32.28 removed.

## [0.32.28] - 2026-10-28

### Changed

- Maintenance's CLI setup no longer shows the Bun and PowerShell cards with their install notes.
  The Team Window runs on Bun, so it could never report Bun missing there; the installed launcher
  already reports a missing or outdated Bun before the window opens. The runtime check still runs:
  its result appears as one line in CLI setup's summary and in the first-run summary, and missing
  or outdated runtimes still put setup first.

## [0.32.26] - 2026-10-28

### Fixed

- A teammate's roster row now explains an unverified Stop on hover, as its label already said,
  instead of describing an ordinary provider turn.
- An unverified Stop's diagnostic is now saved to the fault journal as a warning, once per launch's
  attempt, without showing an error banner. The note that the session's main process couldn't be
  checked appears as soon as the Stop's answer arrives. A replacement session never inherits the
  previous launch's note.

## [0.32.25] - 2026-10-28

### Fixed

- A Stop whose terminal reports its exit while the unverified state is still being saved now
  answers stopped, instead of leaving the operator, a window close or a rest stop with a stale
  unverified answer.
- The root-process diagnostic of an unverified Stop calls a root alive only when it is the same
  process this launch started. The Window records that process's exact creation time when the
  session starts, and only after matching the session's own launch arguments. A process that
  later reuses the PID reads as gone, and without that recorded identity the root reads as
  unknown, never as alive.

## [0.32.24] - 2026-10-28

### Fixed

- The Team Window shows an unverified Stop instead of an error. The teammate's row, header and
  statusbar read "Stop unverified", and the Stop button is disabled with the same label until the
  terminal's exit settles it. Its tooltip says Summon hasn't seen the session exit yet, and adds
  that the main process couldn't be checked when the stop's answer said so. No process count is
  shown.

## [0.32.23] - 2026-10-28

### Fixed

- On Windows, a Stop whose process-tree termination reports a failure no longer drops the
  operator's stop. The session keeps refusing input, notices and rest stops, and a second Stop
  starts no further termination attempt. When the terminal finally reports its exit, which can
  take minutes, it is recorded as stopped rather than as an unexpected exit. Stop now answers
  "unverified" instead of failing outright. Whether the session's root process is gone, still
  running or unreadable is kept as a diagnostic only; it is never taken as proof that every child
  process ended. Rest stops and closing the window still treat an unverified stop as not stopped.

## [0.32.22] - 2026-10-27

### Fixed

- Codex notices can be delivered when the native turn reader is unavailable or returns unknown.
  A measured busy turn still holds ordinary notices. The queue's existing coalescing and final
  source, read, binding and receiver checks remain in place; unknown is never treated as verified
  idle. Live unattended-wake acceptance remains required before 1.0.

### Changed

- Moved the claims and storage guides into `docs/reference/` and updated their incoming links.

## [0.32.21] - 2026-10-27

### Changed

- User documentation now starts with a short README, a docs index and guides for first use,
  work tracking, decisions and controls, profiles, maintenance and delivery troubleshooting.
  Existing detailed instructions remain reachable in topic reference pages.
- Public release history lives at `docs/CHANGELOG.md`. Package contents, installer inputs,
  support and site links use that path. Source-version checks read old Git baselines at their
  original history path while requiring the canonical path for a newly versioned candidate.
- Root TODO/FUTURE planning files are reconciled into local project features and milestones,
  retaining their complete clauses and unresolved decisions. Existing approval and completion
  states are preserved; undecided proposals remain waiting for approval.

## [0.32.20] - 2026-10-27

### Fixed

- Codex automatic notices now wait for a fresh native idle observation and recheck their source,
  thread binding and pause eligibility before entering the provider queue. Reading mail or Room
  traffic during a busy turn no longer releases another automatic submission. Busy or unknown
  observations retain pending work. Notices already accepted by Codex cannot be withdrawn, and
  native rest/wake acceptance remains unmeasured.

## [0.32.19] - 2026-10-27

### Fixed

- A mail notice that names only confirmations now routes to `summon --mail receive`, which shows
  them, instead of `summon --current-requests`, which leaves them out by design and looked empty.
  A notice that mixes confirmations with other mail keeps the focused-read wording and adds the
  receive route for the confirmations. Reading a confirmation records read coverage only; it sends
  nothing back. Codex queued-notice coalescing is unchanged. This fixes the route mismatch only and
  does not explain the earlier wakes with zero unread mail.

## [0.32.18] - 2026-10-27

### Fixed

- Windows installer builds stop before staging payload files when the compiler version check
  fails or does not report stable Inno Setup 7.1.0. The build log now includes that check's exit
  status and captured output, so valid-looking text from a failed process cannot pass the guard.

## [0.32.17] - 2026-10-26

### Changed

- Bun 1.4.3 or later and PowerShell 7.6 or later are now external prerequisites for the Windows
  installer. Summon no longer stages or downloads these runtimes for distribution. The launcher
  reports a missing or outdated Bun before opening the app; first-run setup checks both runtimes
  alongside provider CLIs and links to their official installation guides. Electron and application
  library dependencies remain included with their license files. Source checks and fixture results
  do not establish clean-host acceptance of an installer.

## [0.32.16] - 2026-10-26

### Fixed

- Codex teammates no longer pile up stale Room and mail notices during a long turn. Codex holds
  every notice Summon submits until the turn ends and then runs each one as its own turn, so a busy
  teammate came back to a row of notices naming messages it had already read. While a Room or mail
  notice is still waiting there unread, Summon now holds the next one from that source. The waiting
  notice already says to checkpoint or read current requests, which covers everything after it.
  Room releases once the read cursor or the active checkpoint package reaches it; mail releases
  once each message it named is completely read, archived, obsolete or in the active package.
  Later messages stay unread and are announced after release. Other providers, Telegram and
  approval decisions are unchanged, failed sends behave as before, and nothing already queued is
  withdrawn. If Codex loses a queued notice, the next one from that source waits for the
  teammate's own read or for someone to act on the response watchdog's alert; nothing is re-sent
  automatically.

## [0.32.15] - 2026-10-26

### Fixed

- Schedules refresh keeps keyboard focus on the same schedule when due times, paused states or
  owner groups reorder the rows. If that schedule was removed, focus moves to the enabled
  Refresh button. Refresh preserves expanded rows and scroll position and leaves focus outside
  the list alone, including when it moves there while a read is pending.

## [0.32.14] - 2026-10-26

### Fixed

- `bun run lint` no longer checks the retained audit evidence under `.aidd/` (reports, source
  snapshots and probe scripts). Lint had been reporting thousands of errors from those files, so
  `smoke:qc` stopped at lint and never reached its dead-code, build, licence, leak-guard and test
  steps in a checkout that held them. `.aidd/` is the only new exclusion. Every rule, the
  zero-warning limit and the coverage of source, tests, scripts and root config are unchanged,
  and a regression test checks both sides through the installed ESLint.

## [0.32.13] - 2026-10-26

### Fixed

- Resting teammates' fallback avatar initials keep full text contrast. Only avatar images retain
  the quiet treatment.

## [0.32.12] - 2026-10-26

### Fixed

- Primary action labels stay readable when hovered or focused with the keyboard in both themes.
- Room authors and mentions use readable colors on ordinary, directed, question and approval
  messages. Existing names follow a theme switch without redrawing the messages.
- A failed Schedules refresh marks retained rows with a border and keeps the failure message,
  without fading their text or disclosure controls.
- Resting teammates keep readable names, state, provider, account and task text. Their existing
  Resting label, badges, selection and Zzz control remain in place.

## [0.32.11] - 2026-10-26

### Changed

- The startup instructions now give catch-up a concrete trigger: when a checkpoint package has
  more than 5 pages or more than 200 items, use the explicit catch-up preview, index and apply flow
  instead of reading it page by page. Both counts are the `package.pages` and `package.items`
  every checkpoint page already reports. Past that threshold the page's catch-up advice says to
  use catch-up; packages of 4 or 5 pages within it still only get the suggestion. Items addressed
  to you are still read in full, direct mail keeps its state, and skipped history is never marked
  read, handled or approved.

## [0.32.10] - 2026-10-26

### Fixed

- Notepad's Markdown preview renders a table's first row as column headers (`th` with
  `scope="col"`) inside `thead`, with ordinary data cells in `tbody`. Header cells keep the
  preview's existing cell padding and borders.

## [0.32.9] - 2026-10-26

### Fixed

- Repeated Macros opener clicks share one pending load and leave an already-open editor alone,
  so a late response cannot replace unsaved slot text. Failed loads can still be retried, and
  Close, Escape and backdrop dismissal retain their discard confirmation.

## [0.32.8] - 2026-10-26

### Fixed

- Team rules over their prompt budget (40 lines or 8000 characters) no longer stop every session
  from starting. A start now prints a warning that names each exceeded limit and the file's size,
  and still gives the provider every rule; none is cut or dropped. Rules without a source or
  earned line, or a file with no rule entries, still refuse the start as before.

## [0.32.7] - 2026-10-25

### Fixed

- A Kilo seat's reasoning variant is now described as what it is wherever Summon shows it: the
  variant sent with the startup turn at each launch and resume, when the model lists it. Later
  turns follow Kilo's own loaded pick, and an empty setting leaves the session's stored variant or
  Kilo's pick rather than the model default. This corrects the `--variant` help from 0.32.6 and the
  Team Maintenance field's title, placeholder and hint. Text only; behaviour is unchanged.

## [0.32.6] - 2026-10-25

### Fixed

- `summon --help` now says a Kilo `--variant` applies at each launch and resume. Before, it said
  the variant applies only to a session without one of its own, but since 0.31.21 the registered
  variant wins over the session's stored one. Help text only; behaviour is unchanged.

## [0.32.5] - 2026-10-25

### Fixed

- A Codex notice whose queue call fails while Summon waits for the queue command to exit no longer
  ends the whole session. Since 0.32.3 the error output was read in the background and only
  awaited after the exit, so a read that failed in that window was an unhandled error that
  stopped the session with exit 1. The failure now reaches the notice's own error handling, as it
  did before 0.32.3. The suite's relaunch-race test had caught it on every run.

## [0.32.4] - 2026-10-25

### Fixed

- In the Team Window, the operator identity error stays on screen while the settings file is
  still broken. Before, the first action after the fault, such as selecting a teammate, cleared
  the banner for good, and the Room and Diary went on showing no operator names with nothing to
  say why. A successful action now shows the error again; a failed action still shows its own
  error, Dismiss still hides the banner until the next action, and the fault is still journalled
  once.

## [0.32.3] - 2026-10-25

### Fixed

- A Codex notice no longer waits for, or is reported as timed out because of, a detached process
  that `codex queue` leaves holding its error output. Since 0.32.2 a queue call that exited
  successfully could wait until that process ended and then be reported as an uncertain timeout.
  The queue command's own exit, or its kill at the 15-second limit, now decides the outcome, and
  reading its output stops half a second later.

## [0.32.2] - 2026-10-25

### Added

- A Codex seat's own `summon --mail status` now shows `codexQueueFailures`: the latest failed
  `codex queue` call for this launch (exit code, timeout or failure to start) with a fixed label
  for a few known Codex queue errors, and how many the launch retains (up to 20). Codex's own
  output is read to the end so the queue command cannot stall, used only to choose the label, and
  never stored, logged or shown. Delivery outcomes, retries and existing records are unchanged.

## [0.32.1] - 2026-10-25

### Fixed

- Invalid operator identity settings now leave teammate startup available with a generic
  operator display and a visible warning. Registration and PM display-name changes refuse
  operator-name collisions under the identity writer's lock. Existing session updates remain
  available while a damaged setting is corrected. The operator-only identity `create` command
  refuses an identity saved by another writer instead of replacing it.

## [0.32.0] - 2026-10-25

### Added

- Each team can configure its operator display name and addressing aliases with
  `summon --operator-identity`. Startup Diary examples, Diary recipient labels and Room name
  highlighting use that identity. Personal names, mention-only roles and Diary shorthand stay
  distinct. Names that collide with registered teammates are refused. Invalid configuration
  leaves the roster usable, reports the identity fault once, and shows recipients literally
  without substituting a human name. Saved Diary entries and Room text are unchanged.

### Changed

- New teams receive the four communication skills and two neutral default macros. The bundled
  fleet-specific `summon-next` workflow and its default macro are removed; saved macro text is
  preserved. Generic startup and approval guidance refer to the operator and the team's own
  reminder policy. Existing teams must preserve their needed external workflow and approve
  its live mapping before adopting this change. The editable suggested PM name confers no
  permission, wake selection or recurring duty. Documentation examples use caller-selected
  project and checkout paths.

## [0.31.68] - 2026-10-24

### Fixed

- Telegram health notices no longer read as if a halt were in force (Phillip, #22292). The
  failure notice and the CLI's refresh warning said local work used "the recorded halt state",
  and the recovery notice said "the recorded halt state remains in force", even while
  communications were set to Proceed. They now say local work uses the recorded communication
  state and that remote halt/proceed updates may be pending. The recovery notice says recovery
  alone does not change that state. Wording only: enforcement, pause suppression, signal
  processing and timing are unchanged.

## [0.31.67] - 2026-10-24

### Fixed

- A Kilo hold no longer hides an earlier delivery problem (Morticia's Low and Roger's L2 on
  0.31.65). A cycle can end with a notice unsent or possibly started, or an inventory that could
  not be read; then the stream is lost and a hold replaces that reason. When the hold later
  cleared, as a turn went busy, the status went straight to live or unconfirmed from readiness
  alone, for the whole busy turn, while the problem was still unresolved. Now a hold's reason
  carries the problem the retained records still report, and clearing returns to that problem.
  Both read in the same order as the end of a full cycle: an unrecovered inventory or room-policy
  error for this launch, then an unsent notice, then an uncertain one, then readiness. The outcome
  and wake-error records were never affected.

## [0.31.66] - 2026-10-24

### Fixed

- The summon-next skill no longer tells wip file owners, or its runner, to append to notes files
  directly (Auden's report, routed by Morgan). Notes are edited with `summon --notes read`, then
  `summon --notes write`, which keeps existing notes and refuses a stale revision. The runner's
  record of what it mailed is kept the same way, and nobody is asked to write another teammate's
  files.
- The summon-receive skill now says that `ack-self` checks only for an open hold, not that the
  message was read in full, confirmed or replied to. It says never to batch it with `confirm` or
  `reply`, that `confirm` needs the inbox copy, and to use `read-history` for an archived copy
  (Alice's report 20b6a651). Instructions only; no command changed.

## [0.31.65] - 2026-10-24

### Fixed

- A Kilo seat whose notices are held now says why (Roger M1 and Morticia L1 on 0.31.64, within
  Phillip's #22057). Before this, a seat with no turn record, a lost turn stream, or a settled
  launch still waiting for busy then idle kept its notices queued in silence. The output of
  `summon --mail status` now reports a queued-only reason naming the seat, the launch and the
  safe next step. A manual checkpoint collects queued work but does not restore observation;
  only an operator relaunch does. The reason comes from observed state only, with no timeout. It
  is written only when it changes, never for a running turn or an attached stream's startup
  wait, and it clears once the hold does. A lost or never-opened turn stream now clears its observer, so loss is
  recorded rather than looking like an ordinary wait. The input gate itself is unchanged.

## [0.31.64] - 2026-10-24

### Changed

- A Kilo seat gets no notice before its startup turn has finished (Phillip, #22057 on #22056).
  Summon could type the readiness request into Kilo before the startup turn existed, where it
  could be lost while recorded as submitted. Summon now marks the startup input just before its
  POST and records the outcome after it: accepted, or uncertain for any non-2xx or timed-out
  response, since that can't prove no turn was taken. The first notice waits for a busy then idle
  observed after the mark, even when the turn finishes before the response returns. The one
  pre-idle readiness notice is gone, so a seat whose turn stream is unavailable or lost keeps its
  notices queued instead of getting one typed blind. A seat launched before this change has a
  version 1 turn record, which is refused with a relaunch diagnostic rather than translated.

## [0.31.63] - 2026-10-24

### Fixed

- The deep-package catch-up advice no longer abbreviates the read command. It said
  `catch-up show <plan-id>` (or `--room show`), which needs a source and ID and so failed as
  written; it now points to the exact read command that each `catch-up list` entry carries.

## [0.31.62] - 2026-10-24

### Added

- A checkpoint page in a frozen package of more than three pages now carries `catchUpAdvice`, in
  JSON and text and on replayed pages, pointing a returning seat to the explicit
  `summon --checkpoint catch-up` preview, its index and read-back, and its apply step, with what to
  do if catch-up refuses. The page itself skips, applies and marks nothing, and page sizing
  reserves room for the advice so delivery limits hold.

## [0.31.61] - 2026-10-24

### Changed

- A registration refused for a Room post with an unreadable time now names that post's ID, so the
  post can be found and repaired. The README and a code comment now describe the new-member start
  as it works: just before the first post, in append order, stamped at or after local midnight,
  with a later post stamped before midnight still read.

## [0.31.60] - 2026-10-24

### Fixed

- A quoted mention starts nobody. A name or `@all` inside backticks, a fenced block, a blockquote
  or double quotes was already not an address, but the Window's mention start and missed-mention
  recovery still read the raw post, so a quoted example could start a stopped teammate (Roger M1
  and Morticia I1 on 0.31.58). Every start path now reads the post the way addressing does. A
  real, unquoted mention beside a quoted one still starts that teammate.

## [0.31.59] - 2026-10-24

### Fixed

- Two sends of one fixed message ID, or a send racing that message's acknowledgement, can no
  longer slip a second body past the identity check. 0.31.57 checked the recipient's inbox and
  archive and then linked, so a publisher paused between the two could find the inbox emptied by
  an acknowledgement and deliver a different body, or the same body again. The check and the link
  now hold the per-message lock that acknowledgement takes. Random-ID mail is unchanged.
- A confirmation whose first attempt was delivered but died before recording it is no longer
  stuck. A retry with different wording used to be refused, and the message could then never be
  held. The retry now records the already-delivered confirmation, but only when the retained copy
  has the same sender, recipient, kind and reply binding. Anything else is still refused, and no
  confirmed state is written.

## [0.31.58] - 2026-10-24

### Changed

- An agent's `@all` notifies but starts nobody (Phillip, #21677). It still counts as addressed for
  every teammate, so running teammates get the notice and it appears in checkpoints and current
  requests, but on its own it no longer starts a stopped seat or resumes a seat stopped for rest.
  A human or CLI `@all` starts everyone as before, and an agent's explicit `@name`, alone or beside
  `@all`, still starts that teammate. Normal mention starts, missed-mention recovery and rest
  resume all use the same start rule.

## [0.31.57] - 2026-10-24

### Fixed

- Mail sent under a fixed ID (hold confirmations, read receipts, confirmations, claims notices,
  rest notices) is checked against the copy already in the recipient's inbox or archive. The same
  content counts as already delivered, and different content is refused with "Mail publication
  identity conflicts with retained content". Before, a second body under a pending ID was dropped
  while the send reported success, and an ID already handled was delivered again. Mail with a
  random ID is unchanged.
- Read-receipt and confirmation IDs now include the reader, so two members who received one
  message ID send its sender two distinct receipts instead of one colliding ID.

## [0.31.56] - 2026-10-24

### Changed

- A newly registered member now reads today's Room instead of starting empty. Its Room cursor
  begins just before the first post at or after local midnight, so its first checkpoint holds the
  day's posts so far and everything after, and never the whole history. A later post stamped
  before midnight cannot move that start past an earlier post from today, and a Room post whose
  time cannot be read refuses the registration before any cursor or record is written. The
  Telegram cursor still begins at the latest post, since today's Telegram posts are already
  mirrored into the Room. Older posts stay readable on demand with `--room read`, `--room show` and
  `--room search`.

## [0.31.55] - 2026-10-24

### Fixed

- Mail delivery status now distinguishes an unreadable Room wake policy from a notification
  known to remain unsent. Invalid policy reports that routine-notification eligibility is unknown,
  while healthy addressed work can still be delivered. An addressed scan no longer falsely marks
  that policy error recovered; recovery waits for a valid scan. Policy bytes and permissions stay
  unchanged.

## [0.31.54] - 2026-10-24

### Fixed

- Registering a name whose earlier registration was deleted by hand while its session still runs is
  now refused on every creation path, before any cursor is written. 0.31.52 relied on each caller
  holding the name's session lock, which the CLI and PM command do, but cloning and a Team
  Maintenance add without a session ID did not, so they could reset the live session's Room and
  Telegram cursors. Both now hold the name's session lock while they create the member, release it
  afterwards even on a refusal, and fail closed on an unreadable lock owner.

## [0.31.53] - 2026-10-24

### Fixed

- In a post that stored presence groups, the `online` and `offline` tokens mean those groups,
  never also a member registered under either name. Wakes, missed-mention recovery and the
  addressed check share one rule; older posts stored without groups keep the plain-name meaning.
- An agent's post no longer starts stopped seats through a group. It still addresses the group's
  members in wake notices; only human and CLI posts start seats through a group, matching
  missed-mention recovery. The same rule covers a seat stopped for rest: an agent's group post no
  longer resumes it, while a human or CLI group post, an explicit name or a reply still does.
  Explicit names and the `all` mention are unchanged.
- Presence no longer reads every running member as offline when the process snapshot cannot see
  the calling process, as in a sandboxed CLI. Such a snapshot is unreadable, so held sessions are
  unknown, and a session the snapshot misses is offline only once its process IDs are gone.

## [0.31.52] - 2026-10-24

### Fixed

- A newly registered member no longer replays the whole Room and Telegram history on its first
  checkpoint. Registration starts its Room cursor at the latest post, and its Telegram cursor at
  the last cached message when Telegram is configured, so the first checkpoint, wake notice and
  current-requests view hold only what arrives after it joined. Every reader had treated a missing
  cursor as 0; a new Kilo seat's first package was 22,520 items. Existing members' cursors are
  never moved. A reused name also starts at the present, never at a cursor left under it. Earlier
  posts stay readable through Room read, show and search and through checkpoint catch-up.

## [0.31.51] - 2026-10-24

### Fixed

- An older Team Maintenance form cannot erase or replace newer Kilo model settings while saving
  another field. The form carries the model, variant and LM Studio URL revision it loaded; a save
  refuses if those settings changed, leaving the typed text available to copy before reloading.
  Showing stored expertise and domain does not adopt newer model settings into an older form.
  Reloading still allows an intentional model clear, and model observations do not invalidate
  the form. An older Window calling the new save handler without this revision must reload the
  profile on the current Window build before editing an existing Kilo teammate.

## [0.31.49] - 2026-10-24

### Changed

- `operator` is now a reserved name in any letter case, like `all` and `list`. Creating, cloning,
  adding the PM or saving a Team Maintenance profile under that name is refused with "The name
  operator is reserved for the human operator; choose another name." No current registration used
  it.

## [0.31.48] - 2026-10-24

### Added

- `@online` and `@offline` in Room posts, from the operator, agents or Telegram, address the
  teammates verified online or definitely offline. Presence is read once at send time and the
  resolved members are stored with the message, so delayed delivery, wake notices, missed-mention
  recovery, checkpoint "for me" flags, current requests and rest evidence all use the same list.
  `@online` never starts a teammate; `@offline` starts through the existing mention path with its
  hibernation and rest checks. Unknown presence selects neither group. Groups handed to a writer
  must match the message's group tokens exactly, and stored groups are bounded lists of canonical
  member slugs.

## [0.31.47] - 2026-10-24

### Fixed

- Team Maintenance turns Save off while the dialog is busy with something else, such as a
  profile still loading, Team settings being applied or a usage refresh. Before, Save stayed
  clickable and a press in that moment was dropped without a word, so a model typed for a Kilo
  seat could look saved and never reach the registration. Save comes back when the action
  finishes; it stays off when no CLI is installed to add a teammate with.

## [0.31.44] - 2026-10-24

### Added

- `summon --mail receive` takes `--kind <kind>` and `--since <message-id>`, in the unread and the
  pending view. A kind is one of request, reply, confirmation, receipt, rest-ready or notice.
  Since keeps mail sent after a message you received, found in your own inbox or archive; any
  other id is refused, and nothing looks into sent or peer mail. A filtered page names its filters,
  marks only its own complete bodies read and leaves omitted mail unread and pending, so it never
  counts as complete or checkpoint coverage. Continue it with the same filters and its cursor.

## [0.31.42] - 2026-10-24

### Fixed

- Room and Telegram wake notices no longer end with a bare "No reply.", which a Kilo seat read as an
  order not to answer the operator posts the notice had just named. They now end with "This notice
  needs no reply; the posts it names may." The worst-case notice still fits the 384-character budget
  (374).

## [0.31.41] - 2026-10-24

### Changed

- Windows tests use a bounded 15-second default for integration fixtures that start
  CLI or PowerShell processes. Explicit per-test deadlines and product timeouts stay
  unchanged. Test files remain serial and failed runs remain failures, without retries.

## [0.31.40] - 2026-10-24

### Changed

- Operators can select routine Room wake recipients per team with
  `summon --room wake-policy set <registration>...`, inspect them with `show`, and
  remove the selection with `clear`. Local Room, Telegram and response tracking use
  the same explicit selection instead of a built-in registration exception. New teams
  receive addressed traffic only. Selection grants notices without changing roles,
  approvals or hibernation safeguards; existing teams configure their recipients before
  adopting this behavior. These commands leave startup instructions untouched.

## [0.31.39] - 2026-10-24

### Fixed

- Updated the transitive `ip-address` package from 10.7.3 to 10.7.4 for
  GHSA-rxp7-6hxx-x8q5, within the existing dependency range. Other package pins and
  direct dependencies are unchanged. This update does not establish whether the affected
  parsing path was reachable through Summon.

## [0.31.38] - 2026-10-24

### Added

- Two more cases for the guidance a refused confirmation gives. A checkpoint package that has
  expired, because its id or content no longer matches the recorded state, gives no page hint and
  falls back to read-self. A read-self that stops inside a multibyte UTF-8 character names the
  character-boundary end it returned, and confirming works once the read reaches the last byte.

## [0.31.37] - 2026-10-24

### Security

- Electron moves from 44.7.0 to 44.9.1 for GHSA-jr5w-w6x2-84p9, which distrusts the compromised
  eMudhra intermediate certificates. It's a minor step on the 44 line; Hugo reviewed packaging.
- Three dependencies of dependencies move to their fixed releases, within their parents' existing
  ranges and with no package.json change. body-parser 2.4.0 (GHSA-27r3-jxmh-p828) comes with
  qs 6.16.1, which it requires; undici 7.30.1 fixes GHSA-xjj6-f33q-929c, GHSA-4qv8-2p9j-2685
  and GHSA-f72v-6w45-q472; fast-uri 3.1.9 fixes four Moderate and Low advisories. Summon doesn't
  load body-parser at all (its MCP server is stdio only), and undici runs only when the Electron
  binary is downloaded at install. No other resolution changed.

## [0.31.34] - 2026-10-24

### Fixed

- The idle question now also waits when a Claude, Grok or Kilo launch has no turn record at
  all. A missing record counted as idle before, so the question could still reach a teammate
  whose turn evidence was never written. Missing evidence is now unknown, like unreadable
  evidence: the question is held and the same idle episode is checked again a minute later.
  The tradeoff: a seat whose launch never writes a turn record never gets the idle question.
  Only the idle question changes; other readers of turn evidence keep their current handling.

## [0.31.33] - 2026-10-23

### Changed

- The GitHub mini-site introduces a code-change and review handoff, distinguishes saved and fresh
  conversations, and describes diary entries and rest readiness without treating them as proof
  of completed work. Setup keeps provider accounts separate and makes Grok's support limits
  visible. The existing design and source-install entry point remain.

## [0.31.32] - 2026-10-23

### Fixed

- The idle question ("You have been idle for a while…") no longer reaches a teammate whose
  provider turn is still running, such as a long tool call, just because its status still says
  idle. It also waits when that idle status was left by an earlier launch, or when the turn
  evidence can't be read. Claude, Grok, Kilo and Codex are covered; for Codex the evidence is
  its bound thread's status on the running daemon, so an unavailable daemon holds the question
  too. Cadence and one question per idle episode are unchanged. The evidence is read only when a
  question is about to be sent, and after a busy or unknown reading the same member isn't read
  again for a minute, so an idle Codex seat costs one daemon call a minute, not one every tick.

## [0.31.31] - 2026-10-23

### Changed

- The built-in PM instructions now include the PM's duties and Diary checks, in the wording the
  operator approved. A PM keeps work moving by noticing stalls and routing what comes next. It runs
  a recurring stall check as its own schedule, following its team's own rules for nudging a quiet
  teammate. Summon doesn't create that schedule: the PM proposes it to the operator and creates it
  only after a Yes. The PM checks that the Diary is used and accurate, and asks an entry's author to
  fix it rather than editing another member's entry. The text names no team-specific practice.

## [0.31.30] - 2026-10-23

### Changed

- `summon --mail confirm` on a request you haven't read whole now says how to get read coverage,
  instead of only "Read the entire request before confirming." If the body is on the checkpoint
  page you were just given, it names that page and its receipt and tells you to replay and read
  the page before passing the receipt. If the body completes on a later page, it names the page to
  read through and prints no receipt for pages you haven't been given. If a read-self stopped
  part-way, it names the next offset; otherwise it says to read the request from byte 0. The
  refusal writes nothing, never quotes the body, and falls back to the read-self route whenever
  your checkpoint state is missing, malformed, out of range, in its final receipt or changing
  while it is read.

## [0.31.29] - 2026-10-23

### Fixed

- Codex roster refreshes no longer wait for a proxy process on every two-second poll. They
  refresh in the background and cache each current launch binding for 15 seconds, including
  unavailable observations. Initial or expired evidence reads unknown until refreshed. Stop and
  rest-stop still read fresh evidence; a cached busy row cannot force a question after Codex
  finishes its turn. Reopen the Team Window to load the correction. Other providers are unchanged.

## [0.31.28] - 2026-10-23

### Fixed

- Archiving a teammate works again when its scratch folder is a link or junction or can't be
  read. Since 0.31.27 Archive checked scratch the way Delete does and refused. It now leaves
  scratch alone completely, as it did before.

## [0.31.27] - 2026-10-23

### Fixed

- Deleting a teammate (Delete in the Team Window, or `summon --remove`) now also removes its
  scratch folders, `scratch/<name>` and `scratch/shared/<name>`. Everyone else's scratch and the
  shared files stay. A teammate named "shared" never takes the shared folder itself. Archive keeps
  scratch as before.
- A scratch folder that is a link or junction is refused before anything is deleted, and one that
  changed after the check stops the removal. Scratch goes first, before the teammate's schedules
  are paused, so a folder that cannot be removed leaves the teammate registered with its schedules
  still on. The error names the folders already removed, and the removal can be retried.

## [0.31.26] - 2026-10-23

### Fixed

- Stop now checks a Codex session's bound thread on its running daemon, including turns that
  started after the last roster update. Active or unavailable evidence asks for confirmation;
  only a loaded idle thread stops immediately. Cancel keeps the session and rest-stop refuses
  active or unknown Codex work. Unsupported CLI versions and missing bindings ask rather than
  treating a self-reported idle status as native idle. No provider hook or notification is replaced.

## [0.31.25] - 2026-10-23

### Added

- On Windows, `summon --team` and `summon all` now remove scratch files in the selected store last
  written more than 30 days before that start. Empty folders that were already that old go too.
  This covers every member's scratch and shared. Member folders, shared and the scratch folder
  itself stay. Each start prints one line with the counts and up to 20 skipped paths. Named
  sessions, internal launches, mail, status and other commands never purge, and neither does a
  teammate's own CLI. macOS and Linux skip expiry and remove nothing.
- The removal runs in one hidden PowerShell 7 worker that holds every folder from the drive root
  down to scratch. It never follows links, junctions or other reparse points, and it refuses the
  whole run if scratch or a folder above it is redirected. It deletes only through an exclusive
  handle whose identity, size and times still match. Anything changed, linked, hard linked,
  unreadable or in use is skipped and reported. A handle opened only for attributes doesn't count
  as in use. Each of those starts takes about 1 to 1.5 seconds longer. If the worker can't start,
  the line says nothing was removed. If it stops partway, the line says some files may have been
  removed and the counts are unknown.

## [0.31.24] - 2026-10-23

### Fixed

- Adding a Kilo teammate whose reasoning variant Kilo couldn't confirm no longer loses the reason.
  Add Teammate closes the dialog as soon as the save succeeds, so 0.31.23's note in the form was
  gone at once. The "has been added" pane you land on now starts with it. An add with no note reads
  as before.

## [0.31.23] - 2026-10-23

### Changed

- Saving a Kilo seat's reasoning variant in Team Maintenance now says what it is doing. Save reads
  Saving… and is disabled while the save runs. When a variant is set, the status line explains that
  a new or changed variant is checked with Kilo, which can take up to 45 seconds. If Kilo couldn't
  confirm the variant, the saved message now says the check was skipped and why; before, that note
  went only to the log.

## [0.31.22] - 2026-10-23

### Changed

- The Team Window shows a teammate running somewhere else as In another window only when the same
  check as `summon --presence` confirms its processes. A session lock it can't confirm now reads
  "Lock held, not verified", with the reason and when it was checked, as a hollow grey dot that
  is never green or amber. It is neither online nor offline, so it shows only under All in the
  roster filters, and Start stays unavailable until the lock is released. The empty pane says "Can't start yet: a previous
  session's lock is still held." The window offers no way to clear the lock. Team Maintenance
  treats such a teammate as still running. The check runs only when another window or terminal
  holds a lock, and the window reuses the answer for up to 15 seconds.

## [0.31.21] - 2026-10-23

### Changed

- A Kilo seat's registered reasoning variant is now its setting at every launch. Before, a variant
  already saved in the session won, but since 0.31.16 that saved value is just what Summon wrote
  last, so changing the registration had no effect. A variant picked by hand in the Kilo screen
  still applies for that live session.
- A reasoning variant is checked against Kilo's model list when it is set, or when the seat's model
  changes, in `summon <name> --variant` and in Team Maintenance. A variant the model doesn't list is
  refused. If Kilo can't answer, the setting is kept and the CLI says the check was skipped. A save
  that changes neither model nor variant isn't checked again.

### Fixed

- The startup wait for Kilo's model list now really ends at 15 seconds; a slow read could run it to
  about 17.

## [0.31.20] - 2026-10-23

### Fixed

- `summon --presence` and summon-who work on macOS and Linux again. 0.31.18 read processes only on
  Windows, so elsewhere every running session was reported offline. They now read `ps` there too,
  the way summon-who did before. The summon-who guide no longer says the Team Window shares this
  check; it doesn't yet.

## [0.31.19] - 2026-10-23

### Fixed

- Acknowledging a reused mail ID no longer replaces its archived message. Identical redelivery
  keeps the first archived copy; conflicting content stays pending with a clear error. Overlapping
  acknowledgements share the same lock, and an interrupted archive operation can finish safely
  when acknowledged again.

## [0.31.18] - 2026-10-23

### Added

- `summon --presence` reports each member as online, offline or unknown, with the reason and when
  it was checked. Online needs proof from the running processes: the session lock's owner started
  before the lock (so a reused process ID can't pass), is that member's Summon session, still has
  its terminal or Team Window, and still runs the member's provider. Anything Summon can't confirm
  is unknown, never online. One process check covers the whole report.

### Changed

- summon-who uses the same check, so the PM and `summon --presence` agree. Its old stale, unhosted
  and provider-missing statuses are now reported as unknown with the same detail.

## [0.31.17] - 2026-10-23

### Fixed

- Old Grok turn hooks no longer recreate runtime folders at the former storage root when a
  conversation is resumed. Hooks check the selected layout and current launch ownership before
  writing. A new launch can recover its recorded, unchanged hook across a storage move while
  preserving user edits and unrecorded hooks.

## [0.31.16] - 2026-10-23

### Fixed

- A Kilo seat's registered reasoning variant now lasts past its first turn. Only Summon's startup
  turn carried it; every later turn comes from the Kilo screen, which names the model but no
  variant, so Kilo saved "default" over it straight away. The seat's model and variant now go on
  the Kilo agent the seat runs, which Kilo applies to those turns as well.
- The startup turn no longer drops the variant when Kilo is slow to load its model list: Summon
  keeps asking for up to 15 seconds instead of trying once for 3. When a variant still isn't sent,
  the seat's log says why.

## [0.31.15] - 2026-10-23

### Added

- Team Maintenance has a "Reasoning variant" field for Kilo seats, beside the Kilo model. Name a
  variant such as high and a fresh or cleared session starts on it; leave it empty for Kilo's
  default. It needs a model, suggests low, medium and high, and is cleared when the seat changes to
  another provider.

## [0.31.14] - 2026-10-23

### Fixed

- A long roster no longer jumps back to the top when a teammate's status changes. With a teammate
  selected, each update redrew the roster and refocused that row partway through, which reset the
  scroll; the roster now keeps its scroll position across the redraw.

## [0.31.13] - 2026-10-23

### Fixed

- Release preflight now refuses an integration whose version was raised before its last behavior
  change. The bump must accompany or follow the runtime it covers, including across test-only tips,
  version metadata edits and regressions. A later documentation-only release-note repair remains
  allowed. The main-ref hook checks this before moving main, matching the later build check, so an
  accepted merge cannot acquire this version-order refusal only after integration.

## [0.31.12] - 2026-10-23

### Added

- A Kilo teammate can keep a chosen reasoning variant, such as high, across fresh and cleared
  sessions. Set it with `summon <name> --variant high` while the teammate is stopped, and remove
  it with `--variant default`. The Team Maintenance form has no field for it yet, and saving the
  form keeps the setting while the model stays. At launch Summon sends the session's own saved
  variant when it has one, and otherwise the registered one, only when the selected model offers
  it; a session left on Kilo's default takes the registered variant. It needs a registered model,
  and a teammate without the setting starts exactly as before.

## [0.31.11] - 2026-10-23

### Changed

- When a teammate's provider turn record doesn't say whether a turn is running, its Ready in the
  roster, the session header and the statusbar now has a tooltip saying so, and that Stop asks
  first. Before, a teammate that had rested read Ready with no explanation.

## [0.31.10] - 2026-10-23

### Fixed

- Rest-stop checks the running provider's current turn before ending a session, both from the Zzz
  button and from a delegated request. A busy, unknown or unreadable turn refuses the stop and
  explains why, even if the roster still shows a previous rest confirmation. The check uses the
  running session's provider and launch, so a profile edit for the next launch cannot hide its turn.
- A second check at the owned stop boundary catches a turn that began during the rest checks and
  refuses a replacement launch. Missing turn records, including Codex sessions, still rely on the
  explicit rest confirmation and activity checks; they do not establish native idle.

## [0.31.9] - 2026-10-23

### Changed

- Room and Telegram wake notices name the posts that caused them. The notice lists each mention,
  reply to one of your posts, or human or CLI post by number, followed by one read-only command
  to open them: `summon --room show <id>` for the room, or `summon --telegram read <seq-1>` for
  Telegram, which shows what follows the cursor you give it. The "through" number is labelled as
  the read cursor, so later routine traffic is never presented as the cause, and a wake with no
  such post says nothing in it addresses you. More than five causes end with a pointer to the
  checkpoint manifest. The notice still requires the full checkpoint read and grants no authority.

## [0.31.8] - 2026-10-23

### Fixed

- A teammate that has confirmed rest but whose provider has started a turn, for example after you
  type a prompt into its pane, now reads Busy in the roster, the session header and the statusbar,
  not Resting. A tooltip says the provider reported the turn. If the turn record can't be read, the
  row says Ready rather than claiming either. The Zzz rest-stop button is withdrawn while a provider
  turn is on record, because it stops without the usual question.

## [0.31.7] - 2026-10-23

### Changed

- Startup guidance now explains rest before the mailbox history: after required reading, a teammate
  with no actionable work checks its own work once, confirms rest and ends its turn. Human approval
  waits stay intact, and an active child process still needs to finish first.
- Catch-up guidance asks teammates to verify the operator's actual applicable holds rather than
  asserting that the earlier rollout hold is still active. Catch-up still requires its explicit
  preview, addressed index and apply steps, and grants no other approval.

## [0.31.6] - 2026-10-22

### Changed

- A thumbs-up you've given in the room now shows in Summon green, still with no frame, so it reads
  as done at a glance without looking like a button to press again.

### Fixed

- Stop asks before ending a session that has just started working. It used to decide from the
  roster's last snapshot, which can be up to two seconds old, so a Stop pressed right after typing
  a prompt could end a live turn without asking. The Team Window now checks the session again when
  the stop arrives, and if it finds work you haven't confirmed, it asks the same question first.

## [0.31.5] - 2026-10-22

### Added

- The startup prompt names this launch's own readiness command, `summon --mail ready <nonce>`,
  with the nonce the launch runs under, so a session no longer looks it up or mistakes a provider
  thread id or an earlier launch's nonce for it. A relaunch publishes its new nonce, and the
  earlier command is still refused without marking readiness.

## [0.31.4] - 2026-10-22

### Changed

- A teammate that has been Connecting for more than 30 seconds now shows how long, in its roster
  row, the session header and the status bar ("Connecting… 1m 20s"). The tooltip says the provider
  may be asking a question in its pane, such as Claude's folder-trust prompt, and to answer it
  there. Summon still can't tell a waiting question from a slow start, so it doesn't claim either.

## [0.31.3] - 2026-10-22

### Fixed

- Rest checks skip inbox headers for messages already read. This avoids holding the rest lock
  on unnecessary header reads when retained mail accumulates, so a slow covered header cannot
  starve an explicit rest confirmation. Unread work still needs attention before rest.

## [0.31.2] - 2026-10-22

### Fixed

- The window reports an unreadable Claude turn record once, as a fault on that teammate, and
  again only if the record breaks after reading cleanly. Before, the only sign was the missing
  compacting mark and Stop asking first.

## [0.31.1] - 2026-10-22

### Fixed

- An unreadable Claude turn record no longer turns that teammate's roster row into a "cannot
  load" row either. The row stays as it was without its compacting mark, and Stop asks first, as
  it already did for Kilo and Grok.

## [0.31.0] - 2026-10-21

### Changed

- The default team uses `~/.summon/team-default`, alongside named teams. Its name stays hidden
  in the window. `SUMMON_HOME` selects an exact store; `SUMMON_TEAMS_HOME` selects the teams base.
  Existing flat stores require a separately approved offline copy and verification. Startup
  refuses old, mixed or incomplete default layouts before creating or reading another team.
  Note filenames remain unchanged. The updated standing updater refuses a target build that
  cannot read the moved layout or reaches legacy data before the move. An incompatible window
  bundle refuses before launch. Older entrypoints must be retired during the manual cutover;
  where the global CLI links main, its source switch belongs inside that same offline window.
- An elevated `summon --team` refuses before creating a fresh storage layout.

## [0.30.4] - 2026-10-21

### Fixed

- A Kilo or Grok turn record that can't be read no longer turns that teammate's roster row into a
  "cannot load" row. Stop treats the unreadable record as a turn that may be in progress and asks
  first, and the row stays as it was. An unreadable Claude turn record still shows the "cannot
  load" row, and Stop asks there too.

## [0.30.3] - 2026-10-21

### Fixed

- Stop in the Team Window now asks before ending a session the provider itself reports as busy.
  It used to ask only when the teammate had set its own status to busy, so a Claude session in the
  middle of answering, with its status still Ready, ended at once with no question. The window now
  also reads the provider's turn record for that launch (Claude, Kilo and Grok keep one) and asks
  when it shows a turn in progress or a state it can't read as idle. A session with no sign of work
  still stops at once.

## [0.30.2] - 2026-10-21

### Changed

- In the Team Room, a message you've approved shows its thumbs-up as a plain mark with no fill or
  border, so it no longer looks like a button you could press again. It used to light up green
  with a frame. A second press already did nothing; now it no longer looks pressable.

## [0.30.1] - 2026-10-21

### Fixed

- A Kilo session keeps its chosen reasoning variant (for example high or medium) across a
  Summon launch with a configured model. The startup turn now carries the session's stored
  variant when the selected model lists it. Kilo 7.8.15 could otherwise save "default" when a
  prompt named a model without one. A stored "default", an unsupported variant or an unreadable
  catalog sends none, as before. Sessions already reset to "default" need their variant chosen
  once in Kilo itself.

## [0.30.0] - 2026-10-20

### Added

- Source checks require a higher version and matching dated release notes when shipped code,
  bundled instructions or repository guards change. Test, documentation and verified formatting
  changes can retain the version, with the exemption reported. The main-ref hook checks
  fast-forwards too; the normal static gate and Team Window build use the same preflight.
- `seal:team` prepares a file-hash manifest only after checking clean source pins, the built
  version and the installed source baseline. An unexplained same-version runtime change is
  refused before the seal is written. This command does not copy a bundle or restart anything.

### Fixed

- Offline rollback can rebuild a clean historical release from main while retaining the
  current main ref. The historical release still needs a consistent version baseline;
  dirty checkouts, unpublished candidates and main-ref rewinds receive no new exemption.

## [0.29.0] - 2026-10-20

This version records the changes delivered after 0.28.3 through revision `47fbef5`.
Those builds retained the 0.28.3 label. Updating the source version does not replace an
installed Team Window bundle or restart a session.

### Added

- An active communications halt is visible above every Team Window tab, with its recorded
  actor, channel and time, and a Proceed button. Older pauses without attribution say it was
  not recorded. Hold Interruptions remains a separate notification control.

### Changed

- When a human decision is needed, teammate instructions and mail-hold guidance now call for
  the exact approval or choice control immediately. Teammates no longer wait for "ask me";
  Steward reminds Phillip of unanswered controls. Human approval is still required.

### Fixed

- Only the operator can halt or resume team communications, through the command line, Team
  Room or validated Telegram sender. New changes record their actor; reads stay available
  while sending is paused. Local controls rely on the preserved session identity, rather than
  authenticating a separate operating-system user.
- A `--help` or `-h` after a subcommand now prints help instead of being taken as an argument.
  `summon --room ask --help` used to post "--help" as a real Room question, and the same held for
  sends, `--msg`, status, diary, board and hibernate commands. Read-only commands are unchanged,
  and `summon --help` still installs the agent instructions as before.
- Wrapped Board lane rows leave room for a whole ordinary card at 1440x900, keeping its
  actions reachable. Taller cards still scroll within their lane.
- Board comment bylines wrap between author, timestamp and revision rather than splitting
  those tokens unnecessarily. A title's disclosure caret stays with its last word, and the
  comment count is hidden while the card's comments are open.
- The light-theme Connecting and Compacting letter sweep uses the text amber, keeping lit
  letters readable. The dark-theme color and reduced-motion behavior are unchanged.
- Roster shortcut numbers stop at 9, matching Ctrl+1 through Ctrl+9, with 0 reserved for the
  PM. Later rows have no number. Tighter row padding gives eleven rows 44 pixels more room;
  shorter windows can still scroll.
- The empty terminal instruction names the selected teammate and keeps "a teammate" when
  none is selected, using the existing shared start action.

## [0.28.3] - 2026-10-17

### Changed

- A brief Telegram refresh failure no longer posts a failed/recovered pair in the Room. A
  timeout, dropped connection, DNS error, HTTP 429 or 5xx is announced only after the transient
  episode passes a 60-second grace, and its recovery is posted only after that announcement. A
  link that fails and recovers on alternate refreshes is therefore never announced. A rejected
  token, other HTTP errors and recognized certificate-verification failures are still announced
  at once. The grace changes Room health notices; refresh failures and freshness are still
  reported to the caller.

## [0.28.2] - 2026-10-17

### Fixed

- Only typing in a teammate's own terminal renews their automatic interruption hold. Typing in
  the Room composer, Board search, notepad or a Maintenance field no longer extends the selected
  teammate's countdown. Automatic terminal replies do not renew the hold or write the operator view.
- The installer completion message no longer says storage protection is disabled by default.

## [0.28.1] - 2026-10-17

### Fixed

- Explicit rest confirmation preserves an existing needs-user status and its human-wait text.
  Confirmation is bound to that exact wait; changing it invalidates the old confirmation.
  Doing cards, unread work, schedules, launch identity and approval safeguards still apply.
  Rest does not approve the pending request or clear its raised hand.

## [0.28.0] - 2026-10-17

### Added

- An explicit checkpoint catch-up preview and apply command leaves a recent history tail,
  records older ranges as skipped, and retains addressed originals with reply context for lookup.
  Direct mail and approval holds keep their state. Interrupted application must be resumed before
  normal checkpoint or rest can continue. Superseded receipts cannot acknowledge unseen mail.
  Live apply remains on operator hold #13862 until compatible adoption and resident delivery
  reloads are verified and Phillip explicitly releases it; new-session instructions carry the hold.

### Fixed

- Resting teammates use the same label in the roster, header and statusbar; stopped teammates
  no longer show a placeholder Ready task. Human Board blockers and their opened headings use
  question amber, while satisfied blockers retain green.
- A substantive proposal delivered as a mail reply can be explicitly assessed, confirmed and
  held for the user's decision after a complete read. Confirmation does not approve the proposal;
  receipts, confirmations and notices remain ineligible for proposal confirmation.

## [0.27.2] - 2026-10-17

### Changed

- A POSIX-only test now covers the Telegram credential path that tightens permissions. An
  ordinary command finding `telegram.json` at 0644 in a 0755 folder restricts them to 0600 and
  0700 before reading. Previously only the read-only refusal branch was tested. No source
  change.
- The current-requests Telegram fixture now leaves its credential file private (0600 in a 0700
  folder). On Linux, five of those tests had failed because a read-only read correctly refused
  the default-umask file. No source change.

### Fixed

- If the Team Window page moves out of place, its watcher attempts to return the root and body
  to the top left. The fault record says whether that succeeded, includes the root scroll size,
  and identifies the outermost and innermost elements at the furthest unclipped reach. This
  extends the earlier page-movement diagnostics; it does not establish the cause of a blank window.
- Ready cards awaiting separate approval no longer prevent an agent from explicitly confirming
  rest after checking its work. Doing cards, unread work, due or unfinished schedules and status
  safeguards still block rest. Changes to cards or approval decisions still clear confirmation.
- Multi-cycle delivery fixtures use bounded execution budgets that include their receiver work.
  Retention routing checks each provider separately, preserving assertions and product timing.
- The page-shift UI fixture waits for each expected scroll record before checking it, avoiding
  failures when a rendered frame arrives after the former fixed wait. Extra-record and exit-code
  assertions are unchanged.
- Repository filter/signature security fixtures use a local integration-test budget for their
  Git setup and positive controls. Assertions and product subprocess limits are unchanged.

## [0.27.1] - 2026-10-16

### Fixed

- New checkpoint captures pack short history by complete output size instead of stopping at
  20 items per page. Compact text v2 preserves every field and full body; control-heavy items
  fragment to fit. Receipt, replay, mail coverage and existing frozen packages are unchanged.
  This reduces unnecessary history round trips without changing which posts are excerpts.
- Complete default JSON checkpoint pages also reserve headroom for escaped backslashes and
  nested fragments. Compact metadata escapes Unicode line separators and directional controls
  so short external fields cannot introduce apparent control lines.
- Provider workflow tests compare complete compact manifest metadata with the JSON view and
  verify page ranges, preserving identity and read-boundary checks across all four providers.

## [0.27.0] - 2026-10-16

### Added

- Named sessions can preview their own mailbox files with `--mail-retention preview`. The paged
  inventory reports sizes, stable-file hashes and retention reasons without marking mail read,
  handling requests or changing checkpoint state. Optional citation pins recognize abbreviated
  IDs and retain every ambiguous match. This first step keeps every file; cleanup and automatic
  retention are still pending.
- Owners and the operator can update a schedule's future prompt using
  `--schedule update-prompt`, with an expected-prompt comparison and UTF-8 JSON file input.
  Schedule timing, ownership and existing run snapshots remain unchanged.

### Fixed

- The Windows retention preview now holds checked paths against replacement while the same
  worker reads them. Pin files and mailbox ancestors cannot be swapped for redirects between
  validation and access. Unsupported platforms or contended paths refuse the preview.
- Pin ownership uses the held file's resolved location so Windows short-name aliases cannot
  conceal private storage. Directory observation uses handles and relative file opens while
  allowing ordinary delivery, marker and status atomic saves.

### Changed

- `summon --rest ready` now sets the caller's own status to idle "Ready" when it confirms rest, so
  going to rest is one command. A separate `summon --status idle "Ready"` first still works. When
  rest is refused, for unread mail, cards, schedules, a room mention, another launch or a status
  that changed while rest was being checked, the status is left as it was. A needs-user status is
  kept, because it means the agent is waiting on the user, and rest is refused instead.
- The fleet reconciliation skill reads development entries from `beazley.org/devdiary` after
  the DevDiary move. The entry folder remains unlinked and ignored by the site.
- The checkpoint test that sends a 31-notice burst now has a 20-second time budget instead of
  Bun's 5-second default, which it crossed under full-suite load. Its checks are unchanged; the
  budget is a test-harness limit, not a promised notice latency.

## [0.26.0] - 2026-10-16

### Added

- Team settings has two new Display checkboxes. One hides the sidebar's amber "Furthest behind"
  line and the other hides its amber delivery alerts ("Delivered, awaiting read confirmation").
  Both are on by default, take effect at once and are remembered per window. Hiding a line doesn't
  stop the room-progress reading or the delivery watch behind it.

## [0.25.0] - 2026-10-15

### Added

- Each sidebar row shows a small number left of its avatar: the first PM is 0 and the other
  visible rows count from 1. Filtered-out rows get no number, and the visible count starts at 1
  when the first PM is not in view. Numbers above 9 have no keyboard shortcut.

### Changed

- **Ctrl+1** to **Ctrl+9** now select the teammate showing that number, so they skip the pinned
  PM, which stays on **Ctrl+0**. Before, Ctrl+1 selected the PM as well, and the ninth teammate
  had no key.

### Fixed

- Confirming Zzz/rest readiness no longer sends mail to any PM or adds a rest notice to an
  unrelated work notification. Rest remains visible in the sidebar and `summon --rest candidates`;
  existing stop permissions and the operator's stop pause are unchanged.

- Startup instructions state the session's member type and actual stable registration identifier.
  Each domain roster entry includes its registration identifier and role, so repeated display
  names remain distinguishable. Commands and mailbox delivery use the identifier; role labels
  grant no new permissions. Applies to Claude, Codex, Grok and Kilo startup instructions.
  Existing sessions load the wording on their next approved restart after adoption.

## [0.24.0] - 2026-10-15

### Added

- `summon --registration show|request|edit|audit <name>` lets the operator or the registered PM change another
  teammate's expertise and domain without launching, waking or stopping any session. Text comes
  from UTF-8 files, every other field is refused, PM targets are refused, and an edit must name the
  revision it read. A PM first posts the exact edit as an operator approval with `request`. The
  approval shows the new text, or for long text a write-once proposal file named by its sha256.
  The PM then cites the operator's Yes, which counts only for that PM's own request, word for word
  as generated for that exact edit.
  Each edit is logged as an intent before the record changes and marked applied afterwards.
  `summon --registration audit` reconciles any edit left without an outcome by hash. New text
  reaches the next startup prompts; running sessions keep their context until they restart. The
  PM's built-in instructions describe the new workflow.

- The Team Window records renderer exit, reported hangs and recovery, failed main-frame loads,
  and preload failures in fault history. Failure lines include the last page layout received,
  its age or an explicit unavailable state; recovery records the hang duration.
  Page movement records its offset, page and window sizes,
  and focused element once per episode. Diagnostic reasons retain the journal's first-line and
  redaction rules. Chromium may not report every hang; missing evidence does not explain an
  earlier blank window. Nothing new reloads or restarts the window. Claude, Codex, Grok and Kilo
  behavior is unchanged. Reopen the Team Window after an approved update to begin capture.

### Changed

- For a registered name, `summon <name> --expertise` and `--domain` now run the same checked
  edit as `summon --registration edit`. That means the caller rules, a required `--revision`, the
  character and stale checks, and the audit; a PM also needs `--decision`. The command never
  launches the name. Stopped names previously rewrote the record unchecked and continued to launch;
  running names returned without editing. Registering a new name is unchanged.
- Team Maintenance now refuses to save expertise or domain text that someone changed after the
  form loaded it. The typed values stay in the form, and a Show stored text button swaps between
  the stored text and the operator's own before saving again. Saves that leave the text untouched
  behave as before. The form now refuses control and bidirectional characters in that text, as
  the CLI does. Reopen the Team Window after the update.
- Startup prompts now mark a teammate's registered expertise and domain with markers keyed to the
  text's own digest, and quote each roster domain. The markers make the boundary explicit. They
  are a formatting boundary, not a guarantee about how a model behaves. The PM's code-owned text
  is shown without markers, as before. The registry join instructions say the same about the raw
  records. This applies to Claude, Codex, Grok and Kilo alike, which all read the same prompt; it
  takes effect at each session's next launch.

## [0.23.0] - 2026-10-15

### Added

- Ctrl+0 selects the PM: the first PM on the team, whatever its state, even while it rests and a
  filter such as Active hides its row. Like Ctrl+1 to Ctrl+9 it acts as a click on the row, so a
  running PM's terminal takes focus, and it starts or wakes nobody; the window takes the key
  before a terminal sees it. Claude, Codex, Grok and Kilo behavior is unchanged. Reopen the Team
  Window after the update.

## [0.22.0] - 2026-10-15

### Added

- Teammates registered as PM are listed first in the sidebar, so Ctrl+1 always selects the PM.
  Several PMs keep their existing order among themselves and everyone else keeps theirs. A filter
  that hides a PM hides its row like any other, and Ctrl+1 then selects the first row shown.
  Claude, Codex, Grok and Kilo behavior is unchanged. Reopen the Team Window after the update.
- A teammate's status letters now light in turn while it reads Connecting, Logging in or Summon
  startup, as they already did on Compacting, in the sidebar and the session header alike. A
  launch still in the same phase after five minutes is treated as stuck and holds still at that
  moment, even when nothing else changes in the window. Busy, Needs you and the settled states
  stay still, and reduced-motion settings still hold every label still. Claude, Codex, Grok and
  Kilo behavior is unchanged. Reopen the Team Window after the update.
- The Board gives the operator two more actions. Move to Ready starts a Backlog card that has an
  owner and no blocker and tells the owner in the room, as Allow work does. Change owner gives a
  card to another registered teammate; the new owner and the previous one are told only when the card is
  already Ready or further. Both save at the revision shown and refuse a stale card. Claude, Codex, Grok and
  Kilo behavior is unchanged. Reopen the Team Window after the update.
- Source installations can install one standing Windows update and rollback command with
  `bun run setup:updater`. It remains outside the checkout, refuses running sessions, retains
  the previous installed build before changes, and runs the full gate on the exact selected
  commit. Rollback preserves main and verifies the previous build ID. The operator chooses
  when to close and reopen the Team Window and Claude, Codex, Grok and Kilo sessions; the
  command never stops or starts them. Interrupted rollback retries retain the original target;
  setup shares the maintenance lock and preserves incomplete installation evidence.
- The Team Window has a Schedules panel, opened from the sidebar like Board, Diary and Repos. It
  lists every Summon schedule by owner: how often it runs, whether it is active, paused, due,
  waiting (with the reason) or mid-run, when it is next due and how its last run ended. A row
  opens to show the duty's instruction. Teammates with no schedule are named at the end. It is
  view only: nothing in it creates, pauses, runs or dispatches a schedule. Team Room now has a
  row to itself above the six tool buttons. Claude, Codex, Grok and Kilo behavior is unchanged.
  Reopen the Team Window after the update.
- Rest-ready teammates now use a dimmed full-width row with a purple Resting label and a Zzz
  stop control in the dot position. Mail and raised-hand badges retain full strength; the stop
  action and keyboard focus remain unchanged. Observed compaction, launch and unavailable states
  retain their labels. Hidden head-down rows also hide their controls.
  Reopen the Team Window after adoption; Claude, Codex, Grok and Kilo behavior is unchanged.
- The sidebar presence filter now offers All, Active, Online and Offline. Active hides offline
  teammates and those showing Zzz, remembers the choice and combines with the CLI filters.
  Teammates reappear when their rest confirmation ends. Reopen the Team Window after adoption;
  this filter does not change Claude, Codex, Grok or Kilo session behavior.
- Delivery watchdog alerts and their resolutions now reach registered PM-role accounts by mail,
  once per observed episode. Offline PMs receive queued mail; long working turns do not produce
  repeated alerts. PM accounts keep their own operator-visible alerts without recursive mail.
  Communication controls remain in force, and alerts grant no retry or lifecycle authority.
  After adoption, restart the Team Window and its Claude, Codex, Grok and Kilo sessions to load
  the updated receivers.

### Changed

- Telegram request failures no longer refuse local mail, Room, Board or Diary writes, or
  prevent checkpoint catch-up. Writes warn and retain the recorded halt state; checkpoints
  explicitly report that only local and cached records were read. Remote updates remain pending
  for recovery. Invalid local state and configuration still refuse. This shared behavior affects
  Claude, Codex, Grok and Kilo; resident receivers require an operator-controlled restart after
  adoption. No sessions are restarted by this change.
- Add Knip's `check:dead-code` to the full quality gate. Update Zod to 4.6.6, Bun types to
  1.4.3, Node types to 26.6.5 and Prettier to 3.9.10, with the lockfile and dependency notices.
- Local commands wait about one second for an occupied Telegram poll lock, then report cached
  state and still check the recorded halt. Frozen checkpoint packages retain their outage
  warning on replay, continuation, final receipt and manifest. Package format compatibility
  must be checked against the resident receiver before changing the linked writer.
- Actual Telegram sends retain their strict refresh and poll-lock checks; cached-state
  fallback applies to local work only.
- Telegram request failures and recovery produce deduplicated local Room notices so persistent
  authorization or TLS failures are visible to the operator. Notices obey recorded halt;
  ordinary poll contention uses distinct incomplete-refresh wording.
- The Team Window footer shows its build time in the viewing machine's local time, with the
  zone named; hovering the time shows the UTC original. build.json keeps the UTC instant.
  Affects the Team Window only, not Claude, Codex, Grok or Kilo sessions; a Team Window
  restart after adoption loads it.

### Fixed

- Copy delivery details on a Team Window delivery alert now copies through the window's own
  clipboard, like room copy, instead of the page clipboard that refused with "Write permission
  denied". The button reads Copied for a moment on success, or Not copied with the reason in the
  error banner.
  Reopen the Team Window after adoption.
- Generated teammate rest-readiness mail remains readable bookkeeping for the PM, without
  ending the PM's rest, waking it by itself, or starting a delivery-watchdog episode.
  Current readiness can accompany a notice for real work. Requests and approval wakes remain
  unchanged; older request-kind mail is not reclassified from its wording. This does not grant
  stop permission or restart sessions; installed receivers require separately authorized adoption.
- The Team Window can no longer be scrolled as a whole. Page Up in a teammate's terminal could leave
  every column shifted up into a strip at the top of the window, which no key could undo, only a
  restart. Reopen the Team Window after adoption.
- New checkpoint outage packages keep the strict version-1 envelope readable by the
  ae53f97 receiver. Frozen warnings live in the existing extensible page payload and remain
  visible through the final receipt in current readers. Previously written extended envelopes are read without
  rewriting their hashes; they still require a compatible receiver to finish.
- Checkpoint manifests expose the current page/final position and receipt fingerprint for diagnosis,
  without exposing a usable receipt before its page is read.
  This neither acknowledges the page nor repairs a stuck cursor.
- Sessions with an own task can interleave historical checkpoint pages with work using
  `--checkpoint --work`. Final acknowledgement stops at the frozen package boundary,
  leaving later arrivals unread for the next work boundary. Startup guidance puts current
  mailbox readiness and the first status call before historical catch-up; live notices and
  receive skills direct sessions back to their task. Addressed traffic remains available
  through the focused reader. Native busy-room acceptance remains separate.
- Repos reads local and worktree Git filter configuration concurrently before running
  status, diff or history commands, reducing refresh latency while preserving filter
  suppression and unreadable-scope handling.
- A current registered Claude, Codex, Grok or Kilo session can save its own missing notes
  using the empty revision returned by read. Concurrent and stale edits remain refused;
  owner, file safety and size checks still apply. Use the updated CLI after adoption;
  this change does not restart sessions.
- Mail receive output now labels the pending view and explains that complete bodies are marked
  read while requests remain pending until handled and explicitly acknowledged. Header-only
  entries and read-only archive output retain their distinct meaning. Pagination and archival
  behavior are unchanged for Claude, Codex, Grok and Kilo. After adoption, the next CLI invocation
  uses the new wording without a restart. Restart a Claude session to update its in-process
  mail channel.
- A delivery alert's line in the sidebar is the size of the status lines above it, not the size
  of a teammate's name. Claude, Codex, Grok and Kilo behavior is unchanged. Reopen the Team
  Window after adoption.
- Delivery watchdog alerts leave the sidebar when read progress brings every outstanding wait
  below the alert threshold. The episode stays pending, so a later stall can show the alert again
  without another PM notification. Other overdue items still require attention. This shared
  behavior affects Claude, Codex, Grok and Kilo; after adoption, restart the Team Window and its
  sessions to load the updated watchdog.
- Grok launches recover their own unchanged hook after an earlier runner was forcibly stopped,
  once the session lock confirms neither that runner nor its provider remains. Ownership records
  preserve other sessions' hooks, user edits and older unrecorded files. Interrupted publication
  with uncertain ownership leaves hooks untouched and notices queued for manual inspection.
  This affects Grok only; Claude, Codex and Kilo are unchanged. After adoption, newly started
  Grok sessions use the recovery; existing sessions must be restarted to gain the ownership record.
- Dismissing a delivery alert removes it from the sidebar without leaving a dismissed-details
  section. Keyboard focus moves to a remaining alert or the panel anchor. Delivery evidence and unread work
  remain unchanged for Claude, Codex, Grok and Kilo. Reopen the Team Window after adoption.
- Watchdog PM updates distinguish lost observation state from verified retirement, ignore transport
  confirmations as outstanding work, and suppress never-published alerts after their episode ends.
  Diagnostic mail omits launch nonces; damaged relay journals retain evidence for operator recovery.

### Known limitations

- Codex retains write access to the whole configured Summon store. Mail command ownership
  checks do not isolate direct filesystem writes between teammates. Narrower access and a
  shared-store broker are deferred beyond v1.0 by operator acceptance.
- Kilo's configured LM Studio URL accepts arbitrary HTTP(S) hosts. Prompts and context can
  reach the configured server; plain HTTP is unencrypted. Remote-host policy is deferred
  beyond v1.0 by operator acceptance. These documentation changes alter no Claude, Codex,
  Grok or Kilo behavior and require no restart.

## [0.21.4] - 2026-10-12

### Fixed

- Each roster provider filter is enabled only when the CLI panel's version check says Found.
  Checking, missing and failed results disable that provider's filter; saved-hidden teammates
  remain visible while their filter is unavailable. Refreshing the CLI check updates the filters
  without losing saved preferences. Applies individually to Claude, Codex, Grok and Kilo; sign-in
  and entitlement are not checked. Reopen the Team Window after adoption. This candidate also
  includes the delivery changes above 0.20.0, which require fresh owned-session launch nonces.

## [0.21.3] - 2026-10-11

### Fixed

- Watchdog diagnostic failures now use their own retained files instead of adding a stage to the
  shared wake-error index. This keeps that index readable by the prior 0.20.0 build during an
  operator rollback. Failure and recovery remain visible in mail status, and active failures appear
  in member details. Diagnostic damage does not hide ordinary mail status. Reopen the Team Window
  and every owned session with fresh launch nonces after adoption or rollback; no records are
  deleted or converted. Version 0.21.2 was an unadopted recovery-build experiment, superseded by
  this storage separation.

## [0.21.1] - 2026-10-11

Combines the 0.21.0 delivery watchdog and the Claude startup correction for one adoption.
Reopen the Team Window and every owned session; old launch nonces cannot be reused.

### Fixed

- Claude's first ordinary delivery notice now waits for the native observer to report an idle
  turn with a clear draft, just like later notices. Readiness no longer bypasses this gate during
  startup. The positional startup prompt still starts the session; control delivery is unchanged.
  This prevents a confirmed startup gating race, but does not establish native acceptance of Enter
  or explain every previously stranded editor notice. Reopen the Team Window and its owned sessions
  after adopting this change; no automatic input retry is added. An unattached observer leaves
  ordinary notices queued; use checkpoints. Claude's obsolete bootstrap state field is removed
  from its new per-launch schema. Old launch records are refused, not converted in place; the
  required restart supplies fresh launch nonces. Grok and Kilo retain their existing bootstrap gates.

## [0.21.0] - 2026-10-11

Includes previously adopted changes retained under Unreleased. The delivery watchdog requires
reopening the Team Window and its owned sessions after adoption. No data migration is needed.

### Changed

- Startup instructions state whether Summon selected a fresh or saved provider conversation.
  They also explain that notes and mailbox history remain available and that a fresh launch
  does not clear provider memory or project instructions.
- The state words Ready and Busy are written in their dot's colour, green and amber, in the
  sidebar and beside the name in the session header. The light theme uses a darker amber for the
  word so it stays readable. Other state words are unchanged.
- Team Maintenance has two tabs. Person holds one teammate's record, with the optional fields
  shown under a plain heading; Team holds delivery, interruption holding, display preferences and
  CLI setup. Nothing is folded away, and the dialog keeps one size on both tabs. Team settings in
  the sidebar opens the Team tab directly, including with nobody registered. The result line now
  sits beside Save Teammate. No setting changes what it does or where it is stored.

### Added

- Delivery details show eligible unread work waiting for five minutes and one operator alert
  after ten minutes without relevant read progress. The alert distinguishes blocked delivery,
  submitted or uncertain input, and an unavailable inventory. It covers Claude, Codex, Grok
  and Kilo, suspends under communication controls, and never sends a second notice or Enter.
  Dismissal hides that alert without marking work read. Reading can satisfy the watch even
  when an old notice remains in the CLI editor; this does not repair or detect that stale draft.
- Ctrl+Shift+J opens Jump: type a Room message number, the start of a Board card id or a
  teammate's name and press Enter to go there. Ambiguous entries list every reading, labelled by
  kind. It matches numbers, ids and names only, and the window takes the key before a terminal
  sees it. A card reached this way is shown on the Board whatever the owner filter, archived
  included.
- Ctrl+1 to Ctrl+9 select the first to ninth teammate shown in the sidebar, following the
  filters. Selecting this way is the same as clicking the row. The window takes these keys before
  a terminal sees them, so a CLI no longer receives Ctrl plus a digit from 1 to 9; every other
  key reaches the terminal as before.

### Fixed

- Checkpoint can replay and acknowledge frozen packages containing generated notice metadata.
  Existing packages and receipts remain intact; new packages are validated before publication.
- New generated rest reminders and rest-ended mail identify their launch and originating episode.
  Obsolete notices remain readable and pending without triggering another wake or blocking rest;
  ordinary requests and older messages without this metadata keep their existing handling.
  A new launch's wake notice stays eligible while old activity awaits replacement, as does a
  reminder when its session becomes busy. Unknown notice metadata remains readable and eligible.
- New receivers do not replay a historical unhibernate instruction. Active hibernation and
  subsequent operator transitions still reach the session, including a release owed to a
  conversation hibernated before its previous launch ended. An already covered release
  cannot wake a later launch that has confirmed rest. The last attempted control is retained
  across unheard operator transitions, preserving owed releases without replaying completed cycles.
- Rest status distinguishes a retained confirmation's launch from the latest recorded activity
  launch, without treating matching records as readiness or permission to stop.
- Own mail status and work snapshots recognize the current launch's readiness acknowledgment
  even when the retained receiver status is unconfirmed. They preserve delivery failures and uncertainty;
  a status read never sends input or marks the receiver healthy.

## [0.20.0] - 2026-10-10

This section includes previously adopted changes that remained under Unreleased. Updating from
the installed 0.19.0 build requires no new data migration. Restart the Team Window after adoption;
the approved operator procedure closes its sessions before rebuilding.

### Changed

- Raise the required Bun runtime and packaging baseline to 1.4.3. TypeScript remains on 6.0.3.
- Room pages, search, progress and appends scan archived segments instead of collecting the
  complete history. Archive-body caching is limited to four small segments; historical IDs,
  replies and corruption checks are preserved. Warm page and progress queries reuse validated
  results until live or archive signatures change. Full-history consumers still share their
  existing complete-history cache; the whole-application memory bound remains open.
- Repository refreshes combine branch, tracking and change counts in one Git status read and
  resolve each teammate working folder once per refresh.
- Team Window runtime files share one path definition without moving existing settings or data.
- Eligible idle Grok and Kilo sessions attempt `/exit` before forced termination, with a five-second grace period.
  Stop, rest stops and window shutdown share the path; known drafts and busy sessions skip it.
  Claude and Codex retain forced termination because idle observations cannot rule out an overlay or approval prompt.
- Claude, Codex, Grok and Kilo launch with `AIDD_AGENT=1` so installed repository push guards
  apply to teammate sessions. Existing sessions require a restart to receive the environment.
- Contributor push hooks reject deletions and non-fast-forward ref updates from processes
  marked with `AIDD_AGENT`, while allowing new refs and fast-forward updates.
- Copied room details show provider, model, reasoning and exact capacity values directly,
  without an explanatory heading or repeated field labels.
- Session headers, provider tooltips and copied details use the same ordered facts, including
  the working folder and Claude account label. Missing values name the field that is absent.
- Team notepad stores its Markdown source in `notepad/note.md`. Existing teams need a one-time
  rename from `note.txt` while their window is closed; adoption must refuse a destination collision.

### Fixed

- Inactive rest polling avoids lock writes while keeping in-flight confirmations and active
  rest transitions protected by the existing lock. Automatic notice decisions still acquire
  the lock; transient Windows lock-read denials take the locked path.
- Roster snapshots reuse unchanged avatar image data and discard cached images when the file
  changes, disappears or leaves the roster.
- Room copy controls retain keyboard focus during clipboard writes, and context capacity stays
  beside reasoning in provider tooltips.
- Claude refreshes its draft observation after local commands complete, without treating
  command completion as proof that the session is idle. `/reload-plugins` has native acceptance;
  other commands have regression coverage and still need native acceptance.
- Claude retains authenticated context capacity when a later transcript write records the same
  model. A different model never inherits the previous model's capacity.
- Codex compaction backfill avoids repeatedly hashing rollout prefixes for ordinary appends and bounds
  shutdown draining. Unfinished backfill is reported and can replay on the next launch.
- Grok compaction history accepts native timestamps with explicit UTC offsets, preserving their
  precision instead of silently dropping events whose timestamp does not end in `Z`.
- For Claude and Grok, two human Escape keys within 500 ms clear Summon's draft flag, matching
  the measured CLI input behavior. A single Escape, pasted text and automatic protocol replies
  do not clear it. Pair timing uses a monotonic clock; this adds no draft-clearing rule for Codex
  or Kilo and does not itself erase the CLI's text.
- Claude can recover queued notices after an observer reload when a subsequent native idle
  notification confirms the same session has no active turn, compaction or input draft.

### Added

- Board search finds titles, owners and card text across owners. It offers matching cards or
  all live cards with highlights, includes matching archived cards by default, and restores
  the selected owner when cleared. Folded matches are identified without opening cards.
- Ctrl+F searches the Notepad editor, Markdown preview and saved copy without changing the note.
  Matches ignore case; Enter or F3 steps forward, Shift+Enter or Shift+F3 steps back, and Escape
  closes the bar. Large-note searches count every match while limiting drawn highlights, and
  highlights follow changes to line wrapping.
- While Claude reports compaction, the letters of Compacting light in sequence in both the
  roster and header. Reduced motion keeps the label still. Codex, Grok and Kilo retain their
  existing labels; this adds no new provider observation or input behavior.
- Recorded context capacity beside session model settings, with provider observations and
  reasoning/capacity changes retained in model history. Missing capacity is not inferred.
- A repository and team storage guide identifies durable records, runtime evidence and generated
  files, including what member archival preserves and why runtime folders need individual review.

## [0.19.0] - 2026-10-08

### Added

- `summon --compactions` reads a teammate's retained compaction observations after the event.
  Claude records observed starts and ends, Grok records PreCompact and PostCompact hooks, Kilo
  records owned stream events, and Codex reads compaction metadata from its exact bound rollout.
  Resuming the same Codex thread does not count previously retained events again. Records keep
  phase, observation time, available native time and a hashed identity, without conversation
  text, compaction summaries, raw thread IDs or credentials.

Claude, Grok and Kilo collect future observations after relaunch; they do not reconstruct earlier
events. Codex can backfill the bound thread through the verified 0.161.0 rollout shape. Missing or
unrecognized provider evidence does not prove that no compaction happened. Source fixtures cover
all four collectors; native acceptance remains separate. After adoption, restart the Team Window
and relaunch Claude, Codex, Grok and Kilo to load their collectors. This change performs no provider
start, restart or production adoption.

## [0.18.0] - 2026-10-08

### Added

- Maintenance settings can turn the automatic interruption hold off and set its countdown from
  5 to 600 seconds. The pinned Hold Interruptions button remains available either way.
- The Team Window shows Compacting… in a Claude teammate's roster row and session header while
  its authenticated native observer reports context compaction. The saved task and attention
  state remain available, and the label clears when the observed compaction ends.

### Fixed

- Switching windows with Alt+Tab, Alt+Escape or the Windows key no longer renews the automatic
  interruption hold on the teammate being left. Typing at the teammate still renews it.
- Session headers and roster rows keep their task line's height when an idle Ready teammate
  has no task text, so switching teammates or completing work does not move the controls.
- Failed or aborted Claude compaction balances its native observation while preserving the
  original result or error, so an unmatched start does not leave the display or notice gate set.
- In Claude's existing Live delivery mode, authenticated native events determine whether a turn
  is running. An ignored empty Enter no longer marks it busy indefinitely. Terminal delivery
  retains its draft and submission guards; the selected delivery mode does not change.

Source fixtures cover nested compactions, stale launches and unavailable observations. Native
display acceptance remains separate. Codex, Grok and Kilo retain their existing labels because no
equivalent native signal has been verified. After adoption, restart the Team Window to load the
display and interruption changes. The shared hold controls and layout affect Claude, Codex,
Grok and Kilo. Claude's Live input correction needs separate native acceptance; Codex, Grok and
Kilo delivery paths remain unchanged. This release does not start or restart providers.

## [0.17.10] - 2026-10-08

### Changed

- Active teammate notes are limited to 16 KiB of UTF-8 text across the notes CLI, profile editor,
  appends and cloning. Startup includes the complete notes instead of silently omitting older
  text. Existing oversized files must be preserved and compacted by their owner before launch;
  oversized writes leave the original file unchanged.
- The notes editor preserves oversized pasted text for revision instead of shortening it in
  the browser before the byte-limit check can report the problem.

This affects notes for Claude, Codex, Grok and Kilo. Source fixtures cover each provider and
multibyte boundaries; live acceptance remains separate. After adoption, restart the Team Window
and relaunch affected sessions to use the complete bounded notes. Longer history belongs in the
owner's scratch archive.

## [0.17.9] - 2026-10-08

### Fixed

- Submitting a message during an active Claude turn preserves that turn's completion tracking.
  When Claude incorporates the message into the running turn, ordinary notices can resume after
  its verified completion and a clear draft. The guard before physical Enter remains in place.

Source and installed offline-engine fixtures cover this correction. Live acceptance remains
separate, and this does not resolve every reported missing notice. After adoption, restart the
Team Window and relaunch affected Claude sessions. Codex, Grok and Kilo delivery code is unchanged.

## [0.17.8] - 2026-10-07

### Fixed

- Codex saves its verified conversation ID when the session binds, before publishing the binding.
  A forced Team Stop no longer depends on the wrapper reaching its after-exit save. Stale launches,
  conflicting threads and changed providers cannot replace the current saved conversation.

Source tests cover fresh, resumed and cleared bindings, concurrent profile edits and a forced
fixture process-tree stop followed by exact resume. Adoption and live Codex acceptance remain
separate. After adoption, restart the Team Window and relaunch affected Codex sessions. Claude,
Grok and Kilo session-saving behavior is unchanged by this correction.

## [0.17.7] - 2026-10-07

### Fixed

- Reloading the Claude observer withdraws its previous idle state before observing new work.
  The authenticated bridge issues each attachment a generation; events from a retired attachment
  cannot complete the current turn. Observation failure still preserves native submission and
  compaction results.

Source and installed-engine fixtures cover the correction. Live reload acceptance remains separate;
after adoption, restart the Team Window and relaunch affected Claude sessions. Codex, Grok and Kilo
completion adapters are unchanged by this correction.

## [0.17.6] - 2026-10-07

### Fixed

- Claude ordinary notices wait for an observed completion of the exact owned native turn and a
  clear input draft. Both the terminal receiver and MCP channel reserve the next submission;
  repeated readiness, old completions and uncertain writes cannot queue another notice turn.
- A launch-owned Claude mod reports turn, draft and compaction metadata without changing prompts,
  tool permissions or core event results. Main compaction blocks notices while it runs. Missing,
  interrupted or invalid observation keeps ordinary notices queued for checkpoint reading.

After adoption, restart the Team Window and relaunch affected Claude sessions to load the observer.
The mod requires Claude Code's native mod support (2.1.287 or later); no provider is upgraded or
trust check bypassed. Source and offline-engine tests do not establish live Claude acceptance.
Codex, Grok and Kilo completion contracts are unchanged by this delta; their earlier adoption and
native acceptance requirements remain separate.

## [0.17.5] - 2026-10-07

### Fixed

- Rapid member switches keep the latest requested selection. A slower offline-member lookup or
  older snapshot cannot replace it or hide its focused terminal. Routine refreshes skip snapshots
  for a selection that has already changed.

This change requires a Team Window restart after adoption. Earlier Electron and Kilo adoption
requirements remain separate; no session is restarted by this correction.

## [0.17.4] - 2026-10-07

### Fixed

- Repositories' “Switch to member” action now puts the caret in the selected running terminal,
  using the same selection handling as roster clicks and Enter. A later selection from either
  surface prevents an older request from moving the caret.

This renderer change requires a Team Window restart after adoption. Offline member creation
continues to focus its Summon button. The earlier Electron and Kilo adoption requirements remain.

## [0.17.3] - 2026-10-07

### Changed

- The Team Window uses Electron 44.7.0 with upstream browser/runtime fixes. Claude's MCP channel
  uses SDK 1.32.1, and development linting uses typescript-eslint 8.71.1. TypeScript remains 6.0.3.

Adoption requires closing all Team Windows before replacing their installed Electron runtime,
then reopening the Team Window. Native acceptance for Claude, Codex, Grok and Kilo remains separate.

## [0.17.2] - 2026-10-07

### Fixed

- Selecting a running member by clicking its row or pressing Enter puts the caret in that
  member's terminal. Offline rows keep focus. Routine refreshes leave the composer and notepad
  alone, and failed or superseded selections cannot move the caret later.

This renderer change requires a Team Window restart after adoption. It adds no member Stop/Resume
requirement. The Kilo observer's separate adoption requirement from 0.17.0 still applies.

## [0.17.1] - 2026-10-07

### Fixed

- Kilo readiness can bootstrap before its native observer attaches. Reattaching a receiver
  preserves the outstanding turn and its observer instead of reopening delivery.
- Grok and Kilo keep notices blocked while human Enter marks the turn busy and reaches the
  terminal. New typing and an uncertain submission retain the draft gate.

These source fixes require a Team Window restart after adoption. Kilo observer adoption also
requires Stop/Resume of affected Kilo sessions. Native acceptance remains separate.

## [0.17.0] - 2026-10-07

### Added

- Owned Kilo sessions receive one outstanding wake. Later unread work waits for an observed
  native busy-to-idle transition and a clear human draft, then arrives in one refreshed notice.
  A manual Ready status cannot release the gate, and readiness reminders are deduplicated by launch.

The observer uses the existing authenticated server owned by that Kilo launch, subscribes before
startup input, and retains only completion metadata for the exact session. A disconnected or
invalid event stream closes the gate; startup and explicit checkpoints remain available.
Repeated idle observations cannot release a new reservation. Uncertain writes are not replayed,
and notice delivery does not acknowledge mailbox bodies or Room and Telegram cursors.

Claude, Codex and Grok retain their current completion paths. Their new native acceptance remains
separate. After adoption, restart the Team Window and Stop/Resume its affected Kilo sessions to
load the observer. This source revision does not perform a restart or establish real CLI acceptance.
Grok's Ctrl+U defect and the pending Claude/Codex completion adapters remain separate work.

## [0.16.0] - 2026-10-07

### Added

- `summon --current-requests [cursor] [--format text]` brings exact addressed Room, cached
  Telegram and unread own-mail bodies forward before historical catch-up, with available
  reply and approval context. New requests from each source precede its older requests.
  Fresh reads include later arrivals during an existing frozen checkpoint.
- Startup instructions and live notices direct teammates to the focused reader first.
  The existing latest-human preview remains available for large Room backlogs.
- The notepad fills the requested working area at the operator's screen size. Ctrl+X deletes
  an empty line, Alt+Z toggles wrapping and Alt+Up/Down moves the current or selected lines.
  Edits follow the existing draft and save path; wrapping is remembered for the window.
- Reopening the notepad restores the remembered caret and scroll when its text matches.
  Changed text loaded from disk starts at the top instead of placing the caret at the end.

The focused view does not acknowledge history, record mail coverage, change holds or issue
a checkpoint receipt. Continue the original ordered pages and final receipt; no history may
be skipped. Continuations expire visibly if their source bodies change. Telegram reads use
cached history without refreshing the network, and private reply context is limited to the
named session's own inbox and archive. Missing context is reported rather than inferred.

### Fixed

- Owned Grok sessions receive one outstanding wake per launch. Later unread work waits for
  Grok's native idle notification and a clear human draft, then arrives in one refreshed wake.
  Readiness reminders are deduplicated by launch; writing a notice never acknowledges its bodies.

Each owned Grok launch installs a uniquely named local hook file and removes it on normal exit
if its contents are unchanged. Existing hooks and trust settings are preserved. Grok's idle
notification normally follows a settled turn by about a minute. If observation is unavailable,
ordinary notices stay queued and checkpoints remain available. Claude, Codex and Kilo retain
their existing delivery paths. Halt, head-down, startup and hibernation controls remain in force;
uncertain writes are not replayed. Ctrl+U draft clearing is a separate unresolved defect.

The shared instructions and notices affect Claude, Codex, Grok and Kilo. After adoption,
restart the Team Window and affected named sessions to load resident notice code and fresh
startup instructions, including owned Grok hooks. Source and fixture checks do not establish
native provider acceptance. Nothing restarts automatically.

## [0.15.0] - 2026-10-07

### Added

- `summon --session-history` reads retained Team Window starts, stop requests, completed stops,
  exits and failed stops. Launch identities link a later start to its preceding owned session.
  Records contain lifecycle metadata, without terminal input or message bodies.

The journal covers owned Claude, Codex, Grok and Kilo sessions after the Team Window reloads.
It keeps at most 2,000 transitions within 2 MiB and reports read limits explicitly. It cannot
reconstruct earlier events or prove provider turn acceptance. No provider configuration changes
or separate session restart is needed for this journal alone; inherited phase and rest changes
retain their own acceptance and restart requirements.

## [0.14.4] - 2026-10-07

### Fixed

- Unread mail confirmations and receipts stay available to read without ending confirmed rest.
  Requests and replies carrying work still invalidate readiness.
- PM readiness notifications run after the rest state lock is released. The roster reads
  committed rest state, while automatic wakes wait through contention and stop requests still
  revalidate consent. Lock contention does not imply a failed wake or terminal input.

These shared rest paths affect Claude, Codex, Grok and Kilo. Restart the Team Window and
affected named sessions after activation to reload the resident rest and notification code.
No existing session is restarted automatically, and the operator's rest-stop pause remains.

## [0.14.3] - 2026-10-06

### Fixed

- Queued runtime diagnostics stay in the team that created them, even if the process's storage
  environment changes while saving. A missing originating root refuses the save instead of
  recreating it or writing into another team. Existing diagnostic evidence is preserved.

The shared journal is readable by Claude, Codex, Grok and Kilo; their provider delivery paths
are unchanged. Restart the Team Window after activation to load this correction. No separate
provider-session restart is needed for this journal fix.

## [0.14.2] - 2026-10-06

### Fixed

- An owned running session keeps its row and Select/Stop controls when its saved status or
  registration is unreadable. The row and header show Status unavailable until recovery;
  the public launch view also remains unavailable. Missing records cannot create a new session.

The correction affects the shared Team Window view for Claude, Codex, Grok and Kilo. Restart
the Team Window after activation. Existing-member Stop/Resume and native acceptance remain
required for the underlying launch-phase addition; this row correction adds no provider observer.

## [0.14.1] - 2026-10-06

### Fixed

- The public launch view reports unavailable when an owned running member's roster record
  cannot be read. A partial list cannot appear complete or replace that uncertainty with an
  empty result. Restoring the record restores the current view.

This publisher correction affects the shared view for Claude, Codex, Grok and Kilo without
changing their observer paths. Restart the Team Window after activation; existing-member
Stop/Resume and native acceptance remain required for the underlying launch-phase addition.

## [0.14.0] - 2026-10-06

### Added

- `summon --launch-status` exposes the owning Team Window's active launch phases for a
  coordinator to check. It includes member names, providers, phases, evidence labels and times,
  without private session IDs, tasks, domains or mail. Missing or expired evidence is explicit.

The read-only command requires no member restart. Its publisher needs a Team Window restart
after activation; the underlying launch observers still require Stop/Resume of existing Claude,
Codex, Grok and Kilo members. Native provider acceptance and the coordinator's stall alarm remain
separate from these source changes.

## [0.13.1] - 2026-10-06

### Fixed

- A failed Grok startup-phase update retains its readable roster row and reports one warning
  until recovery. Finished startup no longer invokes the observer. A child that exits while
  the update waits for its activity lock cannot advance its phase afterward.

The phase observer changes affect Grok; Claude, Codex and Kilo retain their existing 0.13.0 paths.
Restart the Team Window after activation. Existing members still need Stop/Resume for the
underlying 0.13.0 observers and startup instructions; native acceptance remains separate.

## [0.13.0] - 2026-10-06

### Added

- Owned sessions show Connecting, Logging in and Summon startup while they launch. The row and
  session header name the observed phase; Logging in reports CLI activity, without checking sign-in.
  The member's first status call replaces startup with Ready or their current work.
- A session that exits during startup retains its last phase in the tooltip and error history.
  Operator stops keep their existing stopped state.

The phases remain separate from self-reported activity, so Kilo can receive its initial readiness
notice while launching. Restart the Team Window after activation, then Stop/Resume existing
Claude, Codex, Grok and Kilo members to load the new launch observers and startup instructions.
Claude observes MCP initialization, Codex its session-start hook, Grok fresh metadata from its
exact saved session, and Kilo its authenticated session response. Native CLI acceptance remains
required for each provider before release acceptance.

## [0.12.1] - 2026-10-06

### Fixed

- Diary search finds entries by author as well as mentions in the task text. Matching author
  text is highlighted, and the search label names both fields. Filtering, older pages and
  the Last Seen boundary keep their existing behavior.

Restart the Team Window after activation to load author search. Claude, Codex, Grok and Kilo
launch, input, account and notification behavior is unchanged; no separate session restart is needed.

## [0.12.0] - 2026-10-06

### Added

- Diary entries accept an original work date. Historical work shows its original calendar day
  or local timestamp, with recording time in the tooltip. Recording time still determines
  order, pagination and the Last Seen boundary.
- An operator backfill script previews prepared batches without writes, retains an exact backup
  before applying them, and preserves existing entry identities and authors. It checks target
  hashes and rejects duplicate outcomes, missing references and unrecognized historical authors.
  Former teammates recorded in public room history can keep their authorship without recreating
  their profiles. Application requires the team's window closed and verified Windows process
  inventory; it never stops a process.

### Fixed

- Reopening Diary reloads repaired entries and approved removals instead of retaining stale rows.
- Entries revealed by a removal keep their recorded order when the open Diary polls for updates;
  the Last Seen marker no longer places an older entry above newer rows.

Restart the Team Window after activation to load the original-date display and reopened view.
Claude, Codex, Grok and Kilo share the updated `--diary` input and output; their launch, input,
account and notification behavior is unchanged. No separate CLI-session restart is required.

## [0.11.4] - 2026-10-06

### Added

- Team Window errors and warnings are retained with their time, source and affected member.
  `summon --faults` reads the retained history and groups repeated reports with counts.
  Dismissing a banner or recovering a session does not erase its retained diagnostic.
- Startup failures and renderer exits join the same history. The journal retains up to four
  512 KiB segments; older segments expire. It excludes terminal streams and user message bodies,
  and omits structured payloads, quoted details, URLs and credential-shaped values from reasons.
  If saving cannot be confirmed, the original failure remains visible with a separate notice.
  A confirmed save from either the window or main process clears that notice after recovery.

Restart the Team Window after activation to enable diagnostic capture. Claude, Codex, Grok and
Kilo launch, input, account and notification behavior is unchanged. Their named Summon CLI calls
share the new read-only reader; no separate provider-session restart is required.

## [0.11.3] - 2026-10-06

### Fixed

- Notepad reads the file on every open, including rapid reopening during a pending read.
  Clean editors adopt outside changes; unsaved drafts retain both versions until you choose
  Keep my draft or Load disk version. The disk version can be viewed without choosing it.
- Notepad pauses editing during verification and saving during unresolved conflicts or read
  failures. Recovery drafts are discarded only after a successful fresh read and a check that
  the stored draft has not changed; failed reads offer retry while keeping the draft.

Restart the Team Window after activation to load this notepad behavior. Claude, Codex, Grok and
Kilo launch, input, account and notification behavior is unchanged.

## [0.11.2] - 2026-10-06

### Changed

- Idle teammates running in this Team Window show Ready in the roster and session header.
  The task line omits a repeated Ready label while retaining task and head-down text.

Restart the Team Window after activation to load these display changes. Claude, Codex, Grok and
Kilo use the same status display; their launch, input and account behavior is unchanged.

## [0.11.1] - 2026-10-06

### Fixed

- Fresh Codex launches remember only their exact launch binding. A launch without that binding
  leaves no saved conversation instead of selecting another team's recent same-folder thread.

### Security

- File message bodies refuse private mailbox, runtime and scratch paths across recognized Summon
  roots and named teams, including resolved directory links. Own private paths, shared scratch and
  domain files remain available. This is a message-input check, not filesystem or account isolation.

This candidate includes the Claude account selection and display from 0.11.0. After activation,
restart the Team Window once and resume affected Codex sessions. Claude account changes require
stopping the selected member and manual sign-in. File-body checks apply to subsequent CLI calls;
Grok and Kilo launch behavior is unchanged. Existing room rotation needs no activation or migration.

## [0.11.0] - 2026-10-06

### Added

- Each Claude teammate can use a separate account directory selected in Team Maintenance.
  Launches and model discovery use that directory, and the roster and session header show its
  name or Default for the inherited account. Long directory labels stay on one line. Switching
  accounts requires stopping the teammate; each account retains its own saved conversation.

Sign-in remains a manual step in Claude. After activation, restart the Team Window for the new
field and roster label, then stop/start each Claude teammate whose account is being changed.
Codex, Grok and Kilo retain their existing launch environment and conversation behavior.

## [0.10.0] - 2026-10-06

### Added

- Room and mail sends/replies accept UTF-8 body files, retaining literal backslashes and internal
  newlines under the caller's permissions and existing identity and communication controls.
- Checkpoint and manifest commands offer a readable full-payload text view with distinct page,
  final-receipt and quiet headings. Explicit acknowledgement remains required.
- Named sessions can inspect compact own work, unread/pending mail, holds, checkpoint progress,
  delivery readiness and schedules without changing those records.
- Room lookup and bounded literal search include archived originals without moving read cursors.
- Compact schedule diagnostics identify unfinished runs, due jobs and recorded deferrals. Rest
  refusals name the existing blocking run or schedule; eligibility rules are unchanged.

These additions require the updated CLI checkout. After activation, restart the Team Window for
rest diagnostics and named sessions/resident MCP servers for revised guidance. They require no
checkpoint migration. Four-provider fixture coverage is separate from live acceptance.

## [0.9.4] - 2026-10-06

### Fixed

- A Telegram refresh failure after checkpoint acknowledgement preserves the acknowledgement
  result. The response identifies the accepted receipt and next-read error, keeping later arrivals
  unread and directing the caller to retry reading. It no longer replaces a successful cursor
  commit with a transport error that suggests the receipt failed.

## [0.9.3] - 2026-10-05

### Fixed

- Offline preflight no longer treats an absent Windows process as alive when Bun's PID probe
  returns `EPERM`. A successful exact-PID CIM lookup may prove absence only after the same query
  finds its own live diagnostic process. Failed queries and missing or mismatched controls still
  refuse migration. Historical runtime records stay intact.

## [0.9.2] - 2026-10-05

### Fixed

- Offline migration accepts a fully empty terminal checkpoint receipt even when saved pagination
  pointers still describe the preceding scan. It preserves that receipt and all source cursors;
  any payload, incomplete continuation or cursor mismatch still refuses. A refused checkpoint now
  names its owner so recovery does not require inspecting another teammate's private batch.

## [0.9.1] - 2026-10-05

### Fixed

- Offline checkpoint preflight distinguishes retained receiver IDs from unrelated Windows
  processes that reused those IDs. Creation-time evidence must prove reuse; active or unverifiable
  receivers and session owners still refuse migration. Refusals identify the metadata path and PID
  without exposing message bodies. Historical runtime records remain intact.

## [0.9.0] - 2026-10-05

### Added

- Maintenance offers a light theme with warm off-white and grey surfaces. The window remembers
  the choice, applies it before page styling, and recolours open teammate and operator terminals
  immediately. Dark remains the default. Electron's native background can still flash dark at
  startup; provider-authored terminal colours need separate live acceptance.

### Changed

- Update the pinned GitHub Pages deployment action from 5.0.0 to 5.0.1.
- The sidebar and empty-state greeting share the untiled bell, also used by the application icon
  and site favicon. The site uses Summon's warm charcoal and brass palette, clearer section names
  and links to the other applications.

### Fixed

- The site's wordmark fits phone screens without horizontal overflow.

This combined candidate includes the checkpoint migration and wake reliability changes recorded
in 0.8.20 through 0.8.24. Activation requires the reviewed offline migration and coordinated restart;
source validation does not establish real provider acceptance or site publication.

## [0.8.24] - 2026-10-05

### Changed

- Each launch receiver combines readiness, new mail, approval decisions, local room and Telegram
  bounds into one notice per scan. Covered frozen checkpoint pages stay quiet while the owner reads
  them; later addressed arrivals can still notify. Routine peer room traffic wakes only the named
  Steward. Human posts, direct mentions and replies to the owner remain eligible after the room's
  quiet window.
- Team Window-owned Kilo sessions use the shared receiver for mail, schedules, rest and room notices.
  Ordinary notices wait for idle and a clear human input draft. Hibernation controls retain their
  separate priority path. External Kilo terminals retain startup and checkpoint reads.

### Fixed

- Delivery outcomes retain exact source bounds before provider input. Definite pre-send failures
  retry with backoff; interrupted or uncertain attempts wait for inspection or complete source
  read coverage. Own-mail status retains older unresolved outcomes when newer notices succeed.
  Independent inventory failures leave healthy sources available and remain visible until recovery.
  Retained receiver-cycle errors report queued-only until a healthy scan proves recovery.
- New work repeats the launch readiness command until the recipient confirms it, without repeating
  readiness-only notices on empty scans.

## [0.8.23] - 2026-10-05

### Fixed

- A mail receiver continues its inbox scan when the owner archives a listed message before its
  header opens. Remaining mail can trigger its notice without a false delivery failure or retry
  delay. Permission failures and malformed messages still report an error; notices do not mark
  requests read or handled.

## [0.8.22] - 2026-10-05

### Changed

- Offline checkpoint migration can defer an explicitly named hibernated Grok owner. Its legacy
  batch stays byte-identical, with its identity recorded in the retained plan. Other owners can
  convert without waiting for Grok availability. Active, changed or unverifiable owners still
  stop conversion. A deferred owner later reads its own batches with the retained old release
  before conversion at an operator-controlled offline boundary.

## [0.8.21] - 2026-10-05

### Fixed

- Team Window wake failures retain a private episode before the window reports it. Own-mail
  status shows the stage, known room target, observed launch nonce and delivery uncertainty.
  Repeated failures share an episode across window restarts; a blocked or paused wake cannot
  mark it recovered. Successful recovery retains the original failure and later episodes.

## [0.8.20] - 2026-10-05

### Changed

- Checkpoint freezes an inventory and bounded pages, with exact replay, an addressed-item index
  and ordered UTF-8 fragments for oversized bodies. Page receipts record completed mail coverage;
  a separate final receipt commits room and Telegram cursors. Later arrivals wait for the next
  package. Existing state requires a reviewed offline migration and coordinated restart.

## [0.8.19] - 2026-10-05

### Added

- ADHD coach and Healthcare advocate join the second row of the Add teammate gallery. The coach
  offers practical planning support; the advocate prepares records, questions and drafts for the
  user to send. Both retain their stated professional and privacy boundaries.

## [0.8.18] - 2026-10-05

### Changed

- Own-mail receive shows unread work newest first, independently of archival. Use `--pending`
  for every unresolved inbox request, including read and held work. Own archive history and
  bounded archived-body reads are available without restoring requests or changing approvals.

## [0.8.17] - 2026-10-05

### Changed

- Rejected checkpoint receipts explain that cursors did not advance and unseen messages remain
  unread, with the command to recover the pending batch. Replay warnings distinguish the original
  batch's continuation flag from the current backlog without changing acknowledgment behavior.

## [0.8.16] - 2026-10-05

### Changed

- Diary rows omit the year from their visible date and hide the destination label for entries
  addressed to Phillip or the operator. Full timestamps remain available on hover; entries for
  teammates keep their destination label.

## [0.8.15] - 2026-10-05

### Fixed

- Grok's Ctrl+U and Ctrl+C now clear Summon's human-draft flag when the operator uses them to
  clear the input. An unfinished paste, terminal reports and a single Escape retain draft
  protection. The key behavior was checked against the real provider before changing the guard.
- Combined Grok notices retain a space between their lines instead of arriving as run-on text.
  The receiver submits one line with one final Enter; the operator's own input is unchanged.

## [0.8.14] - 2026-10-05

### Fixed

- Browser terminal mouse reports, palette and status-string replies no longer set a human-draft
  flag. Hovering, clicking or scrolling a pane cannot block automatic notices as though the
  operator typed an unfinished message. Existing human drafts remain protected. Valid
  reply formats are checked against the installed terminal implementation; keyboard events,
  malformed reports and trailing text remain protected as human input. This extends 0.8.13's
  mode-report fix; live notification acceptance remains separate.
- Scheduled Grok notices use the mail receiver once. Kilo's fallback follows the running
  session, waits behind an unfinished human draft and obeys the shared pause gates. Automatic
  scheduled input no longer sets a human-draft flag, and due work retains its original claim
  and recovery rules.

## [0.8.13] - 2026-10-05

### Fixed

- Rest-ended Grok notices use the durable mail receiver once. Kilo's terminal fallback follows
  the running launch, honors automatic-notice and draft checks, and no longer marks its own
  notification as human typing.
- Automatic xterm mode-query replies no longer set the human-draft flag. This adds the mode
  reports missed by 0.8.12; keyboard input, pasted text, navigation and Escape remain protected.

## [0.8.12] - 2026-10-05

### Fixed

- The shared notification receiver honors halt for mail and room notices, including Codex and
  live-channel Claude. Hibernation control blocked by halt remains pending until proceed.
  Native provider permissions and session ownership checks remain unchanged.
- Automatic terminal query replies no longer make checkpoint-Claude think a human draft is
  waiting. Keyboard input and pasted drafts keep their protection; other provider input still
  passes through unchanged.
- Hibernation controls retry definite pre-send failures without repeating uncertain attempts.
  A Claude notice interrupted after paste remains protected from further pastes and displays
  an inspection error instead of stacking another notice into the same input.
- Grok hibernation uses its launch receiver once instead of also sending through the Kilo
  terminal route. Routing follows the running provider when a registration is changed.
- Local and Telegram room wakes retry definite pre-send failures. Uncertain attempts stay
  protected from same-batch retries, while newer human messages, mentions and replies can
  refresh an unread wake after the normal quiet window.
- Unchanged delivery status no longer rewrites its file on each receiver poll. Repeated terminal
  receiver initialization errors appear once until recovery instead of filling the error view.
- Automatic provider notices share the halt, hibernation, viewing, head-down and rest gates.
  Grok and Kilo terminal notices also wait for human drafts; pasted text ending in a carriage
  return does not count as a separate Enter. Grok rest prompts use its mail receiver once.

## [0.8.11] - 2026-10-05

### Fixed

- Checkpoint-Claude notice submission uses Electron's supported timer. The previous build pasted
  notices but failed before sending Enter because its timer required Bun. The installed Electron
  runtime now has a regression test for this path. A full Team Window restart loads the fix;
  actual idle and busy Claude acceptance remains required. Codex, Grok, Kilo and live-channel
  Claude keep their existing transports.

## [0.8.10] - 2026-10-05

### Fixed

- Checkpoint-mode Claude notices submit with a separate Enter after their pasted text, so they
  stop accumulating as unsent prompt lines. Concurrent room and mail notices stay separate;
  automatic submission waits while the human has a draft and cancels if they edit during delivery.
  A full Team Window restart loads the change. Claude live-channel delivery, Codex, Grok and Kilo
  keep their existing transports. Live checkpoint-Claude acceptance remains required.

## [0.8.9] - 2026-10-04

### Fixed

- Checkpoint-mode Claude sessions in the Team Window receive readiness, mail and room notices
  through their owned terminal. Ordinary MCP tools no longer claim a live-channel receiver in
  checkpoint mode; live-channel Claude and Grok retain their own notification paths. The selected
  delivery mode stays fixed for the running session. Full Team Window restart and affected Claude
  relaunch are required; actual provider acceptance remains separate from fixture evidence.

### Removed

- Summon's Windows storage guard and its provider restrictions, including the restricted launch
  token, Codex child permission profiles, TLS workaround and storage writer. Providers use their
  normal launch and security settings. Operator-only registration/deletion and ordinary session
  ownership checks remain. Existing sessions need a coordinated restart and operator ACL cleanup;
  removal acceptance is recorded separately for each CLI.

## [0.8.8] - 2026-10-04

### Fixed

- Guarded Codex resumes retain their scoped storage policy when a SessionStart hook is configured.
  Permission overrides now share the resume subcommand's configuration layer with the hook.

## [0.8.7] - 2026-10-04

### Fixed

- Live notices recover when Windows reuses a crashed receiver's process ID. Recovery checks the
  process start time and preserves the lease when that evidence is unavailable.

## [0.8.6] - 2026-10-04

### Fixed

- Failed Zzz stop attempts invalidate the old rest confirmation and require inspection before
  fresh consent. They retain their failure record and never enable automatic resume.
- Windows process-tree stop errors retain the owned PID, exit status and bounded diagnostic
  output, rather than discarding the reason for failure.

## [0.8.5] - 2026-10-04

### Changed

- The desktop wordmarks and site header display the approved bell artwork beside summon.

### Fixed

- Furthest behind excludes hibernated teammates from lag and missing-progress counts. When
  teammates share a display name, the selected teammate's slug identifies the record.

## [0.8.4] - 2026-10-04

### Fixed

- Team Window Grok sessions receive mail and room notices through their owned terminal, even
  while the self-reported sidebar status remains Busy. Notices use Grok's input queue, retain
  unread messages, and respect operator-view, head-down, rest, hibernation and communication
  pauses. External Grok terminals keep checkpoint delivery. Real teammate acceptance remains open.

## [0.8.3] - 2026-10-04

This records the internal guard correction. Real teammate acceptance remains open.

### Security

- Guarded Codex profiles disable inherited writable workspace roots within Summon storage before
  applying read-only access and scratch exceptions. A disposable TUI tool call reproduced the
  previous write/delete grants; removing the conflicting root denied all protected handles while
  preserving reads, project writes and both scratch controls. Operator settings remain unchanged.

## [0.8.2] - 2026-10-04

This records the internal launcher correction. Live Codex protection remains unverified.

### Security

- Guarded Codex launches own their server with `--no-daemon` instead of reusing a shared server.
  Post-restart acceptance found a resumed thread still using the broad operator permission profile;
  fresh and resumed enforcement must be confirmed before the storage guard is accepted.

## [0.8.1] - 2026-10-04

This records the internal guard correction. Fresh and resumed provider acceptance remains open.

### Changed

- The app icon and site favicon use the approved bell artwork, with a wider bell at small sizes.
  Desktop wordmarks omit the trailing period. Installer wizard artwork uses the same bell style;
  compiled installer and DPI acceptance remain separate.
- Keyboard help describes Ctrl+backtick as opening or closing the terminal.

### Security

- Guarded Codex launches require an inherited native permission profile that keeps Summon storage
  read-only except personal and shared scratch. Existing broad workspace grants cannot reopen the
  registry. Unsupported configuration fails before launch; no global settings are changed.
- `summon --notes read|write` edits only the current launch's existing notes through its authenticated
  writer, checks the read revision, and preserves Windows file permissions during atomic replacement.
- Windows refuses a guarded launch when a nested restricted token cannot acquire its guard SID.

## [0.8.0] - 2026-10-04

This records the internal source version. Installer candidates and live acceptance remain separate;
no public release or final candidate is declared here.

### Added

- A per-user Windows 11 x64 installer bundles Bun, PowerShell and Electron for offline installation.
  Repair, upgrade and uninstall require installed sessions to be closed; uninstall retains team
  storage and provider credentials. Builds record source identity and payload hashes. Signing and
  clean-host acceptance remain separate.
- Research assistant, Records/files organizer, Writing partner and Learning coach join the Add
  teammate gallery in a second row aligned under Project manager. Every starter has an icon that
  is copied when the operator creates a member, preserving existing custom icons.
- Due schedules explain their last deferral reason in `summon --schedule list`, preserving
  idle-only dispatch, due dates and unfinished-run recovery.
- Reported model history in each member's `runtime/<name>/model-history.jsonl`: an initial
  saved observation followed by dated provider/model changes, including changes across runs.

### Changed

- Update Electron to 44.5.1, the MCP SDK to 1.32.0 and Markdown parsing to
  `mdast-util-from-markdown` 2.1.0; update Node types to 26.6.4 and ESLint to 10.12.0.
- Mail holds use raised-hand guidance and the Team Room approval control instead of Windows
  desktop popups. Existing pending decisions remain pending until the human decision is recorded.
- Startup instructions identify persistent personal and shared scratch folders and tell teammates
  to process notifications at a safe checkpoint, then resume their current task.
- Guarded sessions can use shared scratch for handoffs alongside their personal scratch folder.
- The Interruptions control explains when head-down already queues notices, preventing an unseen
  second pause from being pinned while that mode is active.

### Fixed

- Claude forgets a newly assigned conversation when launch closes before readiness, in both live
  and checkpoint delivery modes, so the next launch does not resume an unconfirmed conversation.
- Add teammate uses one name field and preserves the selected starter while the gallery loads.
- Room images reserve their dimensions before loading so a pinned room keeps following messages.
- Head-down approval buttons retain keyboard focus through roster refreshes. Named regions and
  provider usage results announce correctly; Notepad links open and task checkboxes use their text.
- Errors show their useful reason; discarding an unsaved profile or stopping the operator shell
  requires confirmation. Room and Board text contrast and public-page keyboard access improve.
- Installer uninstall cleans interrupted setup staging files and empty recovered directories while
  preserving unknown contents. Runtime probes verify isolation from the developer's PATH.

### Security

- Launch tools resolve from absolute PATH entries rather than a teammate's working folder. Empty
  and relative PATH entries cannot select executables; missing tools prevent the launch.

## [0.7.0] - 2026-10-03

This is an internal version record. The v1.0 installer and live acceptance remain separate;
this entry does not record a public release.

### Changed

- Team Maintenance and `summon --claude-delivery` let the operator choose Claude live notices with
  confirmation at every start, or startup/checkpoint reads without that prompt. New teams default
  to checkpoint delivery; existing teams retain their live default until explicitly changed.
- Add teammate loads the seven gallery identities from editable JSON files whenever the form
  opens. Invalid files produce warnings while valid choices and Start blank remain usable.
- New teammate notes include the startup workflow. Registration offers a focused form, while
  Maintenance keeps team settings and shows the behavior of each supported provider.
- Room approvals and questions have distinct presentation, reply targets remain visible, and
  repeated thumbs-up submissions do not create another answer. `@operator` highlights for Phillip.
- Board lanes use the available width; Diary entries expand on click and search highlights the
  matching task text. Work panels, dialogs and the operator drawer retain consistent placement.

### Added

- Add the project's FSL-1.1-ALv2 license and public support, privacy and security policies.
- The Start from row offers Project manager and selects the corresponding member type. Ordinary
  starters return the form to Teammate; existing members retain their creation-time type.
- First run and Maintenance automatically check supported CLIs and show one shared comparison of
  Summon capabilities, official installation/account links and sign-in steps. Version discovery
  remains separate from authentication and model readiness; provider installation stays manual.
- Roster room progress names the teammate with the most unacknowledged events and shows a caveat
  when another teammate's progress cannot be measured. It clears when no measured backlog remains.
- Optional built-in PM with Summon-owned workflow instructions, an editable display name and
  stopped-session CLI changes. Any teammate can separately receive operator-granted permission
  to request stops of other rest-ready sessions; the Team Window revalidates each request.
- Windows storage accident guard for subsequent launches, enabled by the operator with
  `summon --storage-guard enable`. Protected storage defaults to read-only for the provider;
  own notes and scratch remain writable, and normal Summon operations use a session-bound writer.
- Goal-scoped head-down requests with explicit return-to-Normal commitment, operator or delegated
  approval, queued automatic notifications, liveness heartbeat and visible controls. Session exit
  or relaunch invalidates the mode; delegation grants no mail-hold or broader approval authority.
- PM receivers report newly confirmed rest readiness promptly even when an older notice remains
  unread. Notices identify the candidate; the operator-granted stop permission and fresh readiness
  checks still control whether a stop can proceed.
- A keyboard-shortcut reference opens with `?` in the Team Window.
- A public project page describes Summon and its installation workflow.

- Bundled `summon-next` Board reconciliation skill, moved from the global `whats-next` skill.

- Human-directed Team Room messages use a blue shaded card instead of the "FOR YOU" banner,
  including previously stored messages and reference previews.
- Teammate registration lists only supported CLIs found on PATH. Maintenance provides an explicit
  version/status refresh; Kilo and its optional LM Studio model server are described separately.
- Plain HTTP(S) links in Team Room open in the browser, preserving URL fragments and surrounding
  text while rejecting executable schemes and embedded credentials at the IPC boundary.
- First-teammate onboarding and a permanent sidebar add action, with a working-folder chooser,
  optional advanced fields, save-without-launch feedback and actionable launch prerequisite errors.
- Diary message search finds matching task text throughout the stored history, with older result
  pages; author, recipient, dates and links do not match. Searching preserves the last-seen marker.
- Ctrl+Shift+N opens a team-local notepad, with autosave, recovered drafts and protection against
  overwriting newer disk changes. Esc closes it and restores focus. Markdown preview includes
  active task checkboxes that preserve the rest of the source text.

### Fixed

- The Team Window error banner has a manual Dismiss control. Clearing it preserves the control
  for later failures; errors raised by background work no longer require another action to hide.
- Refused mail, Room, Telegram, Diary and Board operations name the action that did not start and
  give the safe underlying reason. Network, timeout, permission, response-size and invalid-response
  failures retain useful diagnostics without exposing tokens, request bodies or raw server errors.
- Room history rotates into validated archive segments while preserving message IDs, questions,
  replies, source deduplication and old checkpoint receipts. Reads still assemble the full history;
  rotation does not bound total memory use.
- Guarded Codex uses its supported CA-bundle TLS path with existing Windows public trust roots,
  avoiding Schannel credential acquisition failures. Operator-configured CA bundles take precedence.
- Guarded Windows launches preserve the logon SID needed by Node-based providers to initialize.
  Failed guarded launches now print their exit code instead of only ending the session.
- Concurrent guarded launches wait for the storage ACL setup and tolerate files that disappear
  during its walk. Permission failures and redirected paths still prevent provider launch.
- Backlogged room wake notices point to the latest human message for read-only inspection when
  more than 100 events remain unacknowledged. Previewing it does not skip older history or advance
  a checkpoint receipt; ordinary notices stay compact.
- Board failures distinguish a Telegram halt/proceed check that prevented saving from a failed
  notification after the decision was saved. Saved decisions are not rolled back or retried.
- Windows session locks reject reused process IDs when the new process started after the lock
  was written, preserving genuine running sessions and surviving providers.
- Session wake errors identify the affected teammate separately from the selected session,
  allowing the roster to show the fault alongside the window banner.

- Storage guard configuration lives under `settings/`, so enabling it cannot introduce a bogus
  teammate record or break roster discovery and pending wakes.
- Named sessions cannot register or clone teammates, matching operator-only removal. Creation is
  also checked under the record write lock; cloning refuses an existing destination.
- Claude, Codex and Grok launches pass a short instruction to read a freshly written startup
  file instead of putting the complete context on the Windows command line. Resume refreshes
  that file while preserving the provider session and interactive terminal.
- Team Window launch refuses a missing or mismatched Electron runtime version and explains how
  to repair it after closing existing windows. Failed installer runs preserve their failure status.
- New POSIX team/runtime directories and room images use private permissions. Telegram config
  reads restrict its file and directory before reading and refuse links; Windows keeps profile ACLs.
- Room pages, mention scans and image checks share cached validated history while the file is
  unchanged. Writers still read durable history under their lock; stored messages are unchanged.
- Malformed cover names no longer interrupt teammate removal. New cover assignments reject
  mismatched record names, and roster listing diagnoses them without rewriting stored records.
- Removing a teammate pauses its schedules and removes its published claims, preserving claims
  when archiving is requested. Reusing the name cannot inherit active schedules or stale reports.
- Kilo starts its checkpoint turn through the exact session's authenticated local API on fresh
  and resumed launches. Unconfirmed submissions are reported without automatic retries.
- A failed teammate wake no longer stalls other teammates or later Room events. Failed mentions
  remain queued before the scan advances; peer failures cannot become direct terminal prompts.
- Selecting a running teammate pauses automatic notifications for 30 seconds with a visible countdown,
  renewed by human typing. A header toggle releases or holds the pause, preventing a selected
  teammate from being muted indefinitely just because the window remains focused.
- Board history rotates into durable archives before it fills live storage; card history retains
  every approval across archives and interrupted writes. Unchanged Board snapshots are cached.
- Add teammate opens a focused registration view without team settings or provider usage controls.
  Maintenance retains its team settings; usage appears only for a registered teammate.
- Board CLI mutations return the saved card and board revision instead of every unrelated card.
- Checkpoint delivers an exact mirrored message body once, retaining both transport IDs and cursors
  and replaying the same references until acknowledged. Explicit room reads keep original bodies.
- Operator Stop and Zzz termination show a deliberate stopped state rather than the red
  unrequested-exit alarm. Resuming starts a fresh lifecycle; failed stops retain the running state.
- The test runner isolates each file's hooks and supplies disposable default storage, preventing
  fixture cleanup from restoring the invoking team's live store during another test.
- Failed window shutdown waits for all stop attempts, restores polling and the operator shell,
  and allows a later close attempt rather than leaving the window partly shut down.
- Concurrent profile edits merge under the record lock; saving Maintenance preserves newer notes.
  Atomic record replacement and transient Windows lock errors use bounded retries.
- Repos reads linked working trees and leaves missing upstream counts unknown. Repository-configured
  programs and filters cannot execute through its read-only Git commands.
- New clone expertise stays within the editable limit; dotted and underscored mentions retain
  their wake targets. Discovered provider session IDs are validated before persistence.

### Security

- Update the locked `brace-expansion` dependency from 5.0.9 to 5.0.12 to address the reported
  advisories. This records the historical dependency fix, not a current audit result.
- Package builds include only declared desktop artifacts and ship notices for bundled dependencies.
  Contributor hooks are installed explicitly with `bun run setup:hooks`, rather than by package install.
- Windows CI runs the full quality gate. Its remote execution still needs verification against
  an authorized pushed revision.
- Provider credential and environment access is documented explicitly; the storage guard is an
  optional accident boundary and does not isolate a teammate's entire account or domain.

## [0.6.0] - 2026-09-30

### Added

- Repos browses repositories from teammate working folders: branch and saved-ref tracking status,
  staged/unstaged/untracked changes, literal diffs and recent commits, plus folder, VS Code and
  teammate links. Diary and Repos share the middle row of sidebar tools.

- Diary above the agent terminal records brief, attributed team work newest first, with local
  timestamps and working Team Room and Board references. Agents add entries with `--diary add`;
  startup guidance excludes routine checks and groups related work into notable outcomes.

- Agent-confirmed Ready to rest (Zzz), operator-only stopping, targeted wake after Zzz Stop,
  and routine-notice suppression while resting. Idle reminders ask; they never grant consent.
- Recurring schedules belong to a named agent, with durable run claims,
  explicit completion evidence, and recovery that never blindly repeats an interrupted delivery.
- Large local-room catch-up uses source-linked excerpts for older routine peer posts, while
  preserving exact human/addressed content and reply threads. Original history and receipt replay remain.
- All, Online and Offline roster pills combine with provider filters and remember the selection.
- Directed Team Room replies preserve their local thread and reply to the corresponding Telegram
  message when available. Delayed mirror recovery retains the local parent without resending.

### Changed

- Update Electron to 44.5.0, the MCP SDK to 1.31.0, Node types to 26.6.3,
  eslint-plugin-perfectionist to 5.12.1 and typescript-eslint to 8.71.0.
- Diary remembers the last visible entry between visits and shows a last-seen divider; attribution
  uses the compact author → recipient form.

- Board, Diary and Repos share one remembered divider above the session, keeping its height
  consistent when switching work views.

- Named-team headers and the empty state share the wordmark; application icons use the same palette.

- The sidebar wordmark is larger and centered; Maintenance can save whether domain coverage is shown.
- Sidebar tools use a compact two-column layout with centered footer text; the terminal remains
  available with Ctrl+`.
- Session startup prompts include the machine-local date, time, time zone and UTC offset,
  with guidance to convert UTC timestamps before reporting local times.
- Sidebar CLI pills show saved session model and reasoning settings, with a timestamp and a
  per-agent JSON cache; unavailable settings remain explicit.
- Agents can create, pause and resume their own Summon schedules without operator approval; other owners remain protected.

### Fixed

- Claude model tooltips find resumed sessions in their original project directory after a
  teammate's registered working directory changes.

- Board refreshes retain expanded cards, keyboard focus and scroll position. Unchanged board
  data no longer redraws when a teammate's status changes.

- Expanded Board cards show comments with authors, local timestamps and revision context,
  including cards whose only detail is a comment.

- Rest refusals identify the addressed room event and acknowledged cursor, with the checkpoint
  recovery step. Delivery alone still does not acknowledge unread messages.

- Routine room wakes wait for 30 seconds of quiet, with a two-minute ceiling for continuous traffic.
- Board views refresh after external writes, name prerequisite cards, and flag completed prerequisites. Review headings identify the operator as the next actor.

- Idle rest reminders now ask agents to reconcile outstanding cards and unread mail instead of
  suppressing the question until the queue is already clear. Explicit Zzz eligibility stays strict.

- Returning blocked cards to Backlog preserves their blocker. Deferred cards remain outside the
  startable queue until the blocker is explicitly cleared; board help explains the distinction.

### Security

- Windows launches require a verified Medium-integrity token, preventing agents from silently
  inheriting administrator rights from an elevated Team Window or terminal.

## [0.5.0] - 2026-09-28

### Added

- A desktop team workspace with independent agent terminals, a shared room, an operator shell,
  profile maintenance, live activity, provider filters and persistent resizable regions.
- A dedicated Windows icon and aligned sidebar headings, filters and roster rows.
- Independent named teams: `summon --team <team-name>` uses `~/.summon/team-<team-name>/`,
  with separate rosters, conversations, mailboxes, runtime state and windows.
- Persistent operator Hibernate/Unhibernate controls preserve sessions and pending messages while
  blocking routine notices and automatic wakes. Hibernation requests cooperative wrap-up, not
  forced process suspension.
- A shared board on the desktop and CLI tracks ownership, blockers, review and completion.
  Operator approval announces accepted work; filtering shows the selected teammate's cards.
- Board lane help and action review dialogs explain the selected card, destination, blocker changes,
  notification behavior and archive semantics before applying a decision.
- Team Room supports replies, clickable message references and Back links, older-message previews,
  clipboard image attachments, composer history, Enter to send and Shift+Enter for a newline.
- Ten shared macro slots, quick-reply buttons, optional agent icons and persistent human decision cards.
- Local and Telegram conversations share human reply context while retaining separate read cursors.
  `--to-user` highlights messages directed at the operator; room image attachments remain local.
- Durable checkpoints combine room, mail and approval updates with bounded output and receipts.
- Shared team rules, domain cover records, agent cloning and on-demand presence reports.
- Kilo registration and launch support, model configuration and package-managed startup instructions.
- Published claim checks retain dated evidence, verification states and dispute notifications.
- Operator terminal shell selection, hide/show, stop/start and selection-copy controls. Ctrl+C without
  a selection continues to interrupt the shell.
- A draggable operator-terminal divider with remembered height and keyboard resizing.
- Per-agent session locks prevent duplicate launches and recover after confirmed process exits.
- Build labels identify the version, revision, artifact and build time. Codex usage is available on
  demand; providers without a supported usage interface report it as unavailable.

### Changed

- **Breaking:** the default registry moved from `~/.agent` to `~/.summon`. Stop sessions and watchers,
  then move the entire directory before upgrading. `SUMMON_HOME` remains supported; there is no
  automatic migration or fallback to the old default.
- **Breaking:** the optional argument to `--team` names an independent team, not an agent to start.
  Bare `--team` opens the current team. `--team all` names a team called `all`.
- Room notices batch updates within a 30-second maximum hold measured from the first unread update.
- Team-wide `halt`/`proceed` controls block mail and Telegram sends while preserving reads and
  authenticated operator decisions. Routine peer traffic does not approve held requests.
- Sidebar rows use compact provider labels, working status, unread counts and human-attention badges.

### Fixed

- Install Electron's pinned desktop executable on a fresh installation, including from the packed
  package; existing matching runtimes are reused.
- Recover live receivers after session restarts and ownership contention; keep delivery unconfirmed
  until the recipient acknowledges the current launch's readiness notice.
- Later mail or approval events repeat the readiness instruction when the initial notice was lost,
  without adding periodic empty-mail reminders.
- Quote Windows Codex hook paths through an explicit PowerShell invocation while preserving
  the provider's JSON input.
- Checkpoints settle already-seen mail and hold pages without extra empty turns or discarding work.
- Recover unread mentions across window startup, defer terminal delivery while busy and report
  when hibernation prevents a wake.
- Return blocked board cards to Backlog with the blocker cleared. Report saved decisions separately
  from failed room announcements so an operator does not repeat an already-applied action.
- Keep a team window alive after its launcher exits and report startup failures with a diagnostic log.
- Route terminal text paste correctly, retain measured terminal dimensions on resume and update
  stopped sessions without waiting indefinitely for a ConPTY callback.
- Recover abandoned communication locks without admitting competing owners. Telegram polling
  contention uses saved history for reads; sends still require a fresh control check.
- Resolve configured Windows leak-guard patterns when the parent environment omits their path,
  and reject unreadable configured pattern files.
- Remove inactive agents' runtime data and preserve unrelated team data during maintenance.

### Security

- The contributor leak guard can read approved public names from the staged
  `.githooks/leak-guard-publishes` file. Only a complete matching name clears a private-name
  pattern; unstaged edits do not change a commit's clearance. Secret formats and home paths
  remain protected, and each clearance is announced.

## [0.4.0] - 2026-09-24

### Added

- `summon all` opens a terminal window for every registered agent in name order, with each
  name's saved CLI and working directory. It takes no options and registers nothing. A name
  whose record cannot be read or whose working directory is gone is reported and skipped so the
  rest still open, and the command exits nonzero when any name is skipped.
- `summon list` shows registered agents without launching a session. An unknown name asks before
  it is created. `y` or `yes` registers it. Enter, any other answer, or closed input quits
  without creating an agent.
- Grok Build is a third provider (`summon <name> --using grok`). A new session stores a UUID and
  later calls resume that same session. Grok mail stays queued for startup and checkpoint checks.
  Live delivery into an open Grok session is not enabled.
- Scoped mailbox commands and the bundled `summon-send` and `summon-receive` skills. A session
  can send, receive, reply, confirm, hold, and archive its own mail. Questionable requests stay
  held until you approve or decline them, and `summon --attention list` shows those holds.
  Claude can opt into a development mail channel for one launch with `--claude-mail-channel`.
  Codex binds its root thread with a SessionStart hook and queues notices to that thread. A
  Windows toast can show the agent, the hold id, and a short category. Live receipt in an open
  Claude or Codex session has not been demonstrated.
- Every invocation writes the bundled teammate instructions to `AGENTS.md` in the registry
  directory when that file is missing or differs from the template. A matching copy is left
  unchanged.

### Fixed

- Session instructions tell an agent to read only its own inbox and archive.

## [0.3.0] - 2026-09-23

### Changed

- **Breaking:** records are `version: 3`. The `notes` field is now `expertise`: the standing description
  of what a name is for. Notes moved into `~/.agent/<name>.md`, where they can be read and
  edited like any other file, and `--note` appends there. Version 2 records are rejected with the
  conversion steps rather than migrated silently.

### Added

- Named agents can send requests to each other's persistent mailboxes without starting a session.
  `--mail check` reads pending messages and `--mail ack` archives handled messages. New and resumed
  sessions are instructed to check on startup and between tasks; idle agents are not woken.
- `--expertise` sets what a name knows and is for without hand-editing its record.
- Names can declare a `domain`: the areas they are the primary for, set with `--domain` or in the
  record. Each session prompt now carries its own domain and the domains other names claim, and
  instructs the session to stop when work leads outside it, name the session that owns that area,
  and ask before summoning it. A name without a domain claims nothing and behaves as before.
- Release validation command and installation, terminal, and local data requirements in the README.

### Fixed

- Claude sessions receive current context as a startup message on both launch and resume, so
  restoring a conversation starts a turn that includes the mailbox instructions.
- Relative `SUMMON_HOME` paths keep pointing to the same records and mailboxes when a session
  opens in a different working directory.

### Security

- Restrict package contents to runtime source and public documentation, excluding internal agent
  records, run logs, workspace instructions, hooks, tests, and compiler caches.
- Repository hooks check staged additions for secrets and private paths, and block pushes that
  would expose aidd history. Tagged releases with a screenshot contract must supply matching evidence.
- Source-checkout installation seeds machine-local leak patterns without overwriting existing ones;
  `check:leak-guard` tests the commit guard in an isolated repository.

## [0.2.0] - 2026-09-08

### Added

- Each name now saves its chosen CLI. Register a Codex name with `--using codex`, then resume it
  with just `summon <name>`. New names still default to Claude.

### Changed

- **Breaking:** agent records now require `version: 2`, one `provider`, and a single session list.
  Version 1 records are rejected without being rewritten. Back up old records and follow the
  [record conversion instructions](reference/record-format.md); split names that contain both providers'
  histories into separate records.
- `--using` cannot switch an existing name to a different CLI. A conflicting choice fails before
  changing notes, the working directory, or session history. Use another name for the other CLI.
- Sessions opened in a new terminal use the CLI saved in the named record, just like
  `--same-window` sessions.

### Security

- The internal session runner validates names and rejects path traversal and extra provider
  arguments before opening a record or launching a CLI.

## [0.1.0] - 2026-09-02

### Added

- Named Claude Code and Codex sessions with persistent notes, saved working directories, and
  separate provider histories in `~/.agent/`.
- New-terminal and same-window launches, with saved session IDs used to resume conversations.
