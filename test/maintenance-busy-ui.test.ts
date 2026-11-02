import { expect, test } from 'bun:test';

import { measureBoardUi } from './fixtures/board-ui-harness.ts';

/**
 * Team Maintenance's Save while the dialog is busy (kilo-model-selection-persistence, 2026-10-24).
 * The real index.html and dialog code in Electron, with window.team stubbed and an existing Kilo
 * seat's profile load held open. Save used to stay enabled through any dialog action and a press
 * was dropped without a word, so a model typed then never reached the registration. Save must be
 * off while the action runs and save the typed model afterwards, a refused save must keep what was
 * typed, and the no-CLI add state must still keep Save off.
 */
test('Team Maintenance Save is off while the dialog is busy, then saves what was typed', async () => {
	const [measured] = await measureBoardUi('maintenance-busy-renderer', 'MAINT_BUSY', [
		{ height: 1309, room: false, width: 2250 },
	]);
	// Only what the fixture observed: the window size is the harness's, a pixel off under scaling.
	const { afterLoad, duringLoad, error, noCli, refused, saved, savesDuringLoad } = measured ?? {};
	expect({ afterLoad, duringLoad, error, noCli, refused, saved, savesDuringLoad }).toEqual({
		afterLoad: { model: 'zai-coding-plan/glm-5.3', saveDisabled: false },
		duringLoad: { saveDisabled: true },
		error: undefined,
		noCli: { saveDisabled: true },
		refused: { model: 'other/model', saveDisabled: false, status: 'Refused by the fixture.' },
		saved: {
			label: 'Save Teammate',
			model: 'kilo/poolside/laguna-s-2.1:free',
			saveDisabled: false,
		},
		savesDuringLoad: 0,
	});
}, 30000);
