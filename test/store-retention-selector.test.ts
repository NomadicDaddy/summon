import { expect, test } from 'bun:test';

import { type RetentionProof, selectRetentionRow } from '../src/store-retention-selector.ts';

const hash = 'a'.repeat(64);
const successorHash = 'b'.repeat(64);
const base = {
	path: 'fixture/artifact',
	owner: 'fixture-owner',
	identity: 'fixture-id',
	sha256: hash,
	bytes: 10,
	generationBefore: hash,
	generationAfter: hash,
	references: [],
	canonical: true,
	insideOwnerRoot: true,
	plainFile: true,
	singleLink: true,
	noOpenHandle: true,
	writerQuiescent: true,
	referenceGraphComplete: true,
};

const proofs: RetentionProof[] = [
	{
		...base,
		family: 'schedule-run',
		runId: 'fixture-id',
		stateBeforeHash: hash,
		stateAfterHash: successorHash,
		terminal: true,
		latestTerminal: false,
		successorDurable: true,
		exactIdOperationsSettled: true,
	},
	{
		...base,
		family: 'mail',
		archived: true,
		handlingProjected: true,
		senderStatusProjected: true,
		linkedReferencesClosed: true,
		recoveryScanComplete: true,
	},
	{
		...base,
		family: 'wake',
		resolved: true,
		latest: false,
		unresolvedIndexed: false,
		retryPending: false,
		citationsComplete: true,
	},
	{
		...base,
		family: 'room-image',
		hashNameMatches: true,
		appendCommitted: true,
		checkpointCommitted: true,
		historyGapFree: true,
	},
	{
		...base,
		family: 'compaction',
		superseded: true,
		successorDurable: true,
		checkpointDurable: true,
		historyExposes: false,
		recoveryScanComplete: true,
	},
];

function proofAt(index: number): RetentionProof {
	const proof = proofs[index];
	if (!proof) throw new Error('Fixture family changed.');
	return proof;
}

test('each family requires its terminal and reference proof before candidate status', () => {
	for (const proof of proofs) {
		expect(selectRetentionRow(proof).status).toBe('CANDIDATE');
		const active: RetentionProof =
			proof.family === 'schedule-run'
				? { ...proof, latestTerminal: true }
				: proof.family === 'mail'
					? { ...proof, handlingProjected: false }
					: proof.family === 'wake'
						? { ...proof, unresolvedIndexed: true }
						: proof.family === 'room-image'
							? { ...proof, checkpointCommitted: false }
							: { ...proof, historyExposes: true };
		expect(selectRetentionRow(active).status).toBe('KEEP');
	}
});

test('unknown ownership, link, open handle, incomplete graph and changed generation fail closed', () => {
	const proof = proofAt(0);
	for (const unsafe of [
		{ ...proof, owner: null },
		{ ...proof, path: '' },
		{ ...proof, sha256: 'not-a-hash' },
		{ ...proof, bytes: -1 },
		{ ...proof, insideOwnerRoot: false },
		{ ...proof, singleLink: false },
		{ ...proof, noOpenHandle: false },
		{ ...proof, writerQuiescent: false },
		{ ...proof, referenceGraphComplete: false },
		{ ...proof, generationAfter: successorHash },
		{ ...proof, references: ['live-reader'] },
		{ ...proof, stateAfterHash: hash },
	])
		expect(selectRetentionRow(unsafe).status).toBe('KEEP');
});

test('broken pointer and incomplete recovery proof keep wake and mail', () => {
	const wake = proofAt(2);
	const mail = proofAt(1);
	if (wake.family !== 'wake' || mail.family !== 'mail')
		throw new Error('Fixture family changed.');
	expect(selectRetentionRow({ ...wake, citationsComplete: false }).status).toBe('KEEP');
	expect(selectRetentionRow({ ...mail, recoveryScanComplete: false }).status).toBe('KEEP');
});
