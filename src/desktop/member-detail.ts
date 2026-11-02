import type { TeamAgent } from './types.ts';

import { memberFacts } from './member-facts.ts';

/**
 * The session header's detail line: the teammate's facts joined on one line, the same values in
 * the same order as the provider tooltip and a Shift+click copy (Phillip #7999). The title
 * carries the line whole, since the ellipsis may cut the directory.
 */
export function memberDetail(agent?: TeamAgent): { text: string; title: string } {
	const text = agent ? memberFacts(agent).join(' · ') : '';
	const title = agent?.claudeConfigDir
		? `${text}\nClaude configuration directory: ${agent.claudeConfigDir}. The signed-in identity is managed in Claude.`
		: text;
	return { text, title };
}
