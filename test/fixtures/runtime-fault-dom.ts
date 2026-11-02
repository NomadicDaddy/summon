import type { RuntimeFaultInput } from '../../src/runtime-fault-model.ts';

/** Only the DOM and bridge edges are faked; tests invoke the shipped reporter and banner. */
export async function runtimeFaultDom(
	work: (view: {
		element: (id: string) => HTMLElement;
		dismiss: () => void;
		reports: RuntimeFaultInput[];
		events: string[];
	}) => Promise<void>,
): Promise<void> {
	const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	const nodes = new Map<string, HTMLElement>();
	const handlers = new Map<string, () => void>();
	const element = (id: string): HTMLElement => {
		let node = nodes.get(id);
		if (!node) {
			node = {
				hidden: true,
				textContent: '',
				addEventListener: (_type: string, listener: () => void) =>
					handlers.set(id, listener),
			} as unknown as HTMLElement;
			nodes.set(id, node);
		}
		return node;
	};
	const reports: RuntimeFaultInput[] = [];
	const events: string[] = [];
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: { getElementById: element },
	});
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			dispatchEvent: (event: Event) => {
				events.push(event.type);
				return true;
			},
			team: {
				faultReport: (input: RuntimeFaultInput) => {
					reports.push(input);
					return Promise.resolve();
				},
			},
		},
	});
	try {
		await work({ element, reports, events, dismiss: () => handlers.get('error-dismiss')?.() });
	} finally {
		for (const [key, descriptor] of [
			['window', priorWindow],
			['document', priorDocument],
		] as const) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
}
