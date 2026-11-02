import { spawn } from 'node:child_process';

import { version } from '../../package.json';
import { requireExecutable } from '../executable.ts';
import { operatorOnly } from '../mail-identity.ts';
import { latestSession, loadAgent, slugFor } from '../store.ts';

export interface UsageReport {
	checkedAt: string;
	lines: string[];
}
const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const number = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function usageLines(limits: unknown, usage: unknown): string[] {
	const result: string[] = [];
	const data = object(limits);
	const buckets = object(data.rateLimitsByLimitId);
	const snapshots = Object.keys(buckets).length ? Object.values(buckets) : [data.rateLimits];
	for (const item of snapshots) {
		const bucket = object(item);
		const name =
			typeof bucket.limitName === 'string' ? bucket.limitName.slice(0, 80) : 'Codex account';
		for (const key of ['primary', 'secondary']) {
			const window = object(bucket[key]);
			const used = number(window.usedPercent);
			if (used === undefined || used > 100) continue;
			const mins = number(window.windowDurationMins);
			const reset = number(window.resetsAt);
			const resetDate = reset === undefined ? undefined : new Date(reset * 1000);
			result.push(
				`${name} ${mins === undefined ? key : `${mins} min`}: ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(100 - used)}% remaining${resetDate && Number.isFinite(resetDate.getTime()) ? `; resets ${resetDate.toLocaleString()}` : ''} (shared account allowance)`,
			);
		}
	}
	if (!result.length) result.push('Account limits: unavailable from this provider response.');
	if (typeof data.ordinaryUsageAllowed === 'boolean')
		result.push(
			`Provider permits ordinary included usage: ${data.ordinaryUsageAllowed ? 'yes' : 'no'}.`,
		);
	const thread = object(object(usage).threadUsage);
	const groups = Array.isArray(thread.groups) ? thread.groups : [];
	const counts = groups.map((group: unknown) => number(object(group).totalTokens));
	if (counts.length && counts.every((count) => count !== undefined))
		result.push(
			`Session tokens: ${counts.reduce((sum, count) => sum + count, 0).toLocaleString()} (provider estimate).`,
		);
	else result.push('Session tokens: unavailable.');
	const usd = number(thread.estimatedUsageUsdMicros);
	result.push(
		usd === undefined
			? 'Session cost: unavailable.'
			: `Estimated session usage value: $${(usd / 1000000).toFixed(4)} USD; not necessarily an invoice charge.`,
	);
	return result;
}

/** Read-only RPCs only: never starts/resumes a thread or requests its conversation. */
export async function codexUsage(
	threadId: string,
	command = ['codex', 'app-server', '--stdio'],
): Promise<UsageReport> {
	operatorOnly();
	return new Promise((resolve) => {
		const child = spawn(requireExecutable(command[0] ?? 'codex'), command.slice(1), {
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'ignore'],
		});
		let buffer = '';
		let finished = false;
		let initialized = false;
		const responses = new Map<number, unknown>();
		const finish = (lines: string[]): void => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			child.stdin.end();
			child.kill();
			resolve({ checkedAt: new Date().toISOString(), lines });
		};
		const timer = setTimeout(
			() => finish(['Codex usage unavailable: provider read timed out.']),
			15000,
		);
		const send = (value: unknown): void => {
			child.stdin.write(`${JSON.stringify(value)}\n`);
		};
		child.on('error', () => finish(['Codex usage unavailable: CLI could not start.']));
		child.stdin.on('error', () =>
			finish(['Codex usage unavailable: provider connection closed.']),
		);
		child.on('exit', () => finish(['Codex usage unavailable: provider connection ended.']));
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (text: string) => {
			if (finished) return;
			buffer += text;
			if (buffer.length > 2_000_000) {
				finish(['Codex usage unavailable: response exceeded limit.']);
				return;
			}
			let end: number;
			while ((end = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				let value: Record<string, unknown>;
				try {
					value = object(JSON.parse(line) as unknown);
				} catch {
					continue;
				}
				if (value.id === 1 && !initialized) {
					if (value.error) {
						finish(['Codex usage unavailable: initialization rejected.']);
						return;
					}
					initialized = true;
					send({ method: 'initialized' });
					send({
						id: 2,
						method: 'account/rateLimits/read',
						params: { excludeResetCreditDetails: true },
					});
					if (threadId)
						send({ id: 3, method: 'account/usage/read', params: { threadId } });
					else responses.set(3, null);
				} else if (value.id === 2 || value.id === 3)
					responses.set(value.id, value.result ?? null);
				if (responses.has(2) && responses.has(3)) {
					finish(usageLines(responses.get(2), responses.get(3)));
					return;
				}
			}
		});
		send({
			id: 1,
			method: 'initialize',
			params: {
				clientInfo: { name: 'summon_usage', title: 'summon usage', version },
				capabilities: {
					experimentalApi: false,
					requestAttestation: false,
					explicitGatewayOauth: true,
				},
			},
		});
	});
}

export async function usageFor(name: string): Promise<UsageReport> {
	operatorOnly();
	const agent = await loadAgent(slugFor(name));
	if (!agent) throw new Error('Agent no longer exists.');
	if (agent.provider === 'codex') return codexUsage(latestSession(agent)?.id ?? '');
	return {
		checkedAt: new Date().toISOString(),
		lines: [
			`${agent.provider}: subscription limits, session tokens and cost are unavailable through a connected read-only interface. Check that CLI's usage display.`,
		],
	};
}
