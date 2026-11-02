import { profileTextStale } from './profile-text-stale.ts';
import { profileTextRevision } from './profile-text.ts';
import { type Field, fields, parseEdit, refusePm, USAGE } from './registration-input.ts';
import { requestPlan, writeProposal } from './registration-proposal.ts';
import { askRoom } from './room-question-access.ts';
import { loadAgent } from './store.ts';

/**
 * `summon --registration request`: validates an edit exactly as `edit` would, then posts it as an
 * operator approval through the ordinary room approval path. The question is requestPlan's text:
 * the new text in full, or for long text a write-once proposal file and an excerpt, and on its
 * last line the tag that binds a Yes to this one edit. Only a PM asks: the operator edits without
 * a decision, and room questions come from named sessions.
 * @param actor 'operator' or the PM's slug, already authorized.
 * @param args The edit's name and flags, without --decision.
 */
export async function requestApproval(actor: string, args: string[]): Promise<void> {
	if (actor === 'operator')
		throw new Error(
			'The operator edits directly with summon --registration edit; no approval request is needed.',
		);
	const request = await parseEdit(args);
	if (request.decision !== undefined)
		throw new Error(
			`A request has no --decision; the operator’s answer becomes one.\n${USAGE}`,
		);
	const target = await loadAgent(request.target);
	if (!target) throw new Error(`No stored agent named ${request.target}.`);
	refusePm(target);
	const current: Record<Field, string> = {
		expertise: target.expertise,
		domain: target.domain ?? '',
	};
	if (profileTextRevision(current) !== request.revision)
		throw new Error(
			`${profileTextStale} Run summon --registration show ${request.target} and request from that revision.`,
		);
	if (fields.every((field) => (request.edit[field] ?? current[field]) === current[field]))
		throw new Error('The stored text already matches. Nothing to request.');
	const plan = requestPlan(actor, target.name, request);
	// Before posting: the question must never point at a proposal file that is not there.
	for (const field of plan.proposals) await writeProposal(request.edit[field] ?? '');
	const posted = await askRoom(['--approval', plan.text]);
	console.log(
		`Approval request #${posted.id} posted for ${target.name}. When the operator answers Yes, run the same edit with --decision <id of that Yes>.`,
	);
}
