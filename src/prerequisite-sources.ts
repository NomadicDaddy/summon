import { type RuntimePrerequisiteId, runtimeVersionStatus } from './runtime-prerequisites.ts';

export interface PrerequisiteFallback {
	version: string;
	url: string;
	sha256: string;
	executable: string;
}

export interface PrerequisiteSource {
	name: string;
	winget: string;
	wingetScope: 'user' | 'machine';
	wingetInstallerType?: 'wix';
	fallback: PrerequisiteFallback;
}

export type PrerequisiteSources = Record<RuntimePrerequisiteId, PrerequisiteSource>;

// The one release asset per prerequisite the installer may download: the publisher's official
// Windows x64 ZIP for exactly the pinned version. Nothing else, however it normalizes, is accepted.
const officialReleases: Record<RuntimePrerequisiteId, (version: string) => string> = {
	bun: (version) =>
		`https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-windows-x64.zip`,
	pwsh: (version) =>
		`https://github.com/PowerShell/PowerShell/releases/download/v${version}/PowerShell-${version}-win-x64.zip`,
};

const wingetPackages: Record<RuntimePrerequisiteId, string> = {
	bun: 'Oven-sh.Bun',
	pwsh: 'Microsoft.PowerShell',
};

/** Validate the pinned fallback manifest; never fetch versions or hashes at build time. */
export function validatePrerequisiteSources(value: unknown): PrerequisiteSources {
	if (!value || typeof value !== 'object')
		throw new Error('Prerequisite sources must be an object.');
	const record = value as Record<string, unknown>;
	const ids = Object.keys(officialReleases) as RuntimePrerequisiteId[];
	if (Object.keys(record).sort().join(',') !== [...ids].sort().join(','))
		throw new Error('Prerequisite sources must list exactly bun and pwsh.');
	for (const id of ids) {
		const source = record[id] as Partial<PrerequisiteSource> | undefined;
		const fallback = source?.fallback as Partial<PrerequisiteFallback> | undefined;
		if (!source || !fallback) throw new Error(`${id}: missing source or fallback.`);
		if (source.winget !== wingetPackages[id])
			throw new Error(`${id}: unexpected winget package.`);
		if (source.wingetScope !== (id === 'bun' ? 'user' : 'machine'))
			throw new Error(`${id}: unexpected winget scope.`);
		if (
			(id === 'pwsh' && source.wingetInstallerType !== 'wix') ||
			(id === 'bun' && source.wingetInstallerType !== undefined)
		)
			throw new Error(`${id}: unexpected winget installer type.`);
		const version = fallback.version ?? '';
		// Held to x.y.z: it is also passed to the installer compiler and built into a link.
		if (!/^\d+\.\d+\.\d+$/.test(version))
			throw new Error(`${id}: fallback version must be x.y.z.`);
		if (runtimeVersionStatus(id, version).status !== 'available')
			throw new Error(`${id}: fallback ${version} does not meet the minimum version.`);
		const url = fallback.url ?? '';
		// Exact equality, and the parsed form must equal the raw text: no dot segments, credentials,
		// query, fragment or encoding can point the download anywhere else (Morgan r1 Medium 6).
		let parsed: string;
		try {
			parsed = new URL(url).href;
		} catch {
			throw new Error(`${id}: fallback URL is not a valid URL.`);
		}
		if (url !== officialReleases[id](version) || parsed !== url)
			throw new Error(`${id}: fallback URL is not the official ${version} Windows x64 ZIP.`);
		if (!/^[a-f0-9]{64}$/.test(fallback.sha256 ?? ''))
			throw new Error(`${id}: fallback SHA256 must be 64 lowercase hex characters.`);
		const executable = fallback.executable ?? '';
		if (!/^[\w./-]+\.exe$/.test(executable) || executable.includes('..'))
			throw new Error(`${id}: fallback executable must be a relative .exe path.`);
	}
	return record as unknown as PrerequisiteSources;
}
