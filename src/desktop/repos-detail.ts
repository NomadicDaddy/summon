import type { RepositoryDiff, RepositorySummary } from '../repository-model.ts';

import { splitCommit } from './commit-message.ts';
import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';

function button(text: string, action: () => void): HTMLButtonElement {
	const node = document.createElement('button');
	node.textContent = text;
	node.addEventListener('click', action);
	return node;
}

/** One span of a change or commit row, so each part can be sized and dimmed separately. */
function span(className: string, text: string): HTMLSpanElement {
	const node = document.createElement('span');
	node.className = className;
	node.textContent = text;
	return node;
}

/**
 * A row built from parts rather than one string.
 *
 * The lead is what you scan for - a filename, a short sha - and takes the left edge at full
 * strength. The trail is context that only matters once the lead has caught your eye, so it is
 * dimmed and it is the part that gives way when the row runs out of width.
 */
function detailRow(
	lead: string,
	trail: string,
	title: string,
	action: () => void,
): HTMLButtonElement {
	const node = document.createElement('button');
	node.className = 'detail-row';
	node.title = title;
	node.append(span('detail-lead', lead));
	if (trail) node.append(span('detail-trail', trail));
	// The row marks itself. Without it the panel showed a diff with nothing saying which of twenty
	// rows produced it - Phillip's words were that he could not tell the 4th from the 18th.
	node.addEventListener('click', () => {
		const panel = node.closest('.repos-detail');
		for (const other of panel?.querySelectorAll('.detail-row.is-selected') ?? [])
			other.classList.remove('is-selected');
		node.classList.add('is-selected');
		action();
	});
	return node;
}

/** Separate request tokens prevent a late diff or history response replacing another repository. */
export function repositoryDetail(
	root: HTMLElement,
	showError: (error: unknown) => void,
	selectMember: (slug: string) => Promise<boolean>,
): (repo: RepositorySummary) => Promise<void> {
	let request = 0;
	return async (repo) => {
		const current = ++request;
		root.textContent = 'Loading repository…';
		try {
			const detail = await window.team.reposDetail(repo.id);
			if (current !== request) return;
			const title = document.createElement('h3');
			title.textContent = repo.name;
			const meta = document.createElement('p');
			meta.className = 'repos-meta';
			meta.textContent = `${repo.path} · ${repo.branch} · Checked ${new Date(detail.checkedAt).toLocaleTimeString()} · ${repo.fetchRecordedAt ? `Fetch record ${new Date(repo.fetchRecordedAt).toLocaleString()}` : 'No recorded fetch'}`;
			const actions = document.createElement('div');
			actions.className = 'repos-actions';
			for (const [label, target] of [
				['Open folder', 'folder'],
				['Open in VS Code', 'code'],
			] as const)
				actions.append(
					button(label, () => {
						void window.team.reposOpen(repo.id, target).catch(showError);
					}),
				);
			// "Intern" beside "Open folder" and "Open in VS Code" reads as a third verb and is not
			// one - Phillip had to ask what it did. The name alone was the whole label; say the act.
			for (const member of repo.members)
				actions.append(
					button(`Switch to ${member.name}`, () => {
						void selectMember(member.slug);
					}),
				);
			const columns = document.createElement('div');
			columns.className = 'repos-detail-columns';
			const changes = document.createElement('div');
			changes.className = 'repos-changes';
			// The message gets its own element above the diff rather than a line inside it: in one
			// monospace block the sentence the author wrote was the least visible thing on a screen
			// devoted to reading it, and the subject was repeated on top as a label besides.
			const message = document.createElement('p');
			message.className = 'repos-commit-message';
			message.hidden = true;
			const preview = document.createElement('pre');
			preview.className = 'repos-preview';
			preview.tabIndex = 0;
			// Focusable, so it needs a role for its name to be announced; a named <pre> is ignored.
			preview.setAttribute('role', 'region');
			preview.setAttribute('aria-label', 'Selected change or commit');
			preview.textContent = 'Select a changed file or commit to read its diff.';
			let diffRequest = 0;
			const select = (label: string, selection: RepositoryDiff): void => {
				const selected = ++diffRequest;
				message.hidden = true;
				preview.textContent = `Loading ${label}…`;
				void window.team
					.reposDiff(repo.id, selection)
					.then((text) => {
						if (request !== current || diffRequest !== selected) return;
						// Split on WHAT WAS SELECTED, not on what the output looks like. Deciding
						// by content put an untracked file's own text in the message box, because
						// its diff carried no `diff --git` header and the whole thing read as a
						// message. A commit has one; a file never does.
						const parts =
							selection.kind === 'commit'
								? splitCommit(text)
								: { diff: text, message: '' };
						message.textContent = parts.message;
						message.hidden = parts.message === '';
						preview.textContent = parts.diff || 'No textual diff.';
					})
					.catch((error: unknown) => {
						if (request === current && diffRequest === selected) {
							preview.textContent = readableError(error);
							reportFault({
								level: 'error',
								source: 'repos.diff',
								text: faultText(error),
							});
						}
					});
			};
			for (const [label, kind] of [
				['Staged', 'staged'],
				['Unstaged', 'unstaged'],
				['Untracked', 'untracked'],
			] as const) {
				const files = detail.files.filter((file) =>
					kind === 'untracked' ? file.staged === '?' : ![' ', '?'].includes(file[kind]),
				);
				// An empty group is a heading that says nothing happened. Three of them on a clean
				// tree is three lines of nothing, so the clean case gets one line instead, below.
				if (files.length === 0) continue;
				const heading = document.createElement('h4');
				heading.textContent = `${label} (${files.length})`;
				changes.append(heading);
				for (const file of files) {
					const cut = file.path.lastIndexOf('/');
					changes.append(
						detailRow(
							cut === -1 ? file.path : file.path.slice(cut + 1),
							cut === -1 ? '' : file.path.slice(0, cut),
							file.path,
							() => select(`${label}: ${file.path}`, { kind, path: file.path }),
						),
					);
				}
			}
			if (detail.files.length === 0) {
				const clean = document.createElement('p');
				clean.className = 'repos-clean';
				clean.textContent = 'No local changes.';
				changes.append(clean);
			}
			const history = document.createElement('h4');
			history.textContent = `Recent commits (${detail.commits.length})`;
			changes.append(history);
			for (const commit of detail.commits)
				changes.append(
					detailRow(
						commit.short,
						commit.subject,
						`${commit.subject}\n${new Date(commit.at).toLocaleString()}`,
						() => select(commit.subject, { kind: 'commit', id: commit.id }),
					),
				);
			// The message and the diff share the reading column: one scrolls, the other does not, so
			// they are wrapped rather than appended loose beside the file list.
			const reading = document.createElement('div');
			reading.className = 'repos-reading';
			reading.append(message, preview);
			columns.append(changes, reading);
			root.replaceChildren(title, meta, actions, columns);
		} catch (error: unknown) {
			if (request === current) {
				root.textContent = readableError(error);
				reportFault({ level: 'error', source: 'repos.detail', text: faultText(error) });
			}
		}
	};
}
