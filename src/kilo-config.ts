export function validKiloOptions(provider: string, model?: unknown, url?: unknown): boolean {
	if (
		model !== undefined &&
		(typeof model !== 'string' || !/^[^\s/]+\/[^\s]+$/.test(model) || model.length > 200)
	)
		return false;
	if (url !== undefined) {
		if (typeof url !== 'string' || url.length > 2000) return false;
		try {
			const parsed = new URL(url);
			if (
				!['http:', 'https:'].includes(parsed.protocol) ||
				parsed.username ||
				parsed.password ||
				parsed.search ||
				parsed.hash
			)
				return false;
		} catch {
			return false;
		}
		if (typeof model !== 'string' || !model.startsWith('lmstudio/')) return false;
	}
	return provider === 'kilo' || (model === undefined && url === undefined);
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid KILO_CONFIG_CONTENT object.');
	return value as Record<string, unknown>;
}

export function kiloEnvironment(model?: string, url?: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	if (!model?.startsWith('lmstudio/')) return env;
	const config = env.KILO_CONFIG_CONTENT
		? object(JSON.parse(env.KILO_CONFIG_CONTENT) as unknown)
		: {};
	const providers = config.provider === undefined ? {} : object(config.provider);
	const local = providers.lmstudio === undefined ? {} : object(providers.lmstudio);
	const options = local.options === undefined ? {} : object(local.options);
	const models = local.models === undefined ? {} : object(local.models);
	const id = model.slice('lmstudio/'.length);
	env.KILO_CONFIG_CONTENT = JSON.stringify({
		...config,
		model,
		small_model: model,
		provider: {
			...providers,
			lmstudio: {
				...local,
				options: { ...options, baseURL: url ?? 'http://127.0.0.1:1234/v1' },
				models: { ...models, [id]: models[id] ?? { name: id } },
			},
		},
	});
	return env;
}

/**
 * Only Summon's startup turn carries a variant; every later turn comes from the Kilo TUI, which names
 * the model but no variant, and Kilo then saves "default" over the stored one. An agent whose model
 * matches the prompt supplies its own variant, so the seat's registered one goes on the agent the
 * seat runs (Kilo's default_agent, else code). Measured on Kilo 7.8.17: with model and variant on
 * that agent, a model-only turn runs on and stores the variant; with the variant alone it does not.
 */
export function kiloAgentVariant(
	env: NodeJS.ProcessEnv,
	model?: string,
	variant?: string,
): NodeJS.ProcessEnv {
	if (!model || !variant) return env;
	const config = env.KILO_CONFIG_CONTENT
		? object(JSON.parse(env.KILO_CONFIG_CONTENT) as unknown)
		: {};
	const agents = config.agent === undefined ? {} : object(config.agent);
	const name = typeof config.default_agent === 'string' ? config.default_agent : 'code';
	const agent = agents[name] === undefined ? {} : object(agents[name]);
	return {
		...env,
		KILO_CONFIG_CONTENT: JSON.stringify({
			...config,
			agent: { ...agents, [name]: { ...agent, model, variant } },
		}),
	};
}
import { atomicWrite } from './mail-files.ts';

export async function kiloInstructions(
	env: NodeJS.ProcessEnv,
	path: string,
	prompt: string,
): Promise<NodeJS.ProcessEnv> {
	const config = env.KILO_CONFIG_CONTENT
		? object(JSON.parse(env.KILO_CONFIG_CONTENT) as unknown)
		: {};
	const instructions: unknown = config.instructions ?? [];
	if (
		!Array.isArray(instructions) ||
		instructions.some((value: unknown) => typeof value !== 'string')
	)
		throw new Error('Invalid Kilo instruction paths.');
	await atomicWrite(path, prompt);
	return {
		...env,
		KILO_CONFIG_CONTENT: JSON.stringify({
			...config,
			instructions: [...new Set([...(instructions as string[]), path])],
		}),
	};
}
