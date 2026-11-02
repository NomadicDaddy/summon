import { createInterface } from 'node:readline';

import { pairingCoverage, providerExposure } from './pairing-coverage.ts';
import { listAgentSlugs, loadAgent, slugFor } from './store.ts';

export async function listAgents(): Promise<void> {
	const entries = await listAgentSlugs();
	let count = 0;
	const claiming: { name: string; provider: string; coveredBy?: string }[] = [];
	for (const slug of entries) {
		try {
			const record = await loadAgent(slug);
			if (!record) continue;
			let matchesFile = false;
			try {
				matchesFile = slugFor(record.name) === slug;
			} catch {
				// Report invalid names alongside the readable record without rejecting old data.
			}
			if (!matchesFile) {
				console.error(
					`${slug}.json stores name ${JSON.stringify(record.name)}, which does not match its file name.`,
				);
				process.exitCode = 1;
			}
			console.log(`${record.name}\t${record.provider}\t${record.cwd}`);
			if (record.domain) console.log(`  Domain: ${record.domain}`);
			// Printed for anything that claims a domain, including when nothing covers it: an
			// uncovered domain is the resource gap the pairing exists to make visible, and silence
			// would read as though the question had never been asked.
			if (record.domain) {
				console.log(`  Covered by: ${record.backup ?? 'nobody recorded'}`);
				claiming.push({
					name: record.name,
					provider: record.provider,
					...(record.backup ? { coveredBy: record.backup } : {}),
				});
			}
			count += 1;
		} catch (error: unknown) {
			console.error(
				`Cannot list ${slug}.json: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exitCode = 1;
		}
	}
	// Cover is one-way, so the shape of the whole graph says things no single row can: which domain
	// is the end of a chain, and who is carrying more than one. Reading every row is not the same as
	// being told, and a reader who has to derive it will not.
	if (claiming.length > 0) {
		const { uncovered, overSubscribed, entries: graph } = pairingCoverage(claiming);
		console.log(`\nCover: ${claiming.length - uncovered.length} of ${claiming.length} domains`);
		if (uncovered.length > 0) console.log(`  Uncovered: ${uncovered.join(', ')}`);
		for (const entry of graph.filter((candidate) => candidate.covers.length > 0))
			console.log(`  ${entry.name} covers: ${entry.covers.join(', ')}`);
		if (overSubscribed.length > 0)
			console.log(`  Carrying more than one domain: ${overSubscribed.join(', ')}`);
		// The terminal had none of this. "Cover: 3 of 10" reads as progress and says nothing about
		// two of the three resting on one provider, which is the failure a single outage produces.
		const [worst] = providerExposure(claiming);
		if (worst) {
			console.log(
				`  Worst single outage: if ${worst.provider} is out, ${String(worst.unattended.length)} of ${String(claiming.length)} domains have nobody holding them (${worst.unattended.join(', ')})`,
			);
			if (worst.despiteCover.length > 0)
				console.log(
					`  Covered but on the failed provider, which saveProfile refuses: ${worst.despiteCover.join(', ')}`,
				);
		}
	}
	if (count === 0) console.log('No registered agents found.');
}

export async function confirmRegistration(name: string): Promise<boolean> {
	console.log(`No agent named "${name}" exists. Create a new agent? [y/N] (Enter to quit)`);
	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
	try {
		for await (const line of input) {
			return /^(y|yes)$/i.test(line.trim());
		}
		return false;
	} finally {
		input.close();
	}
}
