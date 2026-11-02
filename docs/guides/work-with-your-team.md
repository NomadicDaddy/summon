# Give work and follow progress

Use a running team whose teammates have completed startup. Choose a teammate with the relevant
domain, and state the desired result, working folder, constraints and what needs your approval.
The optional PM helps route work; its role does not grant permission to approve held actions.

## Choose where to speak

For a direct task or sensitive project context, select the teammate and use its terminal. For
shared work, post in **Team Room** and address the intended teammate by registration name.
Enter sends; Shift+Enter adds a line. Room messages are visible to the team. Agents' private
mailbox bodies should stay in their own mailboxes.

An explicit mention may start a stopped teammate when the team's wake-on-mention setting allows
it. Selection alone starts nobody. Hibernation and other delivery controls still apply. Use
group mentions deliberately; their [presence and wake rules](../reference/sessions-and-communication.md#telegram-team-conversation)
differ from an individual name.

Teammates use durable mail for requests and detailed handoffs. Receiving mail, confirming its
scope, doing the work and archiving a handled request are separate steps. The operator's mail
badge counts unread messages; it does not expose their contents. An empty badge does not mean
the teammate has finished every unresolved request.

## Check the result and the queue

1. Read the teammate's response and any exact decision card. Follow the reply's original scope
   before approving an action.
2. Open **Board** to see assigned work, acceptance criteria and blockers. The
   [Board guide](team-board.md) explains what each lane and action actually changes.
3. Use **Diary** for completed work and decisions linked to Room messages and cards. It is a
   record of reported outcomes, not an independent task validator.
4. Compare claimed verification with the evidence provided. A test, source review, desktop
   interaction and installed-provider check establish different things.

Status combines teammate reports and observed provider state. Busy can mean reported work or an
observed native turn; Needs you is a reported human wait. Resting requires recorded rest
confirmation and no conflicting provider-turn evidence. None certifies implementation correctness.
If progress is unclear, ask what is complete, what remains and what dependency prevents the next
step.

## Find an older conversation

Press **Ctrl+Shift+J** and enter a Room message number, the start of a Board card ID or the start
of a teammate name. The jump opens the matching item or offers the possible matches. Room
history remains available even when a message is older than the visible page.

From a named teammate's session, `summon --room show <id>` reads an exact original without
acknowledging it. `summon --work` summarizes that session's recorded cards, mail, holds and
schedules; it does not complete them. See [mail and delivery](../reference/mail-and-delivery.md)
and the [checkpoint protocol](../reference/installation.md) for receipt-bound reads.

## When a reply does not arrive

Read the visible task and delivery state before sending another copy. Hold Interruptions,
head-down, hibernation, an active native turn or an unavailable provider can delay a notice.
“Delivered” records transport progress, not completed work. Use the
[delivery troubleshooting guide](troubleshoot-startup-and-delivery.md) to preserve uncertain
input and avoid asking the same action to run twice.
