export function element(id: string): HTMLElement {
	const value = document.getElementById(id);
	if (!value) throw new Error(`Missing element ${id}`);
	return value;
}
