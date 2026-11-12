import { expect, test } from 'bun:test';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { newRecord, type Provider } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';
import { telegramHarness } from './fixtures/telegram-harness.ts';

test('file messages retain literal UTF-8 and identity for all registered providers', async () => {
	const fixture = await mailHarness();
	try {
		const body =
			'Literal \\a \\n \\server\\share $HOME $(whoami) `text` “quotes” 😀\r\nsecond line';
		const path = join(fixture.root, 'body with spaces.txt');
		await writeFile(path, body);
		for (const provider of ['claude', 'codex', 'grok', 'kilo'] satisfies Provider[]) {
			await writeFile(
				join(fixture.records, `${provider}.json`),
				JSON.stringify(newRecord(provider, fixture.root, provider)),
			);
			// The harness only records activity for alpha and beta; a seat registered here needs
			// its own record for the launch the child claims, or the CLI refuses it (4250f4c).
			await mkdir(join(fixture.records, 'runtime', provider), { recursive: true });
			await writeFile(
				join(fixture.records, 'runtime', provider, 'activity.json'),
				JSON.stringify({
					workingOn: '',
					state: 'idle',
					updatedAt: new Date().toISOString(),
					nonce: 'test-launch',
				}),
			);
			const sent = await fixture.run(
				['--mail', 'send-self', 'beta', '--body-file', path],
				provider,
			);
			expect(sent.code).toBe(0);
			const id = (JSON.parse(sent.out) as { id: string }).id;
			const raw = await fixture.read(`mailboxes/beta/inbox/${id}.md`);
			expect(raw).toContain(`From: ${provider}\n`);
			expect(raw).toEndWith(`${body}\n`);
			const reply = await fixture.run(['--mail', 'reply', id, '--body-file', path], 'beta');
			expect(reply.code).toBe(0);
			const replyId = (JSON.parse(reply.out) as { id: string }).id;
			expect(await fixture.read(`mailboxes/${provider}/inbox/${replyId}.md`)).toContain(
				`In-Reply-To: ${id}\n\n${body}`,
			);
			const room = await fixture.run(['--room', 'send', '--body-file', path], provider);
			expect(room.code).toBe(0);
			expect(room.out).toContain(JSON.stringify(body));
		}
		expect(await readFile(path, 'utf8')).toBe(body);
	} finally {
		await fixture.dispose();
	}
});

test('invalid file bodies and mixed arguments do not persist messages', async () => {
	const fixture = await mailHarness();
	try {
		const path = join(fixture.root, 'body.txt');
		await mkdir(join(fixture.records, 'mailboxes/beta/inbox'), { recursive: true });
		for (const body of [Buffer.from([0xff]), Buffer.from('   '), Buffer.from('a\0b')]) {
			await writeFile(path, body);
			expect(
				(await fixture.run(['--mail', 'send-self', 'beta', '--body-file', path], 'alpha'))
					.code,
			).toBe(1);
		}
		for (const tail of [
			['--body-file'],
			['--body-file', `${path}.missing`],
			['--body-file', fixture.root],
			['inline', '--body-file', path],
		]) {
			expect(
				(await fixture.run(['--mail', 'send-self', 'beta', ...tail], 'alpha')).code,
			).toBe(1);
		}
		await writeFile(path, 'valid');
		expect(
			(await fixture.run(['--mail', 'send', 'beta', 'alpha', '--body-file', path], 'alpha'))
				.code,
		).toBe(1);
		expect((await fixture.run(['--comms', 'halt'])).code).toBe(0);
		expect(
			(await fixture.run(['--mail', 'send-self', 'beta', '--body-file', path], 'alpha')).code,
		).toBe(1);
		expect(await readdir(join(fixture.records, 'mailboxes/beta/inbox'))).toEqual([]);
	} finally {
		await fixture.dispose();
	}
});

test('directed file sends and replies keep Telegram and local reply boundaries', async () => {
	const fixture = await telegramHarness();
	try {
		const path = join(fixture.root, 'directed body.txt');
		const text = 'Literal \\a and 😀\nsecond line';
		await writeFile(path, text);
		const sent = await fixture.invoke(
			['send', '--to-user', '--body-file', path],
			'success',
			'test-agent',
			'42',
			'--room',
		);
		expect(sent.code).toBe(0);
		const reply = await fixture.invoke(
			['reply', '--to-user', '1', '--body-file', path],
			'success',
			'test-agent',
			'43',
			'--room',
		);
		expect(reply.code).toBe(0);
		const raw = await readFile(join(fixture.root, 'room/events.json'), 'utf8');
		expect(JSON.parse(raw) as unknown).toMatchObject([
			{ text: `📣 FOR YOU\n\n${text}` },
			{ text: `📣 FOR YOU\n\n${text}`, replyTo: 1, sender: { id: 'test-agent' } },
		]);
		const paused = join(fixture.root, 'communications');
		await mkdir(paused, { recursive: true });
		await writeFile(
			join(paused, 'state.json'),
			JSON.stringify({ paused: true, changedAt: Date.now(), source: 'local', updates: {} }),
		);
		expect(
			(
				await fixture.invoke(
					['send', '--to-user', '--body-file', path],
					'success',
					'test-agent',
					'44',
					'--room',
				)
			).code,
		).toBe(1);
		expect(await readFile(join(fixture.root, 'room/events.json'), 'utf8')).toBe(raw);
	} finally {
		await fixture.dispose();
	}
});

test('file messages cannot quote another teammate’s private mailbox or runtime', async () => {
	const fixture = await mailHarness();
	try {
		for (const directory of ['mailboxes/beta/inbox', 'runtime/beta', 'scratch/beta']) {
			const root = join(fixture.records, directory);
			await mkdir(root, { recursive: true });
			const path = join(root, 'private.txt');
			await writeFile(path, 'private fixture');
			expect((await fixture.run(['--room', 'send', '--body-file', path], 'alpha')).code).toBe(
				1,
			);
		}
		const alias = join(fixture.root, 'private alias');
		await symlink(
			join(fixture.records, 'scratch/beta'),
			alias,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		expect(
			(
				await fixture.run(
					['--room', 'send', '--body-file', join(alias, 'private.txt')],
					'alpha',
				)
			).code,
		).toBe(1);
		for (const folder of ['scratch/alpha', 'scratch/shared']) {
			const path = join(fixture.records, folder, 'allowed.txt');
			await mkdir(join(fixture.records, folder), { recursive: true });
			await writeFile(path, 'allowed body');
			expect((await fixture.run(['--room', 'send', '--body-file', path], 'alpha')).code).toBe(
				0,
			);
		}
		const path = join(fixture.root, 'reply.txt');
		await writeFile(path, 'room reply');
		const posted = await fixture.run(['--room', 'send', 'parent'], 'alpha');
		const id = (JSON.parse(posted.out) as { id: number }).id;
		const reply = await fixture.run(
			['--room', 'reply', String(id), '--body-file', path],
			'beta',
		);
		expect(reply.code).toBe(0);
		expect(JSON.parse(reply.out) as unknown).toMatchObject({
			replyTo: id,
			text: 'room reply',
			sender: { id: 'beta' },
		});
	} finally {
		await fixture.dispose();
	}
});
