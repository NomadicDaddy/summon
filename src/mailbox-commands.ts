import { queueFailureView } from './codex-queue-failures.ts';
import {
	assertNotHeld,
	holdMessage,
	readHoldChunk,
	receiveHolds,
	recordDecision,
} from './mail-attention.ts';
import { locked } from './mail-files.ts';
import { currentAgent } from './mail-identity.ts';
import { confirmMessage, header, readOwnChunk, receiveMail, statePath } from './mail-read.ts';
import { parseReceiveArgs, receiveFiltered } from './mail-receive-filter.ts';
import { sentStatus } from './mail-sent-status.ts';
import { bindSession } from './mail-session-hook.ts';
import { deliveryView, markReady } from './mail-session.ts';
import { acknowledgeMessage, operatorMailCommand, sendMessage } from './mailbox.ts';
import { messageBodyArgs } from './message-body-file.ts';
import { responseStatusView } from './response-watchdog-store.ts';
import { loadAgent } from './store.ts';
import { wakeDeliveryStatus } from './wake-delivery-store.ts';
import { wakeErrors } from './wake-errors.ts';

async function acknowledgeHandled(name: string, id: string): Promise<void> {
	await locked(statePath(name, id, 'handling.lock'), async () => {
		await assertNotHeld(name, id);
		await acknowledgeMessage(name, id);
	});
}

const actions = new Set([
	'send-self',
	'receive',
	'history',
	'holds',
	'read-self',
	'read-history',
	'read-hold',
	'sent-status',
	'reply',
	'confirm',
	'ack-self',
	'hold',
	'record-decision',
	'status',
	'ready',
	'bind',
]);

export type ScopedMailResult =
	| { bound: string }
	| { id: string; state: 'persisted' | 'confirmed' | 'handled' }
	| { ready: true }
	| Awaited<ReturnType<typeof receiveFiltered>>
	| Awaited<ReturnType<typeof receiveHolds>>
	| Awaited<ReturnType<typeof readOwnChunk>>
	| Awaited<ReturnType<typeof holdMessage>>
	| Awaited<ReturnType<typeof recordDecision>>
	| Awaited<ReturnType<typeof sentStatus>>
	| (Awaited<ReturnType<typeof deliveryView>> &
			Awaited<ReturnType<typeof responseStatusView>> & {
				wakeErrors: Awaited<ReturnType<typeof wakeErrors>>;
				wakeDelivery: Awaited<ReturnType<typeof wakeDeliveryStatus>>;
				codexQueueFailures: Awaited<ReturnType<typeof queueFailureView>> | null;
			});

export async function scopedMail(args: string[]): Promise<ScopedMailResult> {
	const name = currentAgent();
	if (args[0] === 'send-self' || args[0] === 'reply') args = await messageBodyArgs(args, 2);
	const [action, first, second, third] = args;
	if (action === 'bind' && args.length === 1) {
		const id = process.env.CODEX_THREAD_ID;
		if (!id) throw new Error('Codex did not supply a current thread ID.');
		await bindSession({ hook_event_name: 'SessionStart', source: 'startup', session_id: id });
		return { bound: id };
	}
	if (action === 'send-self' && first && second && args.length === 3) {
		return { id: await sendMessage(name, first, second), state: 'persisted' };
	}
	if (action === 'receive') return receiveFiltered(name, parseReceiveArgs(args.slice(1)));
	if (action === 'history' && args.length <= 2) return receiveMail(name, first, false, 'history');
	if (action === 'holds' && args.length <= 2) return receiveHolds(name, first);
	if (action === 'sent-status' && first && args.length === 2) return sentStatus(name, first);
	if (
		(action === 'read-self' || action === 'read-history') &&
		first &&
		args[2] === '--offset' &&
		args[4] === '--limit' &&
		args.length === 6
	) {
		return readOwnChunk(
			name,
			first,
			Number(args[3]),
			Number(args[5]),
			action === 'read-history',
		);
	}
	if (
		action === 'read-hold' &&
		first &&
		args[2] === '--offset' &&
		args[4] === '--limit' &&
		args.length === 6
	) {
		return readHoldChunk(name, first, Number(args[3]), Number(args[5]));
	}
	if (action === 'confirm' && first && second && args.length === 3) {
		return { id: await confirmMessage(name, first, second), state: 'confirmed' };
	}
	if (action === 'reply' && first && second && args.length === 3) {
		const mail = await header(name, first);
		return {
			id: await sendMessage(name, mail.from, second, { kind: 'reply', replyTo: first }),
			state: 'persisted',
		};
	}
	if (action === 'ack-self' && first && args.length === 2) {
		await acknowledgeHandled(name, first);
		return { id: first, state: 'handled' };
	}
	if (action === 'hold' && first && second && third && args.length === 4)
		return holdMessage(name, first, second, third);
	if (action === 'record-decision' && first && second && third && args.length === 4)
		return recordDecision(name, first, second, third);
	if (action === 'status' && args.length === 1) {
		const status = await deliveryView(name);
		return {
			...status,
			wakeErrors: await wakeErrors(name),
			...(await responseStatusView(name, status.nonce)),
			wakeDelivery: await wakeDeliveryStatus(name, status.nonce),
			codexQueueFailures:
				(await loadAgent(name))?.provider === 'codex'
					? await queueFailureView(name, status.nonce)
					: null,
		};
	}
	if (action === 'ready' && first && args.length === 2) {
		await markReady(name, first);
		return { ready: true };
	}
	throw new Error(
		'Invalid scoped mail command. Read the summon mail skills or run summon --help.',
	);
}

export async function mailCommand(args: string[]): Promise<void> {
	if (args[0] === 'send') args = await messageBodyArgs(args, 3);
	if (actions.has(args[0] ?? '')) {
		console.log(JSON.stringify(await scopedMail(args)));
		return;
	}
	if (args[0] === 'ack' && args[1] && args[2] && args.length === 3) {
		await acknowledgeHandled(args[1], args[2]);
		console.log(`Archived message ${args[2]}.`);
		return;
	}
	await operatorMailCommand(args);
}
