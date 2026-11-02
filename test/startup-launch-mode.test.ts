import { expect, test } from 'bun:test';

import { sessionPrompt } from '../src/providers.ts';
import { newRecord, rememberSession } from '../src/store.ts';

test.each(['claude', 'codex', 'grok', 'kilo'] as const)(
	'%s startup distinguishes fresh conversation from retained context',
	(provider) => {
		const record = newRecord('Launch', '/work', provider);
		const fresh = sessionPrompt(record, 'launch', 'Keep this note', [], 'Keep this mailbox');
		expect(fresh).toContain('Launch mode: fresh.');
		expect(fresh).toContain('Keep this note');
		expect(fresh).toContain('Keep this mailbox');
		expect(fresh).toContain('Fresh does not mean provider memory');
		rememberSession(record, 'saved-conversation');
		expect(sessionPrompt(record, 'launch')).toContain('Launch mode: resume.');
		// The launch decision remains authoritative if persistence changes afterward.
		expect(sessionPrompt(record, 'launch', '', [], '', 'fresh')).toContain(
			'Launch mode: fresh.',
		);
	},
);
