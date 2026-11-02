# Shared rules and published claims

The team's designated editor maintains `<SUMMON_HOME>/team-rules.md` (normally
`~/.summon/team-default/team-rules.md`); teammates propose corrections to that editor. Rules enter
every provider's startup prompt before personal notes. Human directives need exact room citations;
earned rules need the dated correction that justified them. A 40-line, 8000-character budget keeps
this a short rulebook. Rules over budget still all reach the prompt; each start prints a warning
naming the size. A rule without its source or earned correction refuses the start. Changes take effect
on subsequent provider launches without rebuilding. A team without rules or provenance launches
normally without the shared-rules block. Rules are team data, never application or package assets.
No credential values belong in rules, claims, or their evidence: these are public team artifacts.

The editor may number rules as `- R1 Read the decision.` and put their evidence in the adjacent
`team-rules-provenance.md`, for example `R1: source: #123 "Yes"` or
`R1: earned: 2026-10-31, correction that justified the rule`. Use positive rule numbers without
leading zeros. Each numbered rule needs exactly one matching entry; duplicate numbers, missing
evidence, malformed entries and entries without a rule refuse startup. Blank lines and Markdown
headings may separate provenance entries. The provenance stays out of provider prompts and the
40-line, 8000-character rules budget. Existing unnumbered rules with an immediately following,
two-space-indented source or earned line remain valid during the split. The author-time
`validateTeamRules(rules, provenance)` check validates both strings and enforces the rules budget.

Update the two files together while no provider launch is expected, then validate the completed
pair before launching. The writes and startup reads are not atomic: a launch between them refuses
missing or orphaned evidence. This applies to the initial split and later edits to both files.

`SUMMON_HOME` selects one exact team store. `SUMMON_TEAMS_HOME` selects the base containing
`team-default` and named `team-<name>` stores; without either setting, the base is `~/.summon`.
Existing flat-store data needs the [separate offline cutover](storage-layout.md#default-team-subfolder).
Changing an environment variable does not migrate that data.

Each owner publishes `<SUMMON_HOME>/claims/<slug>.md` (normally
`~/.summon/team-default/claims/<slug>.md`). Use the syntax below to publish your own claims.
Publishing a DUTY describes a chosen evidence criterion; it does not assign work or establish user
authorization. Nobody reads or edits another person's private memory through this feature.

Run `summon --verify-claims` for your own file. An operator supplies the owner explicitly:
`summon --verify-claims <owner>`. Agents cannot verify as another owner. Everyone can review a
published report with `summon --claims-report <owner>`. The report records the invoking OS username;
there is no impersonation, elevation, or promise of identical visibility between callers.

Each claim occupies one line. Arguments are JSON arrays, never executable shell strings:

```text
- FACT Bun meets the minimum | verify: ["tool-version", "bun", "1.4.3"]
- DIRECTIVE Example human directive | source: [123, "exact words from your own team room"]
- DUTY Keep current build evidence | verify: ["artifact-newer-than", "D:/projects/example/build.json", 14]
```

Supported predicates:

| Predicate           | Arguments / evidence                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| file-exists         | absolute path; existence is always WEAK                                                                           |
| file-contains       | absolute path, nonempty literal                                                                                   |
| file-line-equals    | absolute path, one-based line number, literal                                                                     |
| artifact-newer-than | absolute regular-file path, number of days greater than zero and at most 365                                      |
| env-equals          | HKCU Environment variable and literal value; allowlist LANG, TZ, NODE_ENV, BUN_ENV, XDG_CONFIG_HOME; no expansion |
| git-has-commit      | absolute repository path, full 40-digit SHA; local object check, network fetching disabled                        |
| tool-version        | bun or git, numeric minimum major.minor.patch; prerelease semantics are not evaluated                             |
| room-message-says   | message number and exact substring; only structured human senders qualify                                         |

File and repository targets must stay inside the owner's registered working directory. Network
paths, symlinks/junction traversal, private stores, secret-like paths, and alternate data streams
are refused. Text checks are limited to regular nonbinary files of 512,000 bytes. This is a narrow
check vocabulary under existing OS permissions, not a new OS sandbox or secret classification system.
Unrecognized or inaccessible targets remain UNVERIFIABLE. Missing duty artifacts are UNVERIFIABLE;
old artifacts are DISPUTED. Modification time establishes recency, not actual duty performance.

Reports keep NOT-CONTRADICTED, DISPUTED, WEAK, UNVERIFIABLE, and NEVER-CHECKED separate. A match only
validates the declared predicate; it does not prove the prose claim, completeness, usefulness, or
memory quality. Changed source or evidence older than fourteen days displays NEVER-CHECKED.
Reports are snapshots; the report command does not rerun predicates. Public report files are not
cryptographically authenticated. Review the predicate as well as the label.

Successful checks run daily at checkpoints and immediately when published claims change. There is
no background scheduler; idle agents wait until their next checkpoint. Malformed files emit a
diagnostic without blocking message delivery; the check retries at later checkpoints.
Check-on-memory-use is deferred. New disputes send one mail to the owner, with pending notifications retained during
a communications halt or send failure. Owners decide how to correct their claims and memory.
