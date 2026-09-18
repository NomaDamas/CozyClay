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
import { createAgentRunner, classifyError } from "../bin/agent/agent-runner.mjs";
import { createSessionStore } from "../bin/agent/session-store.mjs";

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
		// A realistic cancellable handler: it waits on its own work and, when the
		// real harness abort signal fires, records that and rejects (mirroring
		// how a genuine fetch/subprocess-backed tool would unwind on abort)
		// instead of hanging forever.
		handler: (params, ctx) => new Promise((resolve, reject) => {
			ctx.signal.addEventListener("abort", () => {
				toolObservedAbort = ctx.signal.aborted === true;
				reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
			});
		}),
	};
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	installScripts(faux, [fauxAssistantMessage([fauxToolCall("slow_tool", {})], { stopReason: "toolUse" })]);
	// `clock` defaults to the unbound `performance.now` in agent-runner.mjs
	// (a pre-existing bug outside this task's scope, only reachable once a
	// tool actually executes); supply a bound clock so the tool_start/tool_end
	// telemetry this test depends on does not silently throw inside pi's event
	// bus (which swallows listener errors) and drop the frame.
	const runner = createAgentRunner({ models, tools: [slowTool], clock: () => Date.now() });
	const session = await runner.openSession("errors-tool-abort", { surface: "workflow" });
	const frames = [];
	let aborted = false;
	const iterator = session.start({ text: "run the slow tool", model: "faux/scripted" })[Symbol.asyncIterator]();
	const TIMEOUT_MS = 5000;
	for (;;) {
		const signal = AbortSignal.timeout(TIMEOUT_MS);
		const timedOut = await new Promise((resolve) => {
			const onTimeout = () => resolve(true);
			signal.addEventListener("abort", onTimeout, { once: true });
			iterator.next().then(({ value, done }) => {
				signal.removeEventListener("abort", onTimeout);
				if (done) { resolve(false); return; }
				frames.push(value);
				if (value.type === "tool.start" && !aborted) { aborted = true; session.abort("test").then(() => resolve(false)); }
				else resolve(false);
			});
		});
		if (timedOut) { expect("the runner stream did not hang waiting for the next frame", false, `no frame within ${TIMEOUT_MS}ms; frames so far=${JSON.stringify(frames)}`); break; }
		if (frames.at(-1)?.type === "done") break;
	}
	await runner.close();
	expect("the tool handler received pi's real harness abort signal (ctx.signal.aborted became true, not a function positionally treated as a signal)", toolObservedAbort === true, `toolObservedAbort=${toolObservedAbort}`);
	expect("a done frame is the last frame", frames.at(-1)?.type === "done", JSON.stringify(frames));
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
// ever invoked on the run's own operation error (run_end), never on a tool
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
