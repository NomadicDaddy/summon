import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { checkClaim } from './claims-checks.ts';
import {
	CLAIM_MEANING,
	claimHash,
	type ClaimsReport,
	currentResults,
	parseClaims,
} from './claims-model.ts';
import { communicationState } from './communication-state.ts';
import { atomicWrite, locked } from './mail-files.ts';
import { currentAgent, ownMailbox } from './mail-identity.ts';
import { sendMessage } from './mailbox.ts';
import { redirectedComponent } from './path-identity.ts';
import { loadAgent, slugFor, storageRoot } from './store.ts';

const sourcePath = (name: string): string => join(storageRoot(), 'claims', `${slugFor(name)}.md`);
const reportPath = (name: string): string =>
	join(storageRoot(), 'claims', `${slugFor(name)}.report.json`);

async function safeText(path: string, limit: number): Promise<string | undefined> {
	try {
		const info = await lstat(path);
		// Every component of the path, the claims directory and the store's ancestors included, is
		// checked for a link, and its drive for a redirection. A spelling alias (an 8.3 short name) is
		// neither and is accepted.
		if (
			!info.isFile() ||
			info.isSymbolicLink() ||
			info.size > limit ||
			(await redirectedComponent(dirname(path)))
		)
			throw new Error('Invalid published claims artifact.');
		return await readFile(path, 'utf8');
	} catch (error: unknown) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
		throw error;
	}
}

async function savedReport(name: string): Promise<ClaimsReport | undefined> {
	const text = await safeText(reportPath(name), 64000);
	if (!text) return undefined;
	const schema = z.object({
		owner: z.literal(name),
		identity: z.string(),
		checkedAt: z.iso.datetime(),
		sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
		meaning: z.string(),
		results: z
			.array(
				z.object({
					id: z.string().regex(/^[a-f0-9]{16}$/),
					text: z.string(),
					state: z.enum([
						'NOT-CONTRADICTED',
						'DISPUTED',
						'WEAK',
						'UNVERIFIABLE',
						'NEVER-CHECKED',
					]),
					reason: z.string(),
					checkedAt: z.iso.datetime().optional(),
				}),
			)
			.max(40),
		notification: z
			.object({ id: z.uuid(), claims: z.array(z.string().regex(/^[a-f0-9]{16}$/)).max(40) })
			.optional(),
	});
	const parsed = schema.safeParse(JSON.parse(text));
	if (!parsed.success) throw new Error('Invalid published report.');
	return parsed.data as ClaimsReport;
}

async function notifyDisputes(report: ClaimsReport): Promise<void> {
	if (!report.notification || (await communicationState()).paused) return;
	await sendMessage(
		report.owner,
		report.owner,
		`Published claim checks disputed: ${report.notification.claims.join(', ')}. Review your claims report; only you edit your memory.`,
		{ kind: 'reply', id: report.notification.id },
	);
	delete report.notification;
	await atomicWrite(reportPath(report.owner), JSON.stringify(report));
}

async function claimsReport(name: string) {
	name = slugFor(name);
	const source = (await safeText(sourcePath(name), 16000)) ?? '';
	const claims = parseClaims(source);
	const report = await savedReport(name);
	return {
		owner: name,
		meaning: CLAIM_MEANING,
		identity: report?.identity ?? 'Not checked',
		results: currentResults(claims, report, claimHash(source)),
	};
}

export async function verifyClaims(name: string, daily = false): Promise<ClaimsReport | undefined> {
	name = slugFor(name);
	ownMailbox(name);
	return locked(`${reportPath(name)}.lock`, async () => {
		const record = await loadAgent(name);
		if (!record) throw new Error('Claims require a registered owner.');
		const source = await safeText(sourcePath(name), 16000);
		if (!source) return undefined;
		const claims = parseClaims(source);
		const old = await savedReport(name);
		if (old) await notifyDisputes(old);
		const hash = claimHash(source);
		if (
			daily &&
			old?.sourceHash === hash &&
			Date.now() - Date.parse(old.checkedAt) >= 0 &&
			Date.now() - Date.parse(old.checkedAt) < 86400000
		)
			return undefined;
		const report: ClaimsReport = {
			owner: name,
			identity: userInfo().username,
			checkedAt: new Date().toISOString(),
			sourceHash: hash,
			meaning: CLAIM_MEANING,
			results: [],
		};
		for (const claim of claims) report.results.push(await checkClaim(claim, record.cwd));
		const disputed = report.results.filter((result) => result.state === 'DISPUTED');
		if (disputed.length) {
			const changed = disputed.filter(
				(result) =>
					!old?.results.some(
						(prior) => prior.id === result.id && prior.state === 'DISPUTED',
					),
			);
			const pending = [
				...new Set([...(old?.notification?.claims ?? []), ...changed.map((r) => r.id)]),
			];
			if (pending.length)
				report.notification = {
					id: old?.notification?.id ?? randomUUID(),
					claims: pending,
				};
		}
		await atomicWrite(reportPath(name), JSON.stringify(report));
		await notifyDisputes(report);
		return report;
	});
}

export async function dailyClaims(name: string): Promise<void> {
	try {
		await verifyClaims(name, true);
	} catch {
		console.error(
			'Published claims check unavailable; delivery continues. Run --verify-claims to diagnose.',
		);
	}
}

export async function claimsCommand(args: string[], reportOnly = false): Promise<void> {
	if (args.length > 1) throw new Error('Expected at most one claims owner.');
	const name = slugFor(args[0] ?? currentAgent());
	if (reportOnly) console.log(JSON.stringify(await claimsReport(name)));
	else
		console.log(
			JSON.stringify(
				(await verifyClaims(name)) ?? {
					owner: name,
					results: [],
					meaning: 'No published claims.',
				},
			),
		);
}
