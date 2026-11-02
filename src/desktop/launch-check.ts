import { stat } from 'node:fs/promises';

import type { Provider } from '../store.ts';

import { resolveExecutable } from '../executable.ts';
import { loadAgent } from '../store.ts';
import { providerLabels } from './provider-labels.ts';

export async function installedProviders(path = process.env.PATH ?? ''): Promise<Provider[]> {
	const providers = Object.keys(providerLabels) as Provider[];
	const found = await Promise.all(providers.map((provider) => executableOnPath(provider, path)));
	return providers.filter((_provider, index) => found[index]);
}

export function executableOnPath(command: string, path = process.env.PATH ?? ''): Promise<boolean> {
	return Promise.resolve(
		resolveExecutable(command, { ...process.env, PATH: path }) !== undefined,
	);
}

export async function checkLaunch(slug: string): Promise<void> {
	const agent = await loadAgent(slug);
	if (!agent) throw new Error('Teammate no longer exists.');
	try {
		if (!(await stat(agent.cwd)).isDirectory()) throw new Error('Not a directory');
	} catch {
		throw new Error(
			`The working folder for ${agent.name} is unavailable. Choose an existing folder in Maintenance before starting them.`,
		);
	}
	if (!(await executableOnPath(agent.provider)))
		throw new Error(
			`${agent.provider} was not found on your PATH. Open CLI setup in Maintenance for installation and account guidance. Install the CLI, complete its setup, reopen Summon to refresh PATH, then start ${agent.name} again.`,
		);
}
