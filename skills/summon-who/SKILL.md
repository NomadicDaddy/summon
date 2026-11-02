---
name: summon-who
description: >
    Report which registered summon agents are online. Uses the same session lock
    as summon all, then confirms the lock owner is that name's summon session and
    that a matching terminal or shell is still running. Use when the user runs
    /summon-who, asks who is online, who is summoned, or which agents are running.
---

# Who is summoned

Report presence for the registered names. Do not launch anyone, read a mailbox, or print a process command line. Command lines contain session prompts.

Resolve `scripts/who.ts` relative to this skill file, then run it with Bun. From the summon
repository the command is:

```text
bun skills/summon-who/scripts/who.ts
```

The script uses `SUMMON_HOME` when it is set, otherwise `~/.summon`, and the same resolver as `summon --presence`, reading one process snapshot for the whole report. The Team Window uses the same resolver for members it does not run itself: it shows one as In another window only when the resolver confirms it online, and a held lock it cannot confirm as Lock held, not verified. A name is online only when all of these are true:

- The lock owner is alive, started before its lock was written (so a reused PID cannot pass), is Bun or Node, and its arguments are `__session` followed by that name.
- That process's parent is alive and is a terminal host, a shell or the Team Window.
- The recorded provider child is alive, its parent is the lock owner, and its program name is the name's saved provider.

Each name is `online`, `offline` (no lock, or its owner has ended) or `unknown` (a lock is held but presence can't be verified, for example unreadable process details, a reused PID or a missing provider). Unknown is never online. Say the status and the script's detail. A session started before locking has no lock and is reported offline, which does not prove the terminal is closed.

These checks recognize terminal-launched and summon team-window (Electron) sessions with a
directly hosted provider executable.
Sessions using `--same-window` or provider wrappers may not meet those checks; an unconfirmed
status is not permission to launch a duplicate or remove an agent.

Lead with the online names. Then list anyone else the script reported, including a name whose lock PID is alive but is not the matching host.
