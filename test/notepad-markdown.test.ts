import { expect, test } from 'bun:test';

import {
	headingAnchor,
	markdownTree,
	safeLink,
	toggleMarkdownTask,
} from '../src/desktop/notepad-markdown.ts';

test('Markdown tasks use parser source offsets, preserving nested lists, duplicate labels and CRLF', () => {
	const source =
		'# Tasks 📝\r\n\r\n- [ ] same\r\n    - [x] same\r\n\r\n```md\r\n- [ ] same\r\n```\r\n\r\n1. [ ] last\r\n';
	const tree = markdownTree(source);
	const tasks: number[] = [];
	function visit(node: {
		type: string;
		checked?: boolean | null;
		position?: { start: { offset?: number | undefined } } | undefined;
		children?: readonly unknown[];
	}): void {
		if (node.type === 'listItem' && typeof node.checked === 'boolean') {
			const offset = node.position?.start.offset;
			if (offset === undefined) throw new Error('Missing source position');
			tasks.push(offset);
		}
		if (node.children)
			for (const child of node.children) visit(child as Parameters<typeof visit>[0]);
	}
	visit(tree);
	expect(tasks).toHaveLength(3);
	const nested = tasks[1];
	if (nested === undefined) throw new Error('Missing nested task');
	const changed = toggleMarkdownTask(source, nested, false);
	expect(changed).toBe(source.replace('    - [x] same', '    - [ ] same'));
	expect(toggleMarkdownTask(changed, nested, true)).toBe(source);
	expect(() => toggleMarkdownTask(source, 0, true)).toThrow('source changed');
});

/*
 * The Team Window denies new windows and navigation, so a preview link only works if the notepad
 * follows it itself. These are the links it can follow: web links through the room's open-URL
 * boundary, and fragments to a heading in the preview. Everything else stays as text.
 */
test('the preview follows web links and fragments, and nothing else', () => {
	expect(safeLink('https://example.com')).toBe(true);
	expect(safeLink('HTTP://example.com/x')).toBe(true);
	expect(safeLink('#next-steps')).toBe(true);
	for (const refused of [
		'mailto:a@b.c',
		'javascript:alert(1)',
		'file:///C:/x',
		'ftp://x',
		'//x.y',
	])
		expect(safeLink(refused)).toBe(false);
});

test('heading anchors match the slugs pasted from GitHub', () => {
	expect(headingAnchor('Next Steps')).toBe('next-steps');
	expect(headingAnchor('  What’s left? (v1.0)  ')).toBe('whats-left-v10');
	expect(headingAnchor('Tasks 📝')).toBe('tasks-');
	expect(headingAnchor('Été à Paris')).toBe('été-à-paris');
});

test('preview links are followed in place, never by opening a window', async () => {
	const [markdown, notepad] = await Promise.all([
		Bun.file('src/desktop/notepad-markdown.ts').text(),
		Bun.file('src/desktop/notepad.ts').text(),
	]);
	expect(markdown).not.toContain("target = '_blank'");
	expect(notepad).toContain('window.team.openRoomUrl(link.href)');
	expect(notepad).toContain("heading.scrollIntoView({ block: 'start' })");
	// Each task checkbox is named by its own text; a fixed "Mark task complete" made every one alike.
	expect(markdown).not.toContain('`Mark task ${');
	expect(markdown).toContain("checkbox.setAttribute('aria-labelledby', label.id)");
});
