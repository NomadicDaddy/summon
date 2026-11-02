/**
 * The Kilo-only part of a saved profile. A field the form disabled for another provider is already
 * empty, so a non-Kilo seat sends variant '' and the server clears any stored value (Carl's
 * contract for kilo-seat-default-variant: '' clears, a name needs Kilo and a model).
 */
export function kiloProfile(
	field: (key: 'lmStudioUrl' | 'model' | 'variant') => HTMLInputElement,
): {
	lmStudioUrl: string;
	model: string;
	variant: string;
} {
	return {
		lmStudioUrl: field('lmStudioUrl').value.trim(),
		model: field('model').value.trim(),
		variant: field('variant').value.trim(),
	};
}

/**
 * A save that may check a Kilo reasoning variant, which asks Kilo for its model list and can take
 * up to 45 seconds (kilo-variant-check.ts). Save reads Saving… and is disabled while it runs, the
 * status line says why when a variant is set, and the button is restored whatever the outcome.
 */
export async function savingProfile<T>(
	get: (id: string) => HTMLElement,
	variant: string,
	save: () => Promise<T>,
): Promise<T> {
	const button = get('maint-save') as HTMLButtonElement;
	const before = { disabled: button.disabled, label: button.textContent };
	button.disabled = true;
	button.textContent = 'Saving…';
	if (variant)
		get('maint-error').textContent =
			'Saving. A new or changed reasoning variant is checked with Kilo, which can take up to 45 seconds.';
	try {
		return await save();
	} finally {
		button.disabled = before.disabled;
		button.textContent = before.label;
	}
}

/** The saved message, with the variant check's note when Kilo could not confirm the variant. */
export function savedText(note?: string): string {
	return `Saved.${note ? ` ${note}` : ''} The teammate has not been launched.`;
}

/** Account selection clears the previous account's conversation ID before saving. */
export function setupProviderFields(
	get: (id: string) => HTMLElement,
	run: (work: () => Promise<void>) => void,
): {
	update: () => void;
} {
	const directory = get('maint-claudeConfigDir') as HTMLInputElement;
	const provider = get('maint-provider') as HTMLSelectElement;
	const session = get('maint-sessionId') as HTMLInputElement;
	const row = get('maint-claude-account');
	const update = (): void => {
		const claude = provider.value === 'claude';
		row.hidden = !claude;
		directory.disabled = !claude;
		if (!claude) directory.value = '';
		const kilo = provider.value === 'kilo';
		for (const id of ['maint-model', 'maint-variant', 'maint-lmStudioUrl']) {
			const field = get(id) as HTMLInputElement;
			field.disabled = !kilo;
			if (!kilo) field.value = '';
		}
		for (const node of get('maint-form').querySelectorAll<HTMLElement>('[data-kilo-field]'))
			node.hidden = !kilo;
	};
	directory.addEventListener('input', () => {
		session.value = '';
	});
	get('maint-claude-browse').addEventListener('click', () => {
		run(async () => {
			const path = await window.team.chooseFolder();
			if (path === null) return;
			directory.value = path;
			session.value = '';
		});
	});
	provider.addEventListener('change', update);
	return { update };
}
