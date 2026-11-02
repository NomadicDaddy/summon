# Diagnose startup and delayed notices

Retain the exact error, time, affected teammate, provider and displayed build before changing
anything. A provider pane, Summon controls, launch readiness and notification delivery can fail
independently. Record which surface stopped responding and whether the session was busy.

## Establish what started

The header distinguishes Connecting, Logging in and Summon startup. Logging in means only that
the CLI showed itself. Summon startup ends after the model confirms this launch's readiness
and sets its first explicit status. A working window or provider terminal alone does not prove
either step occurred.

From the intended team, `summon --launch-status` reads public owned startup phases without
starting anyone. Check `current` and its reason: stale, missing or unverifiable evidence does
not establish that no teammate is launching. `summon --presence` distinguishes online, offline
and unknown; unknown is not a stopped process.

If an execution helper fails before running a startup-file read, keep that exact error. The
model must read its entire current UTF-8 startup file before continuing. Truncated output needs
its remaining bytes; an unreadable file means stop. Do not reuse old launch instructions,
invent a nonce or ask another session to confirm readiness for it. Resolve the actual tool or
permission failure before the same launch can complete startup.

## Inspect retained evidence

Use these read-only views in the intended team:

```sh
summon --faults --member <name> --limit 20
summon --session-history --member <name> --limit 20
```

Faults retain recorded errors and warnings; session history retains owned start, stop and exit
transitions. Compare times, source and window identity. Bounded history and a missing record
cannot reconstruct every prior event or establish its cause. Reading does not retry a launch,
resolve a fault or stop anything.

Inside the affected named session, use `summon --mail status` and `summon --work` for launch
readiness, recorded delivery outcomes and unfinished work. These do not prove task completion.
Only that owner may inspect its private mailbox and runtime details. Do not read a peer's mail
to decide whether it saw your request; ask it to reply.

## A notice was sent but no task result appeared

Check Hold Interruptions, head-down, rest, hibernation, communication halt and active native
turns. Status is self-reported; native turn evidence can be unknown. Ordinary Codex notices hold
when a fresh observation reports busy. Unknown or failed observation uses the existing queue
and coalescing rules; it does not prove idle. Before submission, Summon rechecks the selected
source and bound thread. Accepted queue input cannot be recalled, and the final observation
is not an atomic guarantee against a later native state change.

Distinguish a definitely unsent notice from attempted or uncertain provider input. Do not replay
an uncertain action because no reply is visible. Source fixes affect existing receivers only
after the operator relaunches them. A new CLI reading source does not prove a running receiver
or window loaded it. See [provider delivery](../reference/mail-and-delivery.md#live-delivery-and-provider-trust)
for each integration's limits.

## Read pending work without discarding it

The named session first reads `summon --current-requests --format text`, then its own
`summon --mail receive` for complete unread bodies, including confirmations. `--pending` also
includes unresolved messages already read. An empty unread view does not settle all requests.

Checkpoints freeze bounded pages. Read each full page before passing its receipt, then the
separate final receipt; keep the next receipt. A rejected receipt leaves unseen work unread.
Recover lost output by calling checkpoint without a receipt, rather than editing state. For
packages above five pages or 200 items, use the explicit
[catch-up preview, addressed index and apply workflow](../reference/installation.md), subject to
current operator holds. A skipped range is never marked read, completed or approved.

Telegram may be unavailable while local and cached work remains readable. Preserve freshness
warnings; a quiet cache says nothing about unseen remote updates. A recorded halt remains in
force. Do not delete configuration, leases, locks, delivery outcomes or checkpoint packages to
silence warnings or force another submission.
