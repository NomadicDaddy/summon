# Development

Before each new build created for testing, complete `document-changes`: update the internal
version, changelog and affected feature revision records so they describe the build being tested.
This does not authorize adoption, restarts, pushes, tags or publication.

The source version preflight enforces that relationship in the fast/full gates, before a Team
Window build removes output, and in the source checkout's prepared main-ref updates (including
fast-forwards). Run it explicitly with `bun run check:release-version`, or pass two exact hashes
to inspect a proposed integration. It compares accumulated changes with the most recent
version-bearing first-parent main commit. Runtime, UI, bundled startup instructions and guard
changes need a changed semantic version and newly updated, categorized, dated release notes.
The version change must accompany or follow the behavior it covers; an earlier change in the same
integration cannot cover later behavior. A later documentation-only commit may repair the
current version's release notes. Numeric ordering is temporarily unenforced by operator decision
#29235 for the normalization to public 1.0.0. A lower documented version currently
establishes a new baseline too. Restoring numeric downgrade protection is tracked separately for
after this normalization; until then, source review must check version ordering explicitly.
Missing history, stale ancestry or malformed identities refuse rather than guess a baseline.
Quality CI fetches the complete history and establishes the main baseline before checking a
detached pull-request merge. A source archive without Git history cannot run this preflight.
The offline updater can rebuild a clean historical commit reachable from main without moving
main backwards. That rebuild checks the historical commit against its own version-bearing
baseline and reports the historical rebuild reason. Dirty historical checkouts and unversioned
historical runtime changes still refuse. Unpublished candidates retain the normal integration checks.
This working-checkout path does not permit main-ref rewinds. Installed-source comparisons use
the same temporary numeric-ordering policy when sealing a new candidate.

Test and documentation changes may retain the version, including the separately published
`site/` front-door documentation and root `PRIVACY.md`, `SECURITY.md` and `SUPPORT.md` prose.
The site is uploaded as-is by the Pages workflow and is outside the application's package files;
this exemption does not permit publishing it. Formatting-only changes qualify when
the installed formatter produces identical output for both versions; an unsupported format or
missing formatter cannot establish that exemption. The report names the baseline and reason.
These checks supplement review and exact human approval; a matching version is not permission
to merge or adopt. The local hook applies where this checkout's `.githooks` are installed and
present, and is not an operating-system security boundary.
Git selects the hook and checker from the worktree performing the update. A fast-forward merge
can already have checked out the candidate's guard code when the ref check runs, so that code
can weaken its own check. An older linked worktree without this hook runs no check at all.
The hook therefore does not independently enforce its own integrity or cover every worktree;
exact source review and human merge approval remain required.
Same-value ref updates and Git's files-backend packing/pruning preserve the published main
identity and are allowed. Real creation, deletion and rewinds still refuse. A loose-copy prune
qualifies only with the same published packed main and no packed-refs transaction lock; unknown
storage or ambiguous maintenance state refuses. The existing pre-commit/pre-push hooks stay intact.

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

For each change, record the following in its card acceptance criteria and completion report:

- Assess impact on `claude`, `codex`, `grok`, and `kilo`. Name every affected CLI, or explain
  why the change cannot affect any of them.
- Test and confirm each affected CLI before marking the change done. Record the tested provider,
  launch mode and observed result; mocks or another CLI's pass do not establish live acceptance.
- State whether a restart is needed and which sessions or Team Window must restart.

Contributors enable this checkout's Git hooks explicitly after installing dependencies:

```sh
bun run setup:hooks
bun run smoke:qc
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
