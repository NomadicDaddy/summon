import type { Provider } from '../store.ts';

// Match the operator's PowerShell/aliases.ps1 (owned by Carl); room2077 changes kc to ki.
export const providerLabels: Record<Provider, { short: string; name: string }> = {
	claude: { short: 'cc', name: 'Claude' },
	codex: { short: 'cx', name: 'Codex' },
	grok: { short: 'gk', name: 'Grok' },
	kilo: { short: 'ki', name: 'Kilo' },
};
