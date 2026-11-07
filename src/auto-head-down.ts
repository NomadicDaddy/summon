import { z } from 'zod';

import type { HeadDownState } from './head-down-model.ts';
import type { LocalEvent } from './local-room.ts';

import { communicationSend } from './communication-gate.ts';
import { openLocalHistory } from './local-room-segments.ts';
import { appendLocalEvent, localRoomPath, scanLocalEvents } from './local-room.ts';
import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { teamWindowRuntime } from './team-startup.ts';

export interface AutoHeadDownSetting {
	enabled: boolean;
	revision: number;
}

const storedSchema = z.strictObject({
	enabled: z.boolean(),
	previous: z.boolean(),
	revision: z.number().int().positive(),
	auditId: z.number().int().positive(),
	changedAt: z.iso.datetime(),
});
type StoredSetting = z.infer<typeof storedSchema>;
const OFF: AutoHeadDownSetting = { enabled: false, revision: 0 };
const path = (): string => teamWindowRuntime('auto-head-down.json');

function settingText(value: Omit<StoredSetting, 'auditId'>): string {
	return (
		`Auto head-down setting revision ${value.revision}: ` +
		`${value.previous ? 'on' : 'off'} -> ${value.enabled ? 'on' : 'off'} ` +
		`by operator at ${value.changedAt}.`
	);
}

function settingAudit(event: LocalEvent): Omit<StoredSetting, 'auditId'> | undefined {
	if (event.sender.kind !== 'user' || event.sender.id !== 'operator' || event.source !== 'local')
		return undefined;
	const match =
		/^Auto head-down setting revision ([1-9]\d*): (on|off) -> (on|off) by operator at (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\.$/.exec(
			event.text,
		);
	if (!match) return undefined;
	const revision = Number(match[1]);
	const previous = match[2] === 'on';
	const enabled = match[3] === 'on';
	const changedAt = match[4];
	if (
		!Number.isSafeInteger(revision) ||
		previous === enabled ||
		!changedAt ||
		!Number.isFinite(Date.parse(changedAt))
	)
		return undefined;
	return { enabled, previous, revision, changedAt };
}

async function latestSettingAudit(): Promise<
	{ event: LocalEvent; setting: Omit<StoredSetting, 'auditId'> } | undefined
> {
	let latest: { event: LocalEvent; setting: Omit<StoredSetting, 'auditId'> } | undefined;
	await scanLocalEvents((event) => {
		const setting = settingAudit(event);
		if (setting) latest = { event, setting };
	});
	return latest;
}

async function roomEvent(id: number): Promise<LocalEvent | undefined> {
	const value = await (await openLocalHistory(localRoomPath())).find(id);
	if (!value || typeof value !== 'object') return undefined;
	return value as LocalEvent;
}

async function validatedSetting(): Promise<StoredSetting | undefined> {
	try {
		const raw = await optionalText(path());
		if (!raw) return undefined;
		const stored = storedSchema.parse(JSON.parse(raw) as unknown);
		if (stored.previous === stored.enabled || (stored.revision === 1 && stored.previous))
			return undefined;
		const latest = await latestSettingAudit();
		if (latest?.event.id !== stored.auditId || latest.event.text !== settingText(stored))
			return undefined;
		return stored;
	} catch {
		// A missing, unreadable, or unaudited setting never grants authority.
		return undefined;
	}
}

/** Teammates receive only the validated value and revision. */
export async function readAutoHeadDownSetting(): Promise<AutoHeadDownSetting> {
	const stored = await validatedSetting();
	return stored ? { enabled: stored.enabled, revision: stored.revision } : { ...OFF };
}

/** Requests and operator toggles share this lock, so a pending request is never retroactively granted. */
export async function withAutoHeadDownSetting<T>(
	action: (setting: AutoHeadDownSetting & { auditId?: number }) => Promise<T>,
): Promise<T> {
	return locked(`${path()}.lock`, async () => {
		const stored = await validatedSetting();
		return action(
			stored
				? { enabled: stored.enabled, revision: stored.revision, auditId: stored.auditId }
				: { ...OFF },
		);
	});
}

export async function saveAutoHeadDownSetting(enabled: boolean): Promise<AutoHeadDownSetting> {
	operatorOnly();
	if (typeof enabled !== 'boolean') throw new Error('Invalid auto head-down setting.');
	return locked(`${path()}.lock`, async () => {
		const prior = await validatedSetting();
		const latest = await latestSettingAudit();
		const previous = prior?.enabled ?? false;
		if (previous === enabled) return prior ? { enabled, revision: prior.revision } : { ...OFF };
		const next = {
			enabled,
			previous,
			revision: (latest?.setting.revision ?? 0) + 1,
			changedAt: new Date().toISOString(),
		};
		const event = await communicationSend('send the Room post', () =>
			appendLocalEvent({
				sender: { kind: 'user', id: 'operator' },
				text: settingText(next),
				replyTo: null,
				source: 'local',
			}),
		);
		await atomicWrite(path(), JSON.stringify({ ...next, auditId: event.id }));
		return { enabled, revision: next.revision };
	});
}

interface GrantDetails {
	goal: string;
	completion: string;
	nonce: string;
	revision: number;
}

export function autoGrantText(name: string, grant: GrantDetails): string {
	return (
		`${name}: head-down auto-approved by operator setting revision ${grant.revision}. ` +
		`Goal: ${grant.goal}. Completion: ${grant.completion}. Launch: ${grant.nonce}. ` +
		'Return to Normal on completion, blocked work, cancellation, or a human decision.'
	);
}

export async function appendAutoGrant(name: string, grant: GrantDetails): Promise<LocalEvent> {
	return communicationSend('send the Room post', () =>
		appendLocalEvent({
			sender: { kind: 'agent', id: name },
			text: autoGrantText(name, grant),
			replyTo: null,
			source: 'local',
		}),
	);
}

export async function validAutoGrant(name: string, state: HeadDownState): Promise<boolean> {
	const grant = state.autoApproval;
	if (!grant?.revision || state.approvedBy !== 'operator-setting') return false;
	try {
		const settingEvent = await roomEvent(grant.settingAuditId);
		const setting = settingEvent && settingAudit(settingEvent);
		const settingMatch =
			setting?.revision === grant.revision && !setting.previous && setting.enabled;
		const event = await roomEvent(grant.grantEventId);
		return (
			settingMatch &&
			grant.settingAuditId < grant.grantEventId &&
			event?.sender.kind === 'agent' &&
			event.sender.id === name &&
			event.source === 'local' &&
			event.text ===
				autoGrantText(name, {
					goal: state.goal,
					completion: state.completion,
					nonce: state.nonce,
					revision: grant.revision,
				}) &&
			state.questionId === event.id
		);
	} catch {
		return false;
	}
}
