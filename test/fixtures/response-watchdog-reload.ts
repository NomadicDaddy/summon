import { dismissResponseEpisode, responseStatus } from '../../src/response-watchdog-store.ts';
import { evaluateResponseWatchdog } from '../../src/response-watchdog.ts';

const now = Number(process.argv[2]);
if (!Number.isSafeInteger(now)) throw new Error('Fixture time required');
Date.now = () => now;
await evaluateResponseWatchdog('alpha', 'reload-fixture');
const state = await responseStatus('alpha', 'reload-fixture');
if (!state) throw new Error('Missing fixture state');
if (process.argv[3] === 'dismiss')
	await dismissResponseEpisode('alpha', 'reload-fixture', state.id);
console.log(JSON.stringify(await responseStatus('alpha', 'reload-fixture')));
