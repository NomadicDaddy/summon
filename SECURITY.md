# Security Policy

summon is local-first: it runs on your machine, opens sessions of CLIs you installed, and keeps its
records as files in your summon home. Even so, security issues matter here and responsible
disclosure is appreciated.

## Supported versions

Security fixes are made against `main`. Include your installed version and build fingerprint in
a report; for a source installation, include the commit too. Reports against older versions are
welcome. Say which version you tested so a fix already on `main` can be distinguished from an
issue in the version you have installed.

## Reporting

Report privately rather than in a public issue: use GitHub's **Report a vulnerability** on the
summon repository. Include what you ran, what you observed, and the smallest reproduction you have.
Please do not include real credentials, real transcripts, or screenshots of a live team in a report.

## What summon does and does not hold

- **AI-provider credentials stay with the CLI.** summon never asks for a provider key, stores one,
  or passes one between teammates. Authentication is whatever your chosen CLI already does. The
  optional Telegram bridge is the exception: it reads a bot token from a local configuration file
  under summon home, which you create.
- **Records are local files.** The room, board, mail and diary live under your summon home and are
  readable by anything that can read your disk. They are not encrypted at rest. Conversation
  history belongs to each CLI and lives wherever that tool keeps it - Codex under `CODEX_HOME` or
  `~/.codex/sessions` - so summon home is not where a transcript is found or cleared.
- **Prompts go where your CLI sends them.** summon supplies startup instructions and coordination
  messages to the CLI. It does not proxy model requests. Provider and session metadata reads support
  status, delivery and usage displays; see [PRIVACY.md](PRIVACY.md).
- **A peer is not an authority.** Agents can send each other mail and leave approval holds. Only the
  operator releases a hold. An agent cannot grant another agent permission it did not already have,
  and a request arriving by mail is not approval to act on it.
- **`halt` pauses communication, not work.** Sending `halt` on its own pauses every agent's mail,
  local Room and Telegram sends, Board and Diary writes, and scheduled dispatch; `proceed` resumes.
  A session already running keeps running. Closing the window requests shutdown of its owned
  sessions; a failed stop keeps the window open and reports the failure. Quoted, forwarded, bot
  and unapproved-sender messages cannot change the communication state.

## Known boundaries

summon opens terminals and runs the CLI you named, in the working directory you gave it. Anything
that CLI can do, it can do. Treat registering a teammate as granting that CLI access to its working
directory, summon home and the launching shell's environment, within that OS account's permissions.

Launches resolve tools to absolute paths from absolute PATH entries before starting them. Empty
and relative PATH entries do not select executables, and files in a teammate's working folder do
not shadow the installed CLI. The operator's explicit PATH remains a trust boundary; keep it free
of directories controlled by untrusted repositories. Windows children also inherit the setting
that disables implicit current-directory executable lookup.

- **Teammates can read the Telegram credential.** Every teammate CLI runs as your OS user and runs
  `summon --telegram` in its own process tree. The token in `integrations/telegram.json` is within
  its reach. Codex receives the
  [whole selected team store](docs/reference/installation.md#codex-storage-permissions)
  through `--add-dir`; the former restricted-token storage guard and privileged writer are not current
  launch protection.
  Command-level ownership and approval checks do not isolate the filesystem from a process
  running as the same OS user. A teammate can read that token and send
  it to its model provider. Use a dedicated bot with no other privileges. If you do not trust a
  teammate's provider with the token, revoke it through BotFather before using that provider here.
- **The launching environment is inherited.** Credentials exported in the shell that starts summon
  can reach teammate CLIs and the operator terminal. The Team Window removes `SUMMON_AGENT`,
  `SUMMON_NONCE`, `ELECTRON_RUN_AS_NODE` and `NODE_OPTIONS` before starting child terminals; session
  launches then set their own identity. This is control-field cleanup, not credential isolation.
  Start summon from an environment containing only credentials you intend those processes to use.

## About this document

Reviewed 2026-10-30 against the 1.0.0 source candidate `b94061e`. This describes source behavior;
it does not establish fresh provider or clean-host acceptance, or verify historical ACL retirement.

For anything that is not a vulnerability - a question, a bug, a setup problem - use the routes in
[SUPPORT.md](SUPPORT.md) rather than this document.
