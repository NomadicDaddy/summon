import type { TeamSnapshot } from './types.ts';

import { boardActions } from './board-actions.ts';
import { setupBoardToggle } from './board-panel.ts';
import { setupBuildInfo } from './build-info.ts';
import { setupDiary } from './diary-panel.ts';
import { setupErrorBanner } from './error-banner.ts';
import { reportFault } from './fault-report.ts';
import { setupHeadDownControls } from './head-down-controls.ts';
import { focusedHeadDown, headDownRosterRow, restoreHeadDownFocus } from './head-down-roster.ts';
import { canPauseNotifications, isHeadsDown } from './head-down-row.ts';
import { setupHibernationControls } from './hibernation-controls.ts';
import { readableError } from './ipc-error.ts';
import { keepScroll } from './keep-scroll.ts';
import { connectingSince, markElapsed, startElapsedTicker } from './launch-elapsed.ts';
import { setupMacroBar } from './macro-bar.ts';
import { setupMacros } from './macros.ts';
import { setupMaintenance } from './maintenance.ts';
import { memberDetail } from './member-detail.ts';
import { headerState, memberRow, memberWorkingText, writeStateLabel } from './member-identity.ts';
import { setupNotepad } from './notepad.ts';
import { setupNotificationPause } from './notification-pause-control.ts';
import { renderWelcome } from './onboarding.ts';
import { setupOperator } from './operator-pane.ts';
import { watchPageShift } from './page-shift.ts';
import { setupProviderFilters } from './provider-filters.ts';
import { element } from './required-element.ts';
import { setupResponsePanel } from './response-watchdog-panel.ts';
import { restoreRestFocus, restRosterRow } from './rest-roster.ts';
import { setupRoom } from './room.ts';
import { setupRosterCoverage } from './roster-coverage.ts';
import { setupRosterProgress } from './roster-progress.ts';
import { memberSelection, selectionTarget } from './selection-focus.ts';
import { setupShortcuts } from './shortcuts.ts';
import { setupSplitters } from './splitters.ts';
import { stopWithConfirm } from './stop-confirm.ts';
import { renderStopButton, stopUnverifiedNotes } from './stop-unverified-view.ts';
import { faultStore, markFaultedRow, noteFault } from './teammate-faults.ts';
import { setupTerminalPanes } from './terminal-panes.ts';
import { windowActions } from './window-action.ts';
import { setupReadOnlyWorkViews } from './work-views.ts';

const roster = element('roster');
const updateProviderFilters = setupProviderFilters(roster);
const terminalArea = element('terminals');
const empty = element('empty');
const start = element('start');
const stop = element('stop');
const stopNotes = stopUnverifiedNotes();
const errorBanner = setupErrorBanner(element);
const showError = errorBanner.show;
const windowAction = windowActions(errorBanner);
const action = windowAction.action;
const updateResponses = setupResponsePanel(roster, errorBanner.from('response-watchdog'));
const updateHibernation = setupHibernationControls(errorBanner.from('hibernate'));
let addedSlug = '';
let addedNote = '';
const updateHeadDown = setupHeadDownControls(errorBanner.from('head-down'));
const updatePause = setupNotificationPause(errorBanner.from('notification-pause'));
const maintenance = setupMaintenance((slug, note) => {
	addedSlug = slug;
	addedNote = note ?? '';
}, updateProviderFilters);
element('roster-add').addEventListener('click', () => maintenance.add());
const updateRoom = setupRoom();
const updateCoverage = setupRosterCoverage();
const updateProgress = setupRosterProgress();
setupSplitters();
const updateBoard = setupBoardToggle(
	() =>
		window.team.boardRead().catch((error: unknown) => {
			showError(error, 'board.read');
			return null;
		}),
	() => snapshot.selected || null,
	boardActions(
		action,
		() => updateBoard(),
		() => snapshot.agents.map(({ name, slug }) => ({ name, slug })),
	),
);
let snapshot: TeamSnapshot = { agents: [], selected: '' };
const updateDiary = setupDiary(errorBanner.from('diary.read'));
setupNotepad();
setupShortcuts();
watchPageShift(reportFault, (state) => window.team.pageState(state));
const panes = setupTerminalPanes(terminalArea, () => snapshot);
const selectMember = memberSelection(
	(slug) => action(() => window.team.select(slug)),
	() => selectionTarget(snapshot, panes.get(snapshot.selected)?.terminal),
);
setupReadOnlyWorkViews(errorBanner.from('repos'), selectMember);
const faults = faultStore();
function render(value: TeamSnapshot): void {
	const focusedRest =
		document.activeElement instanceof HTMLElement
			? document.activeElement.dataset.restSlug
			: undefined;
	const focusedSlug =
		document.activeElement instanceof HTMLElement && roster.contains(document.activeElement)
			? document.activeElement.dataset.slug
			: undefined;
	const focusedDecision = focusedHeadDown(roster);
	snapshot = value;
	windowAction.operatorError(value.operatorError);
	faults.sync(new Map(value.agents.map((agent) => [agent.slug, agent.status])));
	const teamName = element('team-name');
	teamName.textContent = value.team ?? '';
	teamName.hidden = !value.team;
	element('team-started').textContent = value.startedAt
		? `Started ${new Date(value.startedAt).toLocaleString(undefined, { timeZoneName: 'short' })}`
		: '';
	element('team-started').title = value.startedAt ?? '';
	maintenance.update(value);
	const noTeammates = value.agents.length === 0;
	element('roster-add').textContent = noTeammates ? 'Add your first teammate' : 'Add teammate';
	element('provider-filters').hidden = noTeammates;
	element('presence-filters').hidden = noTeammates;
	updateRoom(value);
	updateDiary(value);
	// The filters can hide rows, so the scroll is restored after them, on the roster's final height.
	keepScroll(roster, () => {
		roster.replaceChildren();
		for (const agent of value.agents) {
			const button = memberRow(agent, value.selected);
			markFaultedRow(button, agent.slug, faults, errorBanner.display, () =>
				selectMember(agent.slug),
			);
			roster.append(
				headDownRosterRow(
					agent,
					restRosterRow(agent, button, (slug, confirmation) => {
						void action(() => window.team.stopRest(slug, confirmation));
					}),
					(slug, id, approve) => {
						void action(() => window.team.headDownDecision(slug, id, approve));
					},
				),
			);
			if (agent.slug === focusedSlug) button.focus({ preventScroll: true });
			if (agent.status === 'running') panes.open(agent.slug);
		}
		updateProviderFilters();
	});
	restoreRestFocus(roster, focusedRest);
	restoreHeadDownFocus(roster, focusedDecision);
	element('count').textContent =
		`${value.agents.filter((agent) => agent.status === 'running').length} here`;
	updateCoverage(value.agents);
	updateProgress(value.agents);
	updateResponses(value.agents);
	const selected = value.agents.find((agent) => agent.slug === value.selected);
	updateHibernation(selected);
	updateHeadDown(selected);
	updatePause(value.notificationPause, canPauseNotifications(selected), isHeadsDown(selected));
	element('name-text').textContent = selected?.name ?? 'Your Team Window';
	element('name-role').hidden = selected?.memberType !== 'pm';
	const nameState = element('name-state');
	const activity =
		selected && (selected.status === 'running' || selected.status === 'elsewhere')
			? selected.activity
			: undefined;
	const header = headerState(selected, activity);
	header.title = stopNotes.title(selected) ?? header.title;
	nameState.className = header.className;
	nameState.hidden = !selected;
	const stateLabel = header.label;
	writeStateLabel(element('name-state-label'), selected, stateLabel);
	element('name-state-label').title = header.title;
	element('header-working').textContent = selected ? memberWorkingText(selected) : '';
	const detail = memberDetail(selected);
	element('detail').textContent = detail.text;
	element('detail').title = detail.title;
	element('status').textContent = stateLabel || 'Ready';
	element('status').title = header.title;
	const since = connectingSince(selected, stateLabel);
	markElapsed(element('name-state-elapsed'), since);
	markElapsed(element('status-elapsed'), since);
	start.hidden =
		!selected || ['running', 'elsewhere', 'unknown', 'hibernated'].includes(selected.status);
	start.textContent = ['exited', 'stopped'].includes(selected?.status ?? '')
		? 'Resume'
		: 'Summon';
	stop.hidden = !selected?.ownedSession;
	renderStopButton(stop, selected);
	const running = selected?.status === 'running';
	const quickReplies = element('agent-quick-replies');
	quickReplies.hidden = !running;
	for (const button of quickReplies.querySelectorAll('button')) button.disabled = !running;
	panes.sync(value);
	empty.hidden = !!selected && panes.has(selected.slug);
	renderWelcome(element, selected, addedSlug, noTeammates, addedNote);
	updateBoard();
	requestAnimationFrame(panes.fitSelected);
}
for (const control of [start, element('empty-start')])
	control.addEventListener('click', () => {
		if (snapshot.agents.length === 0) {
			maintenance.add();
			return;
		}
		const selected = snapshot.agents.find((agent) => agent.slug === snapshot.selected);
		if (!selected) return;
		void action(async () => {
			try {
				await window.team.start(selected.slug);
			} catch (cause: unknown) {
				const message = readableError(cause);
				throw new Error(`${selected.name} could not start. ${message.split('\n')[0]}`, {
					cause,
				});
			}
		});
	});
stop.addEventListener('click', () => {
	const selected = snapshot.agents.find((agent) => agent.slug === snapshot.selected);
	if (!selected) return;
	// Asks on any sign of work, the provider's own turn record included, and again when the main
	// process finds work this snapshot missed (stop-confirm.ts). An unverified answer is not an
	// error: the snapshot's flag relabels the member and disables Stop (stop-unverified-view.ts).
	// Its diagnostic goes to the fault journal once per termination attempt, as a warning and not
	// on the banner, and the current snapshot is drawn again at once so a note it adds shows now.
	// The launch generation is read now, so a late answer can't mark a replacement session.
	const generation = stopNotes.generation(selected.slug);
	void action(async () => {
		const result = await stopWithConfirm(
			selected,
			(message) => window.confirm(message),
			(confirmed) => window.team.stop(selected.slug, confirmed),
		);
		if (result && 'unverified' in result && stopNotes.record(selected.slug, generation, result))
			reportFault({
				level: 'warning',
				member: selected.slug,
				source: 'stop.unverified',
				text: result.detail,
			});
		render(snapshot);
	});
});
window.team.onImagePaste(() => {
	const current = panes.get(snapshot.selected);
	if (current?.node.contains(document.activeElement))
		window.team.input(snapshot.selected, '\x16');
});
window.team.onEvent((event) => {
	if (event.type === 'snapshot') render(event.value);
	else if (event.type === 'reset') {
		// A new launch for this member: its terminal and its unverified-stop state start fresh.
		panes.reset(event.slug);
		stopNotes.launch(event.slug);
	} else if (event.type === 'output') panes.open(event.slug).terminal.write(event.data);
	else if (event.type === 'board') updateBoard();
	else noteFault(faults, event, errorBanner, () => render(snapshot));
});
void window.team
	.ready()
	.then((value) => {
		render(value);
		setupOperator(value.windowsPty);
	})
	.catch(errorBanner.from('window.ready'));
setupMacros();
startElapsedTicker();
setupBuildInfo(errorBanner.from('window.open-repository'));
setupMacroBar(
	element('agent-quick-replies'),
	(text, send) => {
		if (snapshot.agents.find((agent) => agent.slug === snapshot.selected)?.status !== 'running')
			return;
		const current = panes.open(snapshot.selected);
		current.terminal.paste(text);
		if (send) window.team.input(snapshot.selected, '\r');
		current.terminal.focus();
	},
	() =>
		snapshot.agents.some(
			(agent) => agent.slug === snapshot.selected && agent.status === 'running',
		),
);
