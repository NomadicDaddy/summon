/** Full presentation of the delivered payload. No filtering, truncation or receipt advancement. */
export function checkpointText(value: Record<string, unknown>, compact = false): string {
	const packet = value.package;
	const phase =
		packet && typeof packet === 'object'
			? (packet as Record<string, unknown>).phase
			: undefined;
	const heading =
		value.work &&
		typeof value.work === 'object' &&
		'packageComplete' in value.work &&
		value.work.packageComplete === true
			? 'CHECKPOINT WORK BOUNDARY — later arrivals not checked'
			: phase === 'page'
				? 'CHECKPOINT PAGE'
				: phase === 'final'
					? 'CHECKPOINT FINAL RECEIPT'
					: value.hibernated === true
						? 'CHECKPOINT HIBERNATED'
						: value.changed === false && value.more === false
							? 'CHECKPOINT QUIET'
							: 'CHECKPOINT VIEW';
	const lines = [compact ? `${heading} (text v2; read-only presentation)` : heading];
	const metadataJson = (item: unknown): string =>
		JSON.stringify(item).replace(
			/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
			(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
		);
	const framed = new Set([
		'text',
		'instruction',
		'catchUp',
		'catchUpAdvice',
		'error',
		'reason',
		'proposal',
		'warning',
		'transportWarning',
		'telegramRefreshError',
	]);
	const prominent = new Set(['receipt', 'changed', 'more', 'paused', 'phase', 'page', 'pages']);
	const childPath = (path: string, key: string): string =>
		compact && !/^[A-Za-z_$][\w$]*$/.test(key)
			? `${path}[${metadataJson(key)}]`
			: path
				? `${path}.${key}`
				: key;
	const render = (item: unknown, path: string): void => {
		if (typeof item === 'string') {
			// Length and path distinguish a body containing apparent headings from real metadata.
			const visible = Array.from(item)
				.map((character) => {
					const code = character.charCodeAt(0);
					return (code < 32 && character !== '\n' && character !== '\t') ||
						(code >= 127 && code <= 159)
						? `\\u${code.toString(16).padStart(4, '0')}`
						: character;
				})
				.join('');
			lines.push(
				`${path} (${Buffer.byteLength(item)} UTF-8 bytes; terminal controls escaped):`,
				visible,
				`END ${path}`,
			);
		} else if (Array.isArray(item)) {
			lines.push(`${path}: ${item.length} item(s)`);
			item.forEach((child, index) => render(child, `${path}[${index}]`));
		} else if (item !== null && typeof item === 'object') {
			const entries = Object.entries(item);
			const metadata = compact
				? entries.filter(
						([key, child]) =>
							!framed.has(key) &&
							!prominent.has(key) &&
							(child === null ||
								typeof child === 'boolean' ||
								typeof child === 'number' ||
								(typeof child === 'string' &&
									child.length <= 160 &&
									!/[\n\r]/.test(child))),
					)
				: [];
			if (metadata.length)
				lines.push(`${path || 'metadata'}: ${metadataJson(Object.fromEntries(metadata))}`);
			const grouped = new Set(metadata.map(([key]) => key));
			if (!entries.length) lines.push(`${path}: {}`);
			for (const [key, child] of entries) {
				if (!grouped.has(key)) render(child, childPath(path, key));
			}
		} else lines.push(`${path}: ${JSON.stringify(item)}`);
	};
	for (const [key, item] of Object.entries(value)) render(item, childPath('', key));
	lines.push(
		'END CHECKPOINT VIEW — read every body and fragment before explicitly passing its receipt.',
	);
	return lines.join('\n');
}
