/** This module runs in Claude's mod engine. It preserves every event and core result. */
export const claudeTurnModule = String.raw`
function report($, state, kind, turn, completed, draft) {
	const task = state.pending.then(async () => {
		const url = await $.env.get('SUMMON_CLAUDE_TURN_URL');
		const key = await $.env.get('SUMMON_CLAUDE_TURN_KEY');
		const session = await $.session.id();
		if (!url || !key) throw new Error('Summon native observation is unavailable');
		if (state.epoch === null || kind === 'attach') {
			const attached = await $.http.fetch(url.replace(/\/turn$/, '/attach'), {
				method: 'POST', headers: { Authorization: 'Bearer ' + key },
				body: JSON.stringify({ session }),
			});
			if (!attached.ok) throw new Error('Summon native attachment was refused');
			const epoch = JSON.parse(attached.text).epoch;
			if (!Number.isSafeInteger(epoch) || epoch < 1)
				throw new Error('Summon native attachment is invalid');
			state.epoch = epoch;
			state.sequence = 0;
		}
		const ordinal = ++state.sequence;
		const response = await $.http.fetch(url, {
			method: 'POST', headers: { Authorization: 'Bearer ' + key },
			body: JSON.stringify({ session, epoch: state.epoch, sequence: ordinal, kind, turn, completed, draft }),
		});
		if (!response.ok) throw new Error('Summon native observation was refused');
	});
	state.pending = task.catch(() => {});
	return task;
}
export function register(on) {
	let current = null;
	let activity = 0;
	const state = { epoch: null, sequence: 0, pending: Promise.resolve() };
	on('session.start', async ($, e, next) => {
		activity++;
		current = null;
		const draft = (await $.prompt.read()).text.length !== 0;
		await report($, state, 'attach', null, false, draft);
		return next(e);
	});
	on('turn.start', async ($, e, next) => {
		if (e.agentId !== undefined) return next(e);
		activity++;
		current = e.turnId;
		await report($, state, 'start', e.turnId, false, (await $.prompt.read()).text.length !== 0);
		return next(e);
	});
	on('turn.complete', async ($, e, next) => {
		const result = await next(e);
		if (e.agentId !== undefined || current !== e.turnId) return result;
		current = null;
		await report($, state, 'complete', e.turnId, e.reason === 'answer' && !e.isAborted,
			(await $.prompt.read()).text.length !== 0);
		return result;
	});
	on('prompt.edit', async ($, e, next) => {
		activity++;
		const result = await next(e);
		await report($, state, 'draft', current, false, result.text.length !== 0);
		return result;
	});
	on('prompt.submit', async ($, e, next) => {
		activity++;
		// Busy submissions can join this turn without another turn.start event.
		await report($, state, 'submit', current, false, true);
		return next(e);
	});
	on('command.run', async ($, e, next) => {
		const observed = ++activity;
		const epoch = state.epoch;
		const result = await next(e);
		// Local commands may have no turn.complete. Refresh only an unchanged prompt observation;
		// this cannot establish idle, complete a turn, or release a newer draft/submission.
		if (observed !== activity || epoch !== state.epoch || current !== null) return result;
		try {
			const draft = (await $.prompt.read()).text.length !== 0;
			if (observed === activity && epoch === state.epoch && current === null)
				await report($, state, 'draft', null, false, draft);
		} catch { /* Preserve the native result and retain the last conservative observation. */ }
		return result;
	});
	on('session.compact', async ($, e, next) => {
		if (e.agentId !== undefined) return next(e);
		activity++;
		await report($, state, 'compact-start', current, false, true);
		try {
			return await next(e);
		} finally {
			// Failed or aborted core compaction must balance its entry without replacing its error.
			let draft = true;
			try { draft = (await $.prompt.read()).text.length !== 0; } catch {}
			try { await report($, state, 'compact-end', current, false, draft); } catch {}
		}
	});
	on('session.end', async ($, e, next) => {
		activity++;
		current = null;
		await report($, state, 'end', null, false, true);
		return next(e);
	});
	on('classic.Notification', async ($, e, next) => {
		const observed = activity;
		const result = await next(e);
		if (e.notification_type !== 'idle_prompt' || e.agent_id !== undefined || current !== null)
			return result;
		if (e.session_id !== await $.session.id()) return result;
		const draft = (await $.prompt.read()).text.length !== 0;
		if (!draft && observed === activity && current === null)
			await report($, state, 'idle', null, false, false);
		return result;
	});
	on('session.measure', async ($, e, next) => {
		const result = await next(e);
		const observed = activity;
		const task = state.pending.then(async () => {
			if (state.epoch === null || observed !== activity) return;
			const session = await $.session.id();
			const model = await $.session.model();
			const contextWindow = (await $.session.usage()).context.window;
			if (model !== await $.session.model() || observed !== activity) return;
			const url = await $.env.get('SUMMON_CLAUDE_TURN_URL');
			const key = await $.env.get('SUMMON_CLAUDE_TURN_KEY');
			if (!url || !key || observed !== activity) return;
			await $.http.fetch(url.replace(/\/turn$/, '/model'), {
				method: 'POST', headers: { Authorization: 'Bearer ' + key },
				body: JSON.stringify({ session, epoch: state.epoch, model, contextWindow }),
			});
		});
		state.pending = task.catch(() => {});
		await state.pending;
		return result;
	});
}
`;
