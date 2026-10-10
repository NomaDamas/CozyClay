#!/usr/bin/env node
// The supervisor completion gate (#718): at the end of a Studio run the main
// model's helper role reads a digest of the run and either lets it end or
// continues the same run with the items it reports missing (at most twice).
// Both models are faux models on one provider, so every reply is scripted.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { buildSupervisorDigest, createAgentRunner, parseSupervisorVerdict } from "../bin/agent/agent-runner.mjs";
import { createSessionStore } from "../bin/agent/session-store.mjs";
import { contextFixture, envelopeFixture, receiptFixture } from "./verify-studio-agent-protocol.mjs";

const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-supervisor-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
process.on("exit", () => rmSync(sessionDir, { recursive: true, force: true }));
delete process.env.COZYCLAY_SUPERVISOR;
delete process.env.COZYCLAY_SUPERVISOR_ROLE;

const MAIN = "claude-sonnet-5-5";
const HELPER = "claude-haiku-5-5";
const MAIN_KEY = `anthropic/${MAIN}`;
const HELPER_KEY = `anthropic/${HELPER}`;
const textOf = (message) => typeof message?.content === "string" ? message.content
	: (message?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("");

/** One faux provider serving main and helper; replies dispatch on the model. */
function scriptedModels({ main = [], supervisor = [] }) {
	const faux = fauxProvider({ provider: "anthropic", models: [{ id: MAIN, reasoning: true, input: ["text", "image"] }, { id: HELPER, input: ["text", "image"] }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const calls = { main: [], supervisor: [] };
	const reply = (context, options, state, model) => {
		if (model.id === HELPER) { calls.supervisor.push(context); return fauxAssistantMessage(supervisor.shift() ?? "script exhausted"); }
		calls.main.push(context);
		return main.shift() ?? fauxAssistantMessage("script exhausted");
	};
	faux.setResponses(Array.from({ length: 64 }, () => reply));
	return { faux, models, calls };
}

const edit = (id, key) => fauxAssistantMessage([fauxToolCall("patch_elements", { ops: [{ target: { kind: "stage" }, set: { [key]: 0.5 } }] }, { id })]);
const say = (text) => fauxAssistantMessage([fauxText(text)]);

async function studioTurn(script, text) {
	const { faux, models, calls } = scriptedModels(script);
	const commands = [];
	const liveHub = {
		command: async (name, args) => { commands.push({ name, args }); return name === "patch_elements" ? receiptFixture() : { ok: true, status: "applied", receiptId: "receipt-1", revision: { before: 41, after: 42 } }; },
		workspaceId: () => "tab-7", resolveWorkspace: () => "handle-12", handleForWorkspaceId: () => "handle-12", connected: true, workspaceHandles: ["handle-12"],
	};
	let server;
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models, fauxProvider: faux, liveHub, studioRuntime: { readContext: async () => contextFixture() }, port: () => server.address().port });
	server = createServer((req, res) => handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`;
	const sessionId = randomUUID();
	const body = { ...envelopeFixture(), sessionId, turnId: randomUUID(), text, model: MAIN_KEY };
	const response = await fetch(`${origin}/agent/turn`, { method: "POST", signal: AbortSignal.timeout(20_000), headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
	const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
	await handler.close();
	await new Promise((resolve) => server.close(resolve));
	return { status: response.status, frames, calls, commands, history: createSessionStore().read(sessionId)?.history ?? [] };
}
const supervisorFrames = (frames) => frames.filter((frame) => frame.type === "supervisor").map(({ eventSeq: _seq, ...frame }) => frame);
const assertDone = (frames) => {
	assert.equal(frames.filter((frame) => frame.type === "done").length, 1, "exactly one done frame");
	assert.equal(frames.at(-1).type, "done", "the turn ends with done");
	assert.equal(typeof frames.at(-1).usage?.requests, "number", "done carries usage");
};

// Pure: the digest reads only the latest request's run, never the context part
// or a supervisor follow-up, and keeps each tool's machine-readable outcome.
{
	const context = (text) => ({ role: "user", content: [{ type: "text", text: "<studio-context>\n{}\n</studio-context>" }, { type: "text", text }] });
	const result = (toolName, value, isError = false) => ({ role: "toolResult", toolName, isError, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
	const digest = buildSupervisorDigest([
		context("earlier request"), result("inspect_studio", { ok: true }),
		context("move the cube and warm the light"),
		{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "patch_elements", arguments: {} }] },
		result("patch_elements", { ok: true, status: "applied", affectedIds: ["a", "b"], receiptId: "r-1" }),
		result("arrange_objects", "STALE_SCENE: changed", true),
		{ role: "assistant", content: [{ type: "text", text: "first pass" }] },
		{ role: "user", content: "Supervisor check: the request is not complete. Missing: x." },
		{ role: "assistant", content: [{ type: "text", text: "all done" }] },
	]);
	assert.equal(digest.request, "move the cube and warm the light");
	assert.deepEqual(digest.tools, [
		{ tool: "patch_elements", ok: true, status: "applied", affected: 2, receiptId: "r-1" },
		{ tool: "arrange_objects", ok: false, error: "STALE_SCENE: changed" },
	]);
	assert.equal(digest.reply, "all done");
	const plain = buildSupervisorDigest([{ role: "user", content: "plain request" }, { role: "assistant", content: [{ type: "text", text: "a" }] }, { role: "user", content: "Supervisor check: more" }]);
	assert.equal(plain.request, "plain request", "a follow-up is never the request");
	assert.deepEqual(buildSupervisorDigest([{ role: "user", content: [{ type: "text", text: "<studio-context>\n{}\n</studio-context>\nframe request" }] }]).request, "frame request");
	assert.deepEqual(buildSupervisorDigest(undefined), { request: "", tools: [], reply: "" });
	console.log("PASS supervisor digest: latest request, this run's tool outcomes, last reply");
}

{
	assert.deepEqual(parseSupervisorVerdict('```json\n{"complete": false, "missing": ["warm the light", 3, " "]}\n```'), { complete: false, missing: ["warm the light"] });
	assert.deepEqual(parseSupervisorVerdict('Verdict {bad} then {"complete": true}'), { complete: true, missing: [] });
	assert.deepEqual(parseSupervisorVerdict('{"complete": true, "missing": [], "note": {"x": 1}}'), { complete: true, missing: [] });
	assert.equal(parseSupervisorVerdict("looks fine to me"), null);
	assert.equal(parseSupervisorVerdict('{"complete": "yes"}'), null);
	assert.equal(parseSupervisorVerdict(undefined), null);
	console.log("PASS supervisor verdict parser: first JSON object, boolean complete, string missing items");
}

// (a) One of two edits, then "done": the supervisor sends the agent back once,
// the second edit lands, and the second verdict lets the run end.
{
	const turn = await studioTurn({
		main: [edit("e1", "keyLight.warmth"), say("done"), edit("e2", "keyLight.intensity"), say("done, both")],
		supervisor: ['{"complete":false,"missing":["raise the key light intensity"]}', '{"complete":true,"missing":[]}'],
	}, "warm the key light and raise its intensity");
	assert.equal(turn.status, 200);
	assert.deepEqual(supervisorFrames(turn.frames), [
		{ type: "supervisor", verdict: "incomplete", missing: ["raise the key light intensity"], model: HELPER_KEY, followUp: 1 },
		{ type: "supervisor", verdict: "complete", model: HELPER_KEY },
	]);
	assert.equal(turn.commands.filter((command) => command.name === "patch_elements").length, 2, "both edits reach the editor");
	assert.equal(turn.calls.main.length, 4);
	assert.equal(turn.calls.supervisor.length, 2);
	const digest = JSON.parse(textOf(turn.calls.supervisor[0].messages[0]));
	assert.equal(digest.request, "warm the key light and raise its intensity");
	assert.deepEqual(digest.tools.map((entry) => entry.tool), ["patch_elements"]);
	assert.equal(digest.reply, "done");
	const followUp = turn.history.filter((message) => message.role === "user" && textOf(message).startsWith("Supervisor check:"));
	assert.equal(followUp.length, 1, "the lane history holds the follow-up user message");
	assert.match(textOf(followUp[0]), /raise the key light intensity/);
	assertDone(turn.frames);
	assert.equal(turn.frames.at(-1).usage.requests, 4, "usage counts the main model's requests");
	console.log("PASS incomplete verdict continues the same run once, complete verdict ends it with one done");
}

// (b) A supervisor that never agrees stops after maxFollowUps (2).
{
	const never = '{"complete":false,"missing":["one more thing"]}';
	const turn = await studioTurn({ main: [say("done"), say("done again"), say("still done")], supervisor: [never, never, never] }, "do the thing");
	assert.deepEqual(supervisorFrames(turn.frames).map((frame) => [frame.verdict, frame.followUp]), [["incomplete", 1], ["incomplete", 2]]);
	assert.equal(turn.calls.supervisor.length, 2, "no third supervisor call");
	assert.equal(turn.calls.main.length, 3);
	assertDone(turn.frames);
	console.log("PASS a never-satisfied supervisor stops after two follow-ups");
}

// (c) An unparsable verdict is reported and never blocks the turn.
{
	const turn = await studioTurn({ main: [say("done")], supervisor: ["Looks great, ship it!"] }, "do the thing");
	assert.deepEqual(supervisorFrames(turn.frames).map((frame) => frame.verdict), ["unavailable"]);
	assert.equal(typeof supervisorFrames(turn.frames)[0].reason, "string");
	assert.equal(turn.calls.main.length, 1, "no follow-up");
	assertDone(turn.frames);
	console.log("PASS an unparsable supervisor reply is reported as unavailable and the turn ends");
}

// COZYCLAY_SUPERVISOR=off removes the gate entirely.
{
	process.env.COZYCLAY_SUPERVISOR = "off";
	try {
		const turn = await studioTurn({ main: [say("done")], supervisor: ['{"complete":false,"missing":["x"]}'] }, "do the thing");
		assert.equal(turn.calls.supervisor.length, 0);
		assert.deepEqual(supervisorFrames(turn.frames), []);
		assertDone(turn.frames);
	} finally { delete process.env.COZYCLAY_SUPERVISOR; }
	console.log("PASS COZYCLAY_SUPERVISOR=off runs the Studio turn unsupervised");
}

// (d) The runner never supervises a Workflow turn, even when handed a supervisor.
{
	const { faux, models, calls } = scriptedModels({ main: [say("done")], supervisor: ['{"complete":false,"missing":["x"]}'] });
	const runner = createAgentRunner({ models, fauxProvider: faux });
	const session = await runner.openSession("supervisor-workflow", { surface: "workflow" });
	const frames = [];
	for await (const frame of session.start({ surface: "workflow", model: MAIN_KEY, text: "hello", supervisor: { modelKey: HELPER_KEY, maxFollowUps: 2 } })) frames.push(frame);
	await runner.close();
	assert.equal(calls.supervisor.length, 0, "the supervisor model is never called");
	assert.equal(calls.main.length, 1);
	assert.ok(!frames.some((frame) => frame.type === "supervisor"));
	assert.equal(frames.at(-1).type, "done");
	console.log("PASS a Workflow-surface turn never calls the supervisor");
}
