# Choose a work or communication control

Use controls from your own operator terminal or Team Window. A teammate can request an action,
but only your direct decision releases a held proposal. Read the exact action, target, limits
and consequences before choosing Yes. A changed proposal needs another decision.

## Answer a decision

Teammates can post Yes/No approval cards or choice cards in Team Room. Your answer is a permanent
reply to that exact question. It does not execute the action or automatically update a mailbox
hold. The responsible teammate must record the decision and act within its scope. Dismissing a
notice, restarting a session or leaving a question unanswered does not approve it.

Mailbox holds can also be inspected and decided from your own operator terminal with
`summon --attention list`, `summon --attention approve <hold-id>` and
`summon --attention decline <hold-id>`. Do not use an unrelated approval for a new action.

## Select the control that fits

| Control            | Effect                                                                                                                                                     | What continues                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Hold Interruptions | Holds automatic input to the selected terminal; manual holding lasts until released or another teammate is selected.                                       | Direct input and existing work; unread records remain.                                  |
| `halt`             | Your standalone Room or Telegram message pauses Summon mail, local Room and Telegram sends, and scheduled dispatch. Your standalone `proceed` releases it. | Reading and project work. In-flight messages cannot be recalled.                        |
| Head-down          | An approved bounded goal holds automatic notices until the teammate ends the mode or is steered.                                                           | The task and direct session input. Queued messages stay unread.                         |
| Rest / Zzz         | The teammate explicitly confirms recorded work is settled enough to rest. You can stop an owned session with its Zzz button.                               | Durable history; specified new work can clear rest or resume a rest-stopped session.    |
| Hibernate          | Your persistent dormancy instruction asks for wrap-up and blocks routine wakes and direct launches.                                                        | The process and lock remain; this is cooperative dormancy.                              |
| Stop Session       | Stops the session owned by this window, with confirmation or refusal when required.                                                                        | Saved team data. Unsaved work and completed provider shutdown hooks are not guaranteed. |

Selecting or typing in a running terminal can start or renew the automatic interruption countdown.
**Team settings** lets you disable it or choose 5 to 600 seconds. The manual button works
independently. Neither form can withdraw input already accepted by a provider.

## Pause or end a mode deliberately

For a shared communication halt, send `halt` alone in Team Room or Telegram, or use
`summon --comms halt` in your own terminal. The window shows its recorded actor and time.
While halted, Board saves and comments and Diary writes also refuse. Reading those records remains
available.
Send `proceed` alone, or use the window's Proceed button, to resume. Saying halt inside one
teammate's terminal only instructs that teammate to stop sending.

For head-down, approve the named goal and completion condition. Turning on **Can Approve
Heads-down** lets the selected teammate approve other teammates' requests. It does not approve
its own goal, held mail or any other action.
Ending or steering it returns the teammate to ordinary delivery; see the
[Team Window reference](../reference/team-window.md).

For hibernation, use **Hibernate / Unhibernate**, or `summon --hibernate <name>` and
`summon --unhibernate <name>` from your own terminal. Unhibernate allows pending work again; it
does not approve it. An external Grok/Kilo terminal needs its wrap-up instruction delivered by
you. See [hibernation](../reference/sessions-and-communication.md#hibernation).

## If a control refuses

Keep its exact reason and inspect the named task, process or approval. Unknown provider state
does not mean idle. Do not delete a lock, reset a cursor, replay uncertain input or use another
teammate to bypass a refusal. [Rest and stop details](../reference/rest.md) explain the recorded
checks; [troubleshooting](troubleshoot-startup-and-delivery.md) explains evidence collection.
