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
const providerEnvNames = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "CLIPROXY_API_KEY", "CLIPROXY_BASE_URL"];
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
	assert.equal(corruptModels.providers.length, 6, "listAgentModels still lists all six providers with a corrupt providers.json");
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

{
	// #379 (16n, F2 pass 6 finding 3): the process-wide codex fetch wrapper
	// installed by loadProvider('openai-codex') must (a) never let observation
	// affect the returned Response, even when the RequestInfo's `url` getter
	// throws or the observer itself throws, and (b) match ONLY the exact codex
	// responses pathname ('/codex/responses'), not a substring anywhere in the
	// URL. `providers.mjs` is already imported (and its wrapper already
	// installed) earlier in this same process, so a fresh module instance
	// (cache-busted) is required to observe install-time behavior with a
	// controlled stub standing in for the native fetch.
	const originalFetch = globalThis.fetch;
	const stubResponses = new Map();
	const stubCalls = [];
	globalThis.fetch = async (input, init) => {
		stubCalls.push({ input, init });
		const key = stubCalls.length - 1;
		const prepared = stubResponses.get(key) ?? new Response("native-body");
		return prepared;
	};
	try {
		const freshProviders = await import(`../bin/agent/providers.mjs?fetchContract=${Date.now()}-${Math.random()}`);
		await freshProviders.loadProvider("openai-codex");

		// (a) a RequestInfo whose `url` getter throws, but is string-coercible,
		// resolves to the native Response (no throw).
		const throwingUrlInput = { toString: () => "https://exotic.invalid/unrelated", get url() { throw new Error("unrelated url getter evaluated"); } };
		const nativeResponse = new Response("native-body-a");
		stubResponses.set(stubCalls.length, nativeResponse);
		const resultA = await fetch(throwingUrlInput);
		assert.equal(resultA, nativeResponse, "a throwing url getter must not prevent the native Response from being returned");
		console.log("PASS (a) string-coercible RequestInfo with a throwing url getter resolves to the native Response");

		// (b) a URL object and a Request for the codex responses path ARE observed.
		const codexUrlObject = new URL("https://chatgpt.invalid/backend-api/codex/responses");
		const seenB1 = [];
		stubResponses.set(stubCalls.length, new Response("b1", { headers: { "x-observer": "b1" } }));
		await freshProviders.codexResponseObserver.run((event) => seenB1.push(event), () => fetch(codexUrlObject));
		assert.equal(seenB1.length, 1, "a URL object naming the codex responses endpoint must be observed");

		const codexRequest = new Request("https://chatgpt.invalid/backend-api/codex/responses", { method: "POST", body: "x" });
		const seenB2 = [];
		stubResponses.set(stubCalls.length, new Response("b2", { headers: { "x-observer": "b2" } }));
		await freshProviders.codexResponseObserver.run((event) => seenB2.push(event), () => fetch(codexRequest));
		assert.equal(seenB2.length, 1, "a Request for the codex responses endpoint must be observed");
		console.log("PASS (b) a URL object and a Request naming the codex responses endpoint are observed");

		// (c) /other?next=/codex/responses and /codex/responses-backup are NOT observed.
		const seenC1 = [];
		stubResponses.set(stubCalls.length, new Response("c1"));
		await freshProviders.codexResponseObserver.run((event) => seenC1.push(event), () => fetch("https://chatgpt.invalid/other?next=/codex/responses"));
		assert.equal(seenC1.length, 0, "a query string containing the codex path must not be observed");

		const seenC2 = [];
		stubResponses.set(stubCalls.length, new Response("c2"));
		await freshProviders.codexResponseObserver.run((event) => seenC2.push(event), () => fetch("https://chatgpt.invalid/codex/responses-backup"));
		assert.equal(seenC2.length, 0, "a sibling path with a shared prefix must not be observed");
		console.log("PASS (c) /other?next=/codex/responses and /codex/responses-backup are not observed");

		// (d) a string codex URL is observed exactly once.
		const seenD = [];
		stubResponses.set(stubCalls.length, new Response("d"));
		await freshProviders.codexResponseObserver.run((event) => seenD.push(event), () => fetch("https://chatgpt.invalid/backend-api/codex/responses"));
		assert.equal(seenD.length, 1, "a string codex URL must be observed exactly once");
		console.log("PASS (d) a string codex URL is observed exactly once");

		// (e) an observer that throws never affects the returned Response.
		const nativeResponseE = new Response("native-body-e");
		stubResponses.set(stubCalls.length, nativeResponseE);
		const resultE = await freshProviders.codexResponseObserver.run(() => { throw new Error("observer boom"); }, () => fetch("https://chatgpt.invalid/backend-api/codex/responses"));
		assert.equal(resultE, nativeResponseE, "a throwing observer must never affect the returned Response");
		console.log("PASS (e) a throwing observer never affects the returned Response");
	} finally {
		globalThis.fetch = originalFetch;
	}
}

// #400: CLIProxyAPI is a selectable provider with environment/file credentials,
// per-API base URLs, a cached live intersection, and both upstream wire formats.
{
	const key = "cliproxy-test-key";
	let catalogueCalls = 0;
	const baseServer = createServer((req, res) => {
		if (req.method === "GET" && req.url === "/v1/models") {
			catalogueCalls++;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "gpt-6-astra" }, { id: "claude-sonnet-5" }, { id: "not-in-pi" }] }));
			return;
		}
		res.writeHead(404); res.end();
	});
	baseServer.listen(0, "127.0.0.1"); await once(baseServer, "listening");
	const base = `http://127.0.0.1:${baseServer.address().port}`;
	const auth = { readStored: () => undefined };
	const noKeys = { readKeys: () => ({}) };
	const env = { CLIPROXY_API_KEY: key, CLIPROXY_BASE_URL: `${base}/` };
	const envRegistry = await providers.createModels({ auth, keys: noKeys, env });
	const envStatus = await providers.listAgentModels({ models: envRegistry, auth, keys: noKeys, env });
	const cliproxy = envStatus.providers.find((provider) => provider.id === "cliproxy");
	assert.equal((await providers.listAgentModels({ models: envRegistry, auth, keys: noKeys, env })).providers.find((provider) => provider.id === "cliproxy").models.length, 2);
	assert.equal(catalogueCalls, 1);
	assert.equal(cliproxy.signedIn, true);
	assert.equal(cliproxy.authSource, "env");
	assert.deepEqual(cliproxy.models.map((model) => model.id), ["gpt-6-astra", "claude-sonnet-5"]);
	const openaiModel = envRegistry.getModel("cliproxy", "gpt-6-astra");
	const anthropicModel = envRegistry.getModel("cliproxy", "claude-sonnet-5");
	assert.equal(openaiModel.provider, "cliproxy");
	assert.equal(openaiModel.baseUrl, `${base}/v1`);
	assert.equal(anthropicModel.provider, "cliproxy");
	assert.equal(anthropicModel.baseUrl, base);
	const fileRegistry = await providers.createModels({ auth, keys: { readKeys: () => ({ cliproxy: key }) }, env: { CLIPROXY_BASE_URL: base }});
	assert.equal((await providers.listAgentModels({ models: fileRegistry, auth, keys: { readKeys: () => ({ cliproxy: key }) }, env: { CLIPROXY_BASE_URL: base }})).providers.find((provider) => provider.id === "cliproxy").authSource, "file");
	const signedOut = await providers.listAgentModels({ models: await providers.createModels({ auth, keys: noKeys, env: { CLIPROXY_BASE_URL: base }}), auth, keys: noKeys, env: { CLIPROXY_BASE_URL: base }});
	assert.equal(signedOut.providers.find((provider) => provider.id === "cliproxy").signedIn, false);
	assert.equal(signedOut.providers.find((provider) => provider.id === "cliproxy").models.length > 0, true);
	await new Promise((resolve) => baseServer.close(resolve));

	const failing = createServer((req, res) => { res.writeHead(500); res.end("nope"); });
	failing.listen(0, "127.0.0.1"); await once(failing, "listening");
	const failingBase = `http://127.0.0.1:${failing.address().port}`;
	const fallbackModels = await providers.createModels({ auth, keys: noKeys, env: { CLIPROXY_API_KEY: key, CLIPROXY_BASE_URL: failingBase }});
	const fallback = await providers.listAgentModels({ models: fallbackModels, auth, keys: noKeys, env: { CLIPROXY_API_KEY: key, CLIPROXY_BASE_URL: failingBase }});
	const staticCount = fallbackModels.getModels("cliproxy").filter((model) => model.input.includes("text") && model.input.includes("image")).length;
	assert.equal(fallback.providers.find((provider) => provider.id === "cliproxy").models.length, staticCount);
	await new Promise((resolve) => failing.close(resolve));

	const requests = [];
	const upstream = createServer(async (req, res) => {
		requests.push({ path: new URL(req.url, "http://local").pathname, authorization: req.headers.authorization, apiKey: req.headers["x-api-key"] });
		for await (const _chunk of req) { /* consume the request before replying */ }
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (req.url === "/v1/responses") {
			res.end([`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", content: [] } })}`, `data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "pong" })}`, `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "pong" }] } })}`, `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }] } })}`].join("\n\n") + "\n\n");
		} else {
			res.end([`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg-test", type: "message", role: "assistant", content: [], model: "claude-sonnet-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}`, `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`, `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } })}`, `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`, `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}`, `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`].join("\n\n") + "\n\n");
		}
	});
	upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
	const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
	const turnModels = await providers.createModels({ auth, keys: noKeys, env: { CLIPROXY_API_KEY: key, CLIPROXY_BASE_URL: upstreamBase }});
	const handler = createAgentHandler({ models: turnModels, auth, env: { CLIPROXY_API_KEY: key, CLIPROXY_BASE_URL: upstreamBase }, handlers: [], liveHub: {}, port: () => sidecar.address().port });
	const sidecar = createServer((req, res) => handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	sidecar.listen(0, "127.0.0.1"); await once(sidecar, "listening");
	const sidecarOrigin = `http://127.0.0.1:${sidecar.address().port}`;
	for (const model of ["cliproxy/gpt-6-astra", "cliproxy/claude-sonnet-5"]) {
		const response = await fetch(`${sidecarOrigin}/agent/turn`, { method: "POST", headers: { origin: sidecarOrigin, "content-type": "application/json" }, body: JSON.stringify({ sessionId: model.replaceAll("/", "-"), text: "reply pong", model }), signal: AbortSignal.timeout(10000) });
		assert.equal(response.status, 200);
		const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
		assert.equal(frames.some((frame) => frame.type === "error"), false, `${model} turn has no error`);
	}
	assert.deepEqual(requests.map((request) => ({ path: request.path, authorization: request.authorization, apiKey: request.apiKey })), [
		{ path: "/v1/responses", authorization: `Bearer ${key}`, apiKey: undefined },
		{ path: "/v1/messages", authorization: undefined, apiKey: key },
	]);
	await handler.close(); await new Promise((resolve) => sidecar.close(resolve)); await new Promise((resolve) => upstream.close(resolve));
}

for (const [name, value] of Object.entries(previousProviderEnv)) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
console.log("agent provider verification passed");

// #379 / 16w: live catalogue entries belong to the registry/account that
// discovered them, not to every registry in this process.
{
	const tokenFor = account => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.e30`;
	const authFor = account => ({ getAccessToken: async () => tokenFor(account), readStored: () => ({ access_token: tokenFor(account), refresh_token: `${account}-refresh`, expires_at: Date.now() + 3600000 }), status: () => ({ signedIn: true }) });
	const signedOut = { getAccessToken: async () => null, readStored: () => undefined, status: () => ({ signedIn: false }) };
	const keys = { readKeys: () => ({}) };
	let aCalls = 0, bCalls = 0;
	const aClient = { listModels: async () => { aCalls++; return [{ slug: "gpt-16w-account-a", supported_reasoning_levels: ["medium"] }]; } };
	const bClient = { listModels: async () => { bCalls++; return [{ slug: "gpt-16w-account-b", supported_reasoning_levels: ["low"] }]; } };
	const a = await providers.createModels({ auth: authFor("account-a"), keys, env: {}, codexBaseUrl: "http://127.0.0.1:61121" });
	const aFirst = await providers.listAgentModels({ models: a, codex: aClient, auth: authFor("account-a"), keys, env: {} });
	const aSecond = await providers.listAgentModels({ models: a, codex: aClient, auth: authFor("account-a"), keys, env: {} });
	const b = await providers.createModels({ auth: authFor("account-b"), keys, env: {}, codexBaseUrl: "http://127.0.0.1:61122" });
	const bList = await providers.listAgentModels({ models: b, codex: bClient, auth: authFor("account-b"), keys, env: {} });
	const c = await providers.createModels({ auth: signedOut, keys, env: {}, codexBaseUrl: "http://127.0.0.1:61123" });
	const cList = await providers.listAgentModels({ models: c, codex: aClient, auth: signedOut, keys, env: {} });
	assert.ok(aFirst.models.some(model => model.id === "openai-codex/gpt-16w-account-a"));
	assert.ok(aSecond.models.some(model => model.id === "openai-codex/gpt-16w-account-a"));
	assert.equal(aCalls, 1, "registry A fetches its catalogue once");
	assert.ok(bList.models.some(model => model.id === "openai-codex/gpt-16w-account-b"), "registry B advertises its own live model");
	assert.equal(bList.models.some(model => model.id === "openai-codex/gpt-16w-account-a"), false, "registry B does not inherit A's live model");
	assert.equal(bCalls, 1, "registry B fetches its catalogue once");
	assert.equal(cList.models.some(model => model.id === "openai-codex/gpt-16w-account-a"), false, "signed-out registry C does not inherit A's live model");
	assert.equal(cList.models.some(model => model.id === "openai-codex/gpt-16w-account-b"), false, "signed-out registry C does not inherit B's live model");
	assert.equal(a.getModel("openai-codex", "gpt-16w-account-a")?.id, "gpt-16w-account-a");
	assert.equal(b.getModel("openai-codex", "gpt-16w-account-b")?.id, "gpt-16w-account-b");
	assert.equal(c.getModel("openai-codex", "gpt-16w-account-a"), undefined);
	console.log("PASS 16w: live Codex catalogues are isolated per registry and account");
}

// #379 / 16s: a live-only model advertised by the real, non-injected route
// must reach the real Codex HTTP provider, not stop at UNKNOWN_MODEL.
{
	const { zstdDecompressSync } = await import("node:zlib");
	const { createCodexClient } = await import("../bin/agent/codex-client.mjs");
	const liveId = "gpt-future-16s-live-only";
	const noneId = "gpt-future-16s-none";
	const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "16s-fixture" } })).toString("base64url")}.e30`;
	const fixtureAuth = {
		getAccessToken: async () => token,
		readStored: () => ({ access_token: token, refresh_token: "fixture-refresh", expires_at: Date.now() + 3600000 }),
		status: () => ({ signedIn: true }),
	};
	let catalogueCalls = 0;
	const received = [];
	const fixture = createServer(async (req, res) => {
		if (req.method === "GET") {
			catalogueCalls++;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ models: [
				{ slug: liveId, supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }] },
				{ slug: noneId, supported_reasoning_levels: ["none", "medium", "high"] },
			] }));
			return;
		}
		const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const encoded = Buffer.concat(chunks);
		const body = JSON.parse((req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(encoded) : encoded).toString("utf8"));
		received.push({ path: req.url, model: body.model, ...(body.reasoning?.effort !== undefined ? { effort: body.reasoning.effort } : {}) });
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`);
	});
	const listening = once(fixture, "listening", { signal: AbortSignal.timeout(5000) });
	fixture.listen(0, "127.0.0.1"); await listening;
	const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
	const codex = createCodexClient({ getAccessToken: fixtureAuth.getAccessToken, getAccountId: async () => "16s-fixture", fetch: (_url, init) => fetch(`${fixtureOrigin}/models`, init) });
	const staticRegistry = await providers.createModels({ auth: fixtureAuth, codexBaseUrl: fixtureOrigin });
	assert.equal(staticRegistry.getModel("openai-codex", liveId), undefined, "the live id is absent from pi's static catalogue");
	const staticModel = staticRegistry.getModel("openai-codex", "gpt-6-astra");
	let sidecar;
	const liveHandler = createAgentHandler({ auth: fixtureAuth, codex, codexBaseUrl: fixtureOrigin, handlers: [], liveHub: {}, port: () => sidecar.address().port });
	sidecar = createServer((req, res) => liveHandler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	const ready = once(sidecar, "listening", { signal: AbortSignal.timeout(5000) });
	sidecar.listen(0, "127.0.0.1"); await ready;
	const sidecarOrigin = `http://127.0.0.1:${sidecar.address().port}`;
	const getCatalogue = async () => {
		const response = await fetch(`${sidecarOrigin}/agent/models`, { signal: AbortSignal.timeout(8000) });
		assert.equal(response.status, 200);
		return response.json();
	};
	try {
		const catalogue = await getCatalogue();
		const advertised = catalogue.models.find((model) => model.id === `openai-codex/${liveId}`);
		assert.ok(advertised, "GET /agent/models advertises the live-only id");
		assert.deepEqual(advertised.efforts, ["medium", "high"]);
		for (const model of [advertised.id, "openai-codex/gpt-6-astra", advertised.id]) {
			const response = await fetch(`${sidecarOrigin}/agent/turn`, {
				method: "POST", headers: { origin: sidecarOrigin, "content-type": "application/json" },
				body: JSON.stringify({ sessionId: "16s-live-catalogue", text: "hello", model, effort: "medium" }), signal: AbortSignal.timeout(8000),
			});
			assert.equal(response.status, 200);
			const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
			assert.deepEqual(frames.filter((frame) => frame.type === "error"), [], "an advertised model executes without UNKNOWN_MODEL or provider errors");
			assert.equal(frames.at(-1)?.type, "done");
		}
		const effortMismatches = [];
		const checkEffort = (assertion) => { try { assertion(); } catch (error) { effortMismatches.push(error.message); } };
		const noneAdvertised = catalogue.models.find((model) => model.id === `openai-codex/${noneId}`);
		checkEffort(() => assert.ok(noneAdvertised, "GET /agent/models advertises the live no-reasoning id"));
		checkEffort(() => assert.deepEqual(noneAdvertised?.efforts, ["none", "medium", "high"]));
		checkEffort(() => assert.equal(noneAdvertised?.defaultEffort, "medium"));
		const noneRegistry = await providers.createModels({ auth: fixtureAuth, codexBaseUrl: fixtureOrigin });
		await providers.listAgentModels({ models: noneRegistry, codex, auth: fixtureAuth, keys: { readKeys: () => ({}) }, env: {} });
		const noneModel = noneRegistry.getModel("openai-codex", noneId);
		checkEffort(() => assert.equal(noneModel?.thinkingLevelMap?.off, "off"));
		checkEffort(() => assert.equal(noneModel?.thinkingLevelMap?.minimal, null));
		checkEffort(() => assert.equal(noneModel?.thinkingLevelMap?.low, null));
		checkEffort(() => assert.equal(noneModel?.thinkingLevelMap?.medium, "medium"));
		checkEffort(() => assert.equal(noneModel?.thinkingLevelMap?.high, "high"));
		checkEffort(() => assert.equal(noneModel?.thinkingLevelMap?.xhigh, null));
		checkEffort(() => assert.equal(noneModel?.thinkingLevelMap?.max, null));
		const noReasoningResponse = await fetch(`${sidecarOrigin}/agent/turn`, {
			method: "POST", headers: { origin: sidecarOrigin, "content-type": "application/json" },
			body: JSON.stringify({ sessionId: "16s-live-none", text: "hello", model: noneAdvertised.id, effort: "none" }), signal: AbortSignal.timeout(8000),
		});
		assert.equal(noReasoningResponse.status, 200);
		const noReasoningFrames = [...(await noReasoningResponse.text()).matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
		checkEffort(() => assert.deepEqual(noReasoningFrames.filter((frame) => frame.type === "error"), []));
		checkEffort(() => assert.equal(noReasoningFrames.at(-1)?.type, "done"));
		checkEffort(() => assert.deepEqual(received, [liveId, "gpt-6-astra", liveId, noneId].map((model, index) => ({ path: "/codex/responses", model, ...(index === 3 ? {} : { effort: "medium" }) })), "the provider preserves no-reasoning instead of escalating it"));
		assert.deepEqual(effortMismatches, [], `live no-reasoning effort mismatches: ${JSON.stringify(effortMismatches)}`);
		const refreshed = await Promise.all([getCatalogue(), getCatalogue()]);
		assert.ok(refreshed.every((result) => result.models.some((model) => model.id === advertised.id)));
		assert.equal(catalogueCalls, 2, "each registry fetches its live catalogue once");
		assert.deepEqual(noneRegistry.getModel("openai-codex", "gpt-6-astra"), staticModel, "registration preserves static model metadata");
		console.log("PASS 16s: live-only and static Codex models execute through HTTP; listings and turns fetch the catalogue once");
	} finally {
		await liveHandler.close();
		for (const server of [sidecar, fixture]) {
			const closed = once(server, "close", { signal: AbortSignal.timeout(5000) });
			server.close(); server.closeAllConnections(); await closed;
		}
	}
}
