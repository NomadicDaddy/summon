# Back up, update and remove Summon

Identify how Summon was installed and which storage root it uses before changing it. Application
files, team records and provider accounts have separate lifetimes. The default team is
`~/.summon/team-default`; custom `SUMMON_HOME` and named teams can select other roots.

## Preserve team data

Close the relevant Team Windows and sessions yourself before making an offline backup. Preserve
the complete intended team store through your approved private backup process, including
registrations, notes, mail, approvals, Room history, Board, Diary, schedules and settings. For
multiple teams, inventory each root and the teams-base settings. Do not treat `runtime/` as one
disposable cache or remove locks and checkpoint packages to make a copy or startup succeed.

Team storage can contain Telegram configuration and private work. Keep backups out of public
repositories and shared handoff folders. Provider credentials and conversations are separate
from Summon's profile archive; follow their own backup and account procedures. See the
[storage inventory](../reference/storage-layout.md) before deciding what a backup covers.

Restoring an older application does not reverse a team-data migration. Retain the backup and
its application version, and use an explicitly reviewed offline procedure for a layout change.
Copying an archive or completing a local build does not establish restoration acceptance.

## Windows installer

Close installed windows and sessions before repair, upgrade or uninstall. Run the same installer
again to repair, or a newer reviewed installer to upgrade. Setup copies the payload before
replacing the launcher and keeps previous application versions until uninstall. Those files do
not establish compatibility with older data formats.

Setup refuses active or unverifiable owners and reports the process and PID. Resolve that
condition deliberately before retrying. Setup and uninstall logs go to the Windows temporary
directory; `/LOG="path"` selects an explicit path. The
[installer reference](../reference/installation.md#windows-installer) lists prerequisites and
the separate build and clean-host acceptance boundary.

Uninstall removes installed application files and its user `PATH` entry. It retains team storage,
external Bun/PowerShell/provider installations and provider credentials. Delete none of those
merely because uninstall completed.

## Linked source installation

For a clean Windows `main` checkout linked with `bun link`, the operator can install the standing
maintenance command once with `bun run setup:updater`. Setup prints the exact update and rollback
commands and does not update or restart Summon. Its bundle lives outside the checkout.

1. Close the intended windows and sessions yourself.
2. Run the printed update command from your own terminal. It refuses dirty source, a changed
   link, active/unverifiable owners and a Bun version different from the selected manifest.
3. Wait for its frozen install, full gate and build identity check to finish. Preserve the
   output, `maintenance/logs` and `maintenance/state.json`.
4. Reopen Summon yourself only after success and any separate data-layout requirements are met.

It does not fetch, push, tag, stop/start sessions or migrate team data. If update fails after
changing files, remain offline and run its printed `--rollback` command first. Rollback restores
the recorded prior commit in a detached checkout and runs its gate. A failed rollback retries
that same target; it does not switch back to the newer build. Do not delete its lock or state.

Interrupted initial setup and future layout changes need the checks in the
[source installation reference](../reference/installation.md#source-installation). Existing
configuration or state rules out treating it as a fresh setup.
