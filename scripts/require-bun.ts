import { packageManager } from '../package.json';

if (!(process.env.npm_config_user_agent ?? '').startsWith('bun/')) {
	console.error('Use "bun install" for installation in this project.');
	process.exit(1);
}
const minimum = packageManager.slice('bun@'.length);
if (typeof Bun === 'undefined' || !Bun.semver.satisfies(Bun.version, `>=${minimum}`)) {
	console.error(`summon requires Bun ${minimum} or later. Install it from https://bun.sh/`);
	process.exit(1);
}
