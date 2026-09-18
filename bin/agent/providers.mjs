import * as defaultAuth from "../codex-auth.mjs";
import * as defaultKeys from "./provider-keys.mjs";
import { createCredentialStore } from "./credential-store.mjs";

export const PROVIDERS = [
	{ id: "openai-codex", label: "ChatGPT (OpenAI Codex)", auth: "chatgpt-oauth", env: [] },
	{ id: "anthropic", label: "Anthropic", auth: "api_key", env: ["ANTHROPIC_API_KEY"] },
	{ id: "openai", label: "OpenAI", auth: "api_key", env: ["OPENAI_API_KEY"] },
	{ id: "google", label: "Google Gemini", auth: "api_key", env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
	{ id: "openrouter", label: "OpenRouter", auth: "api_key", env: ["OPENROUTER_API_KEY"] },
];

const factories = {
	"openai-codex": "openaiCodexProvider",
	anthropic: "anthropicProvider",
	openai: "openaiProvider",
	google: "googleProvider",
	openrouter: "openrouterProvider",
};

const providerConfig = (id) => PROVIDERS.find((provider) => provider.id === id);

export async function loadProvider(id) {
	const config = providerConfig(id);
	if (!config) throw Object.assign(new Error(`Unknown provider: ${id}`), { code: "UNKNOWN_PROVIDER" });
	const module = await import(`@earendil-works/pi-ai/providers/${id}`);
	return module[factories[id]]();
}

export async function createModels({ credentials, auth = defaultAuth, keys = defaultKeys, env = process.env } = {}) {
	const { createModels: createPiModels } = await import("@earendil-works/pi-ai");
	const store = credentials ?? createCredentialStore({ auth, keys, env });
	const models = createPiModels({ credentials: store });
	for (const provider of PROVIDERS) models.setProvider(await loadProvider(provider.id));
	return models;
}

export async function resolveModel(requested, options = {}) {
	if (typeof requested !== "string" || !requested.trim()) throw unknownModel(requested);
	const value = requested.trim();
	const slash = value.indexOf("/");
	const provider = slash === -1 ? "openai-codex" : value.slice(0, slash);
	const modelId = slash === -1 ? value : value.slice(slash + 1);
	if (!providerConfig(provider) || !modelId) throw unknownModel(requested);
	const models = options.models ?? await createModels(options);
	const model = models.getModel(provider, modelId);
	if (!model) throw unknownModel(requested);
	return { provider, modelId, model };
}

function unknownModel(requested) {
	return Object.assign(new Error(`Unknown model: ${requested}`), { code: "UNKNOWN_MODEL" });
}

export function providerStatus({ auth = defaultAuth, keys = defaultKeys, env = process.env } = {}) {
	const saved = keys.readKeys();
	return PROVIDERS.map((provider) => {
		if (provider.id === "openai-codex") {
			const raw = typeof auth.readStored === "function" ? auth.readStored() : undefined;
			const signedIn = auth.status ? !!auth.status().signedIn : !!raw?.refresh_token;
			return { id: provider.id, label: provider.label, authSource: signedIn ? "chatgpt" : null, signedIn };
		}
		const envName = provider.env.find((name) => typeof env[name] === "string" && env[name].trim());
		const authSource = envName ? "env" : saved[provider.id] ? "file" : null;
		return { id: provider.id, label: provider.label, authSource, signedIn: !!authSource };
	});
}
