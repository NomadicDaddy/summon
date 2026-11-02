import { randomUUID } from 'node:crypto';

import type { Options } from './cli-options.ts';
import type { WriteProgress } from './mail-files.ts';

import { profileTextStale } from './profile-text-stale.ts';
import { profileTextRevision, textHash, validProfileText } from './profile-text.ts';
import {
	appendRegistrationAudit,
	type IntentEntry,
	printRegistrationAudit,
	type TextChange,
} from './registration-audit.ts';
import { operatorDecision } from './registration-decision.ts';
import {
	type Field,
	fields,
	parseEdit,
	refusePm,
	type Request,
	textEditor,
	USAGE,
} from './registration-input.ts';
import { requestApproval } from './registration-request.ts';
import { loadAgent, slugFor, updateAgentRecord } from './store.ts';

async function show(name: string): Promise<void> {
	const record = await loadAgent(slugFor(name));
	if (!record) throw new Error(`No registered teammate named ${name}.`);
	console.log(
		JSON.stringify({
			name: record.name,
			memberType: record.memberType ?? 'teammate',
			expertise: record.expertise,
			domain: record.domain ?? '',
			revision: profileTextRevision(record),
		}),
	);
}

interface Result {
	name: string;
	text: Record<Field, string>;
	revision: string;
}
const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * Intent and commit, under the record's write lock: refuse, append `intent`, write the record,
 * then append `applied` once the lock is released. Any failure of the intent append, including a
 * lock release that fails after the line landed, stops before the write. The write reports its own
 * outcome (WriteProgress): completed means `applied`, even when releasing the record lock then
 * fails; failed before the rename means `not-applied` (best effort); anything else writes no marker
 * and leaves the intent unresolved. A failed `applied` marker leaves the edit for hash
 * reconciliation. Success is reported only when the intent, the record and the marker all landed.
 */
async function edit(actor: string, request: Request): Promise<void> {
	// Written inside the update callback; an object so the compiler does not narrow them to their
	// initial values across that closure.
	const state: { intent?: IntentEntry; result?: Result } = {};
	let afterWrite: unknown;
	const write: WriteProgress = {};
	try {
		await updateAgentRecord(
			request.target,
			async (record) => {
				refusePm(record);
				if (profileTextRevision(record) !== request.revision)
					throw new Error(
						`${profileTextStale} Run summon --registration show ${request.target} and edit from that revision.`,
					);
				const before: Record<Field, string> = {
					expertise: record.expertise,
					domain: record.domain ?? '',
				};
				const after = { ...before, ...request.edit };
				const changes: Partial<Record<Field, TextChange>> = {};
				for (const field of fields)
					if (after[field] !== before[field])
						changes[field] = {
							old: textHash(before[field]),
							new: textHash(after[field]),
						};
				if (Object.keys(changes).length === 0)
					throw new Error('The stored text already matches. Nothing changed.');
				const intent: IntentEntry = {
					kind: 'intent',
					id: randomUUID(),
					at: new Date().toISOString(),
					actor,
					target: request.target,
					decision: request.decision ?? null,
					changes,
				};
				try {
					await appendRegistrationAudit(intent);
				} catch (error: unknown) {
					throw new Error(
						`The audit intent could not be confirmed, so the record was not changed: ${message(error)}. If its line landed, summon --registration audit lists ${intent.id} as unresolved.`,
						{ cause: error },
					);
				}
				state.intent = intent;
				record.expertise = after.expertise;
				if (after.domain) record.domain = after.domain;
				else delete record.domain;
				state.result = {
					name: record.name,
					text: after,
					revision: profileTextRevision(after),
				};
			},
			write,
		);
	} catch (error: unknown) {
		const { intent, result } = state;
		if (!intent || !result) throw error;
		// The outcome comes from the write's own report, never from rereading the record: a reread
		// can fail, and a later same-revision writer can change what it shows.
		if (write.failed && !write.renamed) await recordNotApplied(intent.id, error);
		if (!write.renamed)
			throw new Error(
				`The outcome of audit ${intent.id} is unknown (${message(error)}). No outcome marker was written; run summon --registration audit to reconcile.`,
				{ cause: error },
			);
		afterWrite = error;
	}
	const { intent, result } = state;
	if (!intent || !result) throw new Error('Registration edit did not complete.');
	try {
		await appendRegistrationAudit({
			kind: 'applied',
			id: intent.id,
			at: new Date().toISOString(),
		});
	} catch (error: unknown) {
		throw new Error(
			`${result.name}'s record changed, but the audit commit marker for ${intent.id} is missing (${message(error)}). summon --registration audit reconciles it by hash as applied-unmarked.`,
			{ cause: error },
		);
	}
	if (afterWrite !== undefined)
		throw new Error(
			`${result.name}'s record changed and audit ${intent.id} is marked applied, but the update then reported: ${message(afterWrite)}`,
			{ cause: afterWrite },
		);
	report(intent, result);
}

/** The intent is already written, so the failed record write must be recorded next to it. */
async function recordNotApplied(id: string, error: unknown): Promise<never> {
	const reason = message(error);
	try {
		await appendRegistrationAudit({
			kind: 'not-applied',
			id,
			at: new Date().toISOString(),
			reason,
		});
	} catch (failure: unknown) {
		throw new Error(
			`The record was NOT changed (${reason}), and audit entry ${id} could not be marked not-applied; summon --registration audit lists it as unresolved.`,
			{ cause: failure },
		);
	}
	throw new Error(
		`The record was NOT changed (${reason}). Audit entry ${id} is marked not-applied.`,
		{ cause: error },
	);
}

function report(entry: IntentEntry, result: Result): void {
	const lines = [`Updated ${result.name}'s registration text.`];
	for (const field of fields) {
		if (!entry.changes[field]) continue;
		const text = result.text[field];
		lines.push(
			text
				? `${field} is now:\n${text}\n(end of ${field})`
				: `${field} is now empty (cleared).`,
		);
	}
	lines.push(
		`Revision: ${result.revision}`,
		`Audit entry ${entry.id}; decision ${entry.decision ? `Team Room #${entry.decision}` : 'none (operator’s own edit)'}.`,
		`The new text reaches future startup prompts: ${result.name}'s own next launch, and the roster other sessions read when they next launch. Running sessions keep their existing context until they restart.`,
		'No session was launched, woken or stopped.',
	);
	console.log(lines.join('\n'));
}

/**
 * Registration-only edit of another teammate's expertise and domain. Imports nothing that
 * launches, wakes or stops a session; the record's lifecycle state is left exactly as it was.
 */
export async function registrationCommand(args: string[]): Promise<void> {
	const [action, ...rest] = args;
	if (action === 'show' && rest.length === 1 && rest[0]) {
		await textEditor();
		await show(rest[0]);
		return;
	}
	if (action === 'audit' && rest.length <= 1) {
		await textEditor();
		await printRegistrationAudit(rest[0]);
		return;
	}
	if (action === 'request') {
		await requestApproval(await textEditor(), rest);
		return;
	}
	if (action !== 'edit') throw new Error(USAGE);
	const actor = await textEditor();
	await checkedEdit(actor, await parseEdit(rest));
}

/** Every edit, whichever spelling asked for it: decision, target and PM checks, then edit. */
async function checkedEdit(actor: string, request: Request): Promise<void> {
	if (actor !== 'operator' && !request.decision)
		throw new Error(
			'A PM edit needs --decision <room-id>: the operator’s Yes to the approval that summon --registration request posted for this exact edit.',
		);
	const target = await loadAgent(request.target);
	if (!target) throw new Error(`No stored agent named ${request.target}.`);
	refusePm(target);
	// The operator may omit a decision; one that is given must be just as real as a PM's.
	if (request.decision !== undefined)
		await operatorDecision(request.decision, request, actor, target.name);
	await edit(actor, request);
}

/**
 * The older spelling, `summon <name> --expertise <text> | --domain <text>`, for a registered
 * name: the same checked edit, inline text normalized like file text, and never a launch. New
 * names fall through to ordinary creation, where --revision and --decision mean nothing.
 * @param slug The name as a slug.
 * @param registered Whether the name is registered.
 * @param options The parsed launch options.
 * @returns True when the text edit handled the command.
 */
export async function routedTextEdit(
	slug: string,
	registered: boolean,
	options: Options,
): Promise<boolean> {
	const text = options.expertise !== undefined || options.domain !== undefined;
	if (!registered || !text) {
		if (options.revision !== undefined || options.decision !== undefined)
			throw new Error(
				'--revision and --decision apply only to changing a registered name’s expertise or domain.',
			);
		return false;
	}
	if (
		options.provider ||
		options.model !== undefined ||
		options.variant !== undefined ||
		options.lmStudioUrl !== undefined ||
		options.cwd !== undefined ||
		options.notes.length > 0 ||
		options.sameWindow ||
		options.newWindow ||
		options.claudeMailChannel
	)
		throw new Error(
			'Changing a registered name’s expertise or domain takes only --expertise, --domain, --revision and --decision, and launches nothing.',
		);
	const actor = await textEditor();
	if (options.revision === undefined || !/^[a-f0-9]{64}$/.test(options.revision))
		throw new Error(
			`--revision is required to change a registered name’s text: copy it from summon --registration show ${slug}.`,
		);
	const edit: Request['edit'] = {};
	if (options.expertise !== undefined)
		edit.expertise = validProfileText('expertise', options.expertise);
	if (options.domain !== undefined) edit.domain = validProfileText('domain', options.domain);
	await checkedEdit(actor, {
		target: slug,
		revision: options.revision,
		edit,
		...(options.decision === undefined ? {} : { decision: options.decision }),
	});
	return true;
}
