import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-providers-"));
const configDir = join(rootDir, "new-config");
const authFile = join(configDir, "codex-auth.json");
process.env.COZYCLAY_CONFIG_DIR = configDir;
process.env.COZYCLAY_CODEX_AUTH_FILE = authFile;
process.env.COZYCLAY_AGENT_SESSIONS_DIR = join(rootDir, "sessions");
const providerEnvNames = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"];
const previousProviderEnv = Object.fromEntries(providerEnvNames.map((name) => [name, process.env[name]]));
for (const name of providerEnvNames) delete process.env[name];

const [{ createAgentHandler }, auth, { createCredentialStore }, keys, providers] = await Promise.all([
	import("../bin/agent/agent-routes.mjs"),
	import("../bin/codex-auth.mjs"),
	import("../bin/agent/credential-store.mjs"),
	import("../bin/agent/provider-keys.mjs"),
	import("../bin/agent/providers.mjs"),
]);

const injected = {
	stored: undefined,
	readStored() { return this.stored; },
	writeStored(value) { this.stored = value; },
	logout() { this.stored = undefined; },
	status() { return { signedIn: !!this.stored }; },
	getAccessToken: async () => "token",
};
const handler = createAgentHandler({ auth: injected, codex: { listModels: async () => [], parseQuotaHeaders: () => ({ primary: {} }) }, liveHub: {}, port: () => server.address().port });
const server = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const request = (path, init = {}) => fetch(`${origin}${path}`, { ...init, headers: { origin, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) } });

let response = await request("/agent/providers/anthropic", { method: "PUT", body: JSON.stringify({ key: "anthropic-secret-value" }) });
assert.equal(response.status, 200);
assert.equal(statSync(configDir).mode & 0o777, 0o700);
assert.equal(statSync(join(configDir, "providers.json")).mode & 0o777, 0o600);
console.log("PASS newly created config parent is mode 700 and providers.json is mode 600");
const existingConfigDir = join(rootDir, "existing-config");
mkdirSync(existingConfigDir, { recursive: true, mode: 0o755 });
chmodSync(existingConfigDir, 0o755);
process.env.COZYCLAY_CONFIG_DIR = existingConfigDir;
assert.equal((await (await request("/agent/providers/openai", { method: "PUT", body: JSON.stringify({ key: "existing-parent-secret" }) })).status), 200);
assert.equal(statSync(existingConfigDir).mode & 0o777, 0o755);
assert.equal(statSync(join(existingConfigDir, "providers.json")).mode & 0o777, 0o600);
console.log("PASS existing config parent mode 755 is preserved and providers.json is mode 600");
process.env.COZYCLAY_CONFIG_DIR = configDir;
response = await request("/agent/providers");
const listed = await response.json();
assert.equal(response.status, 200);
assert.ok(!JSON.stringify(listed).includes("anthropic-secret-value"));
assert.deepEqual(listed.providers.find((provider) => provider.id === "anthropic"), { id: "anthropic", label: "Anthropic", authSource: "file", signedIn: true });
process.env.ANTHROPIC_API_KEY = "environment-secret-value";
response = await request("/agent/providers");
assert.equal((await response.json()).providers.find((provider) => provider.id === "anthropic").authSource, "env");
delete process.env.ANTHROPIC_API_KEY;
assert.equal((await (await request("/agent/providers/anthropic", { method: "DELETE" })).json()).ok, true);
assert.equal((await (await request("/agent/providers")).json()).providers.find((provider) => provider.id === "anthropic").signedIn, false);
assert.equal((await request("/agent/providers/openai-codex", { method: "PUT", body: JSON.stringify({ key: "nope" }) })).status, 400);
assert.equal((await request("/agent/providers/openai", { method: "PUT", body: JSON.stringify({ key: "   " }) })).status, 400);
assert.equal((await request("/agent/providers/openai", { method: "PUT", headers: { origin: "http://evil.example" }, body: JSON.stringify({ key: "nope" }) })).status, 403);
injected.stored = { access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600000 };
const codexStatus = (await (await request("/agent/providers")).json()).providers.find((provider) => provider.id === "openai-codex");
assert.equal(codexStatus.signedIn, true);
assert.equal(codexStatus.authSource, "chatgpt");
server.close();
await once(server, "close");

const fileStore = createCredentialStore({ auth, keys, env: {} });
await auth.logout();
let changes = 0;
auth.onAuthChange(() => { changes += 1; });
await fileStore.modify("openai-codex", async () => ({ type: "oauth", access: "access-token", refresh: "refresh-token", expires: Date.now() + 3600000 }));
assert.deepEqual(await fileStore.read("openai-codex"), { type: "oauth", access: "access-token", refresh: "refresh-token", expires: (await auth.readStored()).expires_at });
assert.equal(statSync(authFile).mode & 0o777, 0o600);
assert.equal(changes, 1);
const models = await providers.createModels({ credentials: fileStore });
assert.equal((await models.getAuth("openai-codex")).auth.apiKey, "access-token");
assert.equal((await providers.resolveModel("gpt-6-astra")).provider, "openai-codex");
await assert.rejects(() => providers.resolveModel("nope/x"), (error) => error.code === "UNKNOWN_MODEL");
keys.removeKey("anthropic");
assert.equal(auth.status().providersConfigured, 0);
keys.setKey("anthropic", "sk-ant-x");
assert.equal(auth.status().providersConfigured, 1);
keys.removeKey("anthropic");
assert.equal(auth.status().providersConfigured, 0);
keys.setKey("anthropic", "file-secret");
const envStore = createCredentialStore({ auth, keys, env: { ANTHROPIC_API_KEY: "env-secret" } });
assert.deepEqual(await envStore.read("anthropic"), { type: "api_key", key: "env-secret" });
assert.ok((await envStore.list()).some((entry) => entry.providerId === "anthropic" && entry.source === "env"));
assert.ok((await envStore.list()).some((entry) => entry.providerId === "openai-codex" && entry.source === "chatgpt"));
{
	// #379: readKeys() treats a corrupt providers.json as the empty-provider
	// boundary — no throw, exactly one console.warn naming the path (never key
	// contents), ENOENT stays silent {}, and setKey repairs the file.
	const corruptDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-providers-corrupt-"));
	const corruptFile = join(corruptDir, "providers.json");
	writeFileSync(corruptFile, "{bad", { mode: 0o600 });
	const previousConfigDir = process.env.COZYCLAY_CONFIG_DIR;
	process.env.COZYCLAY_CONFIG_DIR = corruptDir;
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...args) => warnings.push(args.join(" "));
	let readResult;
	try {
		readResult = keys.readKeys();
	} finally {
		console.warn = originalWarn;
	}
	assert.deepEqual(readResult, {}, "a corrupt providers.json reads as empty, not a throw");
	assert.equal(warnings.length, 1, `exactly one warning: ${JSON.stringify(warnings)}`);
	assert.match(warnings[0], /providers\.json is not valid JSON; ignoring it/);
	assert.ok(warnings[0].includes(corruptFile), "the warning names the offending path");
	assert.ok(!warnings[0].includes("bad"), "the warning never leaks the file contents");
	console.log("PASS readKeys() treats a corrupt providers.json as {} with exactly one warning");

	const previousAnthropicForCorrupt = process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
	assert.equal(auth.status().providersConfigured, 0, "a corrupt providers.json never throws status() and counts as 0 configured");
	process.env.ANTHROPIC_API_KEY = "env-secret-for-corrupt-file";
	assert.equal(auth.status().providersConfigured, 1, "an env key still counts even while the file is corrupt");
	if (previousAnthropicForCorrupt === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousAnthropicForCorrupt;
	console.log("PASS codex-auth status() survives a corrupt providers.json");

	const corruptModels = await providers.listAgentModels({ auth, keys, env: process.env });
	assert.equal(corruptModels.providers.length, 5, "listAgentModels still lists all five providers with a corrupt providers.json");
	assert.ok(corruptModels.providers.every((provider) => provider.id !== "anthropic" || provider.signedIn === false), "the key provider reports signed-out, not an unhandled rejection");
	console.log("PASS listAgentModels tolerates a corrupt providers.json");

	keys.setKey("anthropic", "sk-ant-x");
	assert.deepEqual(keys.readKeys(), { anthropic: "sk-ant-x" }, "setKey repairs the corrupt file");
	assert.equal(statSync(corruptFile).mode & 0o777, 0o600, "the repaired file is still mode 0600");
	console.log("PASS setKey repairs a corrupt providers.json and keeps it mode 0600");

	process.env.COZYCLAY_CONFIG_DIR = previousConfigDir;
	rmSync(corruptDir, { recursive: true, force: true });
}

{
	// #379 (16c): readKeys() must validate EVERY entry in the map, not just the
	// container. Invalid entries (non-string key/value, empty value) must be
	// treated as an untrusted whole file -> {} + exactly one path-only warning.
	const invalidDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-providers-invalid-"));
	const invalidFile = join(invalidDir, "providers.json");
	const previousConfigDir = process.env.COZYCLAY_CONFIG_DIR;
	process.env.COZYCLAY_CONFIG_DIR = invalidDir;
	const previousAnthropicEnv = process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
	const { createCredentialStore: createStoreForInvalid } = await import("../bin/agent/credential-store.mjs");

	const invalidCases = [
		["object value", '{"anthropic":{"key":"x"}}'],
		["non-string mixed", '{"anthropic":42,"openai":"sk-o"}'],
		["empty string value", '{"anthropic":""}'],
		["empty string key", '{"":"sk-x"}'],
	];
	for (const [label, raw] of invalidCases) {
		writeFileSync(invalidFile, raw, { mode: 0o600 });
		const warnings = [];
		const originalWarn = console.warn;
		console.warn = (...args) => warnings.push(args.join(" "));
		let readResult;
		try {
			readResult = keys.readKeys();
		} finally {
			console.warn = originalWarn;
		}
		assert.deepEqual(readResult, {}, `${label}: readKeys() returns {}`);
		assert.equal(warnings.length, 1, `${label}: exactly one warning, got ${JSON.stringify(warnings)}`);
		assert.ok(warnings[0].includes(invalidFile), `${label}: warning names the path`);
		assert.ok(!warnings[0].includes("sk-o"), `${label}: warning does not contain sk-o`);
		assert.equal(auth.status().providersConfigured, 0, `${label}: providersConfigured is 0`);
		const invalidStore = createStoreForInvalid({ auth, keys, env: {} });
		assert.equal(await invalidStore.read("anthropic"), undefined, `${label}: credential store read(anthropic) is undefined`);
		console.log(`PASS readKeys() rejects invalid entry (${label}) -> {} with one path-only warning`);
	}

	// setKey afterwards writes exactly the new map at 0600
	writeFileSync(invalidFile, '{"anthropic":{"key":"x"}}', { mode: 0o600 });
	keys.setKey("openai", "sk-new");
	const afterSet = JSON.parse(readFileSync(invalidFile, "utf8"));
	assert.deepEqual(afterSet, { openai: "sk-new" }, "setKey writes exactly the new map, discarding the invalid file");
	assert.equal(statSync(invalidFile).mode & 0o777, 0o600, "setKey keeps the file mode 0600");
	console.log("PASS setKey(...) after an invalid file writes exactly the new map at 0600");

	// a valid map still round-trips with no warn
	writeFileSync(invalidFile, '{"anthropic":"sk-a"}', { mode: 0o600 });
	const validWarnings = [];
	const originalWarn2 = console.warn;
	console.warn = (...args) => validWarnings.push(args.join(" "));
	let validResult;
	try {
		validResult = keys.readKeys();
	} finally {
		console.warn = originalWarn2;
	}
	assert.deepEqual(validResult, { anthropic: "sk-a" }, "a valid map still round-trips unchanged");
	assert.equal(validWarnings.length, 0, "a valid map produces no warning");
	console.log("PASS a valid providers.json round-trips with no warning");

	if (previousAnthropicEnv === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousAnthropicEnv;
	process.env.COZYCLAY_CONFIG_DIR = previousConfigDir;
	rmSync(invalidDir, { recursive: true, force: true });
}

for (const [name, value] of Object.entries(previousProviderEnv)) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
console.log("agent provider verification passed");
