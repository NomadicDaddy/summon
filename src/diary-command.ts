import { addDiary, readDiary } from './diary.ts';

export async function diaryCommand(args: string[]): Promise<void> {
	if (args[0] === 'list' && args.length <= 2) {
		console.log(JSON.stringify(await readDiary(args[1])));
		return;
	}
	if (args[0] === 'add' && args.length === 2 && args[1] !== undefined) {
		console.log(JSON.stringify(await addDiary(JSON.parse(args[1]) as unknown)));
		return;
	}
	throw new Error('Usage: summon --diary list [before-entry-id] | add <json>');
}
