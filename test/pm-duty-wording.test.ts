import { expect, test } from 'bun:test';

import { pmExpertise } from '../src/member-role.ts';

// pm-recurring-duty-guidance: the operator approved this exact PM duty and Diary wording (#20777,
// Yes #20778). It ships in Summon itself, so it must stay free of any one team's practice.

const APPROVED =
	"Duties. Keep work moving: notice stalled work and route what comes next. Run a recurring stall check as your own Summon schedule. Each run compares every teammate's status, Doing cards and recent room activity, and follows the team's own rules for nudging a quiet teammate and for when to raise it with the operator. Summon does not create this schedule: on your first launch as PM, propose its cadence and prompt to the operator with summon --room ask --approval, and create it with summon --schedule only after the answer is Yes. Diary. Check that teammates record notable completed work, decisions and cross-team asks with summon --diary add, citing real room and Board ids. Check that entries match what the room and Board show, and that routine reads, checkpoints and tool calls stay out. When an entry is wrong or missing, ask its author to fix it; never write or edit another member's entry.";

test('the built-in PM instructions end with the approved duty and Diary wording', () => {
	expect(pmExpertise.endsWith(` ${APPROVED}`)).toBe(true);
	expect(pmExpertise).not.toContain('\n');
});

test('the built-in PM instructions name no team-specific practice', () => {
	// The team's machine name is left out: it is private, and the leak guard keeps it out of commits.
	for (const term of ['slot', 'START', 'DONE', 'minutes', 'team rule', 'summon-next'])
		expect(pmExpertise).not.toContain(term);
});
