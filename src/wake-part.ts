export type WakeSource = 'readiness' | 'mail' | 'holds' | 'room' | 'telegram';
export type WakeMark = 'attempted' | 'queued' | 'failed' | 'deferred';

/** Queueing transports recheck the selected source and receiver at their input boundary. */
export type WakeSend = (text: string, revalidate?: () => Promise<boolean>) => Promise<void>;

/** Source bounds identify a notice; they never acknowledge a message or grant authority. */
export interface WakeTarget {
	source: WakeSource;
	key: string;
	through: number;
	ids: string[];
}

export interface WakePart {
	target: WakeTarget;
	text: string;
	needed: () => Promise<boolean>;
	acknowledged: () => Promise<boolean>;
	mark: (state: WakeMark) => Promise<void>;
}
