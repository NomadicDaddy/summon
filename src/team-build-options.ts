import { resolve } from 'node:path';

export const teamDist = resolve(import.meta.dir, '../dist/team');
export const teamEntries = [
	['main', 'node', 'esm', 'main.mjs'],
	['preload', 'node', 'cjs', 'preload.cjs'],
	['renderer', 'browser', 'esm', 'renderer.js'],
	// A classic, render-blocking script in <head>, so the colour theme applies before first paint.
	['theme-boot', 'browser', 'iife', 'theme-boot.js'],
] as const;

export function teamBuildOptions(entry: (typeof teamEntries)[number]): Bun.BuildConfig {
	return {
		entrypoints: [resolve(import.meta.dir, `desktop/${entry[0]}.ts`)],
		target: entry[1],
		format: entry[2],
		outdir: teamDist,
		naming: entry[3],
		external: ['electron', 'node-pty'],
		define: { 'process.env.NODE_ENV': JSON.stringify('production') },
	};
}
