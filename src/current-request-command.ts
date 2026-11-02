import { checkpointText } from './checkpoint-text.ts';
import { currentRequests } from './current-requests.ts';

export async function currentRequestCommand(args: string[]): Promise<void> {
	let text = false;
	if (args.at(-2) === '--format' && args.at(-1) === 'text') {
		text = true;
		args = args.slice(0, -2);
	}
	if (args.length > 1 || args.some((arg) => arg.startsWith('--')))
		throw new Error('Usage: summon --current-requests [cursor] [--format text]');
	const result = await currentRequests(args[0]);
	console.log(
		text
			? checkpointText(result)
					.replace(/^CHECKPOINT VIEW\n/, 'CURRENT REQUESTS (READ ONLY)\n')
					.replace(
						'END CHECKPOINT VIEW — read every body and fragment before explicitly passing its receipt.',
						'END CURRENT REQUESTS — no receipt or read coverage was issued.',
					)
			: JSON.stringify(result),
	);
}
