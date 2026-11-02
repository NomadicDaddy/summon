import { afterEach, beforeEach } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PresenceResolver } from '../../src/room-groups.ts';
import type { Presence, PresenceState } from '../../src/session-presence.ts';
import type { Provider } from '../../src/store.ts';

import { Team, type TerminalProcess } from '../../src/desktop/team.ts';
import { newRecord } from '../../src/store.ts';
import { mailHarness } from './mail-harness.ts';

/** A disposable store per test (with the harness's alpha and beta) and a way to add members. */
export function presenceStore() {
	let fixture: Awaited<ReturnType<typeof mailHarness>>;
	const previous = process.env.SUMMON_HOME;
	beforeEach(async () => {
		fixture = await mailHarness();
		process.env.SUMMON_HOME = fixture.records;
	});
	afterEach(async () => {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await fixture.dispose();
	});
	return {
		records: () => fixture.records,
		async register(slug: string, provider: Provider = 'claude', hibernated = false) {
			const record = newRecord(slug, fixture.root, provider);
			if (hibernated)
				record.hibernation = {
					active: true,
					revision: crypto.randomUUID(),
					changedAt: Date.now(),
				};
			await writeFile(join(fixture.records, `${slug}.json`), JSON.stringify(record));
		},
	};
}

/** A presence resolver with fixed verdicts that records which members it was asked about. */
export function presence(states: Record<string, PresenceState>) {
	const asked: string[][] = [];
	const resolve: PresenceResolver = (members) => {
		asked.push(members.map((member) => member.slug));
		const result = new Map<string, Presence>();
		for (const { slug } of members) {
			const state = states[slug];
			if (state) result.set(slug, { state, reason: 'fixture', observedAt: 'fixture' });
		}
		return Promise.resolve(result);
	};
	return { resolve, asked };
}

/** A Team whose launches return one fake terminal, counting how many starts were made. */
export function presenceTeam() {
	let launches = 0;
	const exits: ((event: { exitCode: number }) => void)[] = [];
	const pty: TerminalProcess = {
		pid: 1,
		onData: () => ({ dispose: () => {} }),
		onExit: (listener) => {
			exits.push(listener);
			return { dispose: () => {} };
		},
		write: () => {},
		resize: () => {},
		kill: () => {},
	};
	const team = new Team(
		'bun',
		'cli.ts',
		() => {},
		() => {
			launches++;
			return pty;
		},
	);
	return {
		team,
		launched: () => launches,
		/** End every fake terminal the way a real exit would, then shut the team down. */
		close: async () => {
			for (const exit of exits) exit({ exitCode: 0 });
			await team.shutdown();
		},
	};
}
