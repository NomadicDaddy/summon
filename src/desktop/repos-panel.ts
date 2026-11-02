import type { RepositorySummary } from '../repository-model.ts';

import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';
import { prependPanelHeading } from './panel-heading.ts';
import { repositoryDetail } from './repos-detail.ts';
import { updateWorkPanelDivider } from './work-panel.ts';

/** One span of a repository row. The row is built from these so each part can be placed and sized. */
function span(className: string, text: string): HTMLSpanElement {
	const element = document.createElement('span');
	element.className = className;
	element.textContent = text;
	return element;
}

export function setupRepos(
	showError: (error: unknown) => void,
	selectMember: (slug: string) => Promise<boolean>,
): void {
	const panel = document.getElementById('repos');
	const toggle = document.getElementById('repos-toggle');
	const board = document.getElementById('board-toggle');
	const diary = document.getElementById('diary-toggle');
	if (!panel || !toggle || !board || !diary) return;
	const sidebar = document.createElement('div');
	sidebar.className = 'repos-list';
	const search = document.createElement('input');
	search.type = 'search';
	search.placeholder = 'Find a repository';
	search.setAttribute('aria-label', 'Find a repository');
	const refresh = document.createElement('button');
	refresh.textContent = 'Refresh';
	const status = document.createElement('p');
	status.className = 'repos-meta';
	status.setAttribute('role', 'status');
	const list = document.createElement('nav');
	list.setAttribute('aria-label', 'Repositories');
	const detail = document.createElement('div');
	detail.className = 'repos-detail';
	detail.textContent = 'Choose a repository to inspect its changes and history.';
	sidebar.append(search, refresh, status, list);
	panel.append(sidebar, detail);
	prependPanelHeading(panel, 'Repositories');
	const selectDetail = repositoryDetail(detail, showError, selectMember);
	let repositories: RepositorySummary[] = [];
	let selected = '';
	let open = false;
	let busy = false;
	const draw = (): void => {
		const focused =
			document.activeElement instanceof HTMLElement && list.contains(document.activeElement)
				? document.activeElement.dataset.repoId
				: undefined;
		const scroll = sidebar.scrollTop;
		const query = search.value.toLocaleLowerCase();
		list.replaceChildren();
		for (const repo of repositories.filter((item) =>
			`${item.name} ${item.path} ${item.branch}`.toLocaleLowerCase().includes(query),
		)) {
			const button = document.createElement('button');
			button.className = 'repo-row';
			button.setAttribute('aria-pressed', String(repo.id === selected));
			button.dataset.repoId = repo.id;
			button.append(
				span('repo-name', repo.name),
				// The branch only when it is not the one you expected. Sixty rows reading "main" cost
				// the name its last forty pixels to tell you nothing; a branch that is NOT main is
				// worth seeing from the list. The full branch is in the row's tooltip either way.
				...(repo.branch === 'main' || repo.branch === 'master'
					? []
					: [span('repo-branch', repo.branch)]),
				// A count only where there is one to give. "0 changed" and "No tracking comparison"
				// cost a line each on 56 rows to say that nothing happened.
				...(repo.error ? [span('repo-flag repo-error', '!')] : []),
				...(!repo.error && repo.changed > 0
					? [span('repo-flag', String(repo.changed))]
					: []),
				// Only the direction that has commits in it. "↓0" on every row is a column of zeroes.
				...(repo.ahead !== null && repo.ahead + (repo.behind ?? 0) > 0
					? [
							span(
								'repo-sync',
								[
									repo.ahead > 0 ? `↑${repo.ahead}` : '',
									(repo.behind ?? 0) > 0 ? `↓${repo.behind}` : '',
								]
									.filter(Boolean)
									.join(' '),
							),
						]
					: []),
			);
			// Everything the row no longer spells out stays reachable on hover.
			button.title = `${repo.path}\nBranch ${repo.branch}\nChecked ${new Date(repo.checkedAt).toLocaleString()}\n${repo.error ? 'Status unavailable' : `${repo.changed} changed`} · ${repo.ahead === null ? 'No tracking comparison' : `↑${repo.ahead} ↓${repo.behind ?? 0} from saved refs`}\n${repo.fetchRecordedAt ? `Fetch record updated ${new Date(repo.fetchRecordedAt).toLocaleString()}` : 'No recorded fetch'}${repo.error ? `\n${repo.error}` : ''}`;
			button.addEventListener('click', () => {
				selected = repo.id;
				draw();
				void selectDetail(repo);
			});
			list.append(button);
			if (repo.id === focused) button.focus({ preventScroll: true });
		}
		sidebar.scrollTop = scroll;
	};
	const load = async (refreshSelected: boolean): Promise<void> => {
		if (busy) return;
		busy = true;
		refresh.disabled = true;
		status.textContent = 'Checking working folders…';
		try {
			const result = await window.team.reposList();
			repositories = result.repositories;
			status.textContent = result.warnings.length
				? result.warnings.join('\n')
				: `${repositories.length} repositories · Checked ${new Date().toLocaleTimeString()} · Saved refs; no fetch`;
			for (const warning of result.warnings)
				reportFault({ level: 'warning', source: 'repos.list', text: warning });
			draw();
			const current = repositories.find((repo) => repo.id === selected);
			if (current && refreshSelected) await selectDetail(current);
			if (selected && !current) {
				selected = '';
				detail.textContent = 'The selected repository is no longer in the working folders.';
			}
		} catch (error: unknown) {
			status.textContent = readableError(error);
			reportFault({ level: 'error', source: 'repos.list', text: faultText(error) });
		} finally {
			busy = false;
			refresh.disabled = false;
		}
	};
	const close = (): void => {
		open = false;
		panel.hidden = true;
		updateWorkPanelDivider();
		toggle.setAttribute('aria-pressed', 'false');
	};
	toggle.addEventListener('click', () => {
		if (open) {
			close();
			return;
		}
		for (const other of [board, diary])
			if (other.getAttribute('aria-pressed') === 'true') other.click();
		open = true;
		panel.hidden = false;
		updateWorkPanelDivider();
		toggle.setAttribute('aria-pressed', 'true');
		void load(true);
	});
	for (const other of [board, diary])
		other.addEventListener('click', () => {
			if (other.getAttribute('aria-pressed') === 'true') close();
		});
	search.addEventListener('input', draw);
	refresh.addEventListener('click', () => {
		void load(true);
	});
	window.setInterval(() => {
		if (open) void load(false);
	}, 60000);
}
