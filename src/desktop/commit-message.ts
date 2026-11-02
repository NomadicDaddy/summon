/**
 * Separate what a commit SAYS from what it CHANGED.
 *
 * `git show` returns one blob: a header, the message indented four spaces, then the diff. The panel
 * printed all of it into one monospace block with the subject repeated on top as a label, so the
 * sentence the author actually wrote was the least visible thing on a screen devoted to it.
 * Phillip's words at room #4350 were to drop the summary line and box the real message.
 *
 * The split is the first `diff --git` line, which is where git itself stops narrating and starts
 * listing. A commit that changed nothing has no such line and is all message; a file selection has
 * no message at all and is all diff.
 */
export interface CommitParts {
	/** The header and message, de-indented. Empty for a plain file diff. */
	readonly message: string;
	/** Everything from the first file header onwards. */
	readonly diff: string;
}

const FILE_HEADER = /^diff --git /m;

export function splitCommit(output: string): CommitParts {
	const match = FILE_HEADER.exec(output);
	const head = match ? output.slice(0, match.index) : output;
	return { diff: match ? output.slice(match.index) : '', message: deindent(dropHeader(head)) };
}

/**
 * Drop git's own header - the sha, author and date lines before the first blank one.
 *
 * Phillip asked for the actual commit MESSAGE, and those lines are not it: the sha is already on the
 * row that was clicked, the date is already in its tooltip, and the author of a local commit is
 * whoever is reading. Keeping them pushed the sentence that matters below three lines of metadata.
 *
 * Only a leading run is dropped, and only lines that look like headers, so a message whose own first
 * line happens to start with "Date:" survives as long as a blank line separates it from the header -
 * which git guarantees, because that blank line is how git separates them too.
 */
const HEADER_LINE = /^(?:commit|Author|AuthorDate|Commit|CommitDate|Date|Merge|Tag|Tagger)\b/;

function dropHeader(head: string): string {
	const lines = head.replace(/\r\n/g, '\n').split('\n');
	let index = 0;
	while (index < lines.length && HEADER_LINE.test(lines[index] ?? '')) index += 1;
	return index === 0 ? head : lines.slice(index).join('\n');
}

/**
 * Git indents the message by four spaces to set it apart from the header it follows. Inside its own
 * box that indent is just a ragged left edge, so it comes off - but only where it is the whole
 * prefix, since a message may legitimately indent a line further than git did.
 */
function deindent(text: string): string {
	return text
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map((line) => (line.startsWith('    ') ? line.slice(4) : line))
		.join('\n')
		.trim();
}
