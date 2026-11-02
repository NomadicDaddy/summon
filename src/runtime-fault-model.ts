import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';

export const runtimeFaultInput = z
	.object({
		level: z.enum(['error', 'warning']),
		source: z
			.string()
			.max(80)
			.regex(/^[a-z][a-z0-9.-]*$/),
		member: z
			.string()
			.max(64)
			.regex(/^[a-z0-9][a-z0-9._-]*$/)
			.optional(),
		text: z.string().max(8192),
	})
	.strict();
export type RuntimeFaultInput = z.infer<typeof runtimeFaultInput>;

export const runtimeFaultRecord = runtimeFaultInput
	.extend({
		id: z.uuid(),
		at: z.iso.datetime(),
		windowStartedAt: z.iso.datetime(),
		text: z.string().min(1).max(2048),
	})
	.strict();
export type RuntimeFaultRecord = z.infer<typeof runtimeFaultRecord>;

/** Diagnostics are reasons, not an error stack, input payload or credential store. */
export function runtimeFaultText(value: string): string {
	let text = stripVTControlCharacters(value)
		.replace(/^Error invoking remote method '[^']*':\s*/, '')
		.replace(/^(?:[A-Za-z]*Error):\s*/, '')
		.trim();
	if (
		text.startsWith('[') ||
		text.startsWith('{') ||
		/(?:JSON Parse error|not valid JSON|Unexpected token.*JSON|ZodError)/i.test(text)
	)
		return 'Invalid structured input; payload details omitted.';
	text = text.split(/[\r\n]/, 1)[0] ?? '';
	text = text
		.replace(/\b(?:authorization|cookie|set-cookie)\s*:\s*.*$/gi, '[credential header omitted]')
		.replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[authorization omitted]')
		.replace(
			/\b(password|passwd|secret|token|api[-_ ]?key|authorization|cookie|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
			'$1=[redacted]',
		)
		.replace(/\b(?:sk|gh[pousr]|github_pat)[-_][A-Za-z0-9_-]{8,}\b/g, '[token omitted]')
		.replace(
			/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
			'[token omitted]',
		)
		.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL omitted]')
		.replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, '[quoted detail omitted]')
		.trim();
	text = Array.from(text)
		.map((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127 ? ' ' : character;
		})
		.join('');
	return text.slice(0, 2048) || 'Unclassified runtime fault.';
}

export interface RuntimeFaultGroup extends RuntimeFaultRecord {
	count: number;
	lastAt: string;
}

/** Collapse repeated reports in the reader; every retained occurrence stays in the journal. */
export function groupRuntimeFaults(records: RuntimeFaultRecord[]): RuntimeFaultGroup[] {
	const groups: RuntimeFaultGroup[] = [];
	const recent = new Map<string, RuntimeFaultGroup>();
	for (const record of records) {
		const key = JSON.stringify([
			record.windowStartedAt,
			record.level,
			record.source,
			record.member,
			record.text,
		]);
		const previous = recent.get(key);
		if (previous && Date.parse(record.at) - Date.parse(previous.lastAt) <= 60_000) {
			previous.count++;
			previous.lastAt = record.at;
		} else {
			const group = { ...record, count: 1, lastAt: record.at };
			groups.push(group);
			recent.set(key, group);
		}
	}
	return groups.sort((a, b) => b.lastAt.localeCompare(a.lastAt) || b.id.localeCompare(a.id));
}
