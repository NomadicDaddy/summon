/** One name's place in the cover graph, as the roster and the CLI both need it. */
export interface CoverageEntry {
	name: string;
	/** The name recorded as covering this one, or '' when nothing does. */
	coveredBy: string;
	/** The names this one is recorded as covering, in roster order. */
	covers: string[];
}

export interface Coverage {
	entries: CoverageEntry[];
	/** Names that claim a domain and have nobody recorded to cover it. */
	uncovered: string[];
	/** Names carrying cover for more than one domain, which is legal and worth seeing. */
	overSubscribed: string[];
}

/**
 * Derive who covers whom from the records that claim a domain.
 *
 * Cover is a directed graph rather than a set of pairs: assignments are one-way and need not pair up,
 * so a chain is legal and its last link is uncovered, a ring covers everyone, and two names may both
 * point at a third. All of that is permitted deliberately, and none of it is visible from a single
 * record — you cannot tell from your own row that you are the end of a chain. This computes the part
 * that only exists across the whole roster.
 *
 * Reports rather than refuses. Every shape here is one the operator may have chosen on purpose, so
 * the gap is something to be told about, not something to be prevented.
 * @param records Each name that claims a domain, with whoever is recorded as covering it.
 * @returns The per-name view plus the two facts no single record carries.
 */
export function pairingCoverage(
	records: readonly { name: string; coveredBy?: string }[],
): Coverage {
	const entries: CoverageEntry[] = records.map((record) => ({
		name: record.name,
		coveredBy: record.coveredBy?.trim() ?? '',
		covers: [],
	}));
	const byName = new Map(entries.map((entry) => [entry.name, entry]));
	for (const entry of entries) {
		// A coverer naming somebody outside this roster still counts as cover for the entry that
		// claims it; it simply cannot be credited to anyone here.
		if (entry.coveredBy) byName.get(entry.coveredBy)?.covers.push(entry.name);
	}
	return {
		entries,
		uncovered: entries.filter((entry) => !entry.coveredBy).map((entry) => entry.name),
		overSubscribed: entries
			.filter((entry) => entry.covers.length > 1)
			.map((entry) => entry.name),
	};
}

/** What one provider going out costs, per provider. */
export interface ProviderExposure {
	provider: string;
	/** Domains whose owner runs this provider and whom nobody still running covers. */
	unattended: string[];
	/**
	 * Of those, the ones that DO have a coverer and are unattended anyway, because that coverer
	 * runs the failed provider too. Empty while saveProfile's cross-provider rule holds, so a name
	 * appearing here is a record that bypassed it - hand-edited, or written before the rule.
	 */
	despiteCover: string[];
}

/**
 * What a single provider outage actually costs: the domains left with nobody holding them.
 *
 * The quantity this does NOT report is the one that reads more naturally and is almost useless:
 * how many cover edges run through the failed provider. Losing your coverer while you are still up
 * costs nothing, because cover is for when the owner is down. Worse, the cross-provider rule makes
 * that count STRUCTURALLY INCAPABLE of naming an affected name: a coverer on the failed provider
 * implies the owner is not on it, so every name such a line prints is working. Measured against the
 * live roster it named Jack and Morgan for a claude outage - both up - and omitted Alice, Carl and
 * Jimmy, who would have nobody. Corrected by Dave in #1507.
 *
 * While the cross-provider rule holds, `unattended` is the uncovered set regrouped by provider -
 * verified identical on the live roster - so the fact worth a reader's attention is the SHAPE:
 * which single outage costs the most domains. `despiteCover` is the part no other line can show,
 * and it should always be empty.
 * @param records Each name that claims a domain, with its provider and whoever covers it.
 * @returns One entry per provider that leaves somebody unattended, worst first.
 */
export function providerExposure(
	records: readonly { name: string; provider: string; coveredBy?: string }[],
): ProviderExposure[] {
	const providerOf = new Map(records.map((record) => [record.name, record.provider]));
	const exposures: ProviderExposure[] = [];
	for (const provider of new Set(records.map((record) => record.provider))) {
		const down = records.filter((record) => record.provider === provider);
		// A coverer outside the roster has no known provider, so it cannot be shown to survive the
		// outage. Treated as not surviving, because claiming cover we cannot establish is the failure
		// this module exists to avoid.
		const unattended = down.filter((record) => {
			const coveredBy = record.coveredBy?.trim();
			return !coveredBy || (providerOf.get(coveredBy) ?? provider) === provider;
		});
		if (unattended.length === 0) continue;
		exposures.push({
			provider,
			unattended: unattended.map((record) => record.name),
			despiteCover: unattended
				.filter((record) => (record.coveredBy ?? '').trim() !== '')
				.map((record) => record.name),
		});
	}
	return exposures.sort((a, b) => b.unattended.length - a.unattended.length);
}
