#!/usr/bin/env node
import assert from "node:assert/strict";
import { createAgentPort, createSculptRun } from "../src/sculpt-run.js";
import { STUDIO_SYSTEM_PROMPT } from "../bin/agent/studio-prompt.mjs";

const reference = { dataUrl: "data:image/png;base64,AA==", name: "reference.png" };
function fixture({ turns, clockStep = 1 } = {}) {
	let time = 0;
	const events = [];
	const listeners = new Set();
	let sent = 0;
	let aborted = 0;
	const bus = { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
	const agent = {
		async *sendTurn({ signal, turnId }) {
			const script = turns[Math.min(sent++, turns.length - 1)] ?? [];
			for (const event of script) {
				if (signal.aborted) { aborted += 1; return; }
				// A command the turn ran carries its turnId, as the command tap reports it; `foreign` keeps its own.
				if (event.bus) for (const listener of listeners) listener(event.foreign ? event.bus : { ...event.bus, turnId });
				yield event.stream ?? event;
			}
			time += clockStep;
		},
	};
	return { bus, agent, now: () => time, sent: () => sent, aborted: () => aborted, events, listeners, listening: () => listeners.size };
}
const sculpt = (id = "sculpt-1") => ({ bus: { action: "object.sculpt", args: { id }, result: { affectedIds: [id] } } });
const compare = (iou, sheetDataUrl = `data:image/png;base64,sheet-${iou}`) => ({ bus: { action: "sculpt.compare", args: { id: "sculpt-1" }, result: { report: { iou }, sheetDataUrl } } });

async function runCase(name, setup, check) {
	try { await check(await setup()); console.log(`PASS ${name}`); }
	catch (error) { console.log(`FAIL ${name} - ${error.stack?.split("\n").slice(0, 3).join(" | ") ?? error.message}`); process.exitCode = 1; }
}

await runCase("measured loop reports draft, score, refine, score, done", async () => {
	const f = fixture({ turns: [[sculpt(), compare(0.5)], [sculpt(), compare(0.94)]] });
	const run = createSculptRun({ ...f, maxRounds: 2, targetIou: 0.95 });
	const stages = []; run.subscribe(state => stages.push(state.stage));
	await run.start();
	return { run, stages };
}, ({ run, stages }) => {
	assert.deepEqual(stages.filter((stage, index) => stage !== stages[index - 1]), ["measure", "draft", "score", "refine", "score", "done"], stages.join(" -> "));
	assert.equal(run.getState().iou, 0.94);
});

await runCase("target IoU stops after the first turn", async () => {
	const f = fixture({ turns: [[sculpt(), compare(0.95)], [sculpt(), compare(0.1)]] });
	const run = createSculptRun({ ...f, targetIou: 0.9 });
	await run.start();
	return { run, sent: f.sent, listening: f.listening };
}, ({ run, sent, listening }) => {
	assert.equal(sent(), 1);
	assert.equal(run.getState().stage, "done");
	assert.equal(listening(), 0, "a finished run leaves no bus listener");
});

await runCase("continuations are capped at maxRounds", async () => {
	const f = fixture({ turns: [[sculpt(), compare(0.1)], [sculpt(), compare(0.2)], [sculpt(), compare(0.3)], [sculpt(), compare(0.4)]] });
	const run = createSculptRun({ ...f, maxRounds: 3, targetIou: 0.99 });
	await run.start();
	return { run, sent: f.sent };
}, ({ run, sent }) => {
	assert.equal(sent(), 3);
	assert.equal(run.getState().round, 3);
	assert.equal(run.getState().stage, "done");
});

await runCase("time budget ends the loop", async () => {
	const f = fixture({ turns: [[sculpt(), compare(0.1)], [sculpt(), compare(0.2)]], clockStep: 10 });
	const run = createSculptRun({ ...f, maxRounds: 3, timeBudgetMs: 10, targetIou: 0.99 });
	await run.start();
	return { run, sent: f.sent };
}, ({ run, sent }) => {
	assert.equal(sent(), 1);
	assert.equal(run.getState().stage, "done");
});

await runCase("cancel aborts the turn and sends nothing after", async () => {
	const f = fixture({ turns: [[sculpt()]] });
	let wasAborted = false;
	let sent = 0;
	f.agent.sendTurn = async function* ({ signal }) {
		sent += 1;
		signal.addEventListener("abort", () => { wasAborted = true; }, { once: true });
		await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
	};
	const run = createSculptRun({ ...f });
	const pending = run.start();
	run.cancel();
	await pending;
	return { run, sent: () => sent, aborted: () => wasAborted, listening: f.listening };
}, ({ run, sent, aborted, listening }) => {
	assert.equal(sent(), 1);
	assert.equal(aborted(), true);
	assert.equal(listening(), 0, "a cancelled run leaves no bus listener");
	assert.equal(run.getState().stage, "cancelled");
});

await runCase("a turn without sculpt retries once then fails", async () => {
	const f = fixture({ turns: [[], []] });
	const run = createSculptRun({ ...f });
	await run.start();
	return { run, sent: f.sent, listening: f.listening };
}, ({ run, sent, listening }) => {
	assert.equal(sent(), 2);
	assert.equal(listening(), 0, "a failed run leaves no bus listener");
	assert.equal(run.getState().stage, "failed");
	assert.match(run.getState().error, /object\.sculpt/);
});

await runCase("commands from another turn, MCP or the UI are never claimed", async () => {
	const other = (bus, turnId) => ({ foreign: true, bus: { ...bus, ...(turnId === undefined ? {} : { turnId }) } });
	const f = fixture({ turns: [[
		other(sculpt("chat-sculpt").bus, crypto.randomUUID()),
		other(sculpt("mcp-sculpt").bus),
		other(compare(0.99).bus, null),
		sculpt(), compare(0.5),
	]] });
	const run = createSculptRun({ ...f, maxRounds: 1, targetIou: 0.95 });
	await run.start();
	return run.getState();
}, state => {
	assert.equal(state.sculptId, "sculpt-1");
	assert.equal(state.iou, 0.5);
	assert.deepEqual(state.history.map(row => row.iou), [0.5]);
});

await runCase("a turn whose only sculpt came from elsewhere has not sculpted", async () => {
	const elsewhere = { foreign: true, bus: sculpt("chat-sculpt").bus };
	const f = fixture({ turns: [[elsewhere], [elsewhere]] });
	const run = createSculptRun({ ...f });
	await run.start();
	return run.getState();
}, state => {
	assert.equal(state.stage, "failed");
	assert.equal(state.sculptId, null);
});

await runCase("a throwing state listener never stops the run", async () => {
	const f = fixture({ turns: [[sculpt(), compare(0.95)]] });
	const run = createSculptRun({ ...f, targetIou: 0.9 });
	run.subscribe(() => { throw new Error("listener bug"); });
	const quiet = console.error;
	console.error = () => {};
	try { await run.start(); } finally { console.error = quiet; }
	return run.getState();
}, state => {
	assert.equal(state.stage, "done");
	assert.equal(state.iou, 0.95);
});

await runCase("a raw RGBA sheet is never shown as an image", async () => {
	const raw = { bus: { action: "sculpt.compare", args: { id: "sculpt-1" }, result: { report: { iou: 0.95 }, sheet: { width: 2, height: 1, data: new Uint8Array(8) } } } };
	const f = fixture({ turns: [[sculpt(), raw]] });
	const run = createSculptRun({ ...f, targetIou: 0.9 });
	await run.start();
	return run.getState();
}, state => {
	assert.equal(state.iou, 0.95);
	assert.equal(state.sheetDataUrl, null);
});

await runCase("a cancelled run ignores its turn's late receipts", async () => {
	const f = fixture({ turns: [[]] });
	let late;
	f.agent.sendTurn = async function* ({ signal, turnId }) {
		late = () => { for (const listener of f.listeners) listener({ ...sculpt("late").bus, turnId }); };
		await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
	};
	const run = createSculptRun({ ...f });
	const pending = run.start();
	await Promise.resolve();
	run.cancel();
	late();
	await pending;
	return run.getState();
}, state => {
	assert.equal(state.stage, "cancelled");
	assert.equal(state.sculptId, null);
});

await runCase("the Studio system prompt carries no sculpt-run procedure", async () => STUDIO_SYSTEM_PROMPT, prompt => {
	// The harness's turn text owns the procedure: a system-wide copy reached every Studio turn and told
	// the draft to call sculpt.compare while the draft turn says not to, and pointed at docs the model cannot read.
	assert.doesNotMatch(prompt, /sculpt-run|sculpt\.compare|docs\//);
});

await runCase("the agent port sends UUID session and turn ids the Studio envelope accepts", async () => {
	const requests = [];
	const port = createAgentPort({ turn: async (request) => { requests.push(request); } });
	for await (const _event of port.sendTurn({ text: "one", signal: new AbortController().signal })) { /* drain */ }
	for await (const _event of port.sendTurn({ text: "two", signal: new AbortController().signal })) { /* drain */ }
	return requests;
}, (requests) => {
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	assert.equal(requests.length, 2);
	for (const request of requests) { assert.match(request.sessionId, uuid); assert.match(request.turnId, uuid); assert.equal(request.surface, "studio"); }
	assert.equal(requests[0].sessionId, requests[1].sessionId, "one session per run");
	assert.notEqual(requests[0].turnId, requests[1].turnId);
});

await runCase("a refused turn fails the run with the refusal, without a retry", async () => {
	const f = fixture({ turns: [[{ type: "error", code: "INVALID_SESSION_ID", message: "Studio sessionId must be a UUID." }]] });
	const run = createSculptRun({ ...f });
	await run.start();
	return { run, sent: f.sent };
}, ({ run, sent }) => {
	assert.equal(sent(), 1);
	assert.equal(run.getState().stage, "failed");
	assert.match(run.getState().error, /sessionId must be a UUID/);
});

await runCase("the harness scores a turn the agent left unscored, and tells the agent the exact reference", async () => {
	const f = fixture({ turns: [[sculpt()], [sculpt()]] });
	const texts = [];
	const inner = f.agent.sendTurn;
	f.agent.sendTurn = function (request) { texts.push(request.text); return inner.call(this, request); };
	const scored = [];
	const run = createSculptRun({ ...f, reference: { ...reference, assetId: "asset-snorlax" }, targetIou: 0.9, score: async (args) => { scored.push(args); return { output: { report: { iou: 0.93 }, sheetDataUrl: "data:image/png;base64,s" } }; } });
	await run.start();
	return { run, sent: f.sent, scored, texts };
}, ({ run, sent, scored, texts }) => {
	assert.deepEqual(scored, [{ id: "sculpt-1", reference: { assetId: "asset-snorlax" } }]);
	assert.equal(sent(), 1, "the harness score reached the target, so no continuation");
	assert.equal(run.getState().iou, 0.93);
	assert.equal(run.getState().stage, "done");
	assert.match(texts[0], /do not call sculpt\.compare/);
	assert.match(texts[0], /exactly one of blob, box, cylinder, torus, frame/);
});

await runCase("a continuation carries the harness score, the exact reference and the candidate step", async () => {
	const f = fixture({ turns: [[sculpt()], [sculpt()]] });
	const texts = [];
	const inner = f.agent.sendTurn;
	f.agent.sendTurn = function (request) { texts.push(request.text); return inner.call(this, request); };
	const efforts = [];
	const innerEffort = f.agent.sendTurn;
	f.agent.sendTurn = function (request) { efforts.push(request.effort); return innerEffort.call(this, request); };
	const scores = [0.5, 0.95];
	const run = createSculptRun({ ...f, maxRounds: 2, reference: { ...reference, assetId: "asset-snorlax" }, score: async () => ({ output: { iou: scores.shift(), missingByBand: { top: 0.1 }, extraByPart: [{ id: "arm", fraction: 0.02 }] } }) });
	await run.start();
	return { run, texts, efforts };
}, ({ run, texts, efforts }) => {
	assert.equal(texts.length, 2);
	assert.match(texts[1], /IoU 0\.5/);
	assert.deepEqual(efforts, [undefined, undefined], "turns use the sidecar's default effort unless one is chosen");
	assert.match(texts[1], /"reference": \{"assetId":"asset-snorlax"\}/);
	assert.match(texts[1], /"candidates"/);
	assert.match(texts[1], /missingByBand/);
	assert.equal(run.getState().iou, 0.95);
});

await runCase("the harness does not re-score a turn the agent already scored", async () => {
	const f = fixture({ turns: [[sculpt(), compare(0.95)]] });
	let calls = 0;
	const run = createSculptRun({ ...f, score: async () => { calls += 1; return { report: { iou: 0.1 } }; } });
	await run.start();
	return { run, calls: () => calls };
}, ({ run, calls }) => {
	assert.equal(calls(), 0);
	assert.equal(run.getState().iou, 0.95);
});

await runCase("a candidate score taken before the winning edit does not stop the harness re-scoring", async () => {
	const f = fixture({ turns: [[sculpt()], [compare(0.6), sculpt()]] });
	const scores = [0.6, 0.92];
	let calls = 0;
	const run = createSculptRun({ ...f, maxRounds: 2, score: async () => { calls += 1; return { iou: scores.shift() }; } });
	await run.start();
	return { run, calls: () => calls };
}, ({ run, calls }) => {
	assert.equal(calls(), 2, "round 2's compare came before its object.sculpt, so the harness scores again");
	assert.equal(run.getState().iou, 0.92);
});

await runCase("the harness measurement goes into the first turn", async () => {
	const f = fixture({ turns: [[sculpt(), compare(0.95)]] });
	const texts = [];
	const inner = f.agent.sendTurn;
	f.agent.sendTurn = function (request) { texts.push(request.text); return inner.call(this, request); };
	const measured = [];
	const run = createSculptRun({ ...f, reference: { ...reference, assetId: "asset-snorlax" }, measure: async (ref) => { measured.push(ref); return { widthToHeight: 0.93, rows: [{ y: 0.04, spans: [[0.15, 0.26]] }] }; } });
	await run.start();
	return { texts, measured };
}, ({ texts, measured }) => {
	assert.deepEqual(measured, [{ assetId: "asset-snorlax" }]);
	assert.match(texts[0], /"widthToHeight":0\.93/);
	assert.match(texts[0], /\[0\.15,0\.26\]/);
});

await runCase("the run narrates itself: log lines, what it waits on, score history, candidates and changed parts", async () => {
	const f = fixture({ turns: [
		[{ type: "text.delta", text: "**Built** a 17-part draft.\nThe back is inferred." }, { type: "tool.start", callId: "c1", args: { action: "object.sculpt", args: { recipe: {} } } }, { type: "tool.done", callId: "c1", ok: false, error: "INVALID_ARGUMENT: Recipe refused at parts[ear].roundness (inspect, do not retry)" }, sculpt()],
		[{ bus: { action: "sculpt.compare", args: { id: "sculpt-1" }, result: { iou: 0.6, ranking: [{ label: "wider", iou: 0.66, delta: 0.06 }, { label: "taller", iou: 0.61, delta: 0.01 }] } } }, { bus: { action: "object.sculpt", args: { id: "sculpt-1", edits: [{ set: "body" }, { set: "arm" }] }, result: { affectedIds: ["sculpt-1"] } } }],
	] });
	const scores = [0.6, 0.66];
	const seen = [];
	const run = createSculptRun({ ...f, maxRounds: 2, targetIou: 0.95, score: async () => ({ iou: scores.shift() }), measure: async () => ({ widthToHeight: 0.9, rows: [{ y: 0.1, spans: [[-0.2, -0.1], [0.1, 0.2]] }], box: { left: 0.1, top: 0.1, width: 0.8, height: 0.8, aspect: 1 } }) });
	run.subscribe(state => seen.push(state));
	await run.start();
	return { run, seen };
}, ({ run, seen }) => {
	const state = run.getState();
	const lines = state.activity.map(row => row.text);
	assert.match(lines[0], /Measuring the reference outline/);
	assert.ok(lines.some(line => /Outline measured: width:height 0\.9, 1 slices, 1 with separate limbs/.test(line)), lines.join(" | "));
	assert.ok(lines.some(line => /^Recipe refused: INVALID_ARGUMENT: Recipe refused at parts\[ear\]\.roundness\. The agent is fixing it\.$/.test(line)), lines.join(" | "));
	assert.ok(lines.some(line => /Ranked 2 candidate fixes: "wider" leads \(\+0\.060\)/.test(line)), lines.join(" | "));
	assert.ok(lines.some(line => /Applied 2 edits to body, arm/.test(line)), lines.join(" | "));
	assert.match(lines.at(-1), /Finished at IoU 0\.660/);
	assert.ok(lines.includes("Agent: Built a 17-part draft."), lines.join(" | "));
	assert.deepEqual(state.history.map(row => row.iou), [0.6, 0.66], "a candidate ranking is not a score of the sculpt");
	assert.deepEqual(state.candidates.map(row => row.label), ["wider", "taller"]);
	assert.deepEqual(state.changedParts.ids, ["body", "arm"]);
	assert.equal(state.outline.box.width, 0.8);
	assert.equal(state.waiting, null, "nothing is awaited once the run ends");
	const labels = seen.map(row => row.waiting?.label).filter(Boolean);
	for (const label of ["Measuring the reference outline", "Agent is writing the recipe", "Agent is building the recipe", "Scoring the silhouette against the reference", "Agent is weighing fixes"]) assert.ok(labels.includes(label), `${label} in ${[...new Set(labels)].join(" | ")}`);
	const writing = seen.filter(row => row.waiting?.label === "Agent is writing the recipe").map(row => row.waiting);
	assert.ok(writing[0].expectMs > 0);
	const afterTool = seen.findIndex(row => row.waiting?.label === "Agent is building the recipe");
	assert.equal(seen[afterTool + 1].waiting.label, "Agent is writing the recipe", "a finished tool call hands back to the turn's own wait");
	assert.equal(seen[afterTool + 1].waiting.since, writing[0].since, "the turn's wait keeps counting from when the turn went out");
	assert.equal(seen.find(row => row.waiting?.label === "Agent is writing the recipe").stage, "draft", "the stepper is on Draft while the recipe is written");
	assert.ok(state.activity.every((row, index, rows) => index === 0 || row.atMs >= rows[index - 1].atMs));
});

await runCase("a score repeated with no edit in between adds no log line or trail point", async () => {
	const f = fixture({ turns: [[sculpt(), compare(0.72), compare(0.72)]] });
	const run = createSculptRun({ ...f, maxRounds: 1, targetIou: 0.95 });
	await run.start();
	return run.getState();
}, (state) => {
	assert.deepEqual(state.history.map(row => row.iou), [0.72]);
	assert.equal(state.activity.filter(row => /^Scored IoU/.test(row.text)).length, 1, state.activity.map(row => row.text).join(" | "));
});

await runCase("every turn runs on the chosen model and effort, and the run names that model", async () => {
	const f = fixture({ turns: [[sculpt()], [sculpt()]] });
	const requests = [];
	const inner = f.agent.sendTurn;
	f.agent.sendTurn = function (request) { requests.push({ model: request.model, effort: request.effort }); return inner.call(this, request); };
	const scores = [0.5, 0.6];
	const seen = [];
	const run = createSculptRun({ ...f, maxRounds: 2, model: "openai-codex/gpt-6-astra", effort: "low", modelLabel: "GPT-6 Astra", score: async () => ({ iou: scores.shift() }) });
	run.subscribe(state => seen.push(state));
	await run.start();
	return { run, requests, seen };
}, ({ run, requests, seen }) => {
	assert.deepEqual(requests, [{ model: "openai-codex/gpt-6-astra", effort: "low" }, { model: "openai-codex/gpt-6-astra", effort: "low" }]);
	assert.deepEqual(run.getState().model, { key: "openai-codex/gpt-6-astra", label: "GPT-6 Astra", effort: "low" });
	const lines = run.getState().activity.map(row => row.text);
	assert.ok(lines.includes("Asked GPT-6 Astra (effort low) for a first draft"), lines.join(" | "));
	assert.ok(lines.includes("Round 2: asked GPT-6 Astra for 3-6 candidate fixes"), lines.join(" | "));
	assert.ok(seen.some(row => row.waiting?.label === "GPT-6 Astra is writing the recipe"));
});

await runCase("Start attaches the blueprint's side and back next to the reference and scores against all three (#970)", async () => {
	const f = fixture({ turns: [[sculpt()], [sculpt()]] });
	const requests = [];
	const inner = f.agent.sendTurn;
	f.agent.sendTurn = function (request) { requests.push(request); return inner.call(this, request); };
	const scored = [];
	const views = [{ view: "side", yaw: 90, dataUrl: "data:image/png;base64,SIDE", name: "blueprint-side.png" }, { view: "back", yaw: 180, dataUrl: "data:image/png;base64,BACK", name: "blueprint-back.png" }];
	const run = createSculptRun({ ...f, maxRounds: 2, targetIou: 0.99, reference: { ...reference, assetId: "asset-snorlax" }, views, score: async (args) => { scored.push(args); return { output: { iou: 0.8 } }; } });
	await run.start();
	// Without views nothing changes: only the reference rides, and the score is the one-view shape.
	const g = fixture({ turns: [[sculpt()]] });
	const plain = [];
	const innerPlain = g.agent.sendTurn;
	g.agent.sendTurn = function (request) { plain.push(request); return innerPlain.call(this, request); };
	const plainScored = [];
	await createSculptRun({ ...g, reference, targetIou: 0.5, score: async (args) => { plainScored.push(args); return { iou: 0.9 }; } }).start();
	return { run, requests, scored, plain, plainScored };
}, ({ run, requests, scored, plain, plainScored }) => {
	for (const request of requests) {
		assert.deepEqual(request.attachments, [{ dataUrl: "data:image/png;base64,AA==", name: "reference.png" }, { dataUrl: "data:image/png;base64,SIDE", name: "blueprint-side.png" }, { dataUrl: "data:image/png;base64,BACK", name: "blueprint-back.png" }]);
	}
	assert.match(requests[0].text, /Also attached, after the reference: the blueprint's side view \(yaw 90, [^)]*\) and back view \(yaw 180, [^)]*\)/);
	assert.match(requests[1].text, /against the reference and the blueprint's side and back views \(weighted\)/);
	assert.deepEqual(scored[0], { id: "sculpt-1", views: [{ yaw: 0, reference: { assetId: "asset-snorlax" } }, { yaw: 90, reference: { dataUrl: "data:image/png;base64,SIDE" } }, { yaw: 180, reference: { dataUrl: "data:image/png;base64,BACK" } }] });
	assert.ok(run.getState().activity.some(entry => entry.text === "Using the blueprint's side and back views next to the reference"));
	assert.deepEqual(plain[0].attachments, [{ dataUrl: "data:image/png;base64,AA==", name: "reference.png" }]);
	assert.doesNotMatch(plain[0].text, /Also attached/);
	assert.deepEqual(plainScored[0], { id: "sculpt-1", reference: { dataUrl: "data:image/png;base64,AA==" } });
});

await runCase("the agent port sends the model and effort on the Studio envelope", async () => {
	const requests = [];
	const port = createAgentPort({ turn: async (request) => { requests.push(request); } });
	for await (const _event of port.sendTurn({ text: "one", signal: new AbortController().signal, model: "cliproxy/gpt-6.1-sol", effort: "medium" })) { /* drain */ }
	for await (const _event of port.sendTurn({ text: "two", signal: new AbortController().signal })) { /* drain */ }
	return requests;
}, (requests) => {
	assert.equal(requests[0].model, "cliproxy/gpt-6.1-sol");
	assert.equal(requests[0].effort, "medium");
	assert.equal("model" in requests[1], false, "no model is sent when none was chosen");
	assert.equal("effort" in requests[1], false);
});

if (process.exitCode) process.exit(1);
