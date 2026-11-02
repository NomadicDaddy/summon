import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { AgentRecord } from './store.ts';

import { readActivity } from './agent-activity.ts';
import { currentAgent } from './mail-identity.ts';
import { assertPublicOrOwn } from './message-body-file.ts';
import { validProfileText } from './profile-text.ts';
import { loadAgent, slugFor } from './store.ts';

export const USAGE =
	'Usage: summon --registration show <name>\n' +
	'       summon --registration audit [name]\n' +
	'       summon --registration request <name> --revision <sha256> [--expertise-file <path> | --clear-expertise] [--domain-file <path> | --clear-domain]\n' +
	'       summon --registration edit <name> --revision <sha256> [--expertise-file <path> | --clear-expertise] [--domain-file <path> | --clear-domain] [--decision <room-id>]';
export const fields = ['expertise', 'domain'] as const;
export type Field = (typeof fields)[number];
export type Edit = Partial<Record<Field, string>>;

/**
 * The operator, or the current launch of a registered PM. Uses the same trust model as the other
 * scoped commands: SUMMON_AGENT absent is the operator's terminal; present, it must carry the
 * nonce of the agent's current launch. This is process identity, not OS authentication.
 * @returns 'operator' or the PM's slug.
 */
export async function textEditor(): Promise<string> {
	if (!process.env.SUMMON_AGENT) return 'operator';
	const actor = currentAgent();
	const record = await loadAgent(actor);
	if (!record) throw new Error('This command requires a registered named session.');
	if ((await readActivity(actor))?.nonce !== process.env.SUMMON_NONCE)
		throw new Error('This command belongs to a previous launch.');
	if (record.memberType !== 'pm')
		throw new Error(
			'Only the operator or the registered PM may edit another teammate’s expertise or domain.',
		);
	return actor;
}

async function textFile(path: string): Promise<string> {
	const real = await realpath(resolve(path));
	if (process.env.SUMMON_AGENT) await assertPublicOrOwn(real);
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(real));
	} catch {
		throw new Error(`${path} must contain valid UTF-8 text.`);
	}
}

export interface Request {
	target: string;
	revision: string;
	edit: Edit;
	decision?: string;
}

export async function parseEdit(args: string[]): Promise<Request> {
	const [name, ...rest] = args;
	if (!name || name.startsWith('-')) throw new Error(USAGE);
	const seen = new Set<string>();
	const request: Request = { target: slugFor(name), revision: '', edit: {} };
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index] ?? '';
		const field = fields.find((key) => flag === `--${key}-file` || flag === `--clear-${key}`);
		const takesValue = flag === '--revision' || flag === '--decision' || flag.endsWith('-file');
		if (!field && flag !== '--revision' && flag !== '--decision')
			throw new Error(
				`${flag} is not accepted. This command changes only expertise and domain; provider, model, endpoint, cwd, notes, sessions, name, member type, permissions and cover stay with Team Maintenance.\n${USAGE}`,
			);
		const key = field ?? flag;
		if (seen.has(key))
			throw new Error(
				field
					? `Give one of --${field}-file or --clear-${field}, once.`
					: `Give ${flag} once.`,
			);
		seen.add(key);
		const value = takesValue ? rest[++index] : undefined;
		if (takesValue && value === undefined) throw new Error(`${flag} needs a value.\n${USAGE}`);
		if (flag === '--revision') request.revision = value ?? '';
		else if (flag === '--decision') request.decision = value ?? '';
		else if (field)
			request.edit[field] =
				value === undefined ? '' : validProfileText(field, await textFile(value));
	}
	if (!/^[a-f0-9]{64}$/.test(request.revision))
		throw new Error(
			'--revision is required: copy it from summon --registration show <name>, so an edit made since cannot be overwritten.',
		);
	if (Object.keys(request.edit).length === 0)
		throw new Error(`Give at least one of expertise or domain to change.\n${USAGE}`);
	return request;
}

export function refusePm(record: AgentRecord): void {
	if (record.memberType === 'pm')
		throw new Error(
			`${record.name} is the PM. Summon sets PM expertise and domain in code and ignores stored text, so this edit would have no effect. Nothing changed.`,
		);
}
