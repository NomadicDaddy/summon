/** Shared by the command output, startup prompt and live notices. */
export const CHECKPOINT_CATCH_UP_HOLD =
	'An applicable operator hold needs its explicit release; verify the actual current decision for your team. Startup readiness, a source merge or a fixture pass grants no hold release or lifecycle authority. Read the addressed index before applying. Use only the explicit catch-up preview/index/apply workflow; assess refusals without bypassing them.';

/** Past either limit a backlog is caught up with the explicit preview, not paged (#24035). */
export const CATCH_UP_PAGES = 5;
export const CATCH_UP_ITEMS = 200;

/** The threshold as seats read it, in the counters every checkpoint page reports. */
export const CATCH_UP_THRESHOLD = `more than ${String(CATCH_UP_PAGES)} pages or more than ${String(CATCH_UP_ITEMS)} items (the package.pages and package.items a checkpoint page reports)`;

export const CHECKPOINT_WORK_INSTRUCTION =
	'In Normal mode while an own task is pending, read at most one historical checkpoint page at a safe work boundary using summon --checkpoint [receipt] --work. Read that page completely and retain its receipt. Then perform two concrete steps on your own task before the next routine page; never spend consecutive turns on routine catch-up alone. Operator input, mentions, replies, mail and approval decisions remain actionable at every safe boundary through summon --current-requests --format text and own mail reads. Continue retained page and final receipts in order at later work boundaries; never bypass receipt reading or claim caught up early. ' +
	`When a package has ${CATCH_UP_THRESHOLD}, use summon --checkpoint catch-up instead of paging: preview a bounded recent tail and retained addressed references, then its explicit apply command; skipped history is not read or completed, and direct mail stays unchanged. ` +
	'If no own task is actionable, finish normal catch-up or the explicit catch-up operation. Active head-down keeps queued notices unread until that mode ends. ' +
	CHECKPOINT_CATCH_UP_HOLD;

export const CHECKPOINT_STARTUP_INSTRUCTION =
	'Startup order, before historical catch-up: bind Codex with summon --mail bind when applicable; inspect own summon --mail status; confirm the current launch with summon --mail ready <nonce> using the supplied readiness nonce; then set summon --status busy "<authorized task>" or summon --status idle "Ready". Do not drain checkpoints before readiness and this first status call. Readiness and status grant no work authority. After required read coverage, if no authorized work is actionable, check summon --work once. Set idle Ready or idle Waiting for a teammate; preserve needs-user and its Room line for the operator. Run summon --rest ready; on confirmation, end your turn and wait for new input. Do not loop through empty mail or checkpoint checks. Assess any rest refusal without bypassing it. Never rest while your own child process is running.';

// "No reply." alone read to a fresh Kilo seat as an order not to answer the operator posts the
// notice named (Phillip #21103/#21104); say which thing needs no reply.
export const CHECKPOINT_NOTICE_INSTRUCTION =
	' summon --current-requests; summon --checkpoint [receipt]; own task: add --work. This notice needs no reply; the posts it names may.';

export function checkpointWork(packageComplete = false) {
	return {
		pageBudget: 1,
		taskStepsBeforeRoutinePage: 2,
		packageComplete,
		instruction: packageComplete
			? 'The final package receipt is acknowledged and no active package remains. Later arrivals have not been captured; this is a work boundary, not a quiet or rest-ready claim. No receipt is issued here. Resume your task now. At a later work boundary start summon --checkpoint --work without a receipt to capture the next package. Retrying the prior final receipt also captures later arrivals; read the returned content before acknowledging its receipt. With no actionable task, finish required read coverage, check summon --work once, set idle or preserve your human wait, confirm summon --rest ready and end your turn. Do not poll for assignments.'
			: CHECKPOINT_WORK_INSTRUCTION,
	};
}
