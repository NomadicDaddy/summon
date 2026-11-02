import { z } from 'zod';

/** The owned window chooses the launch identity before the session wrapper can publish activity. */
export function ownedLaunchNonce(args: string[]): { args: string[]; nonce?: string } {
	const index = args.indexOf('--launch-nonce');
	if (index < 0) return { args };
	if (args.lastIndexOf('--launch-nonce') !== index || index < 2)
		throw new Error('Invalid owned launch identity.');
	const nonce = z.uuid().parse(args[index + 1]);
	return { nonce, args: [...args.slice(0, index), ...args.slice(index + 2)] };
}
