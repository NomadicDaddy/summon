import { ackLocalRoom, localAgent, readLocalRoom, sendLocal } from './local-room-access.ts';
import { messageBodyArgs } from './message-body-file.ts';
import { roomCursor } from './room-cursor.ts';
import { askRoom } from './room-question-access.ts';
import { sendRoomReply, telegramCommand } from './telegram.ts';

const usage =
	'Usage: summon --room read [cursor] | ack <cursor> | send [--to-user] <text> | reply [--to-user] <id> <text>';
export async function localRoomCommand(args: string[]): Promise<void> {
	await localAgent();
	if (args[0] === 'send' || args[0] === 'reply')
		args = await messageBodyArgs(
			args,
			(args[0] === 'reply' ? 2 : 1) + (args[1] === '--to-user' ? 1 : 0),
		);
	const [command, value, text] = args;
	if (command === 'ask') {
		console.log(JSON.stringify(await askRoom(args.slice(1))));
	} else if (
		command === 'send' &&
		value === '--to-user' &&
		text !== undefined &&
		args.length === 3
	) {
		await telegramCommand(['send', '--to-user', text]);
	} else if (command === 'reply' && value === '--to-user' && args.length === 4) {
		await sendRoomReply(roomCursor(text ?? ''), args[3] ?? '');
	} else if (command === 'read' && args.length <= 2) {
		console.log(JSON.stringify(await readLocalRoom(value)));
	} else if (command === 'ack' && value !== undefined && args.length === 2) {
		const cursor = await ackLocalRoom(value);
		console.log(`Local room read through ${cursor}; not proof of completed work.`);
	} else if (command === 'send' && value !== undefined && args.length === 2) {
		console.log(JSON.stringify(await sendLocal(value)));
	} else if (
		command === 'reply' &&
		value !== undefined &&
		text !== undefined &&
		args.length === 3
	) {
		console.log(JSON.stringify(await sendLocal(text, roomCursor(value))));
	} else if ((command === 'reply' || command === 'send') && args.length > 3) {
		// Naming the likely cause, because the usage line alone sent someone looking in the wrong
		// place for an hour. PowerShell accepts the curly quotes U+2018/U+2019 and U+201C/U+201D as
		// string delimiters, so a body written in ordinary prose - don't, I'm, anything with an
		// apostrophe an editor smartened - closes its own quoting early and arrives as several
		// arguments. The command then looks malformed rather than misquoted, and the shell is never
		// suspected. On 2026-09-27 a session read the resulting exit 1 as success and reported a
		// reply it had not sent.
		throw new Error(
			`Expected one text argument after ${command}; got ${String(args.length - (command === 'reply' ? 2 : 1))}. Your shell split it: in PowerShell a curly quote (’ or ”) inside a quoted string ends that string. Pass the body from a file instead of inline.`,
		);
	} else throw new Error(usage);
}
