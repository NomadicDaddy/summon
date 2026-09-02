import { describe, expect, test } from 'bun:test';
import { newRecord, rememberSession } from '../src/store.ts';
import { providerCommand, sessionPrompt } from '../src/providers.ts';

describe('provider commands', () => {
	test('Codex is started for a new record', () => {
		const record = newRecord('Carl', '/work');
		expect(providerCommand('codex', record, undefined).slice(0, 3)).toEqual([
			'codex',
			'-C',
			'/work',
		]);
	});

	test('Codex resumes a remembered session', () => {
		const record = newRecord('Carl', '/work');
		rememberSession(record, 'codex', 'session-1');
		expect(providerCommand('codex', record, 'session-1').slice(0, 5)).toEqual([
			'codex',
			'resume',
			'-C',
			'/work',
			'session-1',
		]);
	});

	test('Claude uses a supplied UUID for its first session', () => {
		const record = newRecord('Carl', '/work');
		const command = providerCommand('claude', record, '00000000-0000-4000-8000-000000000000');
		expect(command.slice(0, 3)).toEqual([
			'claude',
			'--session-id',
			'00000000-0000-4000-8000-000000000000',
		]);
	});

	test('the prompt carries the name and notes', () => {
		const record = newRecord('Carl', '/work');
		record.notes = 'Keeps release notes terse.';
		expect(sessionPrompt(record)).toContain('Carl');
		expect(sessionPrompt(record)).toContain('Keeps release notes terse.');
	});
});
