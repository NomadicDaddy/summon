export interface ProcessOwner {
	pid: number;
	nonce: string;
	childPid?: number;
}

export function parseOwner(text: string): ProcessOwner | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (!value || typeof value !== 'object') return undefined;
		const owner = value as Record<string, unknown>;
		if (
			!Number.isSafeInteger(owner.pid) ||
			Number(owner.pid) <= 0 ||
			typeof owner.nonce !== 'string' ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				owner.nonce,
			) ||
			(owner.childPid !== undefined &&
				(!Number.isSafeInteger(owner.childPid) || Number(owner.childPid) <= 0))
		)
			return undefined;
		return value as ProcessOwner;
	} catch {
		return undefined;
	}
}

export function processAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
	}
}
