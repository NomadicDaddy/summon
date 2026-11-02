import type { TeamAgent, TeamBridge } from '../../src/desktop/types.ts';

import { setupResponsePanel } from '../../src/desktop/response-watchdog-panel.ts';

function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
// The copy checks await, so a failed assertion surfaces as a rejection: report it in the title.
const fail = (reason: unknown) => {
	document.title = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`;
};
window.addEventListener('error', (event) => fail(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => fail(event.reason));
const anchor = document.createElement('div');
document.body.append(anchor);
let dismissed = '';
const forbidden = () => {
	throw new Error('Provider input or selection was attempted');
};
// The installed window's renderer clipboard refused (#12033); the panel must not depend on it.
Object.defineProperty(navigator, 'clipboard', {
	configurable: true,
	value: { writeText: () => Promise.reject(new Error('Write permission denied.')) },
});
const copied: string[] = [];
let copyRefuses = false;
window.team = {
	select: forbidden,
	input: forbidden,
	dismissResponse: (slug: string, nonce: string, id: string) => {
		dismissed = `${slug}:${nonce}:${id}`;
		return Promise.resolve();
	},
	operatorCopy: (text: string) => {
		if (copyRefuses) return Promise.reject(new Error('Clipboard refused.'));
		copied.push(text);
		return Promise.resolve();
	},
} as unknown as TeamBridge;
const errors: unknown[] = [];
const update = setupResponsePanel(anchor, (error) => {
	errors.push(error);
});
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const now = Date.now();
const agent = {
	slug: 'alpha',
	cwd: '.',
	name: 'Alpha',
	provider: 'codex',
	status: 'running',
	responseWatchdog: {
		version: 1,
		owner: 'alpha',
		nonce: 'launch',
		id: '11111111-1111-4111-8111-111111111111',
		updatedAt: now,
		retiredEpisodeId: null,
		suspended: false,
		dismissed: false,
		alerted: false,
		episodeTargets: [],
		diagnostic: 'none',
		phase: 'waiting',
		expectations: [
			{
				id: 'room',
				condition: 'uncertain',
				startedAt: now - 660000,
				progressAt: now - 660000,
				progress: 0,
			},
		],
		targets: { room: { source: 'room', key: 'local', through: 42, ids: [] } },
		outcomes: {},
		controlResponse: 'Unhibernate release response is not tracked.',
	},
} as TeamAgent;
update([agent]);
const section = document.querySelector<HTMLElement>('.response-watchdog');
assert(section?.hidden, 'Five-minute state must not create an attention item');
assert(agent.responseWatchdog, 'Fixture state');
agent.responseWatchdog.phase = 'attention';
agent.responseWatchdog.alerted = true;
update([agent]);
const details = section.querySelector('details');
assert(details, 'Attention detail missing');
details.open = true;
const dismiss = [...details.querySelectorAll('button')].find(
	(button) => button.textContent === 'Dismiss',
);
assert(dismiss, 'Dismiss control missing');
dismiss.focus();
const expectation = agent.responseWatchdog.expectations[0];
assert(expectation, 'Fixture expectation missing');
expectation.progress += 1;
update([agent]);
assert(
	details.hasAttribute('open') && document.activeElement === dismiss,
	'Update lost disclosure or keyboard focus',
);
assert(details.textContent.includes('Input may have begun'), 'Uncertainty missing');
assert(details.textContent.includes('bounds 42 to 42'), 'Source bounds missing');
assert(details.textContent.includes('11 min'), 'Elapsed age missing');
assert(details.textContent.includes('Current launch: launch'), 'Launch identity missing');
assert(!details.querySelector('pre'), 'Raw JSON leaked into narrow panel');
assert(section.scrollWidth <= section.clientWidth, 'Panel overflows its column');
// Copy delivery details goes through the window's clipboard bridge and says so on the button.
const copyButton = [...details.querySelectorAll('button')].find(
	(button) => button.textContent === 'Copy delivery details',
);
assert(copyButton, 'Copy control missing');
// Read through functions so each check sees the live value, not a narrowed earlier one.
const label = (): string => copyButton.textContent;
const errorCount = (): number => errors.length;
const copyCount = (): number => copied.length;
// A copy still in flight ignores a second press rather than sending twice.
let release = (): void => undefined;
const held = window.team.operatorCopy;
window.team.operatorCopy = (text: string) =>
	new Promise<void>((resolve) => {
		copied.push(text);
		release = resolve;
	});
copyButton.click();
copyButton.click();
assert(copyCount() === 1, 'A second press during a copy sent it twice');
assert(copyButton.getAttribute('aria-disabled') === 'true', 'In-flight copy not marked');
release();
await settle();
window.team.operatorCopy = held;
assert(
	copyCount() === 1 && copied[0]?.includes(agent.responseWatchdog.id),
	'Copy did not send the delivery details through operatorCopy',
);
assert(label() === 'Copied', 'Copy did not confirm on the button');
assert(!copyButton.hasAttribute('aria-disabled'), 'Finished copy still marked in flight');
assert(errorCount() === 0, 'A successful copy reported an error');
// Refused straight after a success, inside its 1.5 s: the failure replaces Copied (#12047).
copyRefuses = true;
copyButton.click();
await settle();
assert(errorCount() === 1, 'A refused copy was not reported');
assert(label() === 'Not copied', 'A refused copy did not say so on the button');
await settle(1600);
assert(label() === 'Copy delivery details', 'Copy label did not return');
errors.length = 0;
copyRefuses = false;
dismiss.click();
assert(dismissed === `alpha:launch:${agent.responseWatchdog.id}`, 'Dismiss targeted wrong episode');
agent.responseWatchdog.phase = 'dismissed';
update([agent]);
const history = document.querySelector<HTMLDetailsElement>('.response-watchdog-history');
assert(!history, 'Dismissed details history must not be rendered');
assert(
	section.hasAttribute('hidden') && document.activeElement === anchor,
	'Dismiss failed to hide the alert and return focus safely',
);
assert(!details.isConnected, 'Dismissed alert remained in the document');
update([agent]);
assert(!section.querySelector('details'), 'Dismissed alert reappeared on refresh');
agent.responseWatchdog.phase = 'clear';
update([agent]);
assert(!section.querySelector('details') && section.hidden, 'Resolved alert remained');
assert(document.activeElement === anchor, 'Resolved alert moved keyboard focus');
agent.responseWatchdog.id = '22222222-2222-4222-8222-222222222222';
agent.responseWatchdog.phase = 'attention';
update([agent]);
assert(
	!section.hasAttribute('hidden') && section.querySelector('details'),
	'New alert did not appear',
);
assert(document.activeElement === anchor, 'New alert stole keyboard focus');
const second = { ...agent, slug: 'beta', name: 'Beta' };
update([agent, second]);
const firstAlert = section.querySelector('details');
assert(firstAlert, 'First alert missing');
firstAlert.open = true;
firstAlert.querySelector('button')?.focus();
update([second]);
assert(
	document.activeElement === section.querySelector('summary'),
	'Removing focused alert did not focus the remaining alert',
);
update([]);
assert(document.activeElement === anchor, 'Removing last alert did not restore anchor focus');
assert(errors.length === 0, `Unexpected panel errors: ${String(errors[0])}`);
document.title = 'WATCHDOG_UI_PASS';
