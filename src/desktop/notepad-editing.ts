/*
 * Line editing for the Notepad textarea, kept apart from the DOM so the rules can be tested as
 * rules. Phillip asked for three editor habits (#7025, #7026, #7028): Ctrl+X on an empty line
 * deletes the line, Alt+Z toggles wrapping, Alt+Up/Down moves the current line. Each function
 * takes the textarea's value and selection and returns the next value and selection, or
 * undefined when the key should keep its default behaviour.
 */
export interface Selection {
	start: number;
	end: number;
}
export interface Edit extends Selection {
	value: string;
}

/** The [start, end) span of the line holding `offset`, excluding its line break. */
function lineAt(value: string, offset: number): Selection {
	// lastIndexOf treats a negative start as 0, which would find a break AT offset 0.
	const start = offset === 0 ? 0 : value.lastIndexOf('\n', offset - 1) + 1;
	const next = value.indexOf('\n', offset);
	return { start, end: next === -1 ? value.length : next };
}

/**
 * Ctrl+X with nothing selected on an empty line removes the line. A non-empty line keeps the
 * default (cut the selection, or nothing), because deleting text the user can see on a key that
 * normally cuts is a surprise. The cursor lands at the start of the line that moves up.
 */
export function deleteEmptyLine(value: string, selection: Selection): Edit | undefined {
	if (selection.start !== selection.end) return undefined;
	const line = lineAt(value, selection.start);
	if (line.start !== line.end) return undefined;
	// Remove the line's own break; on the last line remove the break before it instead.
	const from = line.end < value.length ? line.start : Math.max(0, line.start - 1);
	const to = line.end < value.length ? line.end + 1 : line.end;
	if (from === to) return undefined;
	return { value: value.slice(0, from) + value.slice(to), start: from, end: from };
}

/**
 * Alt+Up/Down moves every line the selection touches by one line, keeping the selection on the
 * moved text. At the top or bottom there is nowhere to go, so the key does nothing rather than
 * wrapping around or reordering the neighbour.
 */
export function moveLines(
	value: string,
	selection: Selection,
	direction: 'up' | 'down',
): Edit | undefined {
	const first = lineAt(value, selection.start);
	// A selection ending at the very start of a line does not include that line.
	const lastOffset =
		selection.end > selection.start && value[selection.end - 1] === '\n'
			? selection.end - 1
			: selection.end;
	const last = lineAt(value, lastOffset);
	const block = value.slice(first.start, last.end);
	if (direction === 'up') {
		if (first.start === 0) return undefined;
		const above = lineAt(value, first.start - 1);
		const moved = `${block}\n${value.slice(above.start, above.end)}`;
		const shift = -(above.end - above.start + 1);
		return {
			value: value.slice(0, above.start) + moved + value.slice(last.end),
			start: selection.start + shift,
			end: selection.end + shift,
		};
	}
	if (last.end >= value.length) return undefined;
	const below = lineAt(value, last.end + 1);
	const moved = `${value.slice(below.start, below.end)}\n${block}`;
	const shift = below.end - below.start + 1;
	return {
		value: value.slice(0, first.start) + moved + value.slice(below.end),
		start: selection.start + shift,
		end: selection.end + shift,
	};
}
