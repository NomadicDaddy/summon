import { describe, expect, test } from 'bun:test';

/*
 * Two CSS findings from the re-audit. Enabled controls and labels reached AA only because opacity
 * was stacked on colours that pass, and room.css held two rule groups owned by other modules.
 */
const read = (name: string): Promise<string> => Bun.file(`src/desktop/${name}`).text();

/** The declarations of the first rule whose selector list starts with this text. */
function rule(css: string, selector: string): string {
	const at = css.indexOf(`${selector} {`);
	if (at < 0) throw new Error(`no rule for ${selector}`);
	return css.slice(at, css.indexOf('}', at));
}

/** A colour token's dark value, from the first (:root) block of theme.css. */
async function darkValue(token: string): Promise<string | undefined> {
	const theme = await read('theme.css');
	const root = theme.slice(theme.indexOf(':root {'), theme.indexOf('}'));
	return new RegExp(`${token}: ([^;]+);`).exec(root)?.[1];
}

describe('quiet text stays readable', () => {
	test('room message actions are quiet by colour, never by opacity', async () => {
		const room = await read('room.css');
		const rest = rule(room, '.room-message-reply,\n.room-message-action');
		expect(rest).not.toContain('opacity');
		expect(rest).toContain('color: var(--muted-2);');
		expect(await darkValue('--muted-2')).toBe('#98acae');
		expect(rule(room, '.room-message-action:focus-visible')).toContain(
			'color: var(--text-bright);',
		);
		expect(await darkValue('--text-bright')).toBe('#e0ebe8');
	});

	test('an empty lane and a comment count are not faded below AA', async () => {
		const board = await read('board.css');
		expect(rule(board, '.board-lane.is-empty')).not.toContain('opacity');
		expect(rule(board, '.board-lane.is-empty > h3')).toContain('color: var(--muted);');
		expect(await darkValue('--muted')).toBe('#97a8ad');
		expect(rule(board, '.board-card-count')).not.toContain('opacity');
	});

	test('a lit sweep letter is the Busy word amber, which the light theme darkens for text', async () => {
		const [sweep, style, theme] = await Promise.all([
			read('letter-sweep.css'),
			read('style.css'),
			read('theme.css'),
		]);
		const keyframes = sweep.slice(sweep.indexOf('@keyframes letter-sweep'));
		expect(keyframes).not.toContain('var(--warn-fill)');
		expect(keyframes.match(/color: var\(--warn-fill-text\);/gu)).toHaveLength(2);
		// The same rows and header carry the Busy word, which the light theme already reads at AA.
		const busy = rule(
			style,
			".member small[data-tone='busy'],\n#name-state small[data-tone='busy']",
		);
		expect(busy).toContain('color: var(--warn-fill-text);');
		const light = theme.slice(theme.indexOf(":root[data-theme='light'] {"));
		expect(/--warn-fill: ([^;]+);/u.exec(light)?.[1]).toBe('#e3b341');
		expect(/--warn-fill-text: ([^;]+);/u.exec(light)?.[1]).toBe('#855a12');
	});
});

describe('an unverified lock is never drawn online (verified-member-presence clause 4)', () => {
	test('its dot is a hollow ring in the neutral border colour, never the accent or amber', async () => {
		const style = await read('style.css');
		const unknown = rule(style, '.unknown .dot');
		expect(unknown).toContain('background: transparent;');
		expect(unknown).toContain('box-shadow: inset 0 0 0 2px var(--line-stronger);');
		expect(unknown).not.toMatch(/--accent|--warn|--danger/u);
		// The control: the verified-elsewhere ring this one mirrors is the accent.
		expect(rule(style, '.elsewhere .dot')).toContain('var(--accent)');
	});
});

describe('a settled thumbs-up is a mark, not a control (#18201)', () => {
	test('it has no fill or border, and the hover fill cannot bring them back', async () => {
		const room = await read('room.css');
		const selector = ".room-message[data-reacted='true'] .room-message-thumb";
		const settled = rule(room, selector);
		expect(settled).toContain('border-color: transparent;');
		expect(settled).toContain('background: transparent;');
		expect(settled).toContain('cursor: default;');
		// Green comes from the glyph alone (#19414): never a green fill or border again (#4536).
		expect(settled).toContain('color: transparent;');
		expect(settled).toContain('text-shadow: 0 0 0 var(--accent);');
		expect(settled).not.toMatch(/(?:background|border-color): var\(--accent/u);
		// Same specificity as the shared hover rule, so it must come after it to win.
		const hover = room.indexOf('.room-message:hover .room-message-action,');
		expect(hover).toBeGreaterThan(-1);
		expect(room.indexOf(`${selector} {`)).toBeGreaterThan(hover);
	});
});

describe('room styles sit beside the modules that draw them', () => {
	test('question and reference rules live in their own files, linked straight after room.css', async () => {
		const [room, questions, references, html] = await Promise.all([
			read('room.css'),
			read('room-questions.css'),
			read('room-references.css'),
			read('index.html'),
		]);
		expect(room).not.toMatch(/^\.room-(?:message\.)?room-question/mu);
		expect(room).not.toMatch(/^\.room-reference-(?:target|dialog|back)/mu);
		expect(questions).toContain('.room-message.room-question {');
		expect(references).toContain('.room-reference-target {');
		expect(references).toContain('.room-reaction-anchor {');
		const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/gu)].map(
			(m) => m[1],
		);
		const at = links.indexOf('room.css');
		expect(links.slice(at, at + 3)).toEqual([
			'room.css',
			'room-questions.css',
			'room-references.css',
		]);
	});
});
