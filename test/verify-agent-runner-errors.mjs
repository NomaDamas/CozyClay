// Retry, abort and error mapping on the pi runner (#379): a scripted faux
// provider throws provider-shaped errors (`errorMessage` text pi's own
// `isRetryableAssistantError` classifies) so the harness's `retry` policy —
// not any code in this test — does the actual retrying. This file only
// verifies the runner's post-retry error mapping and abort semantics.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentRunner } from "../bin/agent/agent-runner.mjs";

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

// --- 529 three times: retries exhausted (maxRetries:2 = 3 attempts total) -> error{code:'overloaded'} ---
{
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("529 Overloaded"), errorMessage("529 Overloaded"), errorMessage("529 Overloaded")]);
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession("errors-529", { surface: "workflow" });
	const frames = await collect(session, { text: "hi", model: "faux/scripted" });
	await runner.close();
	const error = frames.find((f) => f.type === "error");
	expect("529 three times exhausts retries with one error frame", !!error, JSON.stringify(frames));
	expect("the error frame carries code:'overloaded'", error?.code === "overloaded", JSON.stringify(error));
	expect("a done frame follows the error frame", frames.at(-1)?.type === "done", JSON.stringify(frames));
	expect("the model was called exactly 3 times", calls.length === 3, `calls.length=${calls.length}`);
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

// --- abort mid-stream: no further model calls, an error{code:'aborted'} frame, then done ---
// (Reacts to the runner's own "first text.delta arrived" frame, not a fixed
// sleep; `tokensPerSecond` makes the faux stream's later chunks real,
// throttled setTimeout delays so `session.abort()` — pure microtask work —
// reliably wins the race and lands mid-stream, the way a real abort would
// race a real network stream.)
{
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }], tokensPerSecond: 2 });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [
		fauxAssistantMessage([fauxText("this response streams across several chunks so an abort can land mid-stream")]),
		fauxAssistantMessage([fauxText("should never be reached")]),
	]);
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession("errors-abort", { surface: "workflow" });
	const frames = [];
	let aborted = false;
	const iterator = session.start({ text: "stream something long", model: "faux/scripted" })[Symbol.asyncIterator]();
	for (;;) {
		const { value, done } = await iterator.next();
		if (done) break;
		frames.push(value);
		if (value.type === "text.delta" && !aborted) { aborted = true; await session.abort("test"); }
	}
	await runner.close();
	expect("the stream actually started before the abort landed", frames.some((f) => f.type === "text.delta"), JSON.stringify(frames));
	expect("the model was only called once (no further model calls after abort)", calls.length === 1, `calls.length=${calls.length}`);
	const errorFrames = frames.filter((f) => f.type === "error");
	expect("every error frame surfaced by the aborted run carries code:'aborted'", errorFrames.length > 0 && errorFrames.every((f) => f.code === "aborted"), JSON.stringify(frames));
	expect("a done frame is the last frame", frames.at(-1)?.type === "done", JSON.stringify(frames));
}

// --- tool-level abort (#379): the harness's REAL abort signal must reach the
// tool handler as `ctx.signal`, not a positional update-callback function.
// A fixture tool awaits its own `ctx.signal` and records `signal.aborted`
// once it fires; before the pi-tools.mjs fix this never resolves that way
// because `signal` is actually the harness's `onUpdate` callback (a
// function), so `ctx.signal.aborted` throws / never becomes true.
{
	let toolObservedAbort = null;
	const slowTool = {
		name: "slow_tool",
		description: "A slow tool used to prove the harness abort signal reaches tool handlers.",
		handler: (params, ctx) => new Promise((resolve) => {
			ctx.signal.addEventListener("abort", () => {
				toolObservedAbort = ctx.signal.aborted === true;
				resolve({ ok: true });
			});
		}),
	};
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	installScripts(faux, [fauxAssistantMessage([fauxToolCall("slow_tool", {})], { stopReason: "toolUse" })]);
	const runner = createAgentRunner({ models, tools: [slowTool] });
	const session = await runner.openSession("errors-tool-abort", { surface: "workflow" });
	const frames = [];
	let aborted = false;
	const iterator = session.start({ text: "run the slow tool", model: "faux/scripted" })[Symbol.asyncIterator]();
	for (;;) {
		const { value, done } = await iterator.next();
		if (done) break;
		frames.push(value);
		if (value.type === "tool.start" && !aborted) { aborted = true; await session.abort("test"); }
	}
	await runner.close();
	expect("the tool handler received pi's real harness abort signal (ctx.signal.aborted became true, not a function positionally treated as a signal)", toolObservedAbort === true, `toolObservedAbort=${toolObservedAbort}`);
	expect("a done frame is the last frame", frames.at(-1)?.type === "done", JSON.stringify(frames));
}

process.exit(failures === 0 ? 0 : 1);
