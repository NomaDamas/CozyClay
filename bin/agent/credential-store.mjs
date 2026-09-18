import { PROVIDERS } from "./providers.mjs";

const codexId = "openai-codex";
const apiProvider = (id) => PROVIDERS.find((provider) => provider.id === id);

function envValue(provider, env) {
	const name = provider.env.find((name) => typeof env[name] === "string" && env[name].trim());
	return name ? env[name] : undefined;
}

// Share in-process exclusion across stores used by routes and model registries.
// Each gate always resolves; operation failures still propagate to their caller.
const mutations = new Map();
async function serialized(providerId, operation, signal) {
	const previous = mutations.get(providerId);
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	mutations.set(providerId, gate);
	try {
		await previous;
		signal?.throwIfAborted();
		return await operation();
	} finally {
		release();
		if (mutations.get(providerId) === gate) mutations.delete(providerId);
	}
}

function mapOAuth(raw) {
	if (!raw) return undefined;
	return {
		type: "oauth",
		refresh: raw.refresh_token,
		access: raw.access_token,
		expires: Number(raw.expires_at || 0),
	};
}

function rawOAuth(credential) {
	return {
		access_token: credential.access,
		refresh_token: credential.refresh,
		expires_at: credential.expires,
	};
}

export function createCredentialStore({ auth, keys, env = process.env }) {
	const configured = (id) => apiProvider(id);
	return {
		async read(providerId, { signal } = {}) {
			signal?.throwIfAborted();
			if (providerId === codexId) return mapOAuth(await auth.readStored());
			const provider = configured(providerId);
			if (!provider) return undefined;
			const key = envValue(provider, env) ?? keys.readKeys()[providerId];
			return key ? { type: "api_key", key } : undefined;
		},
		async list({ signal } = {}) {
			signal?.throwIfAborted();
			const saved = keys.readKeys();
			const result = [];
			for (const provider of PROVIDERS) {
				if (provider.id === codexId) {
					if (await auth.readStored()) result.push({ providerId: provider.id, type: "oauth", source: "chatgpt" });
					continue;
				}
				const source = envValue(provider, env) ? "env" : saved[provider.id] ? "file" : null;
				if (source) result.push({ providerId: provider.id, type: "api_key", source });
			}
			return result;
		},
		async modify(providerId, fn, { signal } = {}) {
			return serialized(providerId, async () => {
				const current = await this.read(providerId, { signal });
				const next = await fn(current);
				if (next === undefined) return current;
				if (providerId === codexId) await auth.writeStored(rawOAuth(next));
				else keys.setKey(providerId, next.key);
				return next;
			}, signal);
		},
		async delete(providerId, { signal } = {}) {
			await serialized(providerId, async () => {
				if (providerId === codexId) await auth.logout();
				else if (configured(providerId)) keys.removeKey(providerId);
			}, signal);
		},
	};
}
