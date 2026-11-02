import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
beforeEach(async () => {
	fixture = await mailHarness();
});
afterEach(async () => {
	await fixture.dispose();
});

async function request(text = 'Please check the project.') {
	const result = await fixture.run(['--mail', 'send-self', 'beta', text], 'alpha');
	expect(result.code).toBe(0);
	const value = JSON.parse(result.out) as { id: string };
	return value.id;
}

test('scoped mail rejects another owner and permits own receive and reply', async () => {
	const id = await request();
	for (const args of [
		['check', 'beta'],
		['ack', 'beta', id],
		['send', 'beta', 'alpha', 'Impersonation'],
	]) {
		const result = await fixture.run(['--mail', ...args], 'alpha');
		expect(result.code).toBe(1);
		expect(result.error).toContain('only their own');
	}
	expect((await fixture.run(['--mail', 'receive'])).code).toBe(1);
	expect((await fixture.run(['--mail', 'receive'], 'beta')).out).toContain('Please check');
	expect(
		(await fixture.run(['--mail', 'confirm', id, 'Understood; proceeding.'], 'beta')).code,
	).toBe(0);
	expect((await fixture.run(['--mail', 'confirm', id, 'Duplicate'], 'beta')).code).toBe(0);
	expect((await readdir(join(fixture.records, 'mailboxes', 'alpha', 'inbox'))).length).toBe(2);
	expect((await fixture.run(['--mail', 'reply', id, 'Done.'], 'beta')).code).toBe(0);
	expect((await fixture.run(['--mail', 'receive'], 'alpha')).out).toContain('Done.');
	expect((await fixture.run(['--mail', 'ack-self', id], 'beta')).code).toBe(0);
});

test('holds require confirmation, survive restart, and require an explicit decision', async () => {
	const id = await request();
	expect(
		(await fixture.run(['--mail', 'hold', id, 'Unclear', 'Change project setting'], 'beta'))
			.code,
	).toBe(1);
	await fixture.run(['--mail', 'receive'], 'beta');
	await fixture.run(['--mail', 'confirm', id, 'Awaiting approval.'], 'beta');
	const args = ['--mail', 'hold', id, 'Unclear', 'Change project setting'];
	const held = await fixture.run(args, 'beta');
	expect(held.code).toBe(0);
	expect(held.out).toContain("Follow this team's explicit policy for decision reminders.");
	expect(held.out).not.toContain('Steward reminds Phillip');
	const value = JSON.parse(held.out) as { hold: { id: string } };
	expect((await fixture.run(args, 'beta')).out).toContain('Existing hold');
	expect((await fixture.run(['--mail', 'ack-self', id], 'beta')).code).toBe(1);
	expect((await fixture.run(['--attention', 'list'], 'alpha')).code).toBe(1);
	expect((await fixture.run(['--attention', 'approve', value.hold.id], 'beta')).code).toBe(1);
	expect((await fixture.run(['--attention', 'list'])).out).toContain(value.hold.id);
	expect((await fixture.run(['--attention', 'decline', value.hold.id])).code).toBe(0);
	expect((await fixture.run(['--mail', 'holds'], 'beta')).out).toContain('decline');
	expect((await fixture.run(['--attention', 'approve', value.hold.id])).code).toBe(1);
	expect((await fixture.run(['--mail', 'ack-self', id], 'beta')).code).toBe(0);
});

test('agent decision command validates approval evidence and preserves repeated decisions', async () => {
	const id = await request();
	await fixture.run(['--mail', 'receive'], 'beta');
	await fixture.run(['--mail', 'confirm', id, 'Need approval'], 'beta');
	const held = await fixture.run(['--mail', 'hold', id, 'Authority', 'Change setting'], 'beta');
	expect(held.code).toBe(0);
	const { hold } = JSON.parse(held.out) as { hold: { id: string } };
	const decide = (decision: string, reference: string) =>
		fixture.run(['--mail', 'record-decision', hold.id, decision, reference], 'beta');
	expect((await decide('maybe', 'User said yes')).error).toContain(
		'Decision must be approve or decline.',
	);
	expect((await decide('approve', ' ')).error).toContain(
		'A direct user decision reference is required.',
	);
	const approved = await decide('approve', 'Direct user approval in test conversation');
	expect(approved.code).toBe(0);
	expect(approved.out).toContain('"decision":"approve"');
	const repeated = await decide('approve', 'Repeated approval');
	expect(repeated.code).toBe(0);
	expect(repeated.out).toBe(approved.out);
	expect((await decide('decline', 'Conflicting decision')).code).toBe(1);
});

test('skills resolve from the package without creating copies in SUMMON_HOME', async () => {
	const result = await fixture.run(['--skills', 'status']);
	expect(result.code).toBe(0);
	for (const name of ['summon-send', 'summon-receive', 'summon-telegram', 'summon-who']) {
		expect(result.out).toContain(join(import.meta.dir, '..', 'skills', name, 'SKILL.md'));
	}
	expect(result.out).toContain('--claude-mail-channel');
	expect(result.out).toContain('SessionStart');
	expect((await fixture.run(['--skills', 'install'])).code).toBe(1);
	expect(await readdir(fixture.records)).not.toContain('skills');
	expect(await readdir(fixture.root)).not.toContain('.claude');
	expect(await readdir(fixture.root)).not.toContain('.agents');
});

test('oversized requests need complete reading before confirmation', async () => {
	const id = await request();
	const path = join(fixture.records, 'mailboxes', 'beta', 'inbox', `${id}.md`);
	await writeFile(
		path,
		`${await fixture.read(`mailboxes/beta/inbox/${id}.md`)}${'a'.repeat(40000)}`,
	);
	expect((await fixture.run(['--mail', 'receive'], 'beta')).out).toContain('oversized');
	expect((await fixture.run(['--mail', 'confirm', id, 'Ready'], 'beta')).code).toBe(1);
	const first = await fixture.run(
		['--mail', 'read-self', id, '--offset', '0', '--limit', '32768'],
		'beta',
	);
	expect(first.code).toBe(0);
	const chunk = JSON.parse(first.out) as { end: number };
	expect(
		(
			await fixture.run(
				['--mail', 'read-self', id, '--offset', String(chunk.end), '--limit', '32768'],
				'beta',
			)
		).code,
	).toBe(0);
	expect((await fixture.run(['--mail', 'confirm', id, 'Ready'], 'beta')).code).toBe(0);
});

test('oversized holds have no filesystem path', async () => {
	const id = await request();
	await fixture.run(['--mail', 'receive'], 'beta');
	await fixture.run(['--mail', 'confirm', id, 'Need the full hold'], 'beta');
	const held = await fixture.run(['--mail', 'hold', id, 'Authority', 'Change setting A'], 'beta');
	expect(held.code).toBe(0);
	const value = JSON.parse(held.out) as { hold: { id: string } };
	const stored = JSON.parse(await fixture.read(`mailboxes/beta/holds/${value.hold.id}.json`)) as {
		proposal: string;
	};
	stored.proposal = `Change setting ${'x'.repeat(40000)}`;
	await writeFile(
		join(fixture.records, 'mailboxes', 'beta', 'holds', `${value.hold.id}.json`),
		JSON.stringify(stored),
	);
	const page = await fixture.run(['--mail', 'holds'], 'beta');
	expect(page.out).toContain('"oversized":true');
	expect(page.out).not.toContain(fixture.records);
	expect(
		(
			await fixture.run(
				['--mail', 'read-hold', value.hold.id, '--offset', '0', '--limit', '10'],
				'alpha',
			)
		).code,
	).toBe(1);
	const first = await fixture.run(
		['--mail', 'read-hold', value.hold.id, '--offset', '0', '--limit', '32768'],
		'beta',
	);
	expect(first.code).toBe(0);
	const chunk = JSON.parse(first.out) as { end: number; size: number; text: string };
	expect(chunk.end).toBeLessThan(chunk.size);
	expect(chunk.text).not.toContain(fixture.records);
	expect(
		(
			await fixture.run(
				[
					'--mail',
					'read-hold',
					value.hold.id,
					'--offset',
					String(chunk.end),
					'--limit',
					'32768',
				],
				'beta',
			)
		).code,
	).toBe(0);
});

test('changed proposals require new approval, and receive pages remain bounded', async () => {
	const id = await request();
	await fixture.run(['--mail', 'receive'], 'beta');
	await fixture.run(['--mail', 'confirm', id, 'Need approval'], 'beta');
	const first = await fixture.run(
		['--mail', 'hold', id, 'Authority', 'Change setting A'],
		'beta',
	);
	const hold = JSON.parse(first.out) as { hold: { id: string } };
	expect((await fixture.run(['--attention', 'approve', hold.hold.id])).code).toBe(0);
	const changed = await fixture.run(
		['--mail', 'hold', id, 'Authority', 'Change setting B'],
		'beta',
	);
	expect(changed.out).not.toContain(`"id":"${hold.hold.id}"`);
	expect((await fixture.run(['--mail', 'ack-self', id], 'beta')).code).toBe(1);
	for (let i = 0; i < 3; i++) await request('a'.repeat(14000));
	let cursor = '';
	let count = 0;
	do {
		const response = await fixture.run(
			['--mail', 'receive', '--pending', ...(cursor ? [cursor] : [])],
			'beta',
		);
		expect(Buffer.byteLength(response.out)).toBeLessThanOrEqual(32768);
		const page = JSON.parse(response.out) as { messages: unknown[]; next: string | null };
		count += page.messages.length;
		cursor = page.next ?? '';
	} while (cursor);
	expect(count).toBe(4);
});
