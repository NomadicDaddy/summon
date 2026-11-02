import { afterEach, beforeEach, spyOn } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { initializeActivity } from '../../src/agent-activity.ts';
import { appendLocalEvent } from '../../src/local-room.ts';
import { profileTextRevision } from '../../src/profile-text.ts';
import { registrationAuditPath } from '../../src/registration-audit.ts';
import { registrationCommand } from '../../src/registration-text.ts';
import { loadAgent, newRecord, recordPath, rememberSession, saveAgent } from '../../src/store.ts';
import { mailHarness } from './mail-harness.ts';

/**
 * An isolated store with ordinary teammates alpha and beta, a PM named steward on its current
 * launch, and one agent message. Decisions come from approve (request, then the operator's
 * answer) or answered (a hand-written approval). Registers its own hooks.
 */
export function registrationFixture() {
	const state = {
		harness: undefined as Awaited<ReturnType<typeof mailHarness>> | undefined,
		agentMessage: '',
	};
	/**
	 * Steward asks, and the operator answers.
	 * @param text The request text.
	 * @param choice The operator's choice index.
	 * @param kind An approval (Yes/No) or an ordinary question with the same two labels.
	 * @returns The answer's room id, as typed on the command line.
	 */
	const answered = async (
		text: string,
		choice: 0 | 1,
		kind: 'approval' | 'question' = 'approval',
		sender = 'steward',
	): Promise<string> => {
		const request = await appendLocalEvent({
			sender: { kind: 'agent', id: sender },
			text,
			replyTo: null,
			source: 'local',
			question: { kind, choices: ['Yes', 'No'], allowFreeform: false },
		});
		return answer(request.id, choice);
	};
	/** The operator's answer to an existing question, as answerRoom records it. */
	const answer = async (questionId: number, choice: 0 | 1): Promise<string> =>
		String(
			(
				await appendLocalEvent({
					sender: { kind: 'user', id: 'operator' },
					text: choice === 0 ? 'Yes' : 'No',
					replyTo: questionId,
					source: 'local',
					answer: { questionId, choice },
				})
			).id,
		);
	const saved = {
		home: process.env.SUMMON_HOME,
		agent: process.env.SUMMON_AGENT,
		nonce: process.env.SUMMON_NONCE,
	};
	const room = async (kind: 'user' | 'agent', text: string): Promise<string> =>
		String(
			(
				await appendLocalEvent({
					sender: { kind, id: kind === 'user' ? 'operator' : 'alpha' },
					text,
					replyTo: null,
					source: 'local',
				})
			).id,
		);
	beforeEach(async () => {
		const harness = await mailHarness();
		state.harness = harness;
		process.env.SUMMON_HOME = harness.records;
		delete process.env.SUMMON_AGENT;
		delete process.env.SUMMON_NONCE;
		await writeFile(
			recordPath('steward'),
			JSON.stringify({ ...newRecord('Steward', harness.root, 'codex'), memberType: 'pm' }),
		);
		const beta = await loadAgent('beta');
		if (!beta) throw new Error('fixture missing beta');
		beta.expertise = 'Original expertise';
		beta.domain = 'Original domain';
		rememberSession(beta, 'beta-session');
		await saveAgent('beta', beta);
		await initializeActivity('steward', 'pm-launch');
		await initializeActivity('alpha', 'alpha-launch');
		state.agentMessage = await room('agent', 'Approved, says alpha');
	});
	afterEach(async () => {
		process.env.SUMMON_HOME = saved.home;
		if (saved.agent === undefined) delete process.env.SUMMON_AGENT;
		else process.env.SUMMON_AGENT = saved.agent;
		if (saved.nonce === undefined) delete process.env.SUMMON_NONCE;
		else process.env.SUMMON_NONCE = saved.nonce;
		await state.harness?.dispose();
	});

	async function as<T>(agent: string, nonce: string, work: () => Promise<T>): Promise<T> {
		process.env.SUMMON_AGENT = agent;
		process.env.SUMMON_NONCE = nonce;
		try {
			return await work();
		} finally {
			delete process.env.SUMMON_AGENT;
			delete process.env.SUMMON_NONCE;
		}
	}
	/** Run the command and return what it printed. */
	const run = async (args: string[]): Promise<string> => {
		const log = spyOn(console, 'log').mockImplementation(() => undefined);
		try {
			await registrationCommand(args);
			return log.mock.calls.map((call) => call.join(' ')).join('\n');
		} finally {
			log.mockRestore();
		}
	};
	return {
		/**
		 * The PM requests exactly this edit, and the operator answers it.
		 * @param args The edit's name and flags, without --decision.
		 * @param choice 0 for Yes, 1 for No.
		 * @returns The answer's id, for --decision.
		 */
		approve: async (args: string[], choice: 0 | 1 = 0): Promise<string> => {
			const posted = await as('steward', 'pm-launch', () => run(['request', ...args]));
			const id = /Approval request #(\d+)/.exec(posted)?.[1];
			if (!id) throw new Error(`request posted nothing: ${posted}`);
			return answer(Number(id), choice);
		},
		agentMessage: () => state.agentMessage,
		answered,
		operatorMessage: (text: string) => room('user', text),
		as,
		asPm: <T>(work: () => Promise<T>) => as('steward', 'pm-launch', work),
		textFile: async (name: string, text: string | Uint8Array): Promise<string> => {
			const path = join(state.harness?.root ?? '', name);
			await writeFile(path, text);
			return path;
		},
		revision: async (name = 'beta'): Promise<string> => {
			const record = await loadAgent(name);
			if (!record) throw new Error(`missing ${name}`);
			return profileTextRevision(record);
		},
		run,
		failure: (work: Promise<unknown>): Promise<string> =>
			work.then(
				() => 'resolved',
				(error: unknown) => String(error),
			),
		audit: async (): Promise<Record<string, unknown>[]> => {
			const text = await readFile(registrationAuditPath(), 'utf8').catch(() => '');
			return text
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		},
	};
}
