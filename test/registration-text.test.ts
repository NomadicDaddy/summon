import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { localEvents } from '../src/local-room.ts';
import { textHash } from '../src/profile-text.ts';
import { registrationTag } from '../src/registration-proposal.ts';
import { loadAgent, recordPath } from '../src/store.ts';
import { registrationFixture } from './fixtures/registration.ts';

const {
	agentMessage,
	answered,
	approve,
	as,
	asPm,
	audit,
	failure,
	operatorMessage,
	revision,
	run,
	textFile,
} = registrationFixture();

test('the operator edits one field; omission keeps the other and output states delivery', async () => {
	const path = await textFile('expertise.txt', 'New expertise\r\nsecond line\n');
	const output = await run([
		'edit',
		'beta',
		'--revision',
		await revision(),
		'--expertise-file',
		path,
	]);
	const beta = await loadAgent('beta');
	expect(beta?.expertise).toBe('New expertise\nsecond line');
	expect(beta?.domain).toBe('Original domain');
	expect(beta?.sessions.map((session) => session.id)).toEqual(['beta-session']);
	expect(output).toContain('expertise is now:\nNew expertise\nsecond line');
	expect(output).not.toContain('domain is now');
	expect(output).toContain('future startup prompts');
	expect(output).toContain('Running sessions keep their existing context');
	expect(output).toContain('No session was launched, woken or stopped.');
	const [entry, applied] = await audit();
	expect(entry).toMatchObject({
		kind: 'intent',
		actor: 'operator',
		target: 'beta',
		decision: null,
	});
	expect(Object.keys(entry?.changes as object)).toEqual(['expertise']);
	expect(applied).toMatchObject({ kind: 'applied', id: entry?.id });
	const listed = JSON.parse(await run(['audit', 'beta'])) as {
		entries: { id: string; status: string }[];
		malformed: number;
	};
	expect(listed.malformed).toBe(0);
	expect(listed.entries.map(({ id, status }) => [id, status])).toEqual([
		[String(entry?.id), 'applied'],
	]);
});

test('request, the operator’s Yes, then the matching PM edit succeeds and audits the decision', async () => {
	const path = await textFile('domain.txt', 'Release engineering');
	const spec = ['beta', '--revision', await revision(), '--domain-file', path];
	const yes = await approve(spec);
	await asPm(() => run(['edit', ...spec, '--decision', yes]));
	expect((await loadAgent('beta'))?.domain).toBe('Release engineering');
	const [entry] = await audit();
	expect(entry).toMatchObject({ actor: 'steward', target: 'beta', decision: yes });
	const changes = entry?.changes as Record<string, { old: string; new: string }>;
	expect(changes.domain?.old).toMatch(/^[a-f0-9]{64}$/);
	expect(changes.domain?.old).not.toBe(changes.domain?.new);
	expect(changes.expertise).toBeUndefined();
});

test('request is for a current PM, validates like edit, and posts a summary with one tag', async () => {
	const path = await textFile('domain.txt', 'Release engineering');
	const spec = ['beta', '--revision', await revision(), '--domain-file', path];
	expect(await failure(run(['request', ...spec]))).toContain('The operator edits directly');
	expect(await as('alpha', 'alpha-launch', () => failure(run(['request', ...spec])))).toContain(
		'Only the operator or the registered PM',
	);
	const stale = ['beta', '--revision', '0'.repeat(64), '--domain-file', path];
	expect(await asPm(() => failure(run(['request', ...stale])))).toContain(
		'Expertise or domain changed after this text was read',
	);
	const pm = ['steward', '--revision', await revision('steward'), '--domain-file', path];
	expect(await asPm(() => failure(run(['request', ...pm])))).toContain('is the PM');
	const output = await asPm(() => run(['request', ...spec]));
	const id = Number(/#(\d+)/.exec(output)?.[1]);
	const [question] = (await localEvents()).filter((event) => event.id === id);
	expect(question?.question?.kind).toBe('approval');
	const tag = registrationTag({
		target: 'beta',
		revision: await revision(),
		edit: { domain: 'Release engineering' },
	});
	// Short text is shown complete, between markers keyed to its own digest.
	const key = textHash('Release engineering').slice(0, 16);
	expect(question?.text.split('\n').slice(1)).toEqual([
		`--- new domain ${key}, complete, 19 characters ---`,
		'Release engineering',
		`--- end of new domain ${key} ---`,
		tag,
	]);
});

test('a decision must be the operator’s Yes to a tag matching this exact edit', async () => {
	const domain = await textFile('domain.txt', 'Release engineering');
	const other = await textFile('other.txt', 'Something else');
	const expertise = await textFile('expertise.txt', 'New expertise');
	const read = await revision();
	const spec = ['beta', '--revision', read, '--domain-file', domain];
	const args = ['edit', ...spec];
	const tag = registrationTag({
		target: 'beta',
		revision: read,
		edit: { domain: 'Release engineering' },
	});
	expect(await asPm(() => failure(run(args)))).toContain('A PM edit needs --decision');
	const refusals: [string, string][] = [
		[agentMessage(), 'was not sent by the operator'],
		['99999', 'does not exist'],
		['thread-abc', '--decision takes the Team Room id'],
		[
			await operatorMessage('Yes, go ahead with beta'),
			'is not an answer to an approval request',
		],
		[await approve(spec, 1), 'did not approve: the operator answered No'],
		[await answered(tag, 0, 'question'), 'answers a question, not an approval request'],
		[await answered('Stop Beta?', 0), 'is not a registration-edit request'],
		[
			await answered('Alpha’s domain change, reviewed by Beta', 0),
			'is not a registration-edit request',
		],
		[await answered(`Two edits\n${tag}\n${tag}`, 0), 'does not match this exact edit'],
		[await answered(`Inline ${tag} here`, 0), 'malformed registration-edit tag'],
		[
			await approve([
				'alpha',
				'--revision',
				await revision('alpha'),
				'--domain-file',
				domain,
			]),
			'approved target=alpha, but this edit has target=beta',
		],
		[await approve(['beta', '--revision', read, '--domain-file', other]), 'approved domain='],
		[
			await approve([
				'beta',
				'--revision',
				read,
				'--domain-file',
				domain,
				'--expertise-file',
				expertise,
			]),
			'approved expertise=',
		],
		[await approve(['beta', '--revision', read, '--clear-domain']), 'approved domain=clear'],
	];
	for (const [reference, reason] of refusals) {
		expect(await asPm(() => failure(run([...args, '--decision', reference])))).toContain(
			reason,
		);
		// The operator needs no decision, but one that is given is held to the same standard.
		expect(await failure(run([...args, '--decision', reference]))).toContain(reason);
	}
	expect((await loadAgent('beta'))?.domain).toBe('Original domain');
	expect(await audit()).toEqual([]);
	// A Yes for an older revision does not carry over to a later one.
	const old = await approve(spec);
	await run(['edit', 'beta', '--revision', read, '--expertise-file', expertise]);
	const now = ['edit', 'beta', '--revision', await revision(), '--domain-file', domain];
	expect(await asPm(() => failure(run([...now, '--decision', old])))).toContain(
		'approved revision=',
	);
});

test('ordinary peers, missing identity and stale launches are refused before any file is read', async () => {
	const path = await textFile('domain.txt', 'Taken over');
	const args = ['edit', 'beta', '--revision', await revision(), '--domain-file', path];
	const withDecision = [...args, '--decision', '1'];
	expect(await as('alpha', 'alpha-launch', () => failure(run(withDecision)))).toContain(
		'Only the operator or the registered PM',
	);
	expect(await as('steward', '', () => failure(run(withDecision)))).toContain(
		'requires a named summon session',
	);
	expect(await as('steward', 'old-launch', () => failure(run(withDecision)))).toContain(
		'previous launch',
	);
	expect(await as('ghost', 'x', () => failure(run(withDecision)))).toContain(
		'registered named session',
	);
	expect(await as('alpha', 'alpha-launch', () => failure(run(['show', 'beta'])))).toContain(
		'Only the operator',
	);
	expect((await loadAgent('beta'))?.domain).toBe('Original domain');
	expect(await audit()).toEqual([]);
});

test('missing targets and PM targets, including the PM itself, are refused unchanged', async () => {
	const path = await textFile('domain.txt', 'Anything');
	const zero = '0'.repeat(64);
	expect(
		await failure(run(['edit', 'nobody', '--revision', zero, '--domain-file', path])),
	).toContain('No stored agent named nobody');
	const before = await readFile(recordPath('steward'), 'utf8');
	const pm = ['edit', 'steward', '--revision', await revision('steward'), '--domain-file', path];
	for (const work of [() => run(pm), () => asPm(() => run([...pm, '--decision', '1']))])
		expect(await failure(work())).toContain('Summon sets PM expertise and domain in code');
	expect(await readFile(recordPath('steward'), 'utf8')).toBe(before);
	expect(await audit()).toEqual([]);
});

test('invalid, excessive and control-character text is refused', async () => {
	const base = ['edit', 'beta', '--revision', await revision(), '--expertise-file'];
	const cases: [string | Uint8Array, string][] = [
		['x'.repeat(8001), 'exceeds 8000'],
		['Bell\u0007here', 'control or bidirectional'],
		['Escape\u001b[31m', 'control or bidirectional'],
		// Built at run time so this source file holds no right-to-left override itself.
		[`Override ${String.fromCodePoint(0x202e)}desrever`, 'control or bidirectional'],
		['Lone\rreturn', 'control or bidirectional'],
		['   \n\t', 'Use the explicit clear flag'],
		[new Uint8Array([0xff, 0xfe, 0x41]), 'valid UTF-8'],
	];
	for (const [index, [text, message]] of cases.entries())
		expect(await failure(run([...base, await textFile(`bad-${index}.txt`, text)]))).toContain(
			message,
		);
	expect(
		await failure(run([...base, await textFile('limit.txt', `${'y'.repeat(7998)}\tz`)])),
	).toBe('resolved');
	expect((await loadAgent('beta'))?.expertise).toHaveLength(8000);
});

test('only expertise and domain are accepted, and clearing is explicit', async () => {
	const rev = await revision();
	for (const flag of [
		'--using',
		'--model',
		'--cwd',
		'--note',
		'--notes-file',
		'--session',
		'--name',
		'--member-type',
		'--can-stop-resting',
		'--backup',
		'--cover',
		'--lm-studio-url',
		'--expertise',
		'--domain',
	])
		expect(await failure(run(['edit', 'beta', '--revision', rev, flag, 'x']))).toContain(
			'changes only expertise and domain',
		);
	const path = await textFile('d.txt', 'Other');
	expect(
		await failure(
			run(['edit', 'beta', '--revision', rev, '--domain-file', path, '--clear-domain']),
		),
	).toContain('Give one of --domain-file or --clear-domain, once.');
	expect(await failure(run(['edit', 'beta', '--revision', rev]))).toContain('at least one');
	expect(await failure(run(['edit', 'beta', '--domain-file', path]))).toContain(
		'--revision is required',
	);
	const output = await run(['edit', 'beta', '--revision', rev, '--clear-domain']);
	const beta = await loadAgent('beta');
	expect(beta?.domain).toBeUndefined();
	expect(beta?.expertise).toBe('Original expertise');
	expect(output).toContain('domain is now empty (cleared).');
	expect(
		await failure(run(['edit', 'beta', '--revision', await revision(), '--clear-domain'])),
	).toContain('already matches');
});

test('show reports the text and revision the edit expects', async () => {
	const shown = JSON.parse(await run(['show', 'beta'])) as Record<string, string>;
	expect(shown).toEqual({
		name: 'beta',
		memberType: 'teammate',
		expertise: 'Original expertise',
		domain: 'Original domain',
		revision: await revision(),
	});
});
