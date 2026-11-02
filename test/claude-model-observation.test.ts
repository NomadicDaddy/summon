import { expect, test } from 'bun:test';
import { appendFile, mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { readClaudeModel } from '../src/claude-model-observation.ts';
import { startClaudeTurnBridge } from '../src/claude-turn-bridge.ts';
import { claudeTurn } from '../src/claude-turn-state.ts';
import { readProviderModel } from '../src/provider-model-info.ts';
import { newRecord, rememberSession } from '../src/store.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

test('owned native model capacity reaches the reader; stale epoch, session and launch cannot supply it', async () => {
	const fixture = await mailHarness();
	const previous = process.env.SUMMON_HOME;
	const config = process.env.CLAUDE_CONFIG_DIR;
	process.env.SUMMON_HOME = fixture.records;
	process.env.CLAUDE_CONFIG_DIR = `${fixture.root}/absent-claude`;
	const nonce = 'model-observation';
	await initializeActivity('alpha', nonce, 'claude');
	const bridge = await startClaudeTurnBridge('alpha', nonce, 'exact-thread');
	const url = bridge.env.SUMMON_CLAUDE_TURN_URL.replace(/\/turn$/, '');
	const post = (path: string, body: unknown, key = bridge.env.SUMMON_CLAUDE_TURN_KEY) =>
		fetch(url + path, {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}` },
			body: JSON.stringify(body),
		});
	try {
		await post('/attach', { session: 'exact-thread' });
		const epoch = (await claudeTurn('alpha', nonce))?.epoch;
		const data = {
			session: 'exact-thread',
			epoch,
			model: 'native-model',
			contextWindow: 200000,
		};
		expect((await post('/model', data, 'wrong')).status).toBe(403);
		expect(await readClaudeModel('alpha', 'exact-thread')).toBeUndefined();
		expect((await post('/model', { ...data, usage: 'PRIVATE' })).status).toBe(400);
		expect((await post('/model', { ...data, session: 'other' })).status).toBe(400);
		expect((await post('/model', data)).status).toBe(204);
		const record = newRecord('alpha', fixture.root, 'claude');
		rememberSession(record, 'exact-thread');
		expect(await readProviderModel(record, fixture.root, 'alpha')).toMatchObject({
			model: 'native-model',
			contextWindow: 200000,
			sessionId: 'exact-thread',
			provider: 'claude',
		});
		const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fixture');
		await mkdir(project, { recursive: true });
		const transcript = join(project, 'exact-thread.jsonl');
		const assistant = (model: string) =>
			JSON.stringify({
				type: 'assistant',
				sessionId: 'exact-thread',
				message: { model },
				effort: 'high',
			}) + '\n';
		await writeFile(transcript, assistant('native-model'));
		const later = new Date(Date.now() + 10000);
		await utimes(transcript, later, later);
		expect(await readProviderModel(record, fixture.root, 'alpha')).toMatchObject({
			model: 'native-model',
			reasoning: 'high',
			contextWindow: 200000,
		});
		await appendFile(transcript, JSON.stringify({ type: 'progress' }) + '\n');
		await utimes(transcript, later, later);
		expect((await readProviderModel(record, fixture.root, 'alpha'))?.contextWindow).toBe(
			200000,
		);
		expect((await post('/model', { ...data, contextWindow: 1000000 })).status).toBe(204);
		expect((await readProviderModel(record, fixture.root, 'alpha'))?.contextWindow).toBe(
			1000000,
		);
		await appendFile(transcript, assistant('changed-model'));
		await utimes(transcript, later, later);
		const switched = await readProviderModel(record, fixture.root, 'alpha');
		expect(switched?.model).toBe('changed-model');
		expect(switched?.contextWindow).toBeUndefined();
		const earlier = new Date(Date.now() - 10000);
		await utimes(transcript, earlier, earlier);
		expect(await readProviderModel(record, fixture.root, 'alpha')).toMatchObject({
			model: 'native-model',
			contextWindow: 1000000,
		});
		expect(await readClaudeModel('alpha', 'other')).toBeUndefined();
		await post('/attach', { session: 'exact-thread' });
		expect((await post('/model', data)).status).toBe(400);
		expect(await readClaudeModel('alpha', 'exact-thread')).toBeUndefined();
		await post('/model', { ...data, epoch: (await claudeTurn('alpha', nonce))?.epoch });
		await initializeActivity('alpha', 'replacement-launch', 'claude');
		expect(await readClaudeModel('alpha', 'exact-thread')).toBeUndefined();
	} finally {
		await bridge.stop();
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		if (config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = config;
		await fixture.dispose();
	}
});
