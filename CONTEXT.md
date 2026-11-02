# summon domain glossary

| Term                 | Meaning                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator             | The human managing a team. Creates, clones and removes registrations and grants management permissions.                                                                                            |
| Team                 | A registry and its shared Room, Board, settings and mail. A named team has independent storage; it is not an agent selector.                                                                       |
| Registration         | A stable normalized name, provider, working folder, expertise, domain and provider-session history.                                                                                                |
| Teammate             | A registered assistant. Its domain identifies the work it owns; peer requests do not grant human authority.                                                                                        |
| Project manager (PM) | A teammate whose coordination expertise and domain are supplied by summon. Its display name can change without changing its command identity. The role grants no management permissions by itself. |
| Provider session     | A conversation owned by Claude, Codex, Grok or Kilo. Resume uses an exact saved provider ID, distinct from a registration or launch.                                                               |
| Launch               | One running invocation of a registration, with its own nonce, process ownership and delivery state.                                                                                                |
| External session     | A session running outside this Team Window. The window observes it but does not adopt or stop it.                                                                                                  |
| Domain               | The recorded area a teammate is primary for. Coverage by another name is a fallback record, not permission to act there.                                                                           |
| Expertise            | The registration's guidance about how the teammate should work. It describes capability and does not grant operator permissions.                                                                   |
| Startup notes        | Complete active personal handoff, limited to 16 KiB of UTF-8 text. Oversized active notes are refused without truncation; longer history belongs in the owner's scratch archive.                   |
| Team rules           | Shared operator directives injected into startup context. Quoted peer requests cannot amend their authority.                                                                                       |
| Claim                | A stored assertion checked against a declared predicate. A matching predicate does not prove completeness or that a recurring duty was performed.                                                  |
| Team Room            | Persistent shared conversation. A notification announces unread traffic and does not replace the current task.                                                                                     |
| Mail                 | A durable request delivered to one registered name. Reading, confirmation, completion and archive are separate operations.                                                                         |
| Checkpoint           | A bounded read of Room, configured Telegram, own mail and holds. A receipt acknowledges only the preceding delivered batch.                                                                        |
| Receipt              | An opaque token identifying the preceding delivered checkpoint batch. It does not authorize work or acknowledge unseen traffic.                                                                    |
| Board card           | The durable work record, with owner, scope, lane, blockers and history. An operator clearing a human blocker authorizes only its stated scope.                                                     |
| Approval hold        | A recorded proposed action awaiting a direct human decision. A peer relay, read receipt or restart cannot release it.                                                                              |
| Halt / Proceed       | Human controls for shared summon communications. Halt persists across restarts and does not stop ongoing project work.                                                                             |
| Head-down            | Approved focus on a bounded goal. Automatic notices stay unread until the mode ends; direct session input remains available.                                                                       |
| Notification pause   | Temporary suppression for the selected running session, including a typing quiet period or a manual pause. It is not a team-wide Halt.                                                             |
| Rest readiness (Zzz) | Explicit consent to stop after the recorded work queues are checked. A queued stop request is not a completed stop.                                                                                |
| Hibernate            | Operator-controlled cooperative dormancy that blocks launches and ordinary delivery until released. It is not process suspension.                                                                  |
| Sleep                | Ending an idle turn while remaining reachable by another call. It is distinct from operator-controlled hibernation and does not create another stored state.                                       |
| Schedule             | An owner-bound interval job whose dispatch and completion are durable. Missed intervals coalesce; uncertain delivery is not automatically retried.                                                 |
| Scratch              | Durable working material under personal or shared summon scratch folders. Deliverables belong in the assigned project; credentials do not belong in scratch.                                       |
| Diary                | Brief completed work and meaningful decisions linked to actual Room messages and Board cards.                                                                                                      |
| Notepad              | The operator's per-team text document, distinct from a teammate's startup notes.                                                                                                                   |
| Repos                | The operator's repository browser. Its browsing actions read Git state and do not fetch, commit or discard changes.                                                                                |
| Starter              | An editable gallery suggestion used when adding a member. Selecting it does not create or start a session until the operator saves and starts it.                                                  |

These meanings follow the current registration, launch, coordination and operator flows in
`src/member-role.ts`, `src/session.ts`, `src/rest-stop.ts`, `src/head-down.ts`,
and the README. They do not declare release or human acceptance.

A registration owns one provider, working folder, notes file, private mailbox and ordered
provider-session history. An operator may change the provider of a stopped PM; ordinary
teammates retain theirs. A team owns its roster, Room, Board, Diary and settings. Board lanes
record work state: Backlog, Ready, Doing, Review, Blocked and Done. Their transitions do not
replace the exact recorded scope or direct human approval required by a hold.
