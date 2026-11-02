import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type { MaintenanceHost } from './maintenance-update.ts';

import { atomicWrite, optionalText } from './mail-files.ts';
import { plainMaintenancePath, requireMaintenanceOffline } from './maintenance-offline.ts';
import { installedBuildSchema, maintenanceStateSchema } from './maintenance-update.ts';
import { sameRoot } from './path-identity.ts';
import { requireCompatibleTeamLayout } from './storage-layout.ts';

export const maintenanceConfigSchema = z
	.object({
		version: z.literal(1),
		repo: z.string().min(1),
		home: z.string().min(1),
		link: z.string().min(1),
	})
	.strict();
const buildSchema = z.object({
	revision: z.string().regex(/^[a-f0-9]{7,40}$/),
	version: z.string().min(1),
	buildId: z.string().regex(/^[a-f0-9]{10}$/),
});

export async function maintenanceHost(directory: string, logs: string): Promise<MaintenanceHost> {
	await plainMaintenancePath(directory);
	const config = maintenanceConfigSchema.parse(
		JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')) as unknown,
	);
	const git = Bun.which('git');
	if (!git) throw new Error('Git is required.');
	let step = 0;
	async function capture(args: string[]): Promise<string> {
		const child = Bun.spawn([git as string, '-C', config.repo, ...args], {
			stdout: 'pipe',
			stderr: 'pipe',
			windowsHide: true,
		});
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw new Error(`Git refused ${args[0]}: ${err.trim()}`);
		return out.trim();
	}
	async function run(program: string, args: string[], label: string): Promise<void> {
		const file = join(logs, `${++step}-${label}.log`);
		const sink = Bun.file(file).writer();
		console.log(`Starting ${label}; full output: ${file}`);
		const child = Bun.spawn([program, ...args], {
			cwd: config.repo,
			stdout: 'pipe',
			stderr: 'pipe',
			stdin: 'ignore',
			windowsHide: true,
		});
		async function copy(stream: ReadableStream<Uint8Array>): Promise<void> {
			for await (const chunk of stream) {
				await sink.write(chunk);
				process.stdout.write(chunk);
			}
		}
		try {
			await Promise.all([copy(child.stdout), copy(child.stderr)]);
			if ((await child.exited) !== 0)
				throw new Error(`${label} failed; remain offline and retain ${file}`);
		} finally {
			await sink.end();
		}
	}
	async function clean(): Promise<void> {
		await plainMaintenancePath(config.repo);
		await plainMaintenancePath(join(config.repo, 'node_modules'));
		await plainMaintenancePath(join(config.repo, 'dist'));
		// Identities, not spellings: Git reports the checkout's real path and the configured path may
		// be an 8.3 short alias of it. The plainMaintenancePath walks above still refuse any link, and a
		// configured checkout whose real path is on another root (a subst or mapped drive) is refused.
		// The installed link may live on any volume; only its target is checked, against the checkout.
		const checkout = await realpath(config.repo);
		if (!sameRoot(config.repo, checkout))
			throw new Error(
				'Checkout root or clean boundary differs; no reset or stash is performed.',
			);
		const same = (path: string): boolean =>
			process.platform === 'win32'
				? path.toLowerCase() === checkout.toLowerCase()
				: path === checkout;
		if (
			!same(await realpath(await capture(['rev-parse', '--show-toplevel']))) ||
			(await capture(['status', '--porcelain', '--untracked-files=all']))
		)
			throw new Error(
				'Checkout root or clean boundary differs; no reset or stash is performed.',
			);
		if (!same(await realpath(config.link)))
			throw new Error('The installed Summon CLI link does not target this checkout.');
	}
	await mkdir(logs, { recursive: true });
	return {
		readState: async () => {
			await plainMaintenancePath(join(directory, 'state.json'));
			const raw = await optionalText(join(directory, 'state.json'));
			return raw === undefined
				? undefined
				: maintenanceStateSchema.parse(JSON.parse(raw) as unknown);
		},
		writeState: async (state) => {
			await atomicWrite(join(directory, 'state.json'), JSON.stringify(state));
		},
		installed: async () => {
			const path = join(config.repo, 'dist/team/build.json');
			await plainMaintenancePath(path);
			const build = buildSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
			return installedBuildSchema.parse({
				commit: await capture(['rev-parse', '--verify', `${build.revision}^{commit}`]),
				version: build.version,
				buildId: build.buildId,
			});
		},
		main: () => capture(['rev-parse', '--verify', 'refs/heads/main^{commit}']),
		preflight: async () => {
			await clean();
			const branch = await capture(['rev-parse', '--abbrev-ref', 'HEAD']);
			if (!['HEAD', 'main'].includes(branch))
				throw new Error('Updater requires main or its detached rollback checkout.');
		},
		offline: () => requireMaintenanceOffline(config.home),
		compatible: async (pin) => {
			const target = z
				.object({ summonStorageLayout: z.number().int().positive().optional() })
				.parse(JSON.parse(await capture(['show', `${pin}:package.json`])) as unknown);
			await requireCompatibleTeamLayout(config.home, target.summonStorageLayout);
		},
		checkout: async (pin, rollback) => {
			await run(git, rollback ? ['switch', '--detach', pin] : ['switch', 'main'], 'checkout');
		},
		assertCheckout: async (pin, main, rollback) => {
			await clean();
			if (
				(await capture(['rev-parse', 'HEAD'])) !== pin ||
				(await capture(['rev-parse', 'refs/heads/main'])) !== main ||
				(await capture(['rev-parse', '--abbrev-ref', 'HEAD'])) !==
					(rollback ? 'HEAD' : 'main')
			)
				throw new Error('Selected commit or main branch changed; remain offline.');
		},
		install: async () => {
			z.object({ packageManager: z.literal(`bun@${Bun.version}`) }).parse(
				JSON.parse(await readFile(join(config.repo, 'package.json'), 'utf8')) as unknown,
			);
			await run(
				process.execPath,
				['install', '--frozen-lockfile', '--ignore-scripts'],
				'install',
			);
			await run(process.execPath, ['scripts/install-electron.ts'], 'electron');
		},
		build: () => run(process.execPath, ['run', 'build:team'], 'build'),
		gate: () => run(process.execPath, ['run', 'smoke:qc'], 'qc'),
	};
}
