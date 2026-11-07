import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { initializeActivity } from '../src/agent-activity.ts';
import { readAutoHeadDownSetting } from '../src/auto-head-down.ts';
import { automaticNoticeSuppressed } from '../src/automatic-notice.ts';
import { setCommunicationPause } from '../src/communication-state.ts';
import {
	headDownActive,
	headDownPath,
	readHeadDown,
	saveHeadDown,
	sessionHeartbeat,
} from '../src/head-down-model.ts';
import { deliverHeadDownResponse } from '../src/head-down-response.ts';
import { setHibernation } from '../src/hibernation.ts';
import { localEvents, localRoomPath } from '../src/local-room.ts';
import { atomicWrite, optionalText } from '../src/mail-files.ts';
import { saveOperatorView } from '../src/operator-view.ts';
import { answerRoom } from '../src/room-question-access.ts';
import { readTeamSettings, saveTeamSettings } from '../src/team-settings.ts';
import { mailHarness } from './fixtures/mail-harness.ts';

let fixture: Awaited<ReturnType<typeof mailHarness>>;
const previousRoot = process.env.SUMMON_HOME;
const settingPath = () => join(fixture.records, 'runtime/team-window/auto-head-down.json');

beforeEach(async () => {
	fixture = await mailHarness();
	process.env.SUMMON_HOME = fixture.records;
	await initializeActivity('alpha', 'test-launch');
	await sessionHeartbeat('alpha', 'test-launch');
});
afterEach(async () => {
	if (previousRoot === undefined) delete process.env.SUMMON_HOME;
	else process.env.SUMMON_HOME = previousRoot;
	await fixture.dispose();
});

async function request() {
	const result = await fixture.run(
		['--head-down', 'request', 'Bounded goal', 'The gate passes', '--return-to-normal'],
		'alpha',
	);
	return { result, state: await readHeadDown('alpha') };
}

test('off by default; only the operator can switch it on, with a Room audit', async () => {
	expect(await readAutoHeadDownSetting()).toEqual({ enabled: false, revision: 0 });
	const manual = await request();
	expect(manual.result.code).toBe(0);
	expect(manual.state?.phase).toBe('requested');
	expect(await headDownActive('alpha')).toBe(false);
	process.env.SUMMON_AGENT = 'alpha';
	let refused = false;
	try {
		await saveTeamSettings({ autoHeadDown: true });
	} catch {
		refused = true;
	} finally {
		delete process.env.SUMMON_AGENT;
	}
	expect(refused).toBe(true);
	expect(await optionalText(settingPath())).toBeUndefined();
	const enabled = await saveTeamSettings({ autoHeadDown: true });
	expect(enabled.autoHeadDown).toBe(true);
	expect(enabled.autoHeadDownRevision).toBe(1);
	expect((await localEvents()).at(-1)?.text).toContain('off -> on by operator');
	expect((await readHeadDown('alpha'))?.phase).toBe('requested');
	if (!manual.state) throw new Error('Missing manual request');
	await answerRoom(manual.state.questionId, 1);
	const auto = await request();
	expect(auto.result.code).toBe(0);
	expect(JSON.parse(auto.result.out) as { phase: string }).toHaveProperty('phase', 'active');
	expect(auto.state?.phase).toBe('active');
	expect(auto.state?.approvedBy).toBe('operator-setting');
	expect(auto.state?.autoApproval?.revision).toBe(1);
	expect(await headDownActive('alpha')).toBe(true);
	expect((await localEvents()).at(-1)?.text).toContain('head-down auto-approved');
	const sent: string[] = [];
	expect(
		await deliverHeadDownResponse(
			'alpha',
			'test-launch',
			(text) => {
				sent.push(text);
				return Promise.resolve();
			},
			() => Promise.resolve(true),
		),
	).toBe(false);
	expect(sent).toHaveLength(0);
	const onRecord = await optionalText(settingPath());
	if (!onRecord) throw new Error('Missing enabled setting');
	await saveTeamSettings({ autoHeadDown: false });
	expect((await readAutoHeadDownSetting()).enabled).toBe(false);
	expect(await headDownActive('alpha')).toBe(true);
	await atomicWrite(settingPath(), onRecord);
	expect(await readAutoHeadDownSetting()).toEqual({ enabled: false, revision: 0 });
	expect((await saveTeamSettings({ autoHeadDown: true })).autoHeadDownRevision).toBe(3);
});

test('toggle and request serialize: no pending request is promoted by a later enable', async () => {
	const [first, setting] = await Promise.all([
		request(),
		saveTeamSettings({ autoHeadDown: true }),
	]);
	expect(first.result.code).toBe(0);
	expect(setting.autoHeadDown).toBe(true);
	const events = await localEvents();
	const auditId = events.find((event) => event.text.includes('off -> on by operator'))?.id;
	if (auditId === undefined) throw new Error('Missing setting audit');
	if (first.state?.phase === 'requested') {
		expect(first.state.questionId).toBeLessThan(auditId);
		expect(await headDownActive('alpha')).toBe(false);
	} else {
		expect(first.state?.phase).toBe('active');
		expect(first.state?.autoApproval?.settingAuditId).toBe(auditId);
		expect(first.state?.questionId).toBeGreaterThan(auditId);
	}
});

test('a failed or corrupted setting audit never enables auto approval', async () => {
	await atomicWrite(localRoomPath(), '{bad json');
	let refused = false;
	try {
		await saveTeamSettings({ autoHeadDown: true });
	} catch {
		refused = true;
	}
	expect(refused).toBe(true);
	expect(await optionalText(settingPath())).toBeUndefined();
	await atomicWrite(localRoomPath(), '[]');
	await saveTeamSettings({ autoHeadDown: true });
	const raw = await optionalText(settingPath());
	if (!raw) throw new Error('Missing saved setting');
	const stored = JSON.parse(raw) as Record<string, unknown>;
	await atomicWrite(settingPath(), JSON.stringify({ ...stored, auditId: 999999 }));
	expect(await readAutoHeadDownSetting()).toEqual({ enabled: false, revision: 0 });
	await atomicWrite(settingPath(), JSON.stringify({ ...stored, unexpected: true }));
	expect(await readAutoHeadDownSetting()).toEqual({ enabled: false, revision: 0 });
	const manual = await request();
	expect(manual.result.code).toBe(0);
	expect(manual.state?.phase).toBe('requested');
});

test('invalid grant audit and stale launch recover to Normal and expose notices', async () => {
	await saveTeamSettings({ autoHeadDown: true });
	const first = await request();
	if (!first.state?.autoApproval) throw new Error('Missing auto grant');
	await saveHeadDown('alpha', {
		...first.state,
		questionId: 999999,
		autoApproval: { ...first.state.autoApproval, grantEventId: 999999 },
	});
	expect(await headDownActive('alpha')).toBe(false);
	expect((await readHeadDown('alpha'))?.phase).toBe('ended');
	expect((await localEvents()).at(-1)?.text).toContain('grant recovered');
	const second = await request();
	expect(second.state?.phase).toBe('active');
	await initializeActivity('alpha', 'next-launch');
	expect(await headDownActive('alpha')).toBe(false);
	expect((await readHeadDown('alpha'))?.phase).toBe('ended');
});

test('an active auto grant with no revision recovers and exposes queued notices', async () => {
	await saveTeamSettings({ autoHeadDown: true });
	const active = await request();
	if (!active.state?.autoApproval) throw new Error('Missing auto grant');
	const incompleteGrant = {
		settingAuditId: active.state.autoApproval.settingAuditId,
		grantEventId: active.state.autoApproval.grantEventId,
	};
	await atomicWrite(
		headDownPath('alpha'),
		JSON.stringify({ ...active.state, autoApproval: incompleteGrant }),
	);
	expect(await automaticNoticeSuppressed('alpha')).toBe(false);
	expect((await readHeadDown('alpha'))?.phase).toBe('ended');
	expect((await localEvents()).at(-1)?.text).toContain('grant recovered');
});

test('malformed head-down bytes fail off, preserve evidence, and audit recovery', async () => {
	await saveTeamSettings({ autoHeadDown: true });
	const active = await request();
	expect(active.state?.phase).toBe('active');
	await atomicWrite(headDownPath('alpha'), '{bad json');
	expect(await automaticNoticeSuppressed('alpha')).toBe(false);
	expect(await readHeadDown('alpha')).toBeUndefined();
	expect((await localEvents()).at(-1)?.text).toContain('invalid head-down record ignored');
	const marker = await optionalText(
		join(fixture.records, 'runtime/alpha/head-down-invalid-recovery.json'),
	);
	expect(marker).toContain('"reported":true');
});

test('malformed state keeps recovery queued while the Room is unavailable', async () => {
	await saveTeamSettings({ autoHeadDown: true });
	await request();
	const room = await optionalText(localRoomPath());
	if (!room) throw new Error('Missing Room history');
	await atomicWrite(headDownPath('alpha'), '{bad json');
	await atomicWrite(localRoomPath(), '{bad json');
	expect(await automaticNoticeSuppressed('alpha')).toBe(false);
	const markerPath = join(fixture.records, 'runtime/alpha/head-down-invalid-recovery.json');
	expect(await optionalText(markerPath)).toContain('"reported":false');
	await atomicWrite(localRoomPath(), room);
	expect(await automaticNoticeSuppressed('alpha')).toBe(false);
	expect(await optionalText(markerPath)).toContain('"reported":true');
	expect((await localEvents()).at(-1)?.text).toContain('invalid head-down record ignored');
});

test('malformed-state recovery respects a communication halt', async () => {
	await saveTeamSettings({ autoHeadDown: true });
	await request();
	await atomicWrite(headDownPath('alpha'), '{bad json');
	await setCommunicationPause(true);
	expect(await readHeadDown('alpha')).toBeUndefined();
	const markerPath = join(fixture.records, 'runtime/alpha/head-down-invalid-recovery.json');
	expect(await optionalText(markerPath)).toContain('"reported":false');
	await setCommunicationPause(false);
	expect(await automaticNoticeSuppressed('alpha')).toBe(false);
	expect(await optionalText(markerPath)).toContain('"reported":true');
});

test('Room failure ends an invalid grant and records recovery when the Room returns', async () => {
	await saveTeamSettings({ autoHeadDown: true });
	const active = await request();
	expect(active.state?.phase).toBe('active');
	const room = await optionalText(localRoomPath());
	if (!room) throw new Error('Missing Room history');
	await atomicWrite(localRoomPath(), '{bad json');
	expect(await headDownActive('alpha')).toBe(false);
	expect((await readHeadDown('alpha'))?.recoveryPending).toBe(true);
	expect((await readHeadDown('alpha'))?.phase).toBe('ended');
	await atomicWrite(localRoomPath(), room);
	expect(await headDownActive('alpha')).toBe(false);
	expect((await readHeadDown('alpha'))?.recoveryPending).toBe(false);
	expect((await localEvents()).at(-1)?.text).toContain('grant recovered');
});

test('halt and hibernation prevent an automatic grant', async () => {
	await saveTeamSettings({ autoHeadDown: true });
	const uncommitted = await fixture.run(
		['--head-down', 'request', 'Bounded goal', 'The gate passes'],
		'alpha',
	);
	expect(uncommitted.code).toBe(1);
	expect(await readHeadDown('alpha')).toBeUndefined();
	await setCommunicationPause(true);
	const halted = await request();
	expect(halted.result.code).toBe(1);
	expect(halted.state).toBeUndefined();
	await setCommunicationPause(false);
	await setHibernation('alpha', true);
	const sleeping = await request();
	expect(sleeping.result.code).toBe(1);
	expect(sleeping.state).toBeUndefined();
	await setHibernation('alpha', false);
	await saveOperatorView('alpha');
	const paused = await request();
	expect(paused.result.code).toBe(1);
	expect(paused.state).toBeUndefined();
	expect((await readTeamSettings()).autoHeadDown).toBe(true);
});
