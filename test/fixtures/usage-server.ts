import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
for await (const line of input) {
	const message = JSON.parse(line) as {
		id?: number;
		method: string;
		params?: { threadId?: string };
	};
	if (message.method === 'initialized') continue;
	if (message.method === 'initialize')
		console.log(JSON.stringify({ id: message.id, result: {} }));
	else if (message.method === 'account/rateLimits/read')
		console.log(
			JSON.stringify({
				id: message.id,
				result: {
					rateLimits: {
						primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1900000000 },
					},
					ordinaryUsageAllowed: false,
				},
			}),
		);
	else if (
		message.method === 'account/usage/read' &&
		message.params?.threadId === 'fixture-session'
	)
		console.log(
			JSON.stringify({
				id: message.id,
				result: {
					threadUsage: {
						estimatedUsageUsdMicros: 250000,
						groups: [{ totalTokens: 1234 }],
					},
				},
			}),
		);
	else {
		console.log(JSON.stringify({ id: message.id, error: { message: 'Unexpected RPC' } }));
		process.exitCode = 1;
		break;
	}
}
