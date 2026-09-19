import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
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
for (const [name, value] of Object.entries(previousProviderEnv)) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
console.log("agent provider verification passed");
