import { withoutRelease } from './claude-release-token.ts';
import { claudeTurn, pathFor } from './claude-turn-state.ts';
import { traceSwap } from './claude-turn-trace.ts';
import { atomicWrite, locked } from './mail-files.ts';

/**
 * Summon pasted a notice and then refused, before writing it, to press its own Enter. That exact
 * reservation never submitted, so its busy hold is released once, and only while nothing else has
 * touched the record: any native transition, human submission, attachment or compaction spends the
 * token first. The draft stays held unless Claude reported the text and then an empty box, so
 * nothing new can paste over text that may still be in the box. Nothing is resent or cleared.
 */
export async function releaseWithheldClaudeNotice(
	name: string,
	nonce: string,
	token: string,
): Promise<false | { draft: boolean }> {
	const path = pathFor(name, nonce);
	return locked(`${path}.lock`, async () => {
		const state = await claudeTurn(name, nonce);
		// A missing or replaced record is never recreated, and leaves no trace of its own.
		if (!state) return false;
		const release = state.release;
		const refused = async (why: string): Promise<false> => {
			await traceSwap(path, 'notice-release', state, state, `refused: ${why}`);
			return false;
		};
		if (release?.token !== token) return refused('reservation token absent or replaced');
		if (
			release.nonce !== nonce ||
			release.observer !== state.observer ||
			release.epoch !== state.epoch
		)
			return refused('launch, observer or attachment epoch changed');
		if (
			!state.attached ||
			state.phase !== 'busy' ||
			state.turn !== null ||
			state.compactions !== 0
		)
			return refused('turn record moved on since the reservation');
		const next = {
			...withoutRelease(state),
			phase: 'idle' as const,
			draft: state.draft || !(release.sawText && release.sawEmpty),
			generation: state.generation + 1,
		};
		await atomicWrite(path, JSON.stringify(next));
		await traceSwap(path, 'notice-release', state, next, 'Enter withheld before write');
		// The terminal caller must use this locked result, never a later native snapshot.
		return { draft: next.draft };
	});
}

/** Human input that could submit spends any release token before it reaches the terminal. */
export async function spendClaudeRelease(name: string, nonce: string): Promise<void> {
	const path = pathFor(name, nonce);
	await locked(`${path}.lock`, async () => {
		const state = await claudeTurn(name, nonce);
		if (!state?.release) return;
		const next = { ...withoutRelease(state), generation: state.generation + 1 };
		await atomicWrite(path, JSON.stringify(next));
		await traceSwap(path, 'release-spent', state, next, 'human input may submit');
	});
}
