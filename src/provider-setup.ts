import type { Provider } from './store.ts';

import { type RuntimePrerequisite, runtimePrerequisites } from './runtime-prerequisites.ts';

export type CapabilityKey = 'liveMail' | 'checkpoints' | 'resume' | 'usage';

export interface CapabilityValue {
	support: 'yes' | 'no' | 'partial';
	note?: string;
}

export interface ProviderBehaviour {
	delivery: string;
	expected?: string;
	startup: string;
	suitedTo: string;
}

export interface ProviderSetup {
	provider: Provider;
	name: string;
	installText: string;
	installUrl: string;
	accountText: string;
	accountUrl: string;
	signInText: string;
	approvalText: string;
	toolingText: string;
	executionText: string;
	capabilities: Record<CapabilityKey, CapabilityValue>;
	behaviour: ProviderBehaviour;
}

export interface ProviderSetupCatalog {
	prerequisites: RuntimePrerequisite[];
	checkedAt: string;
	columns: { key: CapabilityKey; label: string }[];
	providers: ProviderSetup[];
	common: string;
	matrixNote: string;
	discoveryNote: string;
	runtimeNote: string;
}

const checkpointBehaviour: ProviderBehaviour = {
	delivery:
		'Checks its mailbox at startup and at checkpoints. The current integration has no live delivery for it.',
	expected: 'This seat will sit in queued-only. That is the normal state for it, not a fault.',
	startup: 'Nothing to acknowledge; it picks mail up on its own schedule.',
	suitedTo: 'Pick it when checkpoint-based pickup is acceptable for this seat.',
};

// Installation/accounts: linked official documentation checked 2026-10-03. Capability cells
// describe Summon's adapters (providers.ts, mail-watcher.ts, codex-mail-delivery.ts and
// desktop/usage.ts), not every feature of the underlying CLI or the model's quality.
const providers: Record<Provider, ProviderSetup> = {
	claude: {
		provider: 'claude',
		name: 'Claude Code',
		installText:
			'Install the Claude Code CLI with the native Windows installer in the official guide. Git for Windows is recommended for Bash tools; it is optional.',
		installUrl: 'https://code.claude.com/docs/en/setup',
		accountText:
			'Claude Pro, Max, Team or Enterprise access, or an Anthropic Console account with API billing. The free Claude plan does not include Claude Code. Third-party API access is also supported by the CLI.',
		accountUrl: 'https://code.claude.com/docs/en/authentication',
		signInText:
			'Run claude in a new terminal and follow its sign-in prompts. API access is billed separately from a Claude subscription.',
		approvalText:
			"Interactive terminal with the CLI's configured tool permissions. Live-channel trust confirmation is separate from Summon approval holds.",
		toolingText:
			'Local file and terminal tools, plus Summon MCP mail/Room tools and ordinary Summon CLI commands.',
		executionText:
			'The CLI and its tools run on your computer; Claude inference uses your hosted Claude or configured cloud service.',
		capabilities: {
			liveMail: {
				support: 'partial',
				note: 'Available in live mode after channel trust/readiness.',
			},
			checkpoints: { support: 'yes' },
			resume: { support: 'yes', note: 'Resumes the saved session ID.' },
			usage: { support: 'no', note: 'Use the CLI or account dashboard.' },
		},
		behaviour: {
			delivery:
				'Live mail through the Summon MCP channel, or mailbox checks at startup and checkpoints, following the team-wide Claude delivery setting.',
			startup:
				'The live channel must be initialised and trusted, with confirmation at each start. Checkpoint mode reads notices at startup and checkpoints without that prompt.',
			suitedTo:
				'Pick it when timely new instructions matter; enable the team-wide live delivery setting.',
		},
	},
	codex: {
		provider: 'codex',
		name: 'Codex CLI',
		installText:
			'Install the Codex CLI with the standalone Windows installer in the official guide. The desktop app or editor extension alone is not the CLI.',
		installUrl: 'https://github.com/openai/codex#installing-and-running-codex-cli',
		accountText:
			'Sign in with ChatGPT (including Free and Go; limits vary by plan), or use an OpenAI API account with billing. API charges are separate from a ChatGPT subscription; workspace access rules still apply.',
		accountUrl:
			'https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan',
		signInText:
			'Run codex in a new terminal and choose Sign in with ChatGPT or configure API authentication through the official guide.',
		approvalText:
			'Interactive terminal with Codex sandbox and approval settings. Summon does not grant tool approvals by sending a live notice.',
		toolingText:
			'Local file and terminal tools, Summon CLI commands, and thread-bound live receiver/hook integration.',
		executionText:
			'The CLI/tools run locally; default inference is hosted. Codex also supports configured local providers, but Summon has no --oss selector and local-model acceptance is not established here.',
		capabilities: {
			liveMail: { support: 'partial', note: 'After thread binding and receiver readiness.' },
			checkpoints: { support: 'yes' },
			resume: { support: 'yes', note: 'Resumes the saved session ID.' },
			usage: {
				support: 'partial',
				note: 'Read-only account/session data when the provider exposes it.',
			},
		},
		behaviour: {
			delivery: 'Live mail once it binds the provider thread.',
			startup:
				'It binds the thread at startup or through --mail bind, then its receiver needs readiness acknowledged.',
			suitedTo: 'Pick it when timely new instructions matter.',
		},
	},
	grok: {
		provider: 'grok',
		name: 'Grok Build',
		installText:
			'Install the Grok Build CLI using the Windows PowerShell instructions in the official guide. Summon launches the grok command.',
		installUrl: 'https://docs.x.ai/build/overview',
		accountText:
			'Use a Grok account with Build access (paid SuperGrok usage includes Build), or an xAI API account with credits. Check current account entitlements; free Grok chat access does not establish Build access.',
		accountUrl: 'https://docs.x.ai/grok/faq',
		signInText:
			'Run grok in a new terminal for browser sign-in, or grok login. API-key and custom-provider configuration are described in the official Build guide.',
		approvalText:
			"Interactive terminal with Grok's configured tool permission prompts. Startup and checkpoint turns remain subject to those permissions.",
		toolingText:
			'Local file and terminal tools; Summon mail, Room and other operations use its CLI at checkpoints.',
		executionText:
			'The CLI/tools run locally; Grok inference is hosted by default. The CLI supports custom model endpoints; a local endpoint has not been verified as a Summon workflow.',
		capabilities: {
			liveMail: { support: 'no', note: 'Checkpoint delivery; queued-only is expected.' },
			checkpoints: { support: 'yes' },
			resume: { support: 'yes', note: 'Resumes the saved session ID.' },
			usage: { support: 'no', note: 'Use the CLI or account dashboard.' },
		},
		behaviour: checkpointBehaviour,
	},
	kilo: {
		provider: 'kilo',
		name: 'Kilo CLI',
		installText:
			'Install the Kilo CLI package @kilocode/cli or the Windows binary from official releases, following the CLI guide. The editor extension alone is not the CLI.',
		installUrl: 'https://kilo.ai/docs/code-with-ai/platforms/cli',
		accountText:
			'Choose Kilo Gateway credits, your own provider account/API billing or an eligible provider subscription. Local LM Studio/Ollama models need no hosted inference subscription; Kilo Pass is optional.',
		accountUrl: 'https://kilo.ai/inference',
		signInText:
			'Run kilo in a new terminal and use /connect to configure your provider. For local models, configure the running model server in Kilo, then choose its provider/model in Summon.',
		approvalText:
			"Interactive terminal with Kilo's normal configured tool permissions. Summon does not enable automatic approvals for local models.",
		toolingText:
			'Local file and terminal tools; Summon CLI checkpoint operations. Startup is submitted to the saved session through an owned local API.',
		executionText:
			'The CLI/tools run locally; inference follows your configured hosted or local provider. Summon exposes Kilo model/LM Studio settings; run and configure the model server separately.',
		capabilities: {
			liveMail: { support: 'no', note: 'Checkpoint delivery; queued-only is expected.' },
			checkpoints: { support: 'yes' },
			resume: { support: 'yes', note: 'Resumes the saved session ID.' },
			usage: { support: 'no', note: 'Use the CLI or account dashboard.' },
		},
		behaviour: checkpointBehaviour,
	},
};

export const providerSetupCatalog: ProviderSetupCatalog = {
	prerequisites: runtimePrerequisites,
	checkedAt: '2026-10-03',
	columns: [
		{ key: 'liveMail', label: 'Live mail in Summon' },
		{ key: 'checkpoints', label: 'Checkpoint pickup' },
		{ key: 'resume', label: 'Saved-session resume' },
		{ key: 'usage', label: 'Usage display in Summon' },
	],
	providers: [providers.claude, providers.codex, providers.grok, providers.kilo],
	common: 'Every CLI holds mail until it is handled. Live means the transport is ready, not that the teammate has read or acted on it.',
	matrixNote:
		'This matrix describes Summon support, not model quality. Plans and provider features can change; follow the official links for current terms.',
	discoveryNote:
		'Installed means the CLI answered its version check. Sign-in, account entitlement and model readiness are not checked. Open the CLI and complete its setup before starting a teammate. After installing, reopen Summon so it receives the updated PATH, then refresh this check.',
	runtimeNote:
		'Bun 1.4.3 or later, PowerShell 7.6 or later, provider CLIs and accounts are separate prerequisites for both installer and source installations. After installing Bun or PowerShell, reopen Summon to receive the updated PATH, then refresh. Electron and application library dependencies are included. Install guidance opens in your browser; Summon does not install or sign in for you.',
};
