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

export async function loadProvider(id, { baseUrl } = {}) {
	const config = providerConfig(id);
	if (!config) throw Object.assign(new Error(`Unknown provider: ${id}`), { code: "UNKNOWN_PROVIDER" });
	const module = await import(`@earendil-works/pi-ai/providers/${id}`);
	const provider = module[factories[id]]();
	if (baseUrl) {
		provider.baseUrl = baseUrl;
		const getModels = provider.getModels.bind(provider);
		provider.getModels = () => getModels().map((model) => ({ ...model, baseUrl }));
	}
	return provider;
}

export async function createModels({ credentials, auth = defaultAuth, keys = defaultKeys, env = process.env, codexBaseUrl } = {}) {
	const { createModels: createPiModels } = await import("@earendil-works/pi-ai");
	const store = credentials ?? createCredentialStore({ auth, keys, env });
	const models = createPiModels({ credentials: store });
	for (const provider of PROVIDERS) {
		const baseUrl = provider.id === "openai-codex" ? codexBaseUrl : undefined;
		models.setProvider(await loadProvider(provider.id, { baseUrl }));
	}
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

/** Wire effort (frozen vocabulary) → pi `ModelThinkingLevel`, clamped to what
 * this model actually supports: "none"→"off" (pi's own "no reasoning" level,
 * never clamped up — a model that lacks "off" in its `thinkingLevelMap` still
 * gets "off"; clamping it to the lowest *supported* level would silently turn
 * "no reasoning requested" into "some reasoning requested"), "ultra"→"max"
 * (pi has no "ultra" level) then clamped down like any other level. */
export async function resolveEffort(model, effort) {
	const { clampThinkingLevel } = await import("@earendil-works/pi-ai");
	const level = effort === "none" ? "off" : effort === "ultra" ? "max" : effort;
	return level === "off" ? "off" : clampThinkingLevel(model, level);
}

function unknownModel(requested) {
	return Object.assign(new Error(`Unknown model: ${requested}`), { code: "UNKNOWN_MODEL" });
}

// Shared between the legacy provider-status route and the models registry
// below: the label a signed-in provider surfaces ("env", "file", "chatgpt")
// comes from CozyClay's own stored credentials, never from pi's free-form
// `AuthResult.source` string.
function resolveAuthSource(provider, { auth, saved, env }) {
	if (provider.id === "openai-codex") {
		const raw = typeof auth.readStored === "function" ? auth.readStored() : undefined;
		const signedIn = auth.status ? !!auth.status().signedIn : !!raw?.refresh_token;
		return signedIn ? "chatgpt" : null;
	}
	const envName = provider.env.find((name) => typeof env[name] === "string" && env[name].trim());
	return envName ? "env" : saved[provider.id] ? "file" : null;
}

export function providerStatus({ auth = defaultAuth, keys = defaultKeys, env = process.env } = {}) {
	const saved = keys.readKeys();
	return PROVIDERS.map((provider) => {
		const authSource = resolveAuthSource(provider, { auth, saved, env });
		return { id: provider.id, label: provider.label, authSource, signedIn: !!authSource };
	});
}

// The wire vocabulary the panel and turn route speak (frozen, #379): pi's
// ModelThinkingLevel ("off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max")
// plus "none" (off's wire name) and "ultra" (accepted on input only, clamped
// to "max" — no model ever advertises it as a supported effort).
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const wireEffort = (level) => (level === "off" ? "none" : level);

function effortsFor(levels) {
	const efforts = levels.map(wireEffort);
	const defaultEffort = efforts.includes("medium") ? "medium" : (efforts[0] ?? "none");
	return { efforts, defaultEffort };
}

/** One provider's pi catalog, filtered to chat models that take both text and
 * image input and shaped for the panel: key-addressed, effort levels in the
 * frozen wire vocabulary. */
function catalogModels(models, providerId, getSupportedThinkingLevels) {
	return models.getModels(providerId)
		.filter((model) => Array.isArray(model.input) && model.input.includes("text") && model.input.includes("image"))
		.map((model) => {
			const { efforts, defaultEffort } = effortsFor(getSupportedThinkingLevels(model));
			return { id: model.id, key: `${providerId}/${model.id}`, label: model.name ?? model.id, efforts, defaultEffort, input: ["text", "image"] };
		});
}

/** Codex's live `/models` list, in the same shape as `catalogModels`. Used
 * only to add models the pi catalogue does not (yet) know about. */
function liveModelsCodex(result) {
	const list = Array.isArray(result) ? result : result?.models ?? [];
	return list.map((model) => {
		const id = typeof model === "string" ? model : model.slug || model.id;
		const levels = Array.isArray(model.supported_reasoning_levels)
			? model.supported_reasoning_levels.map((level) => (typeof level === "string" ? level : level.effort)).filter(Boolean).map(wireEffort)
			: [];
		const defaultEffort = levels.includes("medium") ? "medium" : (typeof model.default_reasoning_level === "string" ? wireEffort(model.default_reasoning_level) : levels[0] ?? "none");
		return { id, key: `openai-codex/${id}`, label: id, efforts: levels, defaultEffort, input: ["text", "image"] };
	}).filter((model) => model.id);
}

const astraFirst = (a, b) => Number(b.id === "gpt-6-astra") - Number(a.id === "gpt-6-astra");

/**
 * `/agent/models`, built on the pi provider registry (#379): every provider
 * signed in or not, each with its sign-in state and its chat models shaped
 * for the panel. `models` may be injected (already-built pi `Models`, or a
 * test double exposing `getModels`/`getAuth`) — the route builds a real one.
 */
export async function listAgentModels({ models, codex, auth = defaultAuth, keys = defaultKeys, env = process.env } = {}) {
	const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
	const resolvedModels = models ?? await createModels({ auth, keys, env });
	const saved = keys.readKeys();
	const providers = [];
	for (const provider of PROVIDERS) {
		const authResult = await resolvedModels.getAuth(provider.id).catch(() => undefined);
		const signedIn = authResult !== undefined;
		const authSource = resolveAuthSource(provider, { auth, saved, env });
		let list = catalogModels(resolvedModels, provider.id, getSupportedThinkingLevels);
		if (provider.id === "openai-codex") {
			list = [...list].sort(astraFirst);
			if (signedIn && codex?.listModels) {
				try {
					const known = new Set(list.map((model) => model.id));
					const live = liveModelsCodex(await codex.listModels()).filter((model) => !known.has(model.id));
					list = [...list, ...live];
				} catch { /* the live catalog is a bonus; the static catalog still lists astra */ }
			}
		}
		providers.push({ id: provider.id, label: provider.label, signedIn, authSource, models: list });
	}
	// The flat union is what the panel's dropdown reads today (`models[].id`);
	// with five providers in play the id has to be the provider/id key so two
	// providers' same-named model never collide there, while each provider's
	// own `models[]` keeps the bare id.
	return { providers, models: providers.flatMap((provider) => provider.models.map((model) => ({ ...model, id: model.key }))) };
}
