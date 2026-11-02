import type { AgentRecord } from './store.ts';

import { atomicWrite, locked, type WriteProgress } from './mail-files.ts';
import { operatorNames } from './operator-identity-model.ts';
import { configuredOperatorIdentity, operatorIdentityPath } from './operator-identity.ts';
import { loadAgent, recordPath } from './store.ts';

/** Registration and display-name writes share the identity writer's namespace lock. */
export async function writeMemberIdentity(
	slug: string,
	record: AgentRecord,
	progress?: WriteProgress,
): Promise<void> {
	const current = await loadAgent(slug);
	const write = () =>
		atomicWrite(recordPath(slug), `${JSON.stringify(record, null, '\t')}\n`, progress);
	if (current && current.name === record.name && current.displayName === record.displayName)
		return write();
	await locked(`${operatorIdentityPath()}.lock`, async () => {
		const names = new Set(
			operatorNames(await configuredOperatorIdentity()).map((name) => name.toLowerCase()),
		);
		if (
			[slug, record.name, record.displayName].some(
				(name) => name && names.has(name.trim().toLowerCase()),
			)
		)
			throw new Error(
				'Member name conflicts with the operator identity; choose another name.',
			);
		// Reject namespace conflicts before a new registration seeds its cursors.
		if (!current) await (await import('./new-member-cursors.ts')).seedNewMemberCursors(slug);
		await write();
	});
}
