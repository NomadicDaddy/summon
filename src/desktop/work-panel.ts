/** The work views share one boundary with the session below them. */
export function updateWorkPanelDivider(): void {
	const divider = document.getElementById('split-work');
	if (!divider) return;
	divider.hidden = !['board', 'diary', 'repos', 'schedules'].some((id) => {
		const panel = document.getElementById(id);
		return panel !== null && !panel.hidden;
	});
}
