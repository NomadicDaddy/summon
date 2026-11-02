import { describe, expect, test } from 'bun:test';

/*
 * Attribute contracts for the Team Window's static markup and the two named regions built in code.
 * Each one is cheap to lose in an edit and invisible until a screen reader or a spellchecker trips
 * over it, which is how the re-audit found all of them.
 */
const html = await Bun.file('src/desktop/index.html').text();

/** The opening tag of the element with this id, wherever its attributes wrap. */
function openingTag(id: string): string {
	const match = new RegExp(String.raw`<[a-z]+\b[^>]*\bid="${id}"[^>]*>`, 'u').exec(html);
	if (!match) throw new Error(`no element with id ${id}`);
	return match[0];
}

describe('Team Window markup', () => {
	test('a generic element never carries a name without a role', () => {
		// aria-label is prohibited on a role-less div, span or pre and is simply ignored there.
		const unnamed = [...html.matchAll(/<(?:div|span|pre)\b[^>]*>/gu)]
			.map((match) => match[0])
			.filter((tag) => tag.includes('aria-label=') && !tag.includes('role='));
		expect(unnamed).toEqual([]);
		expect(openingTag('roster-coverage')).toContain('role="group"');
		expect(openingTag('roster-progress')).toContain('role="group"');
	});

	test('the provider usage result is announced when it arrives', () => {
		expect(openingTag('maint-usage')).toContain('role="status"');
	});

	test('identifier fields are not spellchecked; prose fields still are', () => {
		for (const id of [
			'maint-cwd',
			'maint-model',
			'maint-variant',
			'maint-lmStudioUrl',
			'maint-sessionId',
			'maint-confirm',
		])
			expect(openingTag(id)).toContain('spellcheck="false"');
		expect(openingTag('maint-lmStudioUrl')).toContain('type="url"');
		for (const id of ['maint-expertise', 'maint-domain', 'maint-notes', 'room-text'])
			expect(openingTag(id)).not.toContain('spellcheck=');
	});

	test('the named regions built in code carry a role', async () => {
		const [notepad, repos] = await Promise.all([
			Bun.file('src/desktop/notepad.ts').text(),
			Bun.file('src/desktop/repos-detail.ts').text(),
		]);
		expect(notepad).toContain("preview.setAttribute('role', 'region');");
		expect(repos).toContain("preview.setAttribute('role', 'region');");
	});
});
