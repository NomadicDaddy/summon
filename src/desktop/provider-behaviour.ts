import type { ProviderSetupCatalog } from '../provider-setup.ts';

import { providerCatalog } from './provider-setup-view.ts';

/**
 * What the selected CLI actually does, said where the operator chooses one (#4823).
 *
 * This file used to hold the facts as well as draw them. It holds none now: they live in the one
 * catalog behind window.team.providerSetup(), which CLI setup also reads, so the sentence under the
 * select and the row in the comparison cannot drift apart. Two copies of "Grok has no live
 * delivery" would have been two things to correct the day that stops being true.
 *
 * What stays here is the choice of which facts a person needs at the moment of picking, and the
 * three rules that choice was learned under - they bind whoever edits the catalog, too:
 *
 * It describes THIS INTEGRATION, not the CLI and not the model behind it.
 *
 * `suitedTo` follows from the delivery behaviour and nothing else. An earlier hint - batched pickup
 * suits long runs - was an inference that turned out backwards: during a long unattended run,
 * checkpoint pickup DELAYS new instructions reaching the seat.
 *
 * `expected` exists because a correctly-working seat can look broken. Four seats sat in queued-only
 * all morning and were nearly reported as dead. Saying so at the moment of choice is cheaper than
 * the operator discovering it later with no explanation in front of them.
 */
export function setupProviderBehaviour(select: HTMLSelectElement, into: HTMLElement): void {
	let catalog: ProviderSetupCatalog | undefined;
	const draw = (): void => {
		const behaviour = catalog?.providers.find(
			(setup) => setup.provider === select.value,
		)?.behaviour;
		if (!catalog || !behaviour) {
			into.replaceChildren();
			return;
		}
		const lines: HTMLElement[] = [];
		const line = (text: string, className?: string): void => {
			const node = document.createElement('span');
			node.textContent = text;
			if (className) node.className = className;
			lines.push(node);
		};
		line(`${behaviour.delivery} ${behaviour.startup}`);
		if (behaviour.expected) line(behaviour.expected, 'provider-expected');
		line(behaviour.suitedTo);
		line(catalog.common, 'provider-common');
		into.replaceChildren(...lines);
	};
	select.addEventListener('change', draw);
	providerCatalog()
		.then((value) => {
			catalog = value;
			draw();
		})
		.catch(() => {
			into.textContent =
				'How this CLI behaves could not be loaded. CLI setup, above, has the comparison.';
		});
}
