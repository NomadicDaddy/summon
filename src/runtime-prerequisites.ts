export type RuntimePrerequisiteId = 'bun' | 'pwsh';

export interface RuntimePrerequisite {
	id: RuntimePrerequisiteId;
	name: string;
	minimumVersion: string;
	installUrl: string;
}

export interface RuntimePrerequisiteStatus {
	id: RuntimePrerequisiteId;
	status: 'available' | 'missing' | 'outdated' | 'unavailable';
	detail: string;
}

// Official installation guides verified 2026-10-26. Summon never runs their installers.
export const runtimePrerequisites: RuntimePrerequisite[] = [
	{
		id: 'bun',
		name: 'Bun',
		minimumVersion: '1.4.3',
		installUrl: 'https://bun.com/docs/installation',
	},
	{
		id: 'pwsh',
		name: 'PowerShell',
		minimumVersion: '7.6.0',
		installUrl:
			'https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows',
	},
];

export function runtimeVersionStatus(
	id: RuntimePrerequisiteId,
	output: string,
): RuntimePrerequisiteStatus {
	const requirement = runtimePrerequisites.find((item) => item.id === id);
	if (!requirement) throw new Error('Unknown runtime prerequisite.');
	const version = output.trim().match(/^(?:PowerShell )?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/);
	if (!version)
		return { id, status: 'unavailable', detail: 'Stable version could not be verified' };
	const actual = version.slice(1).map(Number);
	const minimum = requirement.minimumVersion.split('.').map(Number);
	const difference = actual.findIndex((part, index) => part !== minimum[index]);
	const supported = difference === -1 || (actual[difference] ?? 0) > (minimum[difference] ?? 0);
	return {
		id,
		status: supported ? 'available' : 'outdated',
		detail: `${requirement.name} ${actual.join('.')} (requires ${requirement.minimumVersion} or later)`,
	};
}
