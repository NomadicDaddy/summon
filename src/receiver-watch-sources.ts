import { dirname, join } from 'node:path';

import { localRoomPath } from './local-room.ts';
import { optionalText } from './mail-files.ts';
import { runtimePath } from './mail-session.ts';
import { mailboxPath } from './mailbox.ts';
import { storageRoot } from './store.ts';
import { telegramConfig } from './telegram-api.ts';
import { roomRoot } from './telegram-room.ts';

export interface ReceiverWatchSource {
	directory: string;
	accept: (file: string | null) => boolean;
}

/** Only durable input files may trigger a cycle; the receiver's own status writes are excluded. */
export async function receiverWatchSources(name: string): Promise<ReceiverWatchSource[]> {
	const root = storageRoot();
	const mailbox = mailboxPath(name);
	const sources: ReceiverWatchSource[] = [
		{ directory: join(mailbox, 'inbox'), accept: (file) => !file || file.endsWith('.md') },
		{ directory: join(mailbox, 'holds'), accept: (file) => !file || file.endsWith('.json') },
		{ directory: dirname(localRoomPath()), accept: (file) => !file || file.endsWith('.json') },
		{ directory: join(root, 'attention'), accept: (file) => !file || file.endsWith('.ref') },
		{
			directory: runtimePath(name),
			accept: (file) =>
				!file ||
				file.endsWith('.ready') ||
				file.endsWith('.cursor') ||
				file.endsWith('.claude-turn') ||
				file.endsWith('.grok-turn') ||
				file.endsWith('.kilo-turn') ||
				file === 'activity.json' ||
				file === 'wake-delivery-unresolved.json' ||
				file === 'head-down.json',
		},
		{
			directory: join(root, 'communications'),
			accept: (file) => !file || file === 'state.json',
		},
		{
			directory: join(root, 'runtime', 'team-window'),
			accept: (file) => !file || file === 'operator-view.json',
		},
		{ directory: join(root, 'settings'), accept: (file) => !file || file === 'room-wake.json' },
		{ directory: root, accept: (file) => !file || file === `${name}.json` },
	];
	if (await optionalText(join(root, 'integrations', 'telegram.json'))) {
		try {
			const config = await telegramConfig();
			sources.push({
				directory: roomRoot(config),
				accept: (file) => !file || file === 'events.json',
			});
		} catch {
			// The coordinator reports the invalid integration; local watches still start.
		}
	}
	return sources;
}
