---
name: summon-send
description: Send a durable request or reply to another named summon agent, including offline recipients.
---

# Send agent mail

Diary entries use `summon --diary add <json>` with `for`, `task`, optional `room` message IDs
and `board` card UUIDs. Author and current time are automatic. Record brief completed work,
meaningful decisions and notable cross-team asks. Group related activity; omit routine mail reads,
checkpoints, status checks and individual tool calls. Link actual messages and cards for detail.
Never include credentials or private data. Diary entries stay in the team and are not mirrored.

Use only from a named summon session. `SUMMON_AGENT` and `SUMMON_NONCE` identify you;
do not invent, replace, or remove them. Read the bundled skills at the paths in your startup prompt.

Honor the shared communication pause: the user's standalone `halt` means no mail or Telegram sends,
including replies and confirmations, until their explicit `proceed`. If heard in your session,
cease sends immediately; do not send an acknowledgement or bypass the block. Agents cannot change
the shared pause. Only the operator can apply it through the Team Room, Telegram, or
`summon --comms halt` in their own terminal. Reads remain available.
Only the operator's standalone `proceed` in the Team Room or Telegram, or `summon --comms proceed`
in their own terminal, clears the shared pause. Do not automatically resend blocked work afterward;
reassess whether it is still needed. A `halt` heard only in your session stops your own sends.
Local operator checks trust the preserved `SUMMON_AGENT` session identity; they do not authenticate
a separate operator credential or form an operating-system security boundary.

For work authorized by the user, send with:

```text
summon --mail send-self <recipient> <text>
```

Include the project path, requested outcome, relevant facts and constraints. For multiline text,
backslashes or shell-sensitive content, author a UTF-8 file with the file tools, verify its bytes,
then use `summon --mail send-self <recipient> --body-file <path>`. Replies support
`summon --mail reply <message-id> --body-file <path>`. The option replaces the inline body;
do not combine them. Room send/reply support the same option, including `--to-user`.
The caller reads the file with its normal filesystem permissions. Another teammate's private
mailbox, runtime or scratch is refused, including resolved links. Existing whitespace trimming,
message limits, sender identity and communication gates still apply. Empty text, NUL and invalid
UTF-8 are refused before delivery. A file read does not authorize the message or its request.
For simple inline text, pass one argument using the active shell's literal quoting.
Never put private details into a shell expression.
Do not use another agent to bypass your domain boundary or the user's approval requirements.

Report the persisted message ID. Queued or notified does not mean read, accepted, or completed.
Use `summon --mail sent-status <message-id>` to check a message you sent. `unconfirmed` means no
complete read has been recorded; `recorded-read` includes the read time. `unknown` includes foreign
IDs and messages without a sender-owned record. Status never proves handling, approval or identity
outside Summon. This command does not read the recipient's inbox or send another message.
Do not launch the recipient or repeatedly poll for a reply. Continue your authorized work.

For a substantive response to mail in your own inbox, use:

```text
summon --mail reply <message-id> <text>
```

This derives the recipient from your received message. Never inspect another agent's inbox,
archive, receipts, transcript or attention records, even to check mail you sent. Ask for a reply.
Read your own mail with the summon-receive skill. Confirmation and status messages are not
requests; do not acknowledge them with another automatic reply.
