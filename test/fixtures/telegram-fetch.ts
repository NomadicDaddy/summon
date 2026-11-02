import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

const mode = process.env.SUMMON_TEST_TELEGRAM;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const capture = process.env.SUMMON_TEST_CAPTURE;
	if (typeof init?.body !== 'string') throw new Error('Expected JSON request body.');
	if (capture) await Bun.write(capture, init.body);
	if (mode === 'network') throw new Error('sensitive token-bearing URL');
	if (mode === 'timeout') throw new DOMException('sensitive token-bearing URL', 'TimeoutError');
	if (mode === 'reject')
		return Response.json({ ok: false, description: 'sensitive details' }, { status: 403 });
	const url = input instanceof Request ? input.url : String(input);
	if (url.endsWith('/getUpdates')) {
		const path = process.env.SUMMON_TEST_UPDATES;
		const updates: unknown =
			path && (await Bun.file(path).exists()) ? await Bun.file(path).json() : [];
		return Response.json({ ok: true, result: updates });
	}
	if (mode === 'mirror-failure' || mode === 'reply-mirror-failure') {
		const root = process.env.SUMMON_HOME;
		if (!root) throw new Error('Missing disposable registry');
		if (mode === 'reply-mirror-failure')
			await rename(join(root, 'room/events.json'), join(root, 'room/saved-events.json'));
		await mkdir(join(root, 'room/events.json'), { recursive: true });
	}
	return Response.json({
		ok: true,
		result: { message_id: Number(process.env.SUMMON_TEST_MESSAGE_ID ?? '42') },
	});
}) as typeof fetch;
