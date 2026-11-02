import { expect, test } from 'bun:test';

import { externalRoomUrl, roomLinks } from '../src/desktop/room-links.ts';

test('plain room URLs preserve query and fragments and exclude surrounding punctuation', () => {
	const text =
		'See (https://example.com/a_(b)?x=1&y=2#42), then https://example.org/end. <https://other.test/path>';
	const links = roomLinks(text);
	expect(links.map((link) => link.label)).toEqual([
		'https://example.com/a_(b)?x=1&y=2#42',
		'https://example.org/end',
		'https://other.test/path',
	]);
	for (const link of links)
		expect(text.slice(link.index, link.index + link.label.length)).toBe(link.label);
});

test('external opener refuses executable schemes and credentials', () => {
	for (const value of [
		'javascript:alert(1)',
		'file:///C:/a',
		'vscode://file/a',
		'https://user:secret@example.com',
		'',
		null,
	])
		expect(() => externalRoomUrl(value)).toThrow();
	expect(externalRoomUrl('https://example.com/a')).toBe('https://example.com/a');
	expect(roomLinks('https://user:secret@example.com javascript:alert(1) https://')).toEqual([]);
});

test('punctuation exposed by unmatched nested brackets stays outside links', () => {
	for (const suffix of ['.)', '.)]', ').]', '.)]}']) {
		const text = `See https://example.com/a_(b)${suffix} next`;
		const link = roomLinks(text)[0];
		expect(link?.label).toBe('https://example.com/a_(b)');
		expect(text.slice((link?.index ?? 0) + (link?.label.length ?? 0))).toBe(`${suffix} next`);
	}
});
