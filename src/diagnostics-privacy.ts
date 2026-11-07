import { runtimePrerequisites, type RuntimePrerequisiteStatus } from './runtime-prerequisites.ts';

export const DIAGNOSTIC_REDACTIONS = [
	'message bodies and work-card contents',
	'credentials, tokens and provider account identifiers',
	'private paths and file contents',
	'peer mailbox and runtime details',
	'home directory replaced by ~ or omitted with unsafe detail',
] as const;

/** Only fixed, application-owned reasons may be copied; arbitrary text can be a message body. */
const safeReasons = new Set([
	'Not found on PATH',
	'Unsafe version-check path',
	'Version check failed or timed out',
	'Version not reported',
	'No live adapter attached.',
	'Receiver process exited; mail remains queued.',
	'Launch readiness acknowledged. Retained receiver status does not confirm delivery health.',
	'Awaiting explicit launch readiness acknowledgment via summon --mail ready. Notices may already be arriving.',
	'An owned running member could not be observed; launch status is incomplete.',
	'Public launch snapshot is stale or its clock is unverifiable.',
	'Owning window process identity is unavailable or no longer matches.',
	'Public launch snapshot expired during identity verification.',
	'Public launch snapshot is missing, unreadable or invalid.',
	'Own presence row is absent.',
]);

export function diagnosticReason(value: unknown): string {
	return typeof value === 'string' && safeReasons.has(value)
		? value
		: 'Details omitted for privacy.';
}

/** Preserve only the probe's bounded version shape; never copy arbitrary command output. */
export function diagnosticRuntimeDetail(
	id: RuntimePrerequisiteStatus['id'],
	status: RuntimePrerequisiteStatus['status'],
	detail: string,
): string {
	if (status !== 'available' && status !== 'outdated') return diagnosticReason(detail);
	const prerequisite = runtimePrerequisites.find((item) => item.id === id);
	const match =
		/^(Bun|PowerShell) (\d{1,9}\.\d{1,9}\.\d{1,9}) \(requires (\d{1,9}\.\d{1,9}\.\d{1,9}) or later\)$/.exec(
			detail,
		);
	if (
		!prerequisite ||
		!match ||
		match[1] !== prerequisite.name ||
		match[3] !== prerequisite.minimumVersion ||
		!match[2]
	)
		return diagnosticReason(detail);
	return `${prerequisite.name} ${match[2]} (requires ${prerequisite.minimumVersion} or later)`;
}

export function diagnosticError(error: unknown): string {
	return diagnosticReason(error instanceof Error ? error.message : error);
}
