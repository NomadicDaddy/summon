export {};

const keys = (environment: NodeJS.ProcessEnv): string[] =>
	Object.keys(environment).filter((key) => key.toUpperCase().startsWith('SUMMON_'));

const child = Bun.spawn(
	[
		process.execPath,
		'-e',
		'console.log(JSON.stringify(Object.keys(process.env).filter(key => key.toUpperCase().startsWith("SUMMON_"))))',
	],
	{
		stdout: 'pipe',
		stderr: 'pipe',
		windowsHide: true,
	},
);
const [output, error, code] = await Promise.all([
	new Response(child.stdout).text(),
	new Response(child.stderr).text(),
	child.exited,
]);
if (code !== 0) throw new Error(`Descendant failed: ${error}`);
const descendant: unknown = JSON.parse(output);
console.log(
	JSON.stringify({
		direct: keys(process.env),
		descendant,
		keep: process.env.KEEP_SETTING,
	}),
);
