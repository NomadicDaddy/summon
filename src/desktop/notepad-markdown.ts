import type { Nodes } from 'mdast';

import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

export function markdownTree(text: string): ReturnType<typeof fromMarkdown> {
	return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** Change only the source marker identified by the parser, preserving all other formatting. */
export function toggleMarkdownTask(text: string, offset: number, checked: boolean): string {
	const marker = /^(?:[-+*]|\d+[.)])\s+\[([ xX])\]/.exec(text.slice(offset));
	if (!marker) throw new Error('Task source changed. Refresh the preview and try again.');
	const at = offset + marker[0].lastIndexOf('[') + 1;
	return text.slice(0, at) + (checked ? 'x' : ' ') + text.slice(at + 1);
}

/**
 * The links the preview can actually follow. The window denies new windows and navigation, so an
 * http or https link goes out through the room's open-URL boundary, and a `#` fragment scrolls to a
 * heading inside the preview. Anything else, `mailto:` included, stays as its text: a link that
 * looks live but does nothing is worse than plain text.
 */
export function safeLink(value: string): boolean {
	return /^(?:https?:\/\/|#)/i.test(value);
}

/** The anchor a `#fragment` link reaches: GitHub's heading slug, so pasted links keep working. */
export function headingAnchor(text: string): string {
	return text
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s-]/gu, '')
		.replace(/\s/g, '-');
}

let taskLabels = 0;

export function renderMarkdown(text: string, update: (text: string) => void): DocumentFragment {
	const tree = markdownTree(text);
	const definitions = new Map(
		tree.children
			.filter((node) => node.type === 'definition')
			.map((node) => [node.identifier, node]),
	);
	// A repeated heading gets `-1`, `-2` and so on, the way GitHub numbers them.
	const anchors = new Map<string, number>();
	function render(node: Nodes): Node {
		if (node.type === 'table') {
			const table = document.createElement('table');
			const head = document.createElement('thead');
			const body = document.createElement('tbody');
			node.children.forEach((row, index) => {
				const tr = document.createElement('tr');
				for (const cell of row.children) {
					const element = document.createElement(index === 0 ? 'th' : 'td');
					if (index === 0) element.setAttribute('scope', 'col');
					for (const child of cell.children) element.appendChild(render(child));
					tr.append(element);
				}
				(index === 0 ? head : body).append(tr);
			});
			table.append(head, body);
			return table;
		}
		if (node.type === 'text' || node.type === 'html')
			return document.createTextNode(node.value);
		if (node.type === 'definition') return document.createDocumentFragment();
		if (node.type === 'thematicBreak') return document.createElement('hr');
		if (node.type === 'break') return document.createElement('br');
		if (node.type === 'image' || node.type === 'imageReference')
			return document.createTextNode(node.alt ?? '');
		if (node.type === 'code' || node.type === 'inlineCode') {
			const code = document.createElement('code');
			code.textContent = node.value;
			if (node.type === 'inlineCode') return code;
			const pre = document.createElement('pre');
			pre.append(code);
			return pre;
		}
		const tags: Partial<Record<Nodes['type'], string>> = {
			paragraph: 'p',
			blockquote: 'blockquote',
			strong: 'strong',
			emphasis: 'em',
			delete: 'del',
			listItem: 'li',
			footnoteDefinition: 'aside',
			footnoteReference: 'sup',
		};
		const tag =
			node.type === 'heading'
				? `h${node.depth}`
				: node.type === 'list'
					? node.ordered
						? 'ol'
						: 'ul'
					: node.type === 'link' || node.type === 'linkReference'
						? 'a'
						: tags[node.type];
		const element = tag ? document.createElement(tag) : document.createDocumentFragment();
		if (
			node.type === 'list' &&
			node.ordered &&
			node.start !== null &&
			node.start !== undefined &&
			element instanceof HTMLOListElement
		)
			element.start = node.start;
		if (
			element instanceof HTMLAnchorElement &&
			(node.type === 'link' || node.type === 'linkReference')
		) {
			const definition = node.type === 'link' ? node : definitions.get(node.identifier);
			if (definition && safeLink(definition.url)) element.href = definition.url;
		}
		let checkbox: HTMLInputElement | undefined;
		if (node.type === 'listItem' && typeof node.checked === 'boolean') {
			const box = document.createElement('input');
			box.type = 'checkbox';
			box.checked = node.checked;
			const offset = node.position?.start.offset;
			box.disabled = offset === undefined;
			if (offset !== undefined) box.dataset.taskOffset = String(offset);
			box.addEventListener('change', () => {
				if (offset !== undefined) update(toggleMarkdownTask(text, offset, box.checked));
			});
			element.append(box);
			if (element instanceof HTMLElement) element.classList.add('notepad-task');
			checkbox = box;
		}
		if ('children' in node)
			for (const child of node.children) element.appendChild(render(child));
		else if (node.type === 'footnoteReference') element.textContent = node.identifier;
		if (node.type === 'heading' && element instanceof HTMLElement) {
			const base = headingAnchor(element.textContent);
			const seen = anchors.get(base) ?? 0;
			anchors.set(base, seen + 1);
			element.dataset.anchor = seen === 0 ? base : `${base}-${seen}`;
		}
		// Named by its own text, not by the action: every box used to be "Mark task complete", so a
		// screen reader could not tell one task from the next, and the checked state already says
		// whether it is done.
		if (checkbox) {
			const label = [...element.childNodes].find(
				(child): child is HTMLParagraphElement => child instanceof HTMLParagraphElement,
			);
			if (label) {
				taskLabels += 1;
				label.id = `notepad-task-${taskLabels}`;
				checkbox.setAttribute('aria-labelledby', label.id);
			} else checkbox.setAttribute('aria-label', 'Empty task');
		}
		return element;
	}
	const fragment = document.createDocumentFragment();
	for (const node of tree.children) fragment.append(render(node));
	return fragment;
}
