import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';

/*
 * The Team settings switch "Show delivery alerts awaiting read confirmation in the sidebar" (#12987)
 * only hides the sidebar section. Episodes are still recorded and still relayed to the PM with it
 * off, so nothing outside the switch itself and the stylesheet that hides the section may read it:
 * not its setting key, its body mark, or the checkbox's own id and source tag.
 */
const SWITCH =
	/showDeliveryAlerts|deliveryAlerts|delivery-alerts|maint-show-delivery|maintenance\.delivery/;

async function readers(): Promise<string[]> {
	const paths = (await readdir('src', { recursive: true }))
		.map((name) => `src/${name.replaceAll('\\', '/')}`)
		.filter((path) => /\.(ts|css|html)$/.test(path));
	const texts = await Promise.all(paths.map((path) => Bun.file(path).text()));
	return paths.filter((_, at) => SWITCH.test(texts[at] ?? '')).sort();
}

describe('delivery alert switch', () => {
	test('only the switch, its checkbox and the sidebar stylesheet read it', async () => {
		expect(await readers()).toEqual([
			'src/desktop/index.html',
			'src/desktop/maintenance-controls.ts',
			'src/desktop/response-watchdog.css',
		]);
	});

	test('switching off marks the body and the stylesheet hides only the section', async () => {
		const controls = await Bun.file('src/desktop/maintenance-controls.ts').text();
		expect(controls).toContain("key: 'summon.showDeliveryAlerts',");
		expect(controls).toContain("document.body.dataset['deliveryAlerts'] = 'off';");
		const css = await Bun.file('src/desktop/response-watchdog.css').text();
		const off = css.slice(css.indexOf("body[data-delivery-alerts='off']"));
		expect(off.slice(0, off.indexOf('}') + 1)).toBe(
			"body[data-delivery-alerts='off'] .response-watchdog {\n\tdisplay: none;\n}",
		);
	});
});
