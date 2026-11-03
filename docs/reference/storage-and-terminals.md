# Terminal and context storage

Windows requires `wt.exe` for a new window; macOS uses Terminal through `osascript`. On Linux,
summon looks for `x-terminal-emulator`, `gnome-terminal`, or `konsole`. If none is found,
`summon <name>` warns and runs that session in the current terminal, but `summon all` stops with
an error, because it needs a launcher to open a window per agent; summon each name with
`--same-window` instead.

Windows is the only tested platform. The macOS and Linux launch paths are implemented but have not
been tested.

Codex session IDs are captured by the trusted hook or explicit mailbox binding for the exact
launch. A fresh launch that exits without that binding leaves no saved conversation; Summon never
selects a conversation from shared provider history by working folder or timestamp.
Claude and Grok session IDs are generated and
stored before launch; both accept an explicit `--session-id`. Grok resumes the exact UUID,
never the most recent conversation for a directory, and does not restore or change repository files.

Expertise and session IDs are stored as plain JSON, and notes as plain markdown beside it. Both are
sent to the selected provider as part of the session prompt, so avoid putting credentials in either.
Expertise is the standing description of what a name is for, edited deliberately. Notes hold
current decisions and handoff pointers, edited through the notes CLI or profile form. Active notes
reach the prompt, bounded to 16 KiB; an oversized file must be compacted before launch.
Set `SUMMON_HOME` to change the record
directory. Provider accounts and working folders remain shared unless configured separately;
named-team storage is a routing boundary, not a security sandbox.

### Scratch expiry at startup

On Windows, `summon --team` and `summon all` remove scratch files in the selected store that were
last written more than 30 days before that start. Empty folders that were already that old go too.
Each start prints one concise line with the counts, never file contents or skipped paths. Old hard
links kept for safety are identified by count. The full paths and reasons from the latest
successful run are saved in `logs/scratch-expiry-details.json` under the selected private store.
Member homes, `shared` and the scratch folder itself always stay. Named sessions, internal launches, mail,
status and other commands never purge, and a teammate's own CLI never does either.

The removal runs in one hidden PowerShell 7 worker (`scripts/scratch-expiry.ps1` and its C#
source), which adds about 1 to 1.5 seconds to each of those starts on Windows. The worker holds
every folder from the drive root down to scratch, opens each entry relative to its held folder
without following links, junctions or other reparse points, and refuses the whole run if scratch
or any folder above it is redirected. It deletes nothing until Summon has accepted its ready
report and told it to start. An entry is deleted only through an exclusive handle whose identity,
size and times still match what was listed. Anything changed, linked, hard linked, unreadable or
in use is skipped and reported. If the worker can't start, the line says nothing was removed. If
it stops after starting, the line says some files may have been removed and the counts are
unknown.

"In use" here means another process has the file open for its contents, under Windows sharing
rules: any open reader, writer or deleter keeps the file, whatever sharing it allows. A handle
opened only to read attributes or other metadata is not sharing-governed, so the exclusive open
can't see it, and such an observer does not keep an otherwise expired file. Summon does not claim
to detect every open handle. macOS and Linux skip expiry and remove nothing.
