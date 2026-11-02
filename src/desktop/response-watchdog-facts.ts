import type { TeamAgent } from './types.ts';

export type ResponseView = NonNullable<TeamAgent['responseWatchdog']>;
const labels = {
	blocked: 'Work waiting, delivery blocked',
	'awaiting-read': 'Delivered, awaiting read confirmation',
	uncertain: 'Input may have begun, awaiting read confirmation',
	inventory: 'Delivery inventory unavailable',
};
const age = (at: number, now: number) => `${Math.floor(Math.max(0, now - at) / 60000)} min`;

export function responseFact(state: TeamAgent['responseWatchdog'], now = Date.now()): string {
	if (!state || state.phase === 'clear' || state.phase === 'observing') return '';
	if (state.phase === 'suspended') return 'Response watch paused by communication controls';
	if (state.phase === 'dismissed') return 'Response alert dismissed';
	const oldest = state.expectations.reduce((a, b) => (a.progressAt < b.progressAt ? a : b));
	return `${labels[oldest.condition]} ${age(oldest.progressAt, now)}`;
}

export function responseFacts(state: ResponseView, now = Date.now()): string[] {
	const lines: string[] = [`Current launch: ${state.nonce}.`];
	for (const [condition, label] of Object.entries(labels)) {
		const items = state.expectations.filter((item) => item.condition === condition);
		if (!items.length) continue;
		const progress = Math.min(...items.map((item) => item.progressAt));
		const started = Math.min(...items.map((item) => item.startedAt));
		lines.push(
			`${label}: ${items.length}; no progress ${age(progress, now)}, total age ${age(started, now)}.`,
		);
	}
	for (const source of ['readiness', 'mail', 'holds', 'room', 'telegram']) {
		const targets = Object.values(state.targets).filter((item) => item.source === source);
		if (!targets.length) continue;
		const bounds = targets.map((item) => item.through).filter(Boolean);
		lines.push(
			`${source}: ${targets.length} target(s)${bounds.length ? `, bounds ${Math.min(...bounds)} to ${Math.max(...bounds)}` : ''}.`,
		);
	}
	if (state.diagnostic !== 'none')
		lines.push('Observation window restarted because stored timing could not be trusted.');
	return lines;
}
