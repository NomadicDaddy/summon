/** A proof is produced by a guarded store reader, never inferred from an artifact's age. */
interface FileProof {
	path: string;
	owner: string | null;
	identity: string | null;
	sha256: string | null;
	bytes: number | null;
	generationBefore: string | null;
	generationAfter: string | null;
	references: string[];
	canonical: boolean;
	insideOwnerRoot: boolean;
	plainFile: boolean;
	singleLink: boolean;
	noOpenHandle: boolean;
	writerQuiescent: boolean;
	referenceGraphComplete: boolean;
}

export type RetentionProof =
	| (FileProof & {
			family: 'schedule-run';
			runId: string;
			stateBeforeHash: string | null;
			stateAfterHash: string | null;
			terminal: boolean;
			latestTerminal: boolean;
			successorDurable: boolean;
			exactIdOperationsSettled: boolean;
	  })
	| (FileProof & {
			family: 'mail';
			archived: boolean;
			handlingProjected: boolean;
			senderStatusProjected: boolean;
			linkedReferencesClosed: boolean;
			recoveryScanComplete: boolean;
	  })
	| (FileProof & {
			family: 'wake';
			resolved: boolean;
			latest: boolean;
			unresolvedIndexed: boolean;
			retryPending: boolean;
			citationsComplete: boolean;
	  })
	| (FileProof & {
			family: 'room-image';
			hashNameMatches: boolean;
			appendCommitted: boolean;
			checkpointCommitted: boolean;
			historyGapFree: boolean;
	  })
	| (FileProof & {
			family: 'compaction';
			superseded: boolean;
			successorDurable: boolean;
			checkpointDurable: boolean;
			historyExposes: boolean;
			recoveryScanComplete: boolean;
	  });

export interface RetentionRow {
	family: RetentionProof['family'];
	path: string;
	owner: string | null;
	identity: string | null;
	sha256: string | null;
	bytes: number | null;
	generation: string | null;
	references: string[];
	status: 'KEEP' | 'CANDIDATE';
	reason: string;
	runId?: string;
	stateBeforeHash?: string | null;
	stateAfterHash?: string | null;
}

function keepReason(proof: RetentionProof): string | null {
	if (!proof.owner?.trim()) return 'owner-unproved';
	if (!proof.path.trim()) return 'path-unproved';
	if (!proof.canonical || !proof.insideOwnerRoot) return 'path-unproved';
	if (!proof.plainFile || !proof.singleLink) return 'linked-or-nonplain-file';
	if (
		!proof.identity?.trim() ||
		!proof.sha256?.match(/^[a-f0-9]{64}$/) ||
		proof.bytes === null ||
		!Number.isSafeInteger(proof.bytes) ||
		proof.bytes < 0
	)
		return 'identity-unproved';
	if (!proof.noOpenHandle) return 'open-handle-unproved';
	if (!proof.writerQuiescent) return 'writer-not-quiescent';
	if (!proof.generationBefore || proof.generationBefore !== proof.generationAfter)
		return 'generation-changed-or-missing';
	if (!proof.referenceGraphComplete) return 'reference-graph-incomplete';
	if (proof.references.length) return 'referenced';
	switch (proof.family) {
		case 'schedule-run':
			if (!proof.terminal || proof.latestTerminal) return 'schedule-run-current-or-open';
			if (!proof.successorDurable || !proof.exactIdOperationsSettled)
				return 'schedule-duty-unsettled';
			if (
				!proof.runId ||
				!proof.stateBeforeHash ||
				!proof.stateAfterHash ||
				proof.stateBeforeHash !== proof.generationBefore ||
				proof.stateBeforeHash === proof.stateAfterHash
			)
				return 'schedule-state-proof-incomplete';
			return null;
		case 'mail':
			if (!proof.archived || !proof.handlingProjected || !proof.senderStatusProjected)
				return 'mail-handling-unsettled';
			if (!proof.linkedReferencesClosed || !proof.recoveryScanComplete)
				return 'mail-recovery-unsettled';
			return null;
		case 'wake':
			if (!proof.resolved || proof.latest || proof.unresolvedIndexed || proof.retryPending)
				return 'wake-delivery-active';
			if (!proof.citationsComplete) return 'wake-citations-incomplete';
			return null;
		case 'room-image':
			if (!proof.hashNameMatches || !proof.appendCommitted || !proof.checkpointCommitted)
				return 'room-image-write-unsettled';
			if (!proof.historyGapFree) return 'room-history-incomplete';
			return null;
		case 'compaction':
			if (!proof.superseded || !proof.successorDurable || !proof.checkpointDurable)
				return 'compaction-successor-unsettled';
			if (proof.historyExposes || !proof.recoveryScanComplete)
				return 'compaction-reader-or-recovery';
			return null;
	}
}

/** This classifies supplied evidence only; a live collector must establish every claim. */
export function selectRetentionRow(proof: RetentionProof): RetentionRow {
	const reason = keepReason(proof);
	return {
		family: proof.family,
		path: proof.path,
		owner: proof.owner,
		identity: proof.identity,
		sha256: proof.sha256,
		bytes: proof.bytes,
		generation: proof.generationAfter,
		references: proof.references,
		status: reason === null ? 'CANDIDATE' : 'KEEP',
		reason: reason ?? 'all-required-proofs-present',
		...(proof.family === 'schedule-run'
			? {
					runId: proof.runId,
					stateBeforeHash: proof.stateBeforeHash,
					stateAfterHash: proof.stateAfterHash,
				}
			: {}),
	};
}
