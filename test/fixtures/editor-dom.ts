/** Minimal DOM edges for editor logic tests; no layout, accessibility tree or browser is simulated. */
export class EditorElement extends EventTarget {
	readonly children: EditorElement[] = [];
	readonly attributes = new Map<string, string>();
	id = '';
	className = '';
	readonly style = { color: '' };
	value = '';
	checked = false;
	disabled = false;
	open = false;
	textContent = '';
	maxLength = 0;
	rows = 0;
	placeholder = '';
	type = '';
	innerHTML = '';
	focused = false;
	readonly tagName: string;
	constructor(tagName: string) {
		super();
		this.tagName = tagName;
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	append(...nodes: (EditorElement | string)[]): void {
		for (const node of nodes) {
			if (typeof node === 'string') {
				const text = new EditorElement('#text');
				text.textContent = node;
				this.children.push(text);
			} else this.children.push(node);
		}
	}
	appendChild(node: EditorElement): EditorElement {
		this.children.push(node);
		return node;
	}
	replaceChildren(...nodes: (EditorElement | string)[]): void {
		this.children.length = 0;
		this.append(...nodes);
	}
	querySelector(selector: string): EditorElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}
	querySelectorAll(selector: string): EditorElement[] {
		return this.children.flatMap((child) => [
			...(selector === child.tagName || selector === `#${child.id}` ? [child] : []),
			...child.querySelectorAll(selector),
		]);
	}
	showModal(): void {
		this.open = true;
	}
	close(): void {
		this.open = false;
		this.dispatchEvent(new Event('close'));
	}
	focus(): void {
		this.focused = true;
	}
	getBoundingClientRect(): { left: number; right: number; top: number; bottom: number } {
		return { left: 10, right: 100, top: 10, bottom: 100 };
	}
}

export function editorDom(windowValue: unknown = {}) {
	const body = new EditorElement('body');
	const toggle = new EditorElement('button');
	toggle.id = 'macros-toggle';
	body.append(toggle);
	const documentValue = {
		body,
		getElementById: (id: string) => body.querySelector(`#${id}`),
		createElement: (tag: string) => {
			const element = new EditorElement(tag);
			if (tag === 'dialog') {
				const form = new EditorElement('form');
				for (const id of ['macro-slots', 'macros-error', 'macros-close']) {
					const control = new EditorElement(id === 'macros-close' ? 'button' : 'div');
					control.id = id;
					form.append(control);
				}
				element.append(form);
			}
			return element;
		},
		createDocumentFragment: () => new EditorElement('#fragment'),
		createTextNode: (value: string) => {
			const node = new EditorElement('#text');
			node.textContent = value;
			return node;
		},
	};
	const globals = {
		document: documentValue,
		window: windowValue,
		HTMLElement: EditorElement,
		HTMLAnchorElement: class extends EditorElement {},
		HTMLOListElement: class extends EditorElement {},
		HTMLParagraphElement: class extends EditorElement {},
	};
	const previous = Object.keys(globals).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, { configurable: true, value });
	return {
		body,
		toggle,
		restore: () => {
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		},
	};
}
