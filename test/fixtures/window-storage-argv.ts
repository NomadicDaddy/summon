import { prepareTeamWindowStorage } from '../../src/desktop/startup-root.ts';
import { selectedTeamsBase, storageRoot } from '../../src/storage-root.ts';
import { openTeam } from '../../src/team-window.ts';

if (process.argv[2] === '--open') await openTeam();
else {
	const values = await prepareTeamWindowStorage(process.argv.slice(2));
	console.log(JSON.stringify({ values, root: storageRoot(), base: selectedTeamsBase() }));
}
