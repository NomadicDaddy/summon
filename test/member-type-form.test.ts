import { expect, test } from 'bun:test';

/*
 * One name while creating (#5592). The registration name and the display name can only differ after
 * creation, so the form used to show the same word twice under two labels. The window probe checks
 * the rendered form; this pins the rule that produces it.
 */
test('a new member is named once; the display name is a field only when editing a PM', async () => {
	const source = await Bun.file('src/desktop/member-type.ts').text();
	expect(source).toContain('displayRow.hidden = !pm || creating;');
	expect(source).toContain('creating = profile === null;');
	// At creation the display name comes from the one Name field, not from a second input.
	expect(source).toContain('(creating ? name.value : display.value).trim() || PM_DEFAULT_NAME');
	// Nothing defaults a field the operator cannot see while creating.
	expect(source).not.toContain(
		"if (display.value.trim() === '') display.value = PM_DEFAULT_NAME;",
	);
});
