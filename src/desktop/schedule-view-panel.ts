import type { ScheduleOwner, ScheduleRow, ScheduleView } from '../schedule-view.ts';

import { faultText, reportFault } from './fault-report.ts';
import { readableError } from './ipc-error.ts';
import { prependPanelHeading } from './panel-heading.ts';
import { conditionText, dueText, intervalText, lastRunText } from './schedule-view-text.ts';
import { updateWorkPanelDivider } from './work-panel.ts';

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string,
	text = '',
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	node.textContent = text;
	return node;
}

function scheduleItem(row: ScheduleRow, now: number, open: Set<string>): HTMLLIElement {
	const item = document.createElement('li');
	item.dataset.scheduleId = row.id;
	const details = document.createElement('details');
	details.open = open.has(row.id);
	details.addEventListener('toggle', () => {
		if (details.open) open.add(row.id);
		else open.delete(row.id);
	});
	const summary = document.createElement('summary');
	const state = element('span', 'schedule-state', conditionText(row));
	state.dataset.condition = row.condition;
	summary.append(
		element('span', 'schedule-title', row.title),
		state,
		element('span', 'schedule-fact schedule-every', intervalText(row.everyMinutes)),
		element('span', 'schedule-fact schedule-due', dueText(row, now)),
		element('span', 'schedule-fact schedule-last', lastRunText(row)),
	);
	details.append(summary, element('p', 'schedule-prompt', row.prompt));
	if (row.lastRun?.result)
		details.append(element('p', 'schedule-prompt', `Last result: ${row.lastRun.result}`));
	item.append(details);
	return item;
}

function ownerSection(owner: ScheduleOwner, now: number, open: Set<string>): HTMLElement {
	const section = document.createElement('section');
	const heading = element('h3', 'schedule-owner', owner.name);
	heading.append(
		element(
			'span',
			'schedule-count',
			owner.schedules.length === 1 ? '1 schedule' : `${owner.schedules.length} schedules`,
		),
	);
	const list = document.createElement('ul');
	list.append(...owner.schedules.map((row) => scheduleItem(row, now, open)));
	section.append(heading, list);
	return section;
}

/** A read-only list of every Summon schedule by owner (card 53ca685d). It changes nothing. */
export function setupScheduleView(): void {
	const panel = document.getElementById('schedules');
	const toggle = document.getElementById('schedules-toggle');
	const others = ['board-toggle', 'diary-toggle', 'repos-toggle']
		.map((id) => document.getElementById(id))
		.filter((item): item is HTMLElement => item !== null);
	if (!panel || !toggle || others.length !== 3) return;
	const refresh = document.createElement('button');
	refresh.type = 'button';
	refresh.textContent = 'Refresh';
	const status = element('p', 'schedule-status');
	status.setAttribute('role', 'status');
	const body = element('div', 'schedule-body');
	const without = element('p', 'schedule-without');
	panel.append(refresh, status, body, without);
	prependPanelHeading(panel, 'Schedules');
	/** Rows the reader opened stay open across the minute refresh. */
	const expanded = new Set<string>();
	let open = false;
	let busy = false;
	const draw = (view: ScheduleView): HTMLElement | null => {
		const scroll = panel.scrollTop;
		const focused =
			document.activeElement instanceof HTMLElement && body.contains(document.activeElement)
				? document.activeElement.closest('li')
				: null;
		const focusId = focused?.dataset.scheduleId;
		body.classList.remove('is-stale');
		body.replaceChildren(
			...view.owners.map((owner) => ownerSection(owner, view.readAt, expanded)),
		);
		const total = view.owners.reduce((sum, owner) => sum + owner.schedules.length, 0);
		status.textContent = total
			? `${total} ${total === 1 ? 'schedule' : 'schedules'} across ${view.owners.length} ${view.owners.length === 1 ? 'teammate' : 'teammates'} · Read ${new Date(view.readAt).toLocaleTimeString()} · View only`
			: `No schedules exist · Read ${new Date(view.readAt).toLocaleTimeString()}`;
		without.textContent = view.without.length ? `No schedule: ${view.without.join(', ')}` : '';
		without.hidden = view.without.length === 0;
		panel.scrollTop = scroll;
		if (focusId === undefined) return null;
		return (
			[...body.querySelectorAll('li')]
				.find((item) => item.dataset.scheduleId === focusId)
				?.querySelector('summary') ?? refresh
		);
	};
	const load = async (): Promise<void> => {
		if (busy) return;
		busy = true;
		let focusTarget: HTMLElement | null = null;
		refresh.disabled = true;
		try {
			focusTarget = draw(await window.team.scheduleView());
		} catch (error: unknown) {
			// What is on screen is now older than it claims; say so and show it as such.
			const shown = body.childElementCount > 0;
			status.textContent = `${readableError(error)}${shown ? ' · The list below was not refreshed' : ''}`;
			body.classList.toggle('is-stale', shown);
			reportFault({ level: 'error', source: 'schedules.view', text: faultText(error) });
		} finally {
			busy = false;
			refresh.disabled = false;
			// A removed row falls back to Refresh only after it can receive focus again.
			focusTarget?.focus({ preventScroll: true });
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
		for (const other of others)
			if (other.getAttribute('aria-pressed') === 'true') other.click();
		open = true;
		panel.hidden = false;
		updateWorkPanelDivider();
		toggle.setAttribute('aria-pressed', 'true');
		void load();
	});
	for (const other of others)
		other.addEventListener('click', () => {
			if (other.getAttribute('aria-pressed') === 'true') close();
		});
	refresh.addEventListener('click', () => {
		void load();
	});
	window.setInterval(() => {
		if (open) void load();
	}, 60000);
}
