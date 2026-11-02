import { expect, test } from 'bun:test';

import { renderMarkdown } from '../src/desktop/notepad-markdown.ts';
import { editorDom, EditorElement } from './fixtures/editor-dom.ts';

test('Markdown table columns have scoped headers and ordinary body cells, preserving inline text', () => {
	const dom = editorDom();
	try {
		const rendered = renderMarkdown(
			'| **Name** | Count |\n| --- | --- |\n| Alpha | 2 |\n| Beta | 3 |',
			() => {},
		);
		const fragment = rendered as unknown as EditorElement;
		const headers = fragment.querySelectorAll('th');
		expect(headers).toHaveLength(2);
		expect(headers.map((cell) => cell.attributes.get('scope'))).toEqual(['col', 'col']);
		expect(fragment.querySelector('thead')?.querySelectorAll('th')).toHaveLength(2);
		expect(headers[0]?.querySelector('strong')?.children[0]?.textContent).toBe('Name');
		const data = fragment.querySelector('tbody')?.querySelectorAll('td');
		expect(data).toHaveLength(4);
		expect(data?.map((cell) => cell.children[0]?.textContent)).toEqual([
			'Alpha',
			'2',
			'Beta',
			'3',
		]);
		expect(data?.every((cell) => !cell.attributes.has('scope'))).toBe(true);
		expect(fragment.querySelector('thead')?.querySelectorAll('td')).toHaveLength(0);
	} finally {
		dom.restore();
	}
});

test('header-only tables retain column semantics and ordinary paragraphs stay paragraphs', () => {
	const dom = editorDom();
	try {
		const rendered = renderMarkdown(
			'Paragraph\n\n| Name |\n| --- |',
			() => {},
		) as unknown as EditorElement;
		expect(rendered.querySelectorAll('p')).toHaveLength(1);
		expect(rendered.querySelectorAll('th')).toHaveLength(1);
		expect(rendered.querySelectorAll('td')).toHaveLength(0);
	} finally {
		dom.restore();
	}
});
