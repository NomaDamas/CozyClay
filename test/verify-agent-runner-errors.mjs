// Retry, abort and error mapping on the pi runner (#379): a scripted faux
// provider throws provider-shaped errors (`errorMessage` text pi's own
// `isRetryableAssistantError` classifies) so the harness's `retry` policy —
// not any code in this test — does the actual retrying. A real Codex HTTP
// fixture also verifies effort mapping through the harness to the wire.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { zstdDecompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentRunner, classifyError } from "../bin/agent/agent-runner.mjs";
import { createSessionStore } from "../bin/agent/session-store.mjs";
import { createModels as createAgentModels } from "../bin/agent/providers.mjs";

process.env.COZYCLAY_AGENT_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-"));

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

async function collect(session, input) {
	const frames = [];
	for await (const frame of session.start(input)) frames.push(frame);
	return frames;
}

/** Queues `steps` (each either an assistant message or a factory) on `faux`
 * and returns the array of contexts pi actually sent it, one per attempt. */
function installScripts(faux, steps) {
	const calls = [];
	faux.setResponses(steps.map((step) => async (context) => {
		calls.push(context);
		return typeof step === "function" ? step() : step;
	}));
	return calls;
}

function errorMessage(text) {
	return fauxAssistantMessage([], { stopReason: "error", errorMessage: text });
}

// --- Wire efforts use the real runner, harness, auth and Codex API module.
// Astra does not advertise off, but an explicit none must still omit reasoning.
{
	const received = [];
	const fixture = createServer(async (req, res) => {
		const chunks = []; for await (const chunk of req) chunks.push(chunk);
		const encoded = Buffer.concat(chunks);
		const body = JSON.parse((req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(encoded) : encoded).toString());
		received.push({ path: req.url, body });
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`);
	});
	const listening = once(fixture, "listening", { signal: AbortSignal.timeout(5000) });
	fixture.listen(0, "127.0.0.1"); await listening;
	const codexBaseUrl = `http://127.0.0.1:${fixture.address().port}`;
	const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "runner-effort-fixture" } })).toString("base64url")}.e30`;
	const auth = { readStored: () => ({ access_token: token, refresh_token: "fixture-refresh", expires_at: Date.now() + 3600000 }) };
	let runner;
	try {
		const models = await createAgentModels({ auth, keys: { readKeys: () => ({}) }, env: {}, codexBaseUrl });
		const metadata = structuredClone(models.getModels("openai-codex"));
		assert.equal(models.getModel("openai-codex", "gpt-6-astra").thinkingLevelMap.off, null, "Astra must exercise the unsupported-off case");
		runner = createAgentRunner({ models, codexBaseUrl });
		const check = async (session, model, effort, expectedEffort, label) => {
			const before = received.length;
			const frames = await collect(session, { text: "hello", model: `openai-codex/${model}`, ...(effort === undefined ? {} : { effort }), signal: AbortSignal.timeout(8000) });
			assert.deepEqual(frames.filter((frame) => frame.type === "error"), [], label);
			assert.equal(frames.filter((frame) => frame.type === "done").length, 1, label);
			assert.equal(frames.at(-1)?.type, "done", label);
			assert.equal(received.length, before + 1, `${label}: exactly one provider request`);
			const request = received.at(-1);
			assert.equal(request.path, "/codex/responses");
			assert.equal(request.body.model, model);
			console.log("runner-effort-wire", JSON.stringify({ label, model, effort, reasoning: request.body.reasoning ?? null }));
			expect(label, expectedEffort === undefined ? !Object.hasOwn(request.body, "reasoning") : request.body.reasoning?.effort === expectedEffort, JSON.stringify(request.body.reasoning));
		};
		const freshCases = [
			["gpt-6-astra", "none", undefined],
			["gpt-5.4", "none", undefined],
			["gpt-6-astra", "high", "high"],
			["gpt-6-astra", "ultra", "max"],
			["gpt-5.4", "ultra", "xhigh"],
			// With no initial effort the harness default is off, not medium.
			["gpt-6-astra", undefined, undefined],
			["gpt-5.4", undefined, undefined],
		];
		for (const [index, [model, effort, expected]] of freshCases.entries()) {
			const session = await runner.openSession(`effort-fresh-${index}`);
			await check(session, model, effort, expected, `fresh ${model} ${effort ?? "omitted"} preserves wire effort`);
		}
		const reused = await runner.openSession("effort-reused");
		for (const [model, effort, expected] of [
			["gpt-6-astra", "high", "high"],
			["gpt-6-astra", "none", undefined],
			["gpt-6-astra", undefined, undefined],
			["gpt-5.4", "ultra", "xhigh"],
			["gpt-5.4", undefined, "xhigh"],
			["gpt-6-astra", "none", undefined],
		]) await check(reused, model, effort, expected, `reused ${model} ${effort ?? "omitted"} preserves wire effort`);
		assert.deepEqual(models.getModels("openai-codex"), metadata, "turn effort must not mutate advertised model metadata");
	} finally {
		await runner?.close();
		const closed = once(fixture, "close", { signal: AbortSignal.timeout(5000) });
		fixture.close(); fixture.closeAllConnections(); await closed;
	}
}

// --- 429 twice then success: pi's own retry (maxRetries:2) absorbs both, one turn ---
{
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("429 Too Many Requests"), errorMessage("429 Too Many Requests"), fauxAssistantMessage([fauxText("done")])]);
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession("errors-429", { surface: "workflow" });
	const frames = await collect(session, { text: "hi", model: "faux/scripted" });
	await runner.close();
	expect("429 twice then success completes with one done frame and no error frame", frames.filter((f) => f.type === "done").length === 1 && frames.every((f) => f.type !== "error"), JSON.stringify(frames));
	expect("the model was called exactly 3 times (1 initial + 2 retries)", calls.length === 3, `calls.length=${calls.length}`);
	expect("the surviving text reached the panel", frames.some((f) => f.type === "text.delta" && f.text) || frames.some((f) => f.type === "text.delta"), JSON.stringify(frames));
}

// --- provider-shaped key material in an upstream error is never exposed ---
for (const token of ["AIza-secret-0123456789abcdefghijk", "sk-or-secret", "sk-ant-secret", "sk-secret", "Bearer secret", "eyJsecret"]) {
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	installScripts(faux, [() => { throw new Error(`provider key ${token}`); }]);
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession("errors-sanitized-key", { surface: "workflow" });
	const frames = await collect(session, { text: "hi", model: "faux/scripted" });
	await runner.close();
	const error = frames.find((frame) => frame.type === "error");
	expect(`provider key material (${token.split("secret")[0]}) is redacted from the runner error frame`, !!error && !error.message.includes("AIza") && !error.message.includes("secret"), JSON.stringify(error));
}

// --- 529 three times: retries exhausted (maxRetries:2 = 3 attempts total) -> error{code:'overloaded'} ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-overloaded-store-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("500 overloaded"), errorMessage("500 overloaded"), errorMessage("500 overloaded"), fauxAssistantMessage([fauxText("recovered after overload")])]);
	const runner = createAgentRunner({ models, tools: [], sessionStore });
	const session = await runner.openSession("errors-529", { surface: "workflow" });
	const frames = await collect(session, { text: "hi", model: "faux/scripted" });
	const firstHistory = sessionStore.read("errors-529")?.history || [];
	console.log("16a-overloaded-store-roles", JSON.stringify(firstHistory.map((message) => message.role)));
	const error = frames.find((f) => f.type === "error");
	expect("529 three times exhausts retries with one error frame", !!error, JSON.stringify(frames));
	expect("the error frame carries code:'overloaded'", error?.code === "overloaded", JSON.stringify(error));
	expect("a done frame follows the error frame", frames.at(-1)?.type === "done", JSON.stringify(frames));
	expect("the model was called exactly 3 times", calls.length === 3, `calls.length=${calls.length}`);
	expect("overloaded failures persist only the user message", JSON.stringify(firstHistory.map((message) => message.role)) === "[\"user\"]", JSON.stringify(firstHistory));
	await collect(session, { text: "recover", model: "faux/scripted" });
	const finalHistory = sessionStore.read("errors-529")?.history || [];
	expect("a successful turn after overload persists [user,user,assistant]", JSON.stringify(finalHistory.map((message) => message.role)) === "[\"user\",\"user\",\"assistant\"]", JSON.stringify(finalHistory));
	expect("the successful post-overload assistant is recovered", finalHistory.at(-1)?.content?.[0]?.text === "recovered after overload", JSON.stringify(finalHistory.at(-1)));
	await runner.close();
	console.log("16a-overloaded-final-roles", JSON.stringify(finalHistory.map((message) => message.role)));
}

// --- truncated provider stream: failed assistant entries never reach JSONL ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-truncated-store-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("response ended before a terminal response event"), fauxAssistantMessage([fauxText("recovered after truncation")])]);
	const runner = createAgentRunner({ models, tools: [], sessionStore });
	const session = await runner.openSession("errors-truncated", { surface: "workflow" });
	const frames = await collect(session, { text: "truncated", model: "faux/scripted" });
	const firstHistory = sessionStore.read("errors-truncated")?.history || [];
	console.log("16a-truncated-store-roles", JSON.stringify(firstHistory.map((message) => message.role)));
	const error = frames.find((f) => f.type === "error");
	assert.equal(error?.code, "truncated");
	assert.equal(frames.at(-1)?.type, "done");
	expect("truncated failures persist only the user message", JSON.stringify(firstHistory.map((message) => message.role)) === "[\"user\"]", JSON.stringify(firstHistory));
	await collect(session, { text: "recover truncation", model: "faux/scripted" });
	const finalHistory = sessionStore.read("errors-truncated")?.history || [];
	expect("a successful turn after truncation persists [user,user,assistant]", JSON.stringify(finalHistory.map((message) => message.role)) === "[\"user\",\"user\",\"assistant\"]", JSON.stringify(finalHistory));
	expect("the successful post-truncation assistant is recovered", finalHistory.at(-1)?.content?.[0]?.text === "recovered after truncation", JSON.stringify(finalHistory.at(-1)));
	expect("truncated scenario uses one initial and one successful provider call", calls.length === 2, `calls.length=${calls.length}`);
	await runner.close();
	console.log("16a-truncated-final-roles", JSON.stringify(finalHistory.map((message) => message.role)));
}

// --- 401 on openai-codex: the credential-store refresh path runs once, then one retry ---
{
	const models = createModels();
	const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6-astra", name: "Astra", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("401 Unauthorized"), fauxAssistantMessage([fauxText("recovered")])]);
	const authCalls = [];
	const originalGetAuth = models.getAuth.bind(models);
	models.getAuth = async (...args) => {
		if (args[1]?.minOAuthValidityMs !== undefined) authCalls.push(args);
		return originalGetAuth(...args);
	};
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession("errors-401", { surface: "workflow" });
	const frames = await collect(session, { text: "hi" }); // default model resolves to openai-codex/gpt-6-astra
	await runner.close();
	expect("the credential-store refresh path (Models.getAuth forced-expiry) runs exactly once", authCalls.length === 1, `authCalls.length=${authCalls.length}`);
	expect("the turn is retried exactly once and recovers", calls.length === 2 && frames.every((f) => f.type !== "error") && frames.at(-1)?.type === "done", JSON.stringify(frames));
}

// --- 401 retry continues the existing transcript, preserving one attachment ---
{
	const models = createModels();
	const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6-astra", name: "Astra", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("401 Unauthorized"), fauxAssistantMessage([fauxText("recovered with the original image")])]);
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession("errors-401-attachment", { surface: "workflow" });
	const frames = await collect(session, {
		text: "describe this image",
		attachments: [{ dataUrl: "data:image/png;base64,AA==", name: "probe.png" }],
	});
	await runner.close();
	const counts = calls.map((context) => context.messages.length);
	const imageCounts = calls.map((context) => context.messages.filter((message) => message.role === "user" && message.content?.some((part) => part.type === "image")).length);
	expect("401 retry resumes the same transcript with one attachment (message counts [2,2])", JSON.stringify(counts) === "[2,2]", JSON.stringify(counts));
	expect("401 retry preserves exactly one image-bearing user message", JSON.stringify(imageCounts) === "[1,1]", JSON.stringify(imageCounts));
	// The original roles, text and image bytes survive the in-place retry.
	const content = (context) => JSON.stringify(context.messages.map(({ role, content: parts }) => ({ role, content: parts })));
	expect("401 retry keeps the original user messages and image bytes unchanged", content(calls[0]) === content(calls[1]), JSON.stringify(calls.map(content)));
	expect("401 attachment retry still completes without an error frame", frames.every((frame) => frame.type !== "error") && frames.at(-1)?.type === "done", JSON.stringify(frames));
}

// --- auth retry after a completed tool must not execute that tool again ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-post-tool-auth-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6-astra", name: "Astra", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	let mutations = 0, refreshes = 0;
	const originalGetAuth = models.getAuth.bind(models);
	models.getAuth = async (...args) => {
		if (args[1]?.minOAuthValidityMs !== undefined) refreshes++;
		return originalGetAuth(...args);
	};
	const calls = [];
	const mutate = (id) => fauxAssistantMessage([fauxToolCall("mutate", {}, { id })], { stopReason: "toolUse" });
	faux.setResponses([
		() => mutate("first-mutation"),
		() => errorMessage("401 Unauthorized"),
		(context) => context.messages.some((message) => message.role === "toolResult")
			? fauxAssistantMessage([fauxText("already applied")]) : mutate("replayed-mutation"),
		() => fauxAssistantMessage([fauxText("done")]),
	].map((respond) => (context) => { calls.push(structuredClone(context)); return respond(context); }));
	const runner = createAgentRunner({ models, sessionStore, tools: [{ name: "mutate", parameters: { type: "object", properties: {}, additionalProperties: false }, handler: async () => ({ applied: ++mutations }) }] });
	let frames;
	try {
		const session = await runner.openSession("errors-post-tool-auth", { surface: "workflow" });
		frames = await collect(session, { text: "apply this change once" });
	} finally { await runner.close(); }
	const history = sessionStore.read("errors-post-tool-auth")?.history || [];
	console.log("post-tool-auth", JSON.stringify({ mutations, refreshes, contexts: calls.map((context) => context.messages.map((message) => message.role)), roles: history.map((message) => message.role), frames }));
	assert.equal(mutations, 1, "auth recovery must not execute an already completed mutation again");
	assert.equal(refreshes, 1);
	assert.deepEqual(calls.map((context) => context.messages.map((message) => message.role)), [["user"], ["user", "assistant", "toolResult"], ["user", "assistant", "toolResult"]]);
	assert.deepEqual(calls[2].messages, calls[1].messages, "the pending model call retries with the exact completed transcript");
	assert.deepEqual(history.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
	assert.equal(history[2].toolCallId, "first-mutation");
	assert.equal(history[2].details.applied, 1);
	assert.equal(history.at(-1).content[0].text, "already applied");
	assert.deepEqual(frames.filter((frame) => frame.type === "tool.start" || frame.type === "tool.done").map((frame) => [frame.type, frame.callId]), [["tool.start", "first-mutation"], ["tool.done", "first-mutation"]]);
	assert.equal(frames.find((frame) => frame.type === "tool.done").ok, true);
	assert.equal(frames.some((frame) => frame.type === "error"), false);
	assert.equal(frames.filter((frame) => frame.type === "done").length, 1);
	assert.equal(frames.at(-1).type, "done");
	console.log("PASS post-tool auth retry preserves the completed mutation, transcript, persistence and tool frames");
}

// --- auth retry persistence stores the completed transcript once ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-retry-store-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6-astra", name: "Astra", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	installScripts(faux, [errorMessage("401 Unauthorized"), fauxAssistantMessage([fauxText("recovered")])]);
	const runner = createAgentRunner({ models, tools: [], sessionStore });
	const session = await runner.openSession("errors-401-persist", { surface: "workflow" });
	await collect(session, { text: "describe this image", attachments: [{ dataUrl: "data:image/png;base64,AA==", name: "probe.png" }] });
	await runner.close();
	const history = sessionStore.read("errors-401-persist")?.history || [];
	assert.deepEqual(history.map((message) => message.role), ["user", "user", "assistant"]);
	assert.equal(history.at(-1).content?.[0]?.text, "recovered");
	assert.equal(history.some((message) => message.errorMessage === "401 Unauthorized"), false);
	console.log("retry-store-roles", JSON.stringify(history.map((message) => message.role)));
	console.log("retry-store-history", JSON.stringify(history));
	console.log("PASS auth retry persistence stores the final branch once, including the recovered assistant");
}

// --- ordinary two-turn persistence remains user/assistant per turn ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-two-turn-store-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	installScripts(faux, [fauxAssistantMessage([fauxText("first")]), fauxAssistantMessage([fauxText("second")])]);
	const runner = createAgentRunner({ models, tools: [], sessionStore });
	const session = await runner.openSession("errors-two-turn-persist", { surface: "workflow" });
	await collect(session, { text: "one", model: "faux/scripted" });
	await collect(session, { text: "two", model: "faux/scripted" });
	await runner.close();
	const history = sessionStore.read("errors-two-turn-persist")?.history || [];
	assert.deepEqual(history.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
	console.log("two-turn-store-roles", JSON.stringify(history.map((message) => message.role)));
	console.log("PASS ordinary two-turn persistence remains user/assistant/user/assistant");
}

// --- a second auth failure persists user messages only and emits one error ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-retry-fail-store-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6-astra", name: "Astra", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("401 Unauthorized"), errorMessage("401 Unauthorized")]);
	let refreshes = 0;
	const originalGetAuth = models.getAuth.bind(models);
	models.getAuth = async (...args) => {
		if (args[1]?.minOAuthValidityMs !== undefined) refreshes++;
		return originalGetAuth(...args);
	};
	const runner = createAgentRunner({ models, tools: [], sessionStore });
	const session = await runner.openSession("errors-401-retry-failed", { surface: "workflow" });
	const frames = await collect(session, { text: "describe this image", attachments: [{ dataUrl: "data:image/png;base64,AA==", name: "probe.png" }] });
	await runner.close();
	const history = sessionStore.read("errors-401-retry-failed")?.history || [];
	assert.deepEqual(history.map((message) => message.role), ["user", "user"]);
	assert.equal(history.some((message) => message.role === "assistant"), false);
	assert.equal(frames.filter((frame) => frame.type === "error").length, 1);
	assert.equal(frames.find((frame) => frame.type === "error").code, "unauthorized");
	assert.equal(frames.filter((frame) => frame.type === "done").length, 1);
	assert.equal(frames.at(-1)?.type, "done");
	assert.equal(calls.length, 2, "a second 401 is terminal, not retried again");
	assert.equal(refreshes, 1);
	console.log("retry-failed-store-roles", JSON.stringify(history.map((message) => message.role)));
	console.log("retry-failed-frames", JSON.stringify(frames));
	console.log("PASS failed auth retry persists user messages only with one error and done");
}

// --- a non-Codex 401 never refreshes Codex credentials or retries ---
{
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("401 Unauthorized"), fauxAssistantMessage([fauxText("must not retry")])]);
	let refreshes = 0;
	const originalGetAuth = models.getAuth.bind(models);
	models.getAuth = async (...args) => {
		if (args[1]?.minOAuthValidityMs !== undefined) refreshes++;
		return originalGetAuth(...args);
	};
	const runner = createAgentRunner({ models });
	const session = await runner.openSession("errors-non-codex-auth");
	const frames = await collect(session, { text: "hi", model: "faux/scripted" });
	await runner.close();
	assert.equal(refreshes, 0);
	assert.equal(calls.length, 1);
	assert.equal(frames.filter((frame) => frame.type === "error").length, 1);
	assert.equal(frames.find((frame) => frame.type === "error").code, "unauthorized");
	assert.equal(frames.filter((frame) => frame.type === "done").length, 1);
	assert.equal(frames.at(-1)?.type, "done");
	console.log("PASS a non-Codex unauthorized response is terminal without a credential refresh");
}

// --- abort mid-stream (#379, strengthened for 16k): the provider stream is
// deliberately frozen — it emits its first delta then blocks forever on
// nothing but the harness's OWN abort signal (never a timer, never a
// self-resolving promise) — so a done+error{aborted} pair can only arrive
// here because `session.abort()` actually propagated pi's real abort signal
// into the still-running generation, strictly before the provider would ever
// have completed on its own. No further model calls follow the abort.
{
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	const started = Promise.withResolvers();
	let providerAborted = false;
	let calls = 0;
	const message = { ...fauxAssistantMessage([fauxText("this response streams across several chunks so an abort can land mid-stream")]), provider: "faux", model: "scripted" };
	faux.provider.streamSimple = (_model, _context, options) => {
		calls += 1;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [fauxText("")] } });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "this response streams", partial: message });
			started.resolve();
			// The ONLY way this stream ever ends: pi's real abort signal firing.
			// If `session.abort()` below did not actually reach this signal, the
			// test hangs until `bounded`'s own deadline, not a false pass.
			options?.signal?.addEventListener("abort", () => {
				providerAborted = true;
				const aborted = { ...message, stopReason: "aborted", errorMessage: "Request was aborted" };
				stream.push({ type: "error", reason: "aborted", error: aborted });
				stream.end(aborted);
			}, { once: true });
		});
		return stream;
	};
	models.setProvider(faux.provider);
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession("errors-abort", { surface: "workflow" });
	const frames = [];
	let aborted = false;
	const iterator = session.start({ text: "stream something long", model: "faux/scripted" })[Symbol.asyncIterator]();
	const deadline = async (promise) => {
		let timer;
		try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("abort mid-stream deadline")), 5000); })]); }
		finally { clearTimeout(timer); }
	};
	for (;;) {
		const { value, done } = await deadline(iterator.next());
		if (done) break;
		frames.push(value);
		if (value.type === "text.delta" && !aborted) { aborted = true; await started.promise; await deadline(session.abort("test")); }
	}
	await runner.close();
	expect("the abort signal actually reached the still-running (frozen) provider stream", providerAborted === true);
	expect("the stream actually started before the abort landed", frames.some((f) => f.type === "text.delta"), JSON.stringify(frames));
	expect("the model was only called once (no further model calls after abort)", calls === 1, `calls=${calls}`);
	const errorFrames = frames.filter((f) => f.type === "error");
	expect("every error frame surfaced by the aborted run carries code:'aborted'", errorFrames.length > 0 && errorFrames.every((f) => f.code === "aborted"), JSON.stringify(frames));
	expect("a done frame is the last frame", frames.at(-1)?.type === "done", JSON.stringify(frames));
}

// --- #379 / 16k (F2 pass 5 finding 4): the first assistant text must reach
// the browser immediately, not after the whole provider call completes. A
// controlled faux stream emits its first text_delta then BLOCKS completion
// until this test releases it (no sleeps — the test's own signal bounds the
// wait) — the SSE consumer must receive that delta, preceded by exactly one
// quota frame, before the release, proving `pushFrame`'s gate no longer
// withholds a turn's first output for the whole generation.
{
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	const release = Promise.withResolvers();
	const started = Promise.withResolvers();
	const message = { ...fauxAssistantMessage([fauxText("first visible token")]), provider: "faux", model: "scripted" };
	let providerEnded = false;
	faux.provider.streamSimple = () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [fauxText("")] } });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "first visible token", partial: message });
			started.resolve();
			await release.promise;
			providerEnded = true;
			stream.push({ type: "text_end", contentIndex: 0, content: "first visible token", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
		});
		return stream;
	};
	models.setProvider(faux.provider);
	const runner = createAgentRunner({ models });
	const session = await runner.openSession("streaming-boundary", { surface: "workflow" });
	const iterator = session.start({ text: "stream the answer", model: "faux/scripted" })[Symbol.asyncIterator]();
	const first = iterator.next();
	await started.promise;
	let timer;
	const early = await Promise.race([first.then((value) => ({ frame: value.value })), new Promise((resolve) => { timer = setTimeout(() => resolve({ deadline: true }), 5000); })]);
	clearTimeout(timer);
	const endedBeforeFirstFrame = providerEnded;
	release.resolve();
	const frames = [(await first).value];
	for (;;) { const next = await iterator.next(); if (next.done) break; frames.push(next.value); }
	await runner.close();
	expect("the first frame arrives before the provider call completes, not at the 5s deadline", !early.deadline, JSON.stringify(early));
	expect("the provider call had not ended when the first frame arrived", endedBeforeFirstFrame === false);
	expect("the first frame delivered is the quota frame", early.frame?.type === "quota", JSON.stringify(early.frame));
	expect("exactly one quota frame precedes the text.delta", frames.filter((f) => f.type === "quota").length === 1 && frames.findIndex((f) => f.type === "quota") < frames.findIndex((f) => f.type === "text.delta"), JSON.stringify(frames));
	expect("the visible text and a terminal done still follow", frames.some((f) => f.type === "text.delta" && f.text === "first visible token") && frames.at(-1)?.type === "done", JSON.stringify(frames));
}

// --- tool-level abort (#379): the harness's REAL abort signal must reach the
// tool handler as `ctx.signal`, not a positional update-callback function.
// A fixture tool awaits its own `ctx.signal` and records `signal.aborted`
// once it fires; before the pi-tools.mjs fix this never resolves that way
// because `signal` is actually the harness's `onUpdate` callback (a
// function), so `ctx.signal.aborted` throws / never becomes true.
{
	const observed = [];
	let started;
	const slowTool = (turn) => ({
		name: "slow_tool",
		description: "A slow tool used to prove the harness abort signal reaches tool handlers.",
		// Subscribe inside the handler before telling the test it may abort.
		// Each turn supplies a new closure with the same name and schema.
		handler: (params, ctx) => new Promise((resolve, reject) => {
			ctx.signal.addEventListener("abort", () => {
				observed.push({ turn, aborted: ctx.signal.aborted });
				reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
			}, { once: true });
			started.resolve(ctx.signal);
		}),
	});
	const bounded = async (promise) => {
		let timer;
		try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("tool abort event deadline")), 5000); })]); }
		finally { clearTimeout(timer); }
	};
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	installScripts(faux, [1, 2].map((turn) => fauxAssistantMessage([fauxToolCall("slow_tool", {}, { id: `slow-${turn}` })], { stopReason: "toolUse" })));
	const runner = createAgentRunner({ models });
	const session = await runner.openSession("errors-tool-abort", { surface: "workflow" });
	let previousSignal;
	try {
		for (const turn of [1, 2]) {
			started = Promise.withResolvers();
			const completed = bounded(collect(session, { text: "run the slow tool", model: "faux/scripted", tools: [slowTool(turn)] }));
			const signal = await bounded(started.promise);
			assert.equal(signal.aborted, false, `turn ${turn} starts with a live signal`);
			assert.notEqual(signal, previousSignal, "each turn receives its own harness abort signal");
			await bounded(session.abort(`test turn ${turn}`));
			const frames = await completed;
			assert.equal(signal.aborted, true);
			assert.equal(frames.at(-1)?.type, "done", JSON.stringify(frames));
			assert.ok(frames.some((frame) => frame.type === "error" && frame.code === "aborted"), JSON.stringify(frames));
			previousSignal = signal;
		}
	} finally { await runner.close(); }
	console.log("two-turn tool abort bindings", JSON.stringify(observed));
	assert.deepEqual(observed, [{ turn: 1, aborted: true }, { turn: 2, aborted: true }], "each turn's slow-tool closure observes that turn's abort");
	console.log("PASS both turns' tool handlers receive pi's real harness abort signal and complete with done");
}

// --- abort persistence: the real session store never gets the cancelled
// assistant message, only the completed user turn that preceded it ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-store-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }], tokensPerSecond: 2 });
	models.setProvider(faux.provider);
	installScripts(faux, [fauxAssistantMessage([fauxText("this response streams across several chunks so an abort can land mid-stream")])]);
	const runner = createAgentRunner({ models, tools: [], sessionStore });
	const session = await runner.openSession("errors-abort-persist", { surface: "workflow" });
	const iterator = session.start({ text: "stream something long", model: "faux/scripted" })[Symbol.asyncIterator]();
	let aborted = false;
	for (;;) {
		const { value, done } = await iterator.next();
		if (done) break;
		if (value.type === "text.delta" && !aborted) { aborted = true; await session.abort("test"); }
	}
	await runner.close();
	const stored = sessionStore.read("errors-abort-persist");
	const roles = (stored?.history || []).map((message) => message.role);
	// Exactly the user turn: no tool ran in this scenario, so there is no
	// completed toolResult to also expect; a scenario with a tool would keep
	// any toolResult from a tool that finished BEFORE the abort (the `persist`
	// filter only withholds the assistant role, never toolResult or user).
	assert.deepEqual(roles, ["user"], `stored roles after abort: ${JSON.stringify(roles)}`);
	console.log("PASS the aborted assistant message never reaches sessionStore; only the completed user turn does");
}

// --- status-first classification: a structured numeric status wins over the
// message text; the message regex is only a fallback ---
{
	expect("{status:429, message:'try later'} classifies as rate_limit from status, not text", classifyError({ status: 429, message: "try later" }).code === "rate_limit", JSON.stringify(classifyError({ status: 429, message: "try later" })));
	expect("{status:401, message:'x'} classifies as unauthorized from status, not text", classifyError({ status: 401, message: "x" }).code === "unauthorized", JSON.stringify(classifyError({ status: 401, message: "x" })));
	const overloadedWordsWrongStatus = classifyError({ status: 500, message: "scene overloaded with props" });
	expect("status wins over message text: status:500 classifies as upstream even though the message says 'overloaded'", overloadedWordsWrongStatus.code === "upstream", JSON.stringify(overloadedWordsWrongStatus));
	expect("the numeric status is preserved on the classification even when it decided the code", overloadedWordsWrongStatus.status === 500, JSON.stringify(overloadedWordsWrongStatus));
	const noStatusFallsBackToText = classifyError({ message: "529 Overloaded" });
	expect("with no structured status, the message-text fallback still classifies 529 as overloaded", noStatusFallsBackToText.code === "overloaded" && noStatusFallsBackToText.status === 529, JSON.stringify(noStatusFallsBackToText));
}

// --- a tool error containing a status-shaped substring in its own text must
// NOT be reclassified as a provider error: it stays a tool failure with the
// CODE: message format, because classifyError/classifyProviderError are only
// ever invoked at provider response/run failure boundaries, never on a tool
// result's text (verified structurally: tool_end never calls classifyError) ---
{
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	installScripts(faux, [
		fauxAssistantMessage([fauxToolCall("failing_tool", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("handled the failure")]),
	]);
	const tools = [{
		name: "failing_tool",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		handler: async () => { throw Object.assign(new Error("the backend answered 403 Forbidden"), { code: "BACKEND_UNAVAILABLE" }); },
	}];
	const runner = createAgentRunner({ models, tools, clock: () => Date.now() });
	const session = await runner.openSession("errors-tool-text-not-reclassified", { surface: "workflow" });
	const frames = await collect(session, { text: "run the failing tool", model: "faux/scripted" });
	await runner.close();
	const toolDone = frames.find((f) => f.type === "tool.done");
	expect("the tool's '403' text produces a tool.done failure frame, never a run-level error frame", toolDone && toolDone.ok === false, JSON.stringify(frames));
	expect("the tool failure keeps the CODE: message format instead of being reclassified as code:'unauthorized'", typeof toolDone?.error === "string" && toolDone.error.startsWith("BACKEND_UNAVAILABLE:"), JSON.stringify(toolDone));
	expect("no run-level error frame was produced for a tool failure that the assistant recovered from", frames.every((f) => f.type !== "error"), JSON.stringify(frames));
}

process.exit(failures === 0 ? 0 : 1);
