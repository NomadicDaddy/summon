import type { ScheduleView } from '../../src/schedule-view.ts';

import { EditorElement } from './editor-dom.ts';

/** Only the tree and focus edges consumed by setupScheduleView; no browser layout simulation. */
export function scheduleFocusDom(initial: ScheduleView) {
	let active: ScheduleElement;
	const setActive = (node: ScheduleElement): void => {
		active = node;
	};
	class ScheduleElement extends EditorElement {
		parent: ScheduleElement | null = null;
		readonly dataset: Record<string, string> = {};
		scrollTop = 0;
		hidden = false;
		readonly classes = new Set<string>();
		readonly classList = {
			remove: (name: string) => this.classes.delete(name),
			toggle: (name: string, enabled: boolean) => {
				if (enabled) this.classes.add(name);
				else this.classes.delete(name);
			},
		};
		get childElementCount(): number {
			return this.children.length;
		}
		getAttribute(name: string): string | null {
			return this.attributes.get(name) ?? null;
		}
		override append(...nodes: (EditorElement | string)[]): void {
			for (const node of nodes) if (node instanceof ScheduleElement) node.parent = this;
			super.append(...nodes);
		}
		prepend(node: ScheduleElement): void {
			node.parent = this;
			this.children.unshift(node);
		}
		override replaceChildren(...nodes: (EditorElement | string)[]): void {
			if (this.contains(active)) active = root;
			for (const child of this.children)
				if (child instanceof ScheduleElement) child.parent = null;
			super.replaceChildren(...nodes);
		}
		contains(node: EditorElement): boolean {
			return (
				node === this ||
				this.children.some((child) =>
					child instanceof ScheduleElement ? child.contains(node) : child === node,
				)
			);
		}
		closest(tag: string): ScheduleElement | null {
			return this.tagName === tag ? this : (this.parent?.closest(tag) ?? null);
		}
		override querySelector(selector: string): ScheduleElement | null {
			return this.querySelectorAll(selector)[0] ?? null;
		}
		override querySelectorAll(selector: string): ScheduleElement[] {
			return super
				.querySelectorAll(selector)
				.filter((node): node is ScheduleElement => node instanceof ScheduleElement);
		}
		override focus(): void {
			if (!this.disabled) setActive(this);
		}
		click(): void {
			if (!this.disabled) this.dispatchEvent(new Event('click'));
		}
	}
	const root = new ScheduleElement('body');
	active = root;
	for (const id of [
		'schedules',
		'schedules-toggle',
		'board-toggle',
		'diary-toggle',
		'repos-toggle',
		'outside',
	]) {
		const node = new ScheduleElement(id === 'schedules' ? 'section' : 'button');
		node.id = id;
		root.append(node);
	}
	let current = initial;
	let reader = (): Promise<ScheduleView> => Promise.resolve(current);
	let interval = () => {};
	let reads = 0;
	const faults: unknown[] = [];
	const globals = {
		document: {
			body: root,
			get activeElement() {
				return active;
			},
			getElementById: (id: string) => root.querySelector(`#${id}`),
			createElement: (tag: string) => new ScheduleElement(tag),
		},
		HTMLElement: ScheduleElement,
		window: {
			team: {
				scheduleView: () => {
					reads++;
					return reader();
				},
				faultReport: (fault: unknown) => {
					faults.push(fault);
					return Promise.resolve();
				},
			},
			setInterval: (callback: () => void) => {
				interval = callback;
				return 1;
			},
		},
	};
	const previous = Object.keys(globals).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, { configurable: true, value });
	const byId = (id: string): ScheduleElement => {
		const node = root.querySelector(`#${id}`);
		if (!node) throw new Error(`Missing fixture node ${id}`);
		return node;
	};
	return {
		byId,
		get active() {
			return active;
		},
		get reads() {
			return reads;
		},
		faults,
		refresh: () => interval(),
		setView: (view: ScheduleView) => {
			current = view;
		},
		setReader: (value: () => Promise<ScheduleView>) => {
			reader = value;
		},
		summary: (title: string): ScheduleElement => {
			const summary = root
				.querySelectorAll('summary')
				.find((node) =>
					node.querySelectorAll('span').some((span) => span.textContent === title),
				);
			if (!summary) throw new Error(`Missing fixture summary ${title}`);
			return summary;
		},
		restore: () => {
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		},
	};
}
