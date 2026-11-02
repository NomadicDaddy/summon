// Quoted examples and fenced code are not assignments to their mentioned names.
export function addressableText(text: string): string {
	return text
		.replace(/```[\s\S]*?(?:```|$)/g, '')
		.split('\n')
		.filter((line) => !/^\s*>/.test(line))
		.join('\n')
		.replace(/`[^`]*`|"[^"\n]*"/g, '');
}
