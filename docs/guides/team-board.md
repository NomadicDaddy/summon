# Team board

The board belongs to the active team. Selecting a teammate filters the board to that owner's
cards. Click a card title to read its scope, blocker and evidence. Click a lane's information
button to see what that lane and its available actions mean.

Every card action opens a review dialog showing the card title, project, owner, current lane,
revision and consequences. Cancel or Escape makes no change. Confirm applies the displayed
revision; if someone changed the card meanwhile, reload and review the new card before retrying.

## Search

The field under the Team Board heading searches card titles, owners and card text: the
description, the blocker, evidence and comments. Matching is a plain, case-insensitive substring
test. A blocker is searched both by the name the card shows (who it waits on or, for a card
waiting on another card, that card's title) and by its recorded reason. Card ids are not searched.
Search only reads; it changes no card.

A search covers every owner, even while a teammate is selected, and the status line under the
field says so along with the number of matches. Clearing the field returns the board to the
selected teammate's live cards.

Two controls appear beside the field while it holds a term. Each names the view you are in:

- **Matches only** shows the cards that match. Press it for **All cards**, which keeps every
  live card in place and marks the matches.
- **With archived** also shows archived cards that match, tagged Archived, in the lane of the
  state they finished in. They carry no action buttons. Press it for **Live only**.

A match in the title or owner is marked where it appears. When the match is in text the card
keeps folded, the card says where ("Matches in description, comments") and the marks are inside
when you open it. Cards do not open by themselves.

## Lanes and available actions

| Lane    | Meaning                                                                       | Actions                                                                                                                     |
| ------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Backlog | Proposed or deferred work, not in the startable queue. An owner is optional.  | Move to Ready, only with an owner and no blocker; Allow work, only for a retained human blocker; Change owner; Archive card |
| Ready   | Assigned work the owner can pick up next.                                     | Return to backlog; Change owner; Archive card                                                                               |
| Doing   | Work the owner has started.                                                   | Return to backlog; Change owner; Archive card                                                                               |
| Blocked | Work waiting on a recorded human, agent, task or external condition.          | Allow work, only for a human blocker; Return to backlog; Change owner; Archive card                                         |
| Review  | Work presented for your review. The lane alone does not prove it is complete. | Accept as done; Return to backlog; Change owner; Archive card                                                               |
| Done    | Completed work with evidence or a recorded operator acceptance.               | Return to backlog; Archive card                                                                                             |

The operator UI exposes these six actions. Other transitions, partners, comments and evidence
are available through `summon --board` commands. A teammate's `--board mine` lists only its
unarchived Doing and Ready cards, with Doing first. Backlog is not permission to start work.

## What each action does

**Accept as done** (formerly **Approve**) accepts the work described on a Review card and moves
it to Done. It posts an attributed room notification to the owner. Existing evidence is retained.
If the card has no evidence, the server records your acceptance of that revision as evidence;
this is a human acceptance record, not proof that a test passed. Agents cannot use this operator
exception to mark their own work complete without evidence.

**Allow work** (formerly **Go ahead**) approves proceeding within the scope shown on a card
blocked on a human, clears that blocker and moves it to Ready. It tells the owner in the room.
It does not mark the work done or clear agent, task or external blockers. A separate mailbox
approval hold still requires its own recorded decision.

**Move to Ready** approves starting a Backlog card that has an owner and nothing it is waiting on,
and moves it to Ready. It tells the owner in the room, as Allow work does. It is not offered on a
card with a blocker: a human blocker is cleared with Allow work, and an agent, task or external
blocker by the condition it names. A card with no owner is given one first with Change owner.

**Change owner** gives the card to another registered teammate you pick from a list. The card's
state, blocker, evidence and history are kept, and its partner and current owner are not offered.
The new owner and the previous one are told in the room, in one message, only when the card is
already Ready, Doing, Blocked or in Review; a Backlog card changes hands without a message,
because it is not yet work to start. It is not offered on a Done card.

**Return to backlog** (formerly **To backlog**) defers or reopens the card. It moves it to Backlog
and retains its blocker, owner, evidence and history. Deferral does not resolve a blocker. It
sends no message and does not interrupt work already running. Tell the owner separately what
needs to change or whether to stop. Returning a Done card reopens its board status; it does not
undo code, deployment or other completed actions.

**Archive card** hides the card from every lane and the startable queue. It preserves its state,
blocker, evidence, comments and history. In every lane it means hiding the record, not acceptance,
rejection, cancellation or deletion. It sends no message and does not stop a running session.
Archived records still count toward storage limits. Restore one through the operator CLI:

```text
summon --board list
summon --board update <id> <current-revision> '{"archived":false}'
```

Accept as done, Allow work, Move to Ready and a Change owner that sends a message use an owner
mention in the room. When mention waking is enabled, this can start a stopped session.
Hibernated sessions stay asleep. Notification failure does not roll back a saved board decision:
the UI reports the failure and refreshes the persisted state. Do not repeat the action to resend
the announcement; tell the owner separately.

## Validation and authority

### Windows paths in CLI input

Create and update take a JSON object. Build it with a serializer rather than manually escaping
backslashes through several shell or script layers. In PowerShell, a single-quoted string keeps
Windows paths literal; `ConvertTo-Json` escapes them for JSON:

```powershell
$body = @{
    title = 'Review project configuration'
    description = 'Inspect C:\projects\example.project and \\server\share\notes.txt'
} | ConvertTo-Json -Compress
summon --board create $body

$patch = @{ description = 'Inspect C:\projects\example.project' } | ConvertTo-Json -Compress
summon --board update <id> <current-revision> $patch
```

CLI create, update and comment results contain `{ revision, item }`: the board revision and the
saved card, including its ID and current card revision. They do not return unrelated cards.
`--board list` remains the explicit full snapshot; `--board history <id>` returns that card's history.

In JavaScript, use `JSON.stringify` on an object whose strings already contain the intended
characters; `String.raw` is useful for literal Windows paths. JSON displays a backslash as `\\`,
but the stored string and card display contain one backslash. Invalid JSON is rejected. Summon
cannot recover separators that a calling shell or JavaScript string literal removed before
invoking it; verify the serialized input and the returned card when writing from a script.

### State and ownership

- Cards outside Backlog require a registered owner. A partner must be registered and different
  from the owner.
- Blocked requires a blocker. Backlog can retain one while work is deferred; other lanes cannot.
  Clear the blocker explicitly before moving deferred work to Ready, Doing, Review or Done.
- An agent blocker must name a registered teammate. Task blockers must reference existing cards
  and cannot form a cycle.
- Done requires evidence, including the operator-acceptance record described above.
- Stale revisions are rejected. Board writes are also blocked while communications are halted.
- Agents may update only their own cards and cannot change ownership. The UI acts as the operator.
- A board acceptance applies to the card's stated scope. It does not grant unrelated deployment,
  publication, credential access or release of a separate mailbox hold.

Board history records the actor and before/after card revision. Comments are append-only and
carry the revision they were made against. Archiving keeps both.
