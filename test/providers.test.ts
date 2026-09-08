import { describe, expect, test } from 'bun:test';
import { newRecord, rememberSession } from '../src/store.ts';
import { providerCommand, sessionPrompt } from '../src/providers.ts';

describe('provider commands', () => {
	test('a new Codex registration starts Codex', () => {
		const record = newRecord('Auden', '/work', 'codex');
		expect(providerCommand(record, undefined).slice(0, 3)).toEqual(['codex', '-C', '/work']);
	});

	test('a Codex registration resumes its remembered session', () => {
		const record = newRecord('Auden', '/work', 'codex');
		rememberSession(record, 'session-1');
		expect(providerCommand(record, 'session-1').slice(0, 5)).toEqual([
			'codex',
			'resume',
			'-C',
			'/work',
			'session-1',
		]);
	});

	test('a new Claude registration uses a supplied UUID', () => {
		const record = newRecord('Carl', '/work', 'claude');
		expect(providerCommand(record, '00000000-0000-4000-8000-000000000000').slice(0, 3)).toEqual(
			['claude', '--session-id', '00000000-0000-4000-8000-000000000000'],
		);
		expect(() => providerCommand(record, undefined)).toThrow('must have an ID');
	});

	test('a Claude registration resumes its remembered session', () => {
		const record = newRecord('Carl', '/work', 'claude');
		rememberSession(record, 'session-1');
		expect(providerCommand(record, 'session-1').slice(0, 3)).toEqual([
			'claude',
			'--resume',
			'session-1',
		]);
	});

	test('the prompt carries the name and notes', () => {
		const record = newRecord('Carl', '/work', 'claude');
		record.notes = 'Keeps release notes terse.';
		expect(sessionPrompt(record)).toContain('Carl');
		expect(sessionPrompt(record)).toContain('Keeps release notes terse.');
	});
});
