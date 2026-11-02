import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'normal';
const record = process.argv[3];
if (record) writeFileSync(`${record}.pid`, String(process.pid));
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
	if (record) appendFileSync(record, `${line}\n`);
	const request = JSON.parse(line) as {
		id?: number;
		method: string;
		params?: { threadId: string };
	};
	if (request.method === 'initialize') {
		if (mode === 'hang') {
			setInterval(() => {}, 1000);
			return;
		}
		if (mode === 'exit') process.exit(1);
		if (mode === 'malformed') {
			process.stdout.write('{private-provider-data\n');
			return;
		}
		if (mode === 'oversize') {
			process.stdout.write('x'.repeat(70_000));
			return;
		}
		if (mode === 'invalid-utf8') {
			process.stdout.write(Buffer.from([0xff, 10]));
			return;
		}
		send(
			mode === 'init-error' ? { id: request.id, error: {} } : { id: request.id, result: {} },
		);
	} else if (request.method === 'thread/read') {
		if (mode === 'error') {
			send({ id: request.id, error: { message: 'private-data' } });
			return;
		}
		const thread = request.params?.threadId ?? '';
		send({
			id: request.id,
			result: {
				thread: {
					id: mode === 'mismatch' ? 'foreign-thread' : thread,
					status: {
						type: thread.startsWith('busy')
							? 'active'
							: thread.startsWith('idle')
								? 'idle'
								: mode,
						activeFlags: [],
					},
				},
			},
		});
	}
});
