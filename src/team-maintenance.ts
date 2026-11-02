import { createHash } from 'node:crypto';
import { lstat, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { AgentRecord } from './store.ts';
import type { TeamProfile } from './team-maintenance-profile.ts';

import {
	applyClaudeConfig,
	claudeConfigDirectory,
	directoryKey,
	selectedClaudeConfig,
} from './claude-config.ts';
import { validKiloOptions } from './kilo-config.ts';
import {
	applyModelSettings,
	assertKiloSettingsCurrent,
	kiloSettingsRevision,
} from './kilo-settings-revision.ts';
import { checkFormKiloVariant } from './kilo-variant-check.ts';
import { atomicWrite, locked, missing, optionalText } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { runtimePath } from './mail-session.ts';
import { assertNotesLimit } from './notes-limit.ts';
import { applyFormText, profileTextRevision, validFormRevision } from './profile-text.ts';
import { acquireSessionLock } from './session-lock.ts';
import {
	isProvider,
	latestSession,
	loadAgent,
	newRecord,
	notesPath,
	rememberSession,
	saveAgent,
	sessionIdPattern,
	slugFor,
	storageRoot,
	updateAgentRecord,
} from './store.ts';

export type { TeamProfile } from './team-maintenance-profile.ts';

const notesRevision = (text: string): string => createHash('sha256').update(text).digest('hex');

export async function profileFor(name: string): Promise<TeamProfile> {
	operatorOnly();
	const slug = slugFor(name);
	const record = await loadAgent(slug);
	if (!record) throw new Error('Agent no longer exists.');
	const notes = await readFile(join(storageRoot(), `${slug}.md`), 'utf8').catch(
		(error: unknown) => {
			if (missing(error)) return '';
			throw error;
		},
	);
	return {
		memberType: record.memberType ?? 'teammate',
		displayName: record.displayName ?? record.name,
		canStopResting: record.canStopResting ?? false,
		name: record.name,
		provider: record.provider,
		...(record.claudeConfigDir ? { claudeConfigDir: record.claudeConfigDir } : {}),
		...(record.model ? { model: record.model } : {}),
		...(record.variant ? { variant: record.variant } : {}),
		...(record.lmStudioUrl ? { lmStudioUrl: record.lmStudioUrl } : {}),
		cwd: record.cwd,
		expertise: record.expertise,
		domain: record.domain ?? '',
		backup: record.backup ?? '',
		notes,
		notesRevision: notesRevision(notes),
		profileRevision: profileTextRevision(record),
		kiloSettingsRevision: kiloSettingsRevision(record),
		sessionId: latestSession(record)?.id ?? '',
	};
}

export async function saveProfile(
	value: unknown,
	existing: string | null,
	report?: (note: string) => void,
): Promise<string> {
	operatorOnly();
	if (!value || typeof value !== 'object') throw new Error('Invalid teammate profile.');
	const record = value as Record<string, unknown>;
	for (const key of [
		'name',
		'provider',
		'cwd',
		'expertise',
		'domain',
		'backup',
		'notes',
		'sessionId',
	])
		if (typeof record[key] !== 'string') throw new Error(`Invalid ${key}.`);
	const input = value as TeamProfile;
	if (
		input.displayName !== undefined &&
		(typeof input.displayName !== 'string' ||
			!input.displayName.trim() ||
			input.displayName.trim().length > 64)
	)
		throw new Error('Display name must contain 1 to 64 characters.');
	if (input.memberType !== undefined && !['teammate', 'pm'].includes(input.memberType))
		throw new Error('Invalid member type.');
	if (input.canStopResting !== undefined && typeof input.canStopResting !== 'boolean')
		throw new Error('Invalid rest-stop permission.');
	if (
		existing === null
			? input.notesRevision !== null
			: typeof input.notesRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.notesRevision)
	)
		throw new Error('Invalid notes revision; reload this profile.');
	if (!validFormRevision(input.profileRevision, existing === null))
		throw new Error('Invalid profile text revision; reload this profile.');
	for (const key of ['model', 'variant', 'lmStudioUrl'])
		if (record[key] !== undefined && typeof record[key] !== 'string')
			throw new Error(`Invalid ${key}.`);
	const slug = slugFor(input.name);
	if (!isProvider(input.provider)) throw new Error('Choose a supported CLI.');
	const provider = input.provider;
	const claudeConfigDir = await selectedClaudeConfig(provider, input.claudeConfigDir);
	if (!validKiloOptions(input.provider, input.model || undefined, input.lmStudioUrl || undefined))
		throw new Error(
			'Model options require Kilo; LM Studio URL requires an lmstudio/model and an HTTP(S) URL without credentials.',
		);
	await checkFormKiloVariant(input, existing, report);
	if (!isAbsolute(input.cwd) || !(await stat(input.cwd).catch(() => null))?.isDirectory())
		throw new Error('Working directory must be an existing absolute directory.');
	assertNotesLimit(input.notes);
	if (input.expertise.length > 8000 || input.domain.length > 8000)
		throw new Error('Profile text is too long.');
	if (input.sessionId && !sessionIdPattern.test(input.sessionId))
		throw new Error('Session ID must be a plain provider identifier, not a path or command.');
	// A coverer is only cover if the name resolves to somebody. Resolve it to the registered
	// spelling rather than trusting what was typed, so the stored name is always one that loads.
	const coverer = input.backup.trim();
	let backupName = '';
	if (coverer) {
		const covererSlug = slugFor(coverer);
		if (covererSlug === slug) throw new Error('A teammate cannot cover itself.');
		const registered = await loadAgent(covererSlug).catch(() => undefined);
		if (!registered) throw new Error('Only another registered teammate can cover this one.');
		let matchesFile = false;
		try {
			matchesFile = slugFor(registered.name) === covererSlug;
		} catch {
			// Existing malformed records remain readable, but cannot create broken cover links.
		}
		if (!matchesFile)
			throw new Error(
				`Cover record ${covererSlug}.json has a name that does not match its file name; correct it before assigning cover.`,
			);
		// Cover exists to survive a provider outage, so a coverer on the same CLI is no cover at
		// all: the one failure most likely to take a teammate out takes the coverer with it.
		if (registered.provider === input.provider)
			throw new Error(
				`Whoever covers this one must run a different CLI. ${registered.name} also runs ${input.provider}, so one provider outage would take both.`,
			);
		backupName = registered.name;
	}
	if (existing !== null && slugFor(existing) !== slug)
		throw new Error('Registered names cannot be renamed.');
	for (const extension of ['json', 'md']) {
		const info = await lstat(join(storageRoot(), `${slug}.${extension}`)).catch(
			(error: unknown) => {
				if (missing(error)) return undefined;
				throw error;
			},
		);
		if (info?.isSymbolicLink()) throw new Error('Refusing redirected profile storage.');
	}
	// A live session writes exactly one field of its own record: the session list, through
	// rememberSession and forgetSession. Everything else here — cwd, model, expertise, domain,
	// backup and the notes file — is read when a session launches and never written by it, so
	// refusing those edits while a teammate runs bought nothing and cost the operator a restart.
	// Binding changes take the session lock. Existing fields merge under updateAgentRecord's
	// record write lock, shared with session writers; profile.lock serializes form saves only.
	const bound = await loadAgent(slug).catch(() => undefined);
	const changesProvider = !!bound && bound.provider !== provider;
	const changesClaudeConfig =
		!!bound &&
		provider === 'claude' &&
		directoryKey(claudeConfigDirectory(bound)) !==
			directoryKey(
				claudeConfigDirectory({
					...(claudeConfigDir ? { claudeConfigDir } : {}),
				}),
			);
	if (changesClaudeConfig && input.sessionId)
		throw new Error(
			'Clear the session ID when switching Claude accounts. Each account keeps its own saved conversations.',
		);
	const changesBinding =
		changesProvider ||
		changesClaudeConfig ||
		input.sessionId !== (bound ? (latestSession(bound)?.id ?? '') : '');
	// An add always holds the name's lock: a session left running under a reused name refuses it
	// before registration seeds that name's cursors.
	const needsLock = changesBinding || existing === null;
	const lock = needsLock ? await acquireSessionLock(slug) : undefined;
	if (needsLock && !lock)
		throw new Error(
			existing === null
				? `A session is still running under the name ${slug}; stop it before registering the name again.`
				: 'Stop this teammate before changing its session ID or Claude account.',
		);
	try {
		return await locked(join(runtimePath(slug), 'profile.lock'), () =>
			locked(`${notesPath(slug)}.lock`, async () => {
				const unchangedNotes = input.notesRevision === notesRevision(input.notes);
				if (
					!unchangedNotes &&
					existing !== null &&
					notesRevision((await optionalText(notesPath(slug))) ?? '') !==
						input.notesRevision
				)
					throw new Error(
						'Notes changed while this form was open. Your text is still here; copy your edits, then reload.',
					);
				const previous = await loadAgent(slug);
				if (existing === null && previous) throw new Error('That teammate already exists.');
				if (existing !== null && !previous) throw new Error('Agent no longer exists.');
				if (
					previous &&
					(previous.memberType ?? 'teammate') !== (input.memberType ?? 'teammate')
				)
					throw new Error('Existing member type cannot be changed.');
				if (
					previous &&
					previous.provider !== input.provider &&
					previous.memberType !== 'pm'
				)
					throw new Error(
						'An existing teammate keeps its registered CLI. Create another name to change CLI.',
					);
				const edit = (profile: AgentRecord): void => {
					assertKiloSettingsCurrent(profile, input, existing === null);
					if (
						bound &&
						provider === 'claude' &&
						directoryKey(claudeConfigDirectory(profile)) !==
							directoryKey(claudeConfigDirectory(bound))
					)
						throw new Error(
							'Claude account changed while this form was open. Reload the profile.',
						);
					if (profile.provider !== provider && profile.memberType !== 'pm')
						throw new Error('Agent registration changed.');
					if (profile.provider !== provider) {
						profile.sessions = [];
						delete profile.modelInfo;
					}
					applyClaudeConfig(profile, claudeConfigDir);
					profile.provider = provider;
					profile.memberType = input.memberType ?? 'teammate';
					if (profile.memberType === 'pm')
						profile.displayName = input.displayName?.trim() || profile.name;
					profile.canStopResting = input.canStopResting ?? false;
					profile.cwd = input.cwd;
					applyModelSettings(profile, input);
					applyFormText(profile, input, existing === null);
					if (backupName) profile.backup = backupName;
					else delete profile.backup;
					if (changesBinding || existing === null) {
						if (input.sessionId && !changesProvider)
							rememberSession(profile, input.sessionId);
						else if (!changesClaudeConfig && latestSession(profile))
							throw new Error(
								'Keep the saved session ID or supply another known ID.',
							);
					}
				};
				if (existing !== null) await updateAgentRecord(slug, edit);
				else {
					const profile = newRecord(input.name.trim(), input.cwd, provider);
					edit(profile);
					await saveAgent(slug, profile, true);
				}
				if (!unchangedNotes) await atomicWrite(notesPath(slug), input.notes);
				return slug;
			}),
		);
	} finally {
		await lock?.release();
	}
}
