import { expect, test } from 'bun:test';

import { referenceIds } from '../src/desktop/room-references.ts';

test('room references identify numbered posts without interpreting tokens or URL fragments', () => {
	const text = 'Reply to #2048; see (#1), #25 and #25. @morgan <img src=x> #9007199254740992';
	expect(referenceIds(text).map(({ id }) => id)).toEqual([2048, 1, 25, 25]);
	for (const match of referenceIds(text))
		expect(text.slice(match.index, match.index + match.label.length)).toBe(match.label);
	expect(referenceIds('color #123abc; #0 #01 ##123 a#12 /#44 https://x/#77')).toEqual([]);
	expect(referenceIds('#123\n#456')).toEqual([
		{ index: 0, label: '#123', id: 123 },
		{ index: 5, label: '#456', id: 456 },
	]);
});
