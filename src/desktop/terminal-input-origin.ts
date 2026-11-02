interface TerminalInputEvents {
	onKey: (listener: (event: { key: string }) => void) => unknown;
	onData: (listener: (data: string) => void) => unknown;
}

function mouseReport(data: string): boolean {
	if (data.length === 4 && data[0] === 'M')
		return data.charCodeAt(1) >= 32 && data.charCodeAt(2) >= 33 && data.charCodeAt(3) >= 33;
	const sgr = /^<([0-9]+);([1-9][0-9]*);([1-9][0-9]*)[Mm]$/.exec(data);
	if (sgr) return Number(sgr[1]) <= 255;
	const urxvt = /^([0-9]+);([1-9][0-9]*);([1-9][0-9]*)M$/.exec(data);
	return urxvt !== null && Number(urxvt[1]) >= 32 && Number(urxvt[1]) <= 287;
}

/** Protocol replies and mouse reports cannot create printable text or a navigation draft. */
function terminalReply(data: string): boolean {
	if (data.startsWith('\u001b[')) {
		const replies = data.split('\u001b[').slice(1);
		return replies.every(
			(reply) =>
				/^(?:[?>]?[0-9]+(?:;[0-9]+)*c|0n|\??[0-9]+;[0-9]+R|\??[0-9]+;[0-4]\$y|[IO])$/.test(
					reply,
				) || mouseReport(reply),
		);
	}
	if (data.startsWith('\u001bP'))
		return (
			data.endsWith('\u001b\\') &&
			/^(?:0\$r|1\$r(?:0m|[1-6] q|[01]"q|61;1"p|[0-9]+;[0-9]+r))$/.test(data.slice(2, -2))
		);
	if (!data.startsWith('\u001b]')) return false;
	const ending = data.endsWith('\u0007') ? 1 : data.endsWith('\u001b\\') ? 2 : 0;
	if (!ending) return false;
	const color = /^(10|11|12|4;([0-9]+));rgb:[0-9a-f]{1,4}\/[0-9a-f]{1,4}\/[0-9a-f]{1,4}$/i.exec(
		data.slice(2, -ending),
	);
	return color !== null && (color[2] === undefined || Number(color[2]) <= 255);
}

/** onData includes terminal query replies; onKey fires first for actual keyboard input. */
export function bindTerminalInput(
	terminal: TerminalInputEvents,
	send: (data: string, humanInput: boolean) => void,
): void {
	let key: string | undefined;
	terminal.onKey((event) => {
		key = event.key;
	});
	terminal.onData((data) => {
		const humanInput = key === data || !terminalReply(data);
		key = undefined;
		send(data, humanInput);
	});
}
