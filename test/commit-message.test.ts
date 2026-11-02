import { describe, expect, test } from 'bun:test';

import { splitCommit } from '../src/desktop/commit-message.ts';

/*
 * Shaped from real `git show` output, because the thing most likely to go wrong is a message that
 * contains the word the split looks for - and this repository's own commit messages discuss diffs.
 */
const SHOW = [
	'commit 1f6f88abc',
	'Author: Somebody <nobody@example.com>',
	'Date:   Wed Oct 1 12:00:00 2026 -0500',
	'',
	'    fix(room): draw a thumbs-up on the message it answers',
	'',
	'    The longer body, indented by git.',
	'',
	'diff --git a/src/a.ts b/src/a.ts',
	'index 111..222 100644',
	'--- a/src/a.ts',
	'+++ b/src/a.ts',
	'@@ -1 +1 @@',
	'-before',
	'+after',
].join('\n');

describe('splitCommit', () => {
	test('puts the message and the diff on opposite sides of the first file header', () => {
		const parts = splitCommit(SHOW);
		expect(parts.message).toContain('fix(room): draw a thumbs-up');
		expect(parts.message).not.toContain('diff --git');
		expect(parts.diff.startsWith('diff --git a/src/a.ts')).toBe(true);
	});

	test('takes off the four spaces git adds, and nothing else', () => {
		expect(splitCommit(SHOW).message).toContain('\nThe longer body, indented by git.');
	});

	test('a message mentioning a diff header does not split early', () => {
		// The guard that matters here: the pattern is anchored to the start of a line, and git has
		// indented every line of the message, so a message ABOUT `diff --git` cannot masquerade.
		const tricky = SHOW.replace(
			'    The longer body, indented by git.',
			'    Explains why diff --git a/x b/x appears twice.',
		);
		const parts = splitCommit(tricky);
		expect(parts.message).toContain('Explains why diff --git');
		expect(parts.diff.startsWith('diff --git a/src/a.ts')).toBe(true);
	});

	test('drops the sha, author and date, keeping what was written', () => {
		const message = splitCommit(SHOW).message;
		expect(message.startsWith('fix(room): draw a thumbs-up')).toBe(true);
		expect(message).not.toContain('Author:');
		expect(message).not.toContain('1f6f88abc');
	});

	test('a message whose own line starts like a header survives', () => {
		// Only the LEADING run is dropped, and git puts a blank line before the message.
		const tricky = SHOW.replace(
			'    The longer body, indented by git.',
			'    Date: unchanged.',
		);
		expect(splitCommit(tricky).message).toContain('Date: unchanged.');
	});
	test('a plain file diff is all diff and no message', () => {
		const parts = splitCommit('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b');
		expect(parts.message).toBe('');
		expect(parts.diff).toContain('@@ -1 +1 @@');
	});

	test('a commit that changed nothing is all message', () => {
		const parts = splitCommit('commit abc\n\n    An empty commit.\n');
		expect(parts.diff).toBe('');
		expect(parts.message).toContain('An empty commit.');
	});
});
