import { isProvider, type Provider } from './store.ts';

export interface Options {
	name: string;
	provider?: Provider;
	model?: string;
	/** Kilo reasoning variant; "default" removes the registered one. */
	variant?: string;
	lmStudioUrl?: string;
	notes: string[];
	domain?: string;
	expertise?: string;
	/** For a registered name's text edit: the revision read, and the operator's decision. */
	revision?: string;
	decision?: string;
	cwd?: string;
	sameWindow: boolean;
	newWindow: boolean;
	claudeMailChannel: boolean;
}

export const HELP = `summon <name> [options]

Open a named coding-agent session. Windows uses tabs in a shared summon window.
Unknown names require confirmation before registration. Enter quits without creating an agent.
Use summon list to show registered agents without launching a session.
Use summon clone <source> <name> [--using claude|codex|grok|kilo] to copy one name's memory to a new name. The new name gets an empty session list and does not claim the source's domain.
Use summon all to open a session for every registered agent.
Use summon --pm [name] [--using claude|codex|grok|kilo] to add or launch the optional PM (default Steward).
Use summon --remove <name> to remove an inactive agent and its summon files.
Use summon --unowned -- <executable> [arguments...] to run a detached tool without inherited SUMMON_* seat variables.

Team window and local conversation:
  summon --msg <text>      Post a local Team Room message as CLI (operator/scripts).
  summon --team [team-name]  Open the default or an independent named team (operator terminal).
  summon --room read [cursor]
  summon --room show <id>
  summon --room search <literal-text> [--after <id>] [--limit <1-20>]
  summon --room wake-policy show | set <registration>... | clear
                          Operator selects routine peer-post recipients; default addressed traffic only.
  summon --operator-identity show | set|create --file <UTF-8-JSON-path>
                          Shared display/Diary identity only; writes are operator-only and grant no authority.
  summon --room ask --approval <text>
  summon --room ask <text> [--choice <label>] [--no-freeform]
  summon --checkpoint [previous-receipt] [--format text]
  summon --checkpoint manifest [cursor] [--format text]
  summon --checkpoint catch-up [--keep-pages 1..3]
  summon --checkpoint catch-up apply <plan-id>
  summon --checkpoint catch-up list <plan-id> [offset]
  summon --checkpoint catch-up show <plan-id> room|telegram <id> [byte-offset]
  summon --current-requests [cursor] [--format text]
                          Exact addressed bodies before catch-up; no receipts or mail read markers.
  summon --work             Compact own snapshot; no reads acknowledged or work completed.
  summon --diagnostics [--member name] [--since ISO-time] [--out path]
                          Write one redacted support bundle for your own named session.
  summon --compactions [--member name] [--limit 1..200] [--before id]
                          Retained observed compaction metadata; named sessions read only their own.
  summon --launch-status    Read public owned startup phases; stale/unverifiable views are explicit.
  summon --presence         Each member online, offline or unknown, verified from process identity.
  summon --faults [--limit 1..200] [--member name] [--since ISO-time]
                          Read retained runtime errors/warnings; repeated reports show a count.
  summon --session-history [--limit 1..200] [--member name] [--before id]
                          Read retained owned starts, stop requests, stops, exits and failures.
  summon --verify-claims [owner]
  summon --claims-report [owner]
  summon --room ack <cursor>
  summon --room send [--to-user] <text>
  summon --room reply [--to-user] <id> <text>
  Replace a send/reply body with --body-file <UTF-8-path>; existing limits still apply.
  summon --status idle|busy|needs-user "Working On"  Set your own sidebar status.
  summon --head-down request <goal> <completion> --return-to-normal
  summon --head-down status
  summon --head-down approve|decline <name> <request-id>
  summon --head-down end|steer <name> <request-id> <reason>
  summon --head-down delegate <name> on|off  Operator: grant only head-down management.
  summon --rest candidates         Operator or delegated teammate: list rest confirmations.
  summon --rest stop <name> <confirmation>  Queue a revalidated stop in the owning Team Window.
  summon --rest stop-status <name>  Read your queued stop result.
  summon --registration show <name>  Operator or PM: expertise, domain and their revision.
  summon --registration audit [name] Operator or PM: audited edits and whether each applied.
  summon --registration edit <name> --revision <sha256> [--expertise-file <path> | --clear-expertise]
      [--domain-file <path> | --clear-domain] [--decision <room-id>]
                          Operator or PM: change only another teammate's expertise/domain from UTF-8
                          files. A PM first posts the exact edit with request (same flags, no
                          --decision), then cites the operator's Yes as --decision. Launches nothing.
  summon --hibernate <name>         Operator: persist dormancy, retain the session.
  summon --unhibernate <name>       Operator: allow work and pending delivery again.

Options:
  --using <claude|codex|grok|kilo>  CLI for a new name (default: claude; saved for later calls)
  --model <provider/model> Kilo model, e.g. lmstudio/google/gemma-4-e4b
  --variant <name>        Kilo reasoning variant for the startup turn at each launch and resume,
                          when the model lists it, e.g. high; needs a model, and default removes it
  --lm-studio-url <url>   LM Studio API base URL (default: http://127.0.0.1:1234/v1)
  --note <text>           Append a note to the name's markdown file before opening
  --expertise <text>      What this name knows and is for
  --domain <text>         What this name is the primary for
                          For a registered name these edit text only and launch nothing: add
                          --revision <sha256> from --registration show; a PM adds --decision <id>
                          (see --registration request). New names: operator registration as before.
  --cwd <path>            Set or replace the session working directory
  --same-window           Run here instead of opening a new window
  --new-window            Open a separate window instead of joining the Windows team window
  --claude-mail-channel   Opt into Claude's custom mail channel for this launch; Claude asks for trust
  --claude-delivery [live|checkpoint]  Operator: show or set how Claude teammates get notices.
                          live asks Claude's development-channel confirmation at every start;
                          checkpoint has no prompt and reads at startup and checkpoints
  -h, --help              Show this help
  --notes read|write      Own notes only; write reads JSON with revision and text from stdin

Mailbox (does not launch a session):
  summon --mail-retention preview [--pins-file <path>] [--cursor <token>]
                          Own-only read-only metadata; all rows KEEP, apply unavailable.
  summon --mail send <from> <to> <text>
  summon --mail check <name>
  summon --mail ack <name> <message-id>
  summon --mail send-self <recipient> <text>
  summon --mail receive [cursor] [--pending]  Unread newest first; --pending includes read requests.
  summon --mail receive ... [--kind <kind>] [--since <message-id>]
                          Narrows that page to one kind or to mail sent after a message you
                          received. Omitted mail keeps its state; not complete coverage.
  summon --mail history [cursor]             Own archive, newest first; read-only.
  summon --mail holds [cursor]
  summon --mail sent-status <message-id>       Own sent mail: unknown, unconfirmed, or recorded-read.
  summon --mail reply|confirm <message-id> <text>
  send, send-self and reply also accept --body-file <UTF-8-path> instead of <text>.
  summon --mail ack-self <message-id>
  summon --mail hold <message-id> <reason> <proposed-action>
  summon --mail record-decision <hold-id> <approve|decline> <user-reference>
  summon --mail read-self <message-id> --offset <bytes> --limit <bytes>
  summon --mail read-history <message-id> --offset <bytes> --limit <bytes>
  summon --mail read-hold <hold-id> --offset <bytes> --limit <bytes>
  summon --mail status
  summon --mail bind
  summon --mail ready <launch-nonce>

Board (does not launch a session):
  summon --board list
  summon --diary list [before-entry-id]
  summon --diary add <json>
  summon --board mine [name]
  summon --board create <json>
  summon --board update <id> <revision> <json>
  summon --board comment <id> <text>
  summon --board history <id>

Schedules (agents manage their own; operator manages all):
  summon --rest ready|cancel|status  agent confirms readiness; operator stops via Zzz
  summon --schedule list
  summon --schedule summary         Compact due/deferred/unfinished view; no dispatch.
  summon --schedule create <json>   owner, title, everyMinutes, prompt; agents own jobs only
  summon --schedule pause|resume <id>
  summon --schedule update-prompt <id> <json>  expectedPrompt, prompt; compare before saving
                    Or replace <json> with --body-file <UTF-8-json-path>.
  summon --schedule run <run-id>
  summon --schedule complete|fail <run-id> <evidence>

Skills, Telegram, and human controls:
  summon --skills status
  summon --telegram status|sync|watch
  summon --telegram send [--to-user] <text>
  summon --telegram reply [--to-user] <message-id> <text>
  summon --telegram read [cursor]
  summon --telegram ack <cursor>
  summon --comms halt|proceed|status
  summon --attention list|approve <hold-id>|decline <hold-id>

Examples:
  summon carl
  summon auden --using codex
  summon all
  summon carl --note "Owns the release checklist" --cwd ./my-project
  summon carl --domain "Home network and storage" --revision <sha256>   (text only, no launch)

Each name uses its registered CLI. --using cannot switch an existing name.\nRecords are stored as JSON files in ~/.summon/team-default (or the exact SUMMON_HOME).`;

export function parseOptions(args: string[]): Options {
	const name = args[0];
	if (!name || name.startsWith('-')) throw new Error(`A name is required.\n\n${HELP}`);
	const result: Options = {
		name,
		notes: [],
		sameWindow: false,
		newWindow: false,
		claudeMailChannel: false,
	};

	for (let index = 1; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '--new-window') {
			result.newWindow = true;
			continue;
		}
		if (argument === '--claude-mail-channel') {
			result.claudeMailChannel = true;
			continue;
		}
		if (argument === '--same-window') {
			result.sameWindow = true;
			continue;
		}
		if (argument === '--using') {
			const provider = args[++index];
			if (!isProvider(provider))
				throw new Error('--using must be claude, codex, grok, or kilo.');
			result.provider = provider;
			continue;
		}
		if (argument === '--note') {
			const note = args[++index];
			if (!note) throw new Error('--note requires text.');
			result.notes.push(note);
			continue;
		}
		if (argument === '--model' || argument === '--variant' || argument === '--lm-studio-url') {
			const value = args[++index];
			if (!value) throw new Error(`${argument} requires a value.`);
			if (argument === '--model') result.model = value;
			else if (argument === '--variant') result.variant = value;
			else result.lmStudioUrl = value;
			continue;
		}
		if (argument === '--expertise') {
			const expertise = args[++index];
			if (!expertise) throw new Error('--expertise requires text.');
			if (expertise.length > 8000)
				throw new Error('--expertise must be at most 8000 characters.');
			result.expertise = expertise;
			continue;
		}
		if (argument === '--domain') {
			const domain = args[++index];
			if (!domain) throw new Error('--domain requires text.');
			if (domain.length > 8000) throw new Error('--domain must be at most 8000 characters.');
			result.domain = domain;
			continue;
		}
		if (argument === '--revision' || argument === '--decision') {
			const value = args[++index];
			if (!value) throw new Error(`${argument} requires a value.`);
			result[argument === '--revision' ? 'revision' : 'decision'] = value;
			continue;
		}
		if (argument === '--cwd') {
			const cwd = args[++index];
			if (!cwd) throw new Error('--cwd requires a path.');
			result.cwd = cwd;
			continue;
		}
		throw new Error(`Unknown option: ${argument}`);
	}
	if (result.sameWindow && result.newWindow)
		throw new Error('--same-window and --new-window cannot be combined.');
	return result;
}
