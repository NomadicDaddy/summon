import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export async function runtimeFaultFixture(work: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'summon-runtime-faults-'));
	if (!resolve(root).startsWith(join(resolve(tmpdir()), 'summon-runtime-faults-')))
		throw new Error('Fixture root escaped its declared temporary directory.');
	const previous = process.env.SUMMON_HOME;
	process.env.SUMMON_HOME = root;
	try {
		await work(root);
	} finally {
		if (previous === undefined) delete process.env.SUMMON_HOME;
		else process.env.SUMMON_HOME = previous;
		await rm(root, { recursive: true, force: true });
	}
}

export async function runtimeFaultRejection(work: Promise<unknown>): Promise<Error> {
	try {
		await work;
	} catch (error: unknown) {
		if (error instanceof Error) return error;
		throw new Error('Refusal was not an Error.', { cause: error });
	}
	throw new Error('Expected the operation to refuse.');
}
