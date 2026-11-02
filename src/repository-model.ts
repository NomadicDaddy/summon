export interface RepositoryMember {
	slug: string;
	name: string;
	cwd: string;
}
export interface RepositoryFile {
	path: string;
	staged: string;
	unstaged: string;
}
export interface RepositoryCommit {
	id: string;
	short: string;
	at: string;
	subject: string;
}
export interface RepositorySummary {
	id: string;
	name: string;
	path: string;
	branch: string;
	changed: number;
	ahead: number | null;
	behind: number | null;
	checkedAt: string;
	fetchRecordedAt: string | null;
	members: { slug: string; name: string }[];
	error?: string;
}
export interface RepositoryList {
	repositories: RepositorySummary[];
	warnings: string[];
}
export interface RepositoryDetail {
	files: RepositoryFile[];
	commits: RepositoryCommit[];
	checkedAt: string;
}
export type RepositoryDiff =
	{ kind: 'staged' | 'unstaged' | 'untracked'; path: string } | { kind: 'commit'; id: string };
