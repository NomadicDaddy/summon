import { catchUpCommand } from './checkpoint-skip-command.ts';
import { checkpointText } from './checkpoint-text.ts';
import { checkpoint, checkpointManifest } from './checkpoint.ts';

export async function checkpointCommand(args: string[]): Promise<void> {
	const work = args.includes('--work');
	if (args.filter((arg) => arg === '--work').length > 1)
		throw new Error('Specify --work only once.');
	if (work) args = args.filter((arg) => arg !== '--work');
	let text = false;
	if (args.at(-2) === '--format' && args.at(-1) === 'text') {
		text = true;
		args = args.slice(0, -2);
	}
	if (args[0] === 'catch-up') {
		if (work) throw new Error('--work is not a catch-up option.');
		const result = await catchUpCommand(args.slice(1));
		console.log(
			text
				? `CHECKPOINT CATCH-UP (skipped is not read)\n${JSON.stringify(result)}`
				: JSON.stringify(result),
		);
		return;
	}
	if (args.length > (args[0] === 'manifest' ? 2 : 1) || args.includes('--format'))
		throw new Error(
			'Usage: summon --checkpoint [receipt] [--work] [--format text] | manifest [cursor] [--format text]',
		);
	if (work && args[0] === 'manifest') throw new Error('--work is not a manifest option.');
	const result =
		args[0] === 'manifest'
			? await checkpointManifest(args[1])
			: await checkpoint(args[0], work);
	console.log(text ? checkpointText(result, true) : JSON.stringify(result));
}
