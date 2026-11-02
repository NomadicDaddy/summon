import { expect, test } from 'bun:test';

import { ComposerHistory } from '../src/desktop/composer-history.ts';

test('composer retains fifty sent entries and restores unsent draft after browsing', () => {
	const history = new ComposerHistory();
	for (let n = 0; n < 60; n++) history.add(`Message ${n}`);
	history.add('Message 59');
	history.add('');
	expect(history.entries).toHaveLength(50);
	expect(history.entries[0]).toBe('Message 10');
	expect(history.move(-1, 'Unsent draft')).toBe('Message 59');
	expect(history.move(-1, 'Message 59')).toBe('Message 58');
	expect(history.move(1, 'Message 58')).toBe('Message 59');
	expect(history.move(1, 'Message 59')).toBe('Unsent draft');
	history.move(-1, 'Draft');
	history.reset();
	expect(history.move(-1, 'Edited recalled message')).toBe('Message 59');
	expect(history.move(1, 'Message 59')).toBe('Edited recalled message');
	const restored = new ComposerHistory([...history.entries, '', 'x'.repeat(4097)]);
	expect(restored.entries).toEqual(history.entries);
});
