import { repositoryGit } from './repository-git.ts';

/** One NUL-delimited status snapshot supplies branch, tracking counts and changed paths. */
export async function repositoryStatus(path: string) {
	const records = (
		await repositoryGit(path, [
			'status',
			'--porcelain=v2',
			'--branch',
			'-z',
			'--untracked-files=all',
		])
	).split('\0');
	let branch = '';
	let changed = 0;
	let ahead: number | null = null;
	let behind: number | null = null;
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;
		if (record.startsWith('# branch.head ')) {
			branch = record.slice('# branch.head '.length);
			if (branch === '(detached)') branch = 'detached';
		} else if (record.startsWith('# branch.ab ')) {
			const match = /^# branch.ab \+(\d+) -(\d+)$/.exec(record);
			if (!match) throw new Error('Invalid Git tracking counts.');
			ahead = Number(match[1]);
			behind = Number(match[2]);
			if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind))
				throw new Error('Invalid Git tracking counts.');
		} else if (/^[12u?] /.test(record)) {
			changed++;
			// Rename/copy source paths are a second record, even when they resemble headers.
			if (record.startsWith('2 ')) index++;
		} else if (!record.startsWith('# ') && !record.startsWith('! ')) {
			throw new Error('Invalid Git status record.');
		}
	}
	if (!branch) throw new Error('Missing Git branch status.');
	return { branch, changed, ahead, behind };
}
