# Development

Ordinary commits, Team Window builds, installer test builds, `smoke:qc:fast` and relevant focused
tests may use the current development version and changelog. Full `smoke:qc` is pre-release only.
The build records its commit, dirty state and artifact
fingerprint so test output remains identifiable. These actions do not authorize adoption,
restarts, pushes, tags or publication.

Before publication, run `bun run release:check` on the clean, exact candidate. It checks the
version and dated, categorized changelog before full QC and the package dry run, then checks
that the source is still clean and at the same commit. Run the version check alone with
`bun run check:release-version`, or pass two exact hashes to inspect a proposed integration.
The checker compares accumulated changes with the most recent
version-bearing first-parent main commit. Runtime, UI, bundled startup instructions and guard
changes need a changed semantic version and newly updated, categorized, dated release notes.
The version change must accompany or follow the behavior it covers; an earlier change in the same
integration cannot cover later behavior. A later documentation-only commit may repair the
current version's release notes. Numeric ordering is temporarily unenforced by operator decision
#29235 for the normalization to public 1.0.0. A lower documented version currently
establishes a new baseline too. Restoring numeric downgrade protection is tracked separately for
after this normalization; until then, source review must check version ordering explicitly.
Missing history, stale ancestry or malformed identities refuse rather than guess a baseline.
The release check needs complete Git history and a main baseline. Full `smoke:qc` is a
pre-release quality gate; it does not validate the release version or changelog. A source
archive without Git history cannot run the release preflight.
The offline updater can rebuild a clean historical commit reachable from main without moving
main backwards. That rebuild checks the historical commit against its own version-bearing
baseline and reports the historical rebuild reason. Dirty historical checkouts and unversioned
historical runtime changes still refuse. Unpublished candidates retain the normal integration checks.
Installed-source comparisons use the same temporary numeric-ordering policy when sealing a new
candidate.

Test and documentation changes may retain the version, including the separately published
`site/` front-door documentation and root `PRIVACY.md`, `SECURITY.md` and `SUPPORT.md` prose.
The site is uploaded as-is by the Pages workflow and is outside the application's package files;
this exemption does not permit publishing it. Formatting-only changes qualify when
the installed formatter produces identical output for both versions; an unsupported format or
missing formatter cannot establish that exemption. The report names the baseline and reason.
These checks supplement review and applicable merge authority; a matching version is not permission
to merge or adopt. The release-policy reference-transaction hook has been removed, including
its local main deletion and rewind guard. Exact source review remains required; pre-v1 Summon
main integration follows Team rule R2. The existing pre-commit and pre-push hooks remain.

After the candidate's own build and checks, prepare an adoption inventory explicitly:

```sh
bun run seal:team --installed <installed-bundle-directory> --out <new-manifest-path>
```

Sealing requires clean, unchanged source pins, a matching built version/revision and a known
installed revision whose version agrees with source. A same-version revision change needs an
explained test/docs/format-only delta; changed behavior refuses before the new seal is written.
The candidate and installed bundle must resolve to distinct directories, including Windows case
aliases. The command hashes the candidate's files twice, rejects links or an output within either bundle,
and never overwrites an existing manifest. It records source, installed and build identities;
the revision label and stable inventory do not independently prove that these bytes were built
from that source. The manifest records `independentBuildVerified: false`. Sealing does not prove
native-provider acceptance, copy files, approve adoption or restart anything.
Keep the installed bundle's original version label until its separate replacement is approved.

## Native and VM test plans

Local disposable fixtures, mocks and fresh temporary stores fit ordinary development. For native
or VM acceptance, the operator approves one bounded plan naming the environment, host and
applicable VM snapshot/restore baseline, artifact or reviewed rebuild, allowed operations,
data and credential boundary, and checked cleanup/restore.
For each attempt, take the required Team R17 slot and head-down; verify the plan, host and artifact;
run only named checks and retain the result and useful failure output; settle children and verify
cleanup/restore before retry. Steward may rerun affected checks within the
unchanged plan. Changed builds need fresh acceptance evidence. New scope or host, credentials or
accounts, live data, disruption, failed restore, STOPPED/HOLD exceptions or hold release require
new decisions.
This grants no current F5 run, final product acceptance or publication.

For each change, record the following in its card acceptance criteria and completion report:

- Assess impact on `claude`, `codex`, `grok`, and `kilo`. Name every affected CLI, or explain
  why the change cannot affect any of them.
- Test and confirm each affected CLI before marking the change done. Record the tested provider,
  launch mode and observed result; mocks or another CLI's pass do not establish live acceptance.
- State whether a restart is needed and which sessions or Team Window must restart.

### Installed-app acceptance

For an approved installed-app acceptance run, use this smoke checklist: launch, readable output,
a basic interaction and safe Stop. The maintainers' internal Summon release supplement governs
the one maintained checklist for each release. Add targeted provider, delivery or draft-input
checks for changed paths. Record Passed, Failed or Not tested with an explanation for each
selected check, and link current known limitations. A shared
integration change may require the full provider matrix; otherwise document affected providers
and reuse applicable evidence. Rerun affected checks after meaningful changes; docs or
version-label-only changes leave unaffected acceptance intact. An accepted known failure stays
Failed; a missing or inconclusive observation is Not tested. Never copy an earlier pass to a
changed candidate. Native execution still requires the bounded plan and slot above.

Contributors enable this checkout's Git hooks explicitly after installing dependencies:

```sh
bun run setup:hooks
bun run smoke:qc:fast
```

Ordinary installation does not change Git hooks or seed contributor leak-guard patterns.
The full QC gate includes `bun run check:dead-code` (Knip) before the build and tests.
It checks unused files, exports and dependencies alongside ESLint's local unused-code checks.
`knip.jsonc` names process-launched entry points that static imports cannot reveal, including
the manual `test/fixtures/team-terminal.ts` probe. Add an entry only for an actual independent
command or process; do not exempt whole source or fixture directories to silence findings.
Hook setup requires this repository's root and refuses a source folder inside another repository.
This checkout uses the hooks in `.githooks`. Commits scan staged additions for likely secrets and
private paths. Pushes prevent publishing aidd history to a configured remote and check screenshot
evidence for tagged releases when the tagged tree opts into that requirement.
For processes marked with `AIDD_AGENT`, pushes also reject remote ref deletions and updates
whose existing tip is not an ancestor of the proposed tip, including unknown existing tips.
This ancestry check allows new refs and fast-forward updates; it is inactive in ordinary
operator shells. It does not make tags immutable.
Summon sets `AIDD_AGENT=1` for launched Claude, Codex, Grok and Kilo sessions, activating this
guard in repositories where it is installed. Existing sessions need to restart to inherit it.
This also applies to operator-entered commands inside those sessions; separate operator shells
are unaffected. The variable alone does not install a hook or protect repositories without it.

Before packaging, run `bun run release:check`. Create the archive with `bun pm pack`; it contains
the TypeScript runtime, Bun installation guard, Windows launch-integrity check, bundled mail skills,
and public documentation. Bun is required at runtime.
Install the archive produced for that version with `bun add -g ./summon-<version>.tgz`.
