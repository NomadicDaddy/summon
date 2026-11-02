import { describe, expect, test } from 'bun:test';

import { profileFields } from '../src/desktop/maintenance-controls.ts';
import { kiloProfile } from '../src/desktop/provider-fields.ts';

/*
 * The Team Maintenance side of kilo-seat-default-variant (Phillip #19661, Carl's contract mail
 * 7c233e59): a "Reasoning variant" beside the Kilo model for each launch/resume startup turn.
 * Empty leaves the stored variant or Kilo's pick; later turns follow Kilo's current pick.
 * The server stores a name only for Kilo with a model, clears on '', and refuses "default". summon
 * has no DOM in bun:test, so the markup is checked as text and the form's save mapping with
 * stand-in fields; the rendered form is checked in a window probe.
 */
const html = await Bun.file('src/desktop/index.html').text();

function openingTag(id: string): string {
	const match = new RegExp(String.raw`<[a-z]+\b[^>]*\bid="${id}"[^>]*>`, 'u').exec(html);
	if (!match) throw new Error(`no element with id ${id}`);
	return match[0];
}

/** The label wrapping an input: from the nearest <label before it to its closing </label>. */
function labelAround(id: string): string {
	const at = html.indexOf(`id="${id}"`);
	const start = html.lastIndexOf('<label', at);
	return html.slice(start, html.indexOf('</label>', at) + '</label>'.length);
}

const fields =
	(values: Record<'lmStudioUrl' | 'model' | 'variant', string>) => (key: keyof typeof values) =>
		({ value: values[key] }) as HTMLInputElement;

describe('the Reasoning variant field', () => {
	test('it sits in a Kilo-only row right after the Kilo model', () => {
		const label = labelAround('maint-variant');
		expect(label.startsWith('<label data-kilo-field')).toBe(true);
		expect(label).toContain('Reasoning variant');
		expect(html.indexOf('id="maint-model"')).toBeLessThan(html.indexOf('id="maint-variant"'));
		expect(html.indexOf('id="maint-variant"')).toBeLessThan(
			html.indexOf('id="maint-lmStudioUrl"'),
		);
	});

	test("its pattern accepts what the server stores and rejects what it can't", () => {
		const pattern = /pattern="([^"]+)"/u.exec(openingTag('maint-variant'))?.[1];
		if (!pattern) throw new Error('no pattern');
		// Browsers compile pattern with the v flag, anchored whole.
		const accepts = new RegExp(`^(?:${pattern})$`, 'v');
		for (const name of ['high', 'low', 'medium', 'max', 'thinking-2', 'v1.5', 'a_b'])
			expect(accepts.test(name)).toBe(true);
		for (const name of ['', 'two words', 'x'.repeat(65), 'high!', 'é'])
			expect(accepts.test(name)).toBe(false);
	});

	test('it suggests the common names without limiting them', () => {
		expect(openingTag('maint-variant')).toContain('list="maint-variant-names"');
		for (const name of ['low', 'medium', 'high'])
			expect(html).toContain(`<option value="${name}"></option>`);
	});

	test('it loads with the profile and counts toward unsaved changes', () => {
		expect(profileFields).toContain('variant');
	});

	test('save sends the trimmed name, and an empty field as an explicit clear', () => {
		expect(
			kiloProfile(fields({ lmStudioUrl: '', model: ' kilo/glm-5.3 ', variant: ' high ' })),
		).toEqual({
			lmStudioUrl: '',
			model: 'kilo/glm-5.3',
			variant: 'high',
		});
		// A non-Kilo seat's fields are emptied by the provider switch, so variant goes as '', which
		// the server treats as clear rather than keep.
		expect(kiloProfile(fields({ lmStudioUrl: '', model: '', variant: '' })).variant).toBe('');
	});
});

describe('the provider switch', () => {
	test('disables and clears the variant with the other Kilo fields', async () => {
		const source = await Bun.file('src/desktop/provider-fields.ts').text();
		expect(source).toContain("['maint-model', 'maint-variant', 'maint-lmStudioUrl']");
	});
});
