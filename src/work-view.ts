import { readActivity } from './agent-activity.ts';
import { boardWork } from './board.ts';
import {
	checkpointHash,
	parseCheckpointPackage,
	parseCheckpointState,
} from './checkpoint-package-model.ts';
import {
	checkpointPackagePath,
	checkpointStatePath,
	validateCheckpointPackage,
} from './checkpoint-package-store.ts';
import { skipProgress } from './checkpoint-skip-progress.ts';
import { CHECKPOINT_CATCH_UP_HOLD } from './checkpoint-work.ts';
import { readHeadDown } from './head-down-model.ts';
import { localAgent } from './local-room-access.ts';
import { ownHolds } from './mail-attention.ts';
import { optionalText } from './mail-files.ts';
import { readMailIndex, statePath } from './mail-read.ts';
import { deliveryView } from './mail-session.ts';
import { pendingMessages } from './mailbox.ts';
import { readRest } from './rest.ts';
import { localCursorPath, roomCursor } from './room-cursor.ts';
import { summarizeSchedules } from './schedule-summary.ts';
import { listSchedules } from './schedules.ts';

async function checkpointProgress(name: string) {
	const state = parseCheckpointState(await optionalText(checkpointStatePath(name)));
	const raw = await optionalText(checkpointPackagePath(name));
	const packet = raw === undefined ? undefined : parseCheckpointPackage(raw);
	if (packet) validateCheckpointPackage(packet, name);
	if (
		state.current &&
		(!packet ||
			packet.id !== state.current.id ||
			checkpointHash(packet) !== state.current.sha256 ||
			state.current.page > packet.pages.length)
	)
		throw new Error(
			'Frozen checkpoint package changed or missing. Run summon --checkpoint for recovery.',
		);
	return {
		phase: state.current
			? state.current.page === packet?.pages.length
				? 'final'
				: 'page'
			: packet &&
				  state.completedPackage !== packet.id &&
				  state.supersededPackage !== packet.id
				? 'recovery-needed'
				: 'no-active-package',
		page: state.current ? Math.min(state.current.page + 1, packet?.pages.length ?? 0) : null,
		pages: state.current ? packet?.pages.length : null,
		lastAcknowledgedReceipt: state.lastAck ?? null,
		lastFullyReadPackage: state.completedPackage ?? null,
		supersededPackage: state.supersededPackage ?? null,
		catchUp: (await skipProgress(name)) ?? null,
		catchUpHold: CHECKPOINT_CATCH_UP_HOLD,
		retainedEmptyReceipt: state.emptyReceipt ?? null,
		instruction:
			'Progress only; bodies are not displayed and no read coverage is recorded. A superseded package was skipped, not fully read. Catch-up records retain its ranges and addressed originals. This cannot authorize acknowledging a page or final receipt. Use summon --checkpoint.',
	};
}

/** Own scope only. Never dispatch, mark mail read, issue a checkpoint or refresh rest state. */
export async function workView() {
	const name = await localAgent();
	const nonce = process.env.SUMMON_NONCE;
	if (!nonce) throw new Error('No current launch nonce.');
	const activity = await readActivity(name);
	const work = await boardWork();
	const { mails, errors } = await readMailIndex(name);
	let unread = 0;
	let unreadNonReceipts = 0;
	let obsoleteNotices = 0;
	for (const mail of mails) {
		if (await optionalText(statePath(name, mail.id, 'read'))) continue;
		unread++;
		if (mail.kind !== 'receipt') unreadNonReceipts++;
		if (mail.noticeStatus === 'obsolete') obsoleteNotices++;
	}
	const holds = await ownHolds(name);
	const mode = await readHeadDown(name);
	const rest = await readRest(name);
	return {
		owner: name,
		readOnly: true,
		snapshotOnly: true,
		activity: {
			currentLaunch: activity?.nonce === nonce,
			state: activity?.state ?? 'unknown',
			workingOn: activity?.workingOn ?? '',
		},
		delivery: await deliveryView(name),
		cards: {
			count: work.items.length,
			items: work.items.slice(0, 20),
			readMore: 'summon --board mine',
		},
		mail: {
			pending: (await pendingMessages(name)).length,
			validPending: mails.length,
			unread,
			unreadNonReceipts,
			obsoleteNotices,
			invalid: errors,
			errorLimit: 10,
			instruction:
				'Unread differs from unresolved pending mail. Inspect summon --mail receive and --mail receive --pending; follow every continuation.',
		},
		holds: {
			pending: holds.filter((hold) => hold.decision === 'pending').length,
			decisions: holds.filter((hold) => hold.decision !== 'pending').length,
			inspect: 'summon --mail holds',
		},
		checkpoint: await checkpointProgress(name),
		roomAcknowledgedThrough: roomCursor((await optionalText(localCursorPath(name))) ?? '0'),
		schedules: summarizeSchedules(await listSchedules()),
		headDown:
			mode?.nonce === nonce ? { id: mode.id, phase: mode.phase, goal: mode.goal } : null,
		rest: rest?.nonce === nonce ? { mode: rest.mode, reason: rest.reason } : null,
		instruction:
			'Independent read-only snapshots, not an atomic readiness proof. No work, approval, receipt, schedule run or rest confirmation is completed by this view.',
	};
}
