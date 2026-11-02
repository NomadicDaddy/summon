import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ownHolds } from '../src/mail-attention.ts';
import { sendMessage } from '../src/mailbox.ts';
import { loadAgent, providers, saveAgent } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousHome = process.env.SUMMON_HOME;
beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
});
afterEach(async () => {
	if (previousHome === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousHome;
	await fixture.dispose();
});

async function proposalReply() {
	const request = await fixture.run(
		['--mail', 'send-self', 'beta', 'Please assess a change.'],
		'alpha',
	);
	expect(request.code).toBe(0);
	const original = JSON.parse(request.out) as { id: string };
	const reply = await fixture.run(
		['--mail', 'reply', original.id, 'Propose changing setting A.'],
		'beta',
	);
	expect(reply.code).toBe(0);
	return (JSON.parse(reply.out) as { id: string }).id;
}

for (const provider of providers) {
	test(`${provider}: an explicitly assessed reply can be held without granting approval`, async () => {
		const member = await loadAgent('alpha');
		if (!member) throw new Error('Missing fixture member');
		member.provider = provider;
		await saveAgent('alpha', member);
		const id = await proposalReply();
		const confirm = () =>
			fixture.run(['--mail', 'confirm', id, 'Assessment: needs approval.'], 'alpha');
		const holdArgs = [
			'--mail',
			'hold',
			id,
			'Separate authority needed',
			'Change only setting A',
		];
		expect((await confirm()).error).toContain('Read the entire request');
		expect((await fixture.run(holdArgs, 'alpha')).code).toBe(1);
		const read = await fixture.run(
			['--mail', 'read-self', id, '--offset', '0', '--limit', '4096'],
			'alpha',
		);
		expect(read.code).toBe(0);
		const chunk = JSON.parse(read.out) as { end: number; size: number };
		expect(chunk.end).toBe(chunk.size);
		const confirmed = await confirm();
		expect(confirmed.code).toBe(0);
		const inbox = join(fixture.records, 'mailboxes', 'beta', 'inbox');
		const afterConfirmation = await readdir(inbox);
		expect((await confirm()).out).toBe(confirmed.out);
		expect(await readdir(inbox)).toEqual(afterConfirmation);
		const held = await fixture.run(holdArgs, 'alpha');
		expect(held.code).toBe(0);
		const first = (JSON.parse(held.out) as { hold: { id: string; decision: string } }).hold;
		expect(first.decision).toBe('pending');
		expect((await fixture.run(holdArgs, 'alpha')).out).toContain('Existing hold');
		expect((await fixture.run(['--mail', 'ack-self', id], 'alpha')).code).toBe(1);
		expect((await fixture.run(['--attention', 'approve', first.id], 'alpha')).code).toBe(1);
		const changed = await fixture.run(
			['--mail', 'hold', id, 'Separate authority needed', 'Change only setting B'],
			'alpha',
		);
		expect(changed.code).toBe(0);
		const second = (JSON.parse(changed.out) as { hold: { id: string } }).hold;
		expect(second.id).not.toBe(first.id);
		expect(
			(
				await fixture.run(
					[
						'--mail',
						'record-decision',
						first.id,
						'approve',
						'Direct user decision in isolated fixture',
					],
					'alpha',
				)
			).code,
		).toBe(0);
		expect((await fixture.run(['--mail', 'ack-self', id], 'alpha')).code).toBe(1);
		expect((await ownHolds('alpha')).find((hold) => hold.id === second.id)?.decision).toBe(
			'pending',
		);
		expect(
			(
				await fixture.run(
					[
						'--mail',
						'record-decision',
						second.id,
						'decline',
						'Direct user decline in isolated fixture',
					],
					'alpha',
				)
			).code,
		).toBe(0);
		expect((await fixture.run(['--mail', 'ack-self', id], 'alpha')).code).toBe(0);
	}, 15000);
}

test('a partial reply read cannot be confirmed or held', async () => {
	const id = await proposalReply();
	const path = join(fixture.records, 'mailboxes', 'alpha', 'inbox', `${id}.md`);
	await writeFile(
		path,
		`${await fixture.read(`mailboxes/alpha/inbox/${id}.md`)}${'x'.repeat(40000)}`,
	);
	const read = await fixture.run(
		['--mail', 'read-self', id, '--offset', '0', '--limit', '4096'],
		'alpha',
	);
	expect(read.code).toBe(0);
	const chunk = JSON.parse(read.out) as { end: number; size: number };
	expect(chunk.end).toBeLessThan(chunk.size);
	expect(
		(await fixture.run(['--mail', 'confirm', id, 'Not completely read'], 'alpha')).code,
	).toBe(1);
	expect(
		(await fixture.run(['--mail', 'hold', id, 'Authority', 'Change setting A'], 'alpha')).code,
	).toBe(1);
	expect(await ownHolds('alpha')).toEqual([]);
});

for (const kind of ['receipt', 'confirmation', 'notice', 'unknown'] as const) {
	test(`${kind} mail does not become a proposal through confirmation`, async () => {
		const id = await sendMessage('beta', 'alpha', 'Mechanical event', { kind: 'receipt' });
		const path = join(fixture.records, 'mailboxes', 'alpha', 'inbox', `${id}.md`);
		await writeFile(
			path,
			(await fixture.read(`mailboxes/alpha/inbox/${id}.md`)).replace(
				'Kind: receipt',
				`Kind: ${kind}`,
			),
		);
		expect((await fixture.run(['--mail', 'receive'], 'alpha')).code).toBe(0);
		const peerInbox = join(fixture.records, 'mailboxes', 'beta', 'inbox');
		await mkdir(peerInbox, { recursive: true });
		const before = await readdir(peerInbox);
		expect((await fixture.run(['--mail', 'confirm', id, 'Not a proposal'], 'alpha')).code).toBe(
			1,
		);
		expect(
			(await fixture.run(['--mail', 'hold', id, 'Authority', 'Change setting A'], 'alpha'))
				.code,
		).toBe(1);
		expect(await ownHolds('alpha')).toEqual([]);
		expect(await readdir(peerInbox)).toEqual(before);
	});
}
