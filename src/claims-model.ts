import { createHash } from 'node:crypto';

export type ClaimState =
	'NOT-CONTRADICTED' | 'DISPUTED' | 'WEAK' | 'UNVERIFIABLE' | 'NEVER-CHECKED';
export interface Claim {
	id: string;
	text: string;
	check: unknown[];
	duty?: boolean;
}
export interface ClaimResult {
	id: string;
	text: string;
	state: ClaimState;
	reason: string;
	checkedAt?: string;
}
export interface ClaimsReport {
	owner: string;
	identity: string;
	checkedAt: string;
	sourceHash: string;
	meaning: string;
	results: ClaimResult[];
	notification?: { id: string; claims: string[] };
}
export const claimHash = (text: string): string => createHash('sha256').update(text).digest('hex');
export const CLAIM_MEANING =
	'NOT-CONTRADICTED means only the declared predicate matched under the recorded identity. It does not assess completeness, usefulness, or performance of a duty; artifact dates prove recency only.';

export function parseClaims(text: string): Claim[] {
	if (Buffer.byteLength(text) > 16000)
		throw new Error('Published claims must be at most 16000 bytes.');
	const claims: Claim[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim() || line.startsWith('#')) continue;
		const match = /^- (FACT|DIRECTIVE|DUTY) (.+?) \| (verify|source): (.+)$/.exec(line);
		if (!match || (match[1] !== 'DIRECTIVE') !== (match[3] === 'verify'))
			throw new Error(
				'Invalid claim line. Use - FACT text | verify: ["check", "arg"] or - DIRECTIVE text | source: [id, "quote"].',
			);
		const args: unknown = JSON.parse(match[4] ?? '');
		if (!Array.isArray(args) || args.length > 4)
			throw new Error('Claim arguments must be a bounded JSON array.');
		const values: unknown[] = args;
		claims.push({
			id: claimHash(line).slice(0, 16),
			text: match[2] ?? '',
			check: match[1] === 'DIRECTIVE' ? ['room-message-says', ...values] : values,
			duty: match[1] === 'DUTY',
		});
	}
	if (claims.length > 40) throw new Error('Publish at most forty claims.');
	return claims;
}

export function currentResults(
	claims: Claim[],
	report: ClaimsReport | undefined,
	hash: string,
	now = Date.now(),
): ClaimResult[] {
	const fresh =
		report?.sourceHash === hash &&
		Number.isFinite(Date.parse(report.checkedAt)) &&
		now - Date.parse(report.checkedAt) >= 0 &&
		now - Date.parse(report.checkedAt) < 14 * 86400000;
	return claims.map((claim) => {
		const result = fresh ? report.results.find((item) => item.id === claim.id) : undefined;
		return (
			result ?? {
				id: claim.id,
				text: claim.text,
				state: 'NEVER-CHECKED',
				reason: 'No current check for this published version (reports expire after fourteen days).',
			}
		);
	});
}
