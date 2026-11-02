import { atomicWrite, locked, optionalText } from './mail-files.ts';
import { operatorOnly } from './mail-identity.ts';
import { teamWindowRuntime } from './team-startup.ts';

export interface TeamMacro {
	text: string;
	send: boolean;
}

function macroPath(): string {
	return teamWindowRuntime('macros.json');
}

function validate(value: unknown): TeamMacro[] {
	if (!Array.isArray(value) || value.length !== 10) throw new Error('Expected ten macro slots.');
	return value.map((item: unknown, index) => {
		if (!item || typeof item !== 'object') throw new Error(`Invalid macro ${index + 1}.`);
		const row = item as Record<string, unknown>;
		if (typeof row.text !== 'string' || typeof row.send !== 'boolean')
			throw new Error(`Invalid macro ${index + 1}.`);
		if (row.text.length > 4096)
			throw new Error(`Slot ${index + 1}: text must be 4096 characters or fewer.`);
		return { text: row.text.trim() ? row.text : '', send: row.send };
	});
}

export async function readMacros(): Promise<TeamMacro[]> {
	operatorOnly();
	return locked(`${macroPath()}.lock`, readStoredMacros);
}

async function readStoredMacros(): Promise<TeamMacro[]> {
	const text = await optionalText(macroPath());
	if (text !== undefined) {
		const saved: unknown = JSON.parse(text);
		const macros = validate(saved);
		// Migrate saved label/text slots to the single-text schema, preserving what is sent.
		if (JSON.stringify(saved) !== JSON.stringify(macros))
			await atomicWrite(macroPath(), JSON.stringify(macros));
		return macros;
	}
	const defaults = ['Status?', 'What are you currently working on?'];
	return Array.from({ length: 10 }, (_, index) => ({
		text: defaults[index] ?? '',
		send: false,
	}));
}

export async function saveMacros(value: unknown): Promise<TeamMacro[]> {
	operatorOnly();
	const macros = validate(value);
	await locked(`${macroPath()}.lock`, () => atomicWrite(macroPath(), JSON.stringify(macros)));
	return macros;
}
