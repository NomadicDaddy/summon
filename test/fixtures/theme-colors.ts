/** Read actual theme declarations; fail loudly on missing/non-hex contrast inputs. */
export function themeBlock(theme: string, selector: string): Map<string, string> {
	const start = theme.indexOf(`${selector} {`);
	if (start < 0) throw new Error(`Missing theme ${selector}`);
	const body = theme.slice(start, theme.indexOf('}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
	const values = new Map<string, string>();
	for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
		if (match[1] && match[2]) values.set(match[1], match[2].trim());
	}
	return values;
}

function luminance(hex: string): number {
	if (!/^#[\da-f]{6}$/iu.test(hex)) throw new Error(`Expected a six-digit color: ${hex}`);
	const linear = [1, 3, 5].map((at) => {
		const value = parseInt(hex.slice(at, at + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

export function contrast(a: string, b: string): number {
	const x = luminance(a);
	const y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
