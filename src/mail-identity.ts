import { loadAgent, slugFor } from './store.ts';

export function currentAgent(): string {
	const name = process.env.SUMMON_AGENT;
	if (!name || !process.env.SUMMON_NONCE) {
		throw new Error('This command requires a named summon session.');
	}
	return slugFor(name);
}

export function ownMailbox(name: string): void {
	if (process.env.SUMMON_AGENT && currentAgent() !== slugFor(name)) {
		throw new Error('Agents may access only their own mailbox or send as themselves.');
	}
}

/**
 * Allow an inbox to be read by its owner, or by the teammate recorded as covering them.
 *
 * Deliberately NOT a relaxation of `ownMailbox`. That one gate gates fifteen call sites, only two
 * of which are inbox reads: the others send mail as the agent, release its holds, publish its
 * claims and write its activity. Widening it to admit a coverer would hand over impersonation and
 * hold release along with the reading, so cover gets its own gate on its own two call sites.
 *
 * Read-only and inbox-only by construction rather than by care: nothing here is reachable from
 * archive, sent mail, acknowledgement or any write.
 * @param name The mailbox owner.
 */
export async function coveringInbox(name: string): Promise<void> {
	const caller = process.env.SUMMON_AGENT;
	if (!caller) return;
	const owner = slugFor(name);
	if (slugFor(caller) === owner) return;
	const record = await loadAgent(owner).catch(() => undefined);
	const cover = record?.backup?.trim();
	if (cover && slugFor(cover) === slugFor(caller)) return;
	throw new Error(
		`Another inbox is readable only by the teammate recorded as covering it. ${owner} does not record you as cover.`,
	);
}

export function operatorOnly(): void {
	if (process.env.SUMMON_AGENT) throw new Error('This command is for the human operator only.');
}

export function messageId(value: string): string {
	if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) {
		throw new Error('A message ID must be a UUID.');
	}
	return value;
}
