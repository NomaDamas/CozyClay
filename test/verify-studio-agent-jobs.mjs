#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import * as motion from "../bin/agent/motion-runtime.mjs";
import { startLiveHub, MotionJobRegistry, LiveHub } from "../mcp/live-hub.mjs";
import { createToolHandlers, setLiveHub } from "../mcp/tool-handlers.mjs";
import { startMotionRequest } from "../src/analytics.js";
const { WebSocket } = createRequire(new URL("../mcp/package.json", import.meta.url))("ws");
const args = process.argv.slice(2);
assert.ok(!args.length || (args.length === 2 && args[0] === "--case" && args[1] === "bridge-cancel-and-replay"), "unknown test case");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function bounded(promise) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("fixture signal deadline")), 10000); })]); } finally { clearTimeout(timer); } }
const checks = [];
const check = (name, work) => checks.push([name, work]);

async function fixture(work) {
	let mode = "ok", gate = null, generationCount = 0;
	const requests = [], commands = [], journal = new Map(), sockets = new Set();
	const state = { take: "old-take", undo: 0, token: "token-1", physics: 1, verify: "verified", repairs: [], commit: "ok", disconnect: null };
	const bridge = createServer(async (req, res) => {
		requests.push(req.url);
		if (req.url === "/ardy/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, host: "fixture", device: "cuda" })); return; }
		if (req.url === "/ardy/motions/123456-abcdef") { res.end("fixture-artifact-bytes"); return; }
		assert.equal(req.url, "/ardy/generate"); generationCount++;
		let body = ""; for await (const chunk of req) body += chunk;
		assert.equal(JSON.parse(body).posePin, false);
		if (gate) { gate.arrived.resolve(); await gate.release.promise; }
		if (res.destroyed) return;
		res.writeHead(200, { "content-type": "application/x-ndjson" });
		const done = JSON.stringify({ event: "done", motionUrl: "/ardy/motions/123456-abcdef" });
		if (mode === "malformed") res.end('{"event":');
		else if (mode === "incomplete") res.end('{"event":"progress","progress":17}\n');
		else if (mode === "trailing-malformed") res.end(done + '\n{bad');
		else if (mode === "invalid-url") res.end('{"event":"done","motionUrl":"http://evil/artifact"}');
		else res.end('{"event":"progress","progress":17}\n' + done + '\n' + done);
	});
	await new Promise(r => bridge.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${bridge.address().port}`;
	const hub = await startLiveHub(0);
	assert.ok(hub);
	let handle, runtime;
	const host = { workspaceId: "workspace-1", documentEpoch: "doc-1", sceneId: "scene-1", sceneEpoch: "epoch-1" };
	const respond = async (socket, frame) => {
		if (frame.type !== "cmd") return;
		commands.push(frame.name);
		const a = frame.args;
		let value;
		if (frame.name === "describe") value = { sceneName: "fixture", activeCharacterId: "char-a", camera: { x: 0, y: 1.6, z: 4.5, focalMm: 35 }, timeline: { currentFrame: 0, frameCount: 48, fps: 24 }, stage: {}, characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, y: 0, z: 0 }], objects: [] };
		else if (frame.name === "prepare_motion_install") {
			assert.equal(a.binding.characterId, "char-a"); assert.deepEqual(a.binding.host, host);
			assert.equal(new URL(a.artifact.url).origin, origin);
			assert.equal(await (await fetch(a.artifact.url)).text(), "fixture-artifact-bytes");
			value = { candidateId: "candidate-1", candidateRevision: 1, targetToken: state.token, physicsRevision: state.physics, structurallyValid: true };
		} else if (frame.name === "verify_motion_candidate") {
			value = { verificationId: randomUUID(), candidateId: a.candidateId, candidateRevision: a.candidateRevision, targetToken: state.token, physicsRevision: state.physics, status: state.verify, structurallyValid: true, repairable: state.verify !== "verified", profile: "studio-motion-v1", evaluatedFrames: 48 };
		} else if (frame.name === "repair_motion_candidate") {
			state.repairs.push(a.method); if (a.method === "fix_collisions") state.verify = "verified";
			value = { candidateId: a.candidateId, candidateRevision: a.candidateRevision + 1, targetToken: state.token, physicsRevision: state.physics, structurallyValid: true };
		} else if (frame.name === "commit_motion_candidate") {
			assert.equal(a.binding.characterId, "char-a"); assert.deepEqual(a.binding.host, host);
			if (state.token !== a.expectedTargetToken) value = { ok: false, code: "STALE_TARGET", mutated: false };
			else if (state.physics !== a.expectedPhysicsRevision) value = { ok: false, code: "STALE_ENVIRONMENT", mutated: false };
			else {
				if (state.commit !== "lost-not-applied" && state.commit !== "lost-unknown") { state.take = "new-take"; state.undo++; }
				value = { ok: true, status: "installed", commandId: a.commandId, receiptId: "receipt-" + a.commandId, host,
					authored: true, revision: { before: state.undo - 1, after: state.undo }, affectedIds: ["char-a"], delta: [{ id: "char-a", after: { takeId: "new-take" } }], checks: { coverage: "whole-clip" }, warnings: [], jobId: a.jobId, artifactId: a.artifactId,
					installed: { characterId: "char-a", beforeTakeId: "old-take", takeId: "new-take", targetToken: "token-new", frameCount: 48, fps: 24, durationSeconds: 2, blocks: [{ sourceBeat: 0, startFrame: 0, endFrameExclusive: 48 }], selectionChanged: false },
					verification: { id: a.verificationId, status: state.verify, profile: "studio-motion-v1", range: { startFrame: 0, endFrameExclusive: 48 }, evaluatedFrames: 48, physicsRevision: state.physics, limitations: [] },
					undo: { entries: 1, historyEntryId: "history-" + a.commandId, canUndoDirect: true }, explicitUnverifiedAcceptance: a.explicitUnverifiedAcceptance === true };
				if (state.commit === "invalid-receipt") delete value.undo;
				if (state.commit === "wrong-job") value.jobId = "other-job";
				if (state.commit === "lost-not-applied") journal.set(a.commandId, { status: "not_applied", evidence: "cancel-fence" });
				else if (state.commit !== "lost-unknown") journal.set(a.commandId, { status: "applied", receipt: value });
				if (state.commit.startsWith("lost")) { socket.close(); state.disconnect?.resolve(); return; }
			}
		} else if (frame.name === "reconcile_studio_command") value = journal.get(a.commandId) ?? { status: "unknown" };
		else if (frame.name === "cancel_motion_install") { journal.set(a.commandId, { status: "not_applied", evidence: "cancel-fence" }); value = { status: "not_applied" }; }
		else if (frame.name === "discard_motion_candidate") value = { discarded: true };
		else throw new Error("unexpected command " + frame.name);
		if (socket.readyState === WebSocket.OPEN) { const raw = JSON.stringify({ type: "result", id: frame.id, ok: true, value }); socket.send(raw); socket.send(raw); }
	};
	async function connect(workspaceId = host.workspaceId) {
		const socket = new WebSocket(`ws://127.0.0.1:${hub.server.address().port}/live`); sockets.add(socket);
		const ready = deferred();
		socket.on("message", raw => { const frame = JSON.parse(raw); if (frame.type === "workspace") ready.resolve(frame.handle); else void respond(socket, frame).catch(error => { console.error(error); socket.close(); }); });
		await once(socket, "open"); socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1, workspaceId }));
		handle = await bounded(ready.promise); return handle;
	}
	try {
		await connect();
		const input = (overrides = {}) => ({ hostBinding: { ...host, workspaceHandle: handle }, characterId: "char-a", targetToken: "token-1", turnId: randomUUID(), commandId: randomUUID(), authorization: { id: randomUUID(), generations: 1 }, source: { kind: "generate", beats: [{ text: "A person walks.", seconds: 2 }] }, repair: "none", ...overrides });
		await work({ hub, origin, state, requests, commands, connect, input, get generations() { return generationCount; }, setMode: v => { mode = v; }, setGate: () => { gate = { arrived: deferred(), release: deferred() }; return gate; }, setRuntime: r => { runtime = r; } });
	} finally {
		if (gate) gate.release.resolve();
		await runtime?.dispose();
		for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, "close"); socket.terminate(); await closed; }
		for (const socket of hub.server.clients) socket.terminate();
		await new Promise(r => hub.server.close(r)); bridge.closeAllConnections(); await new Promise(r => bridge.close(r));
		console.log("CLEANUP HTTP/live sockets closed", origin);
	}
}
function runtimeFor(f, options = {}) {
	assert.equal(typeof motion.createStudioMotionRuntime, "function", "owned Studio admission/start API is required");
	const runtime = motion.createStudioMotionRuntime({ liveHub: f.hub, getBridgeOrigin: () => f.origin, ...options }); f.setRuntime(runtime); return runtime;
}
function begin(runtime, input, listener = () => {}) { const job = runtime.admit(input); runtime.subscribe(job.jobId, listener); return { job, result: runtime.start(job.jobId) }; }

check("legal transition table rejects false proof and terminal revival", async () => {
	assert.equal(typeof motion.assertMotionTransition, "function");
	for (const [from, to] of [["queued","generating"],["generating","preparing"],["preparing","verifying"],["verifying","repairing"],["repairing","verifying"],["verifying","committing"],["committing","installed"],["verifying","review_required"],["committing","reconciling"],["reconciling","proved-not-applied"]]) motion.assertMotionTransition(from, to);
	for (const from of ["queued","generating","preparing","verifying","repairing"]) for (const to of ["failed","cancelled","stale_target","stale_environment"]) motion.assertMotionTransition(from, to);
	for (const [from, to] of [["installed","generating"],["queued","installed"],["reconciling","cancelled"]]) assert.throws(() => motion.assertMotionTransition(from, to));
});
check("shared parser consumes EOF, requires done, rejects malformed tails", async () => {
	assert.equal(typeof motion.readMotionStream, "function");
	const read = text => motion.readMotionStream(new Response(text));
	assert.equal(await read('{"event":"done","motionUrl":"/ardy/motions/123456-abcdef"}'), "/ardy/motions/123456-abcdef");
	for (const text of ['{"event":', '{"event":"progress"}\n', '{"event":"done","motionUrl":"/ardy/motions/123456-abcdef"}\n{bad', '{"event":"done","motionUrl":"http://other/take"}']) await assert.rejects(read(text));
});
check("MCP current handler final non-newline artifact and immediate acknowledgement", () => fixture(async f => {
	const old = process.env.COZYCLAY_BRIDGE_ORIGIN; process.env.COZYCLAY_BRIDGE_ORIGIN = f.origin;
	setLiveHub(f.hub); const published = deferred(); const registry = new MotionJobRegistry(); const gate = f.setGate();
	try {
		const tool = createToolHandlers({ motionJobs: registry, publishMotionJob: job => published.resolve(job) }).find(t => t.name === "generate_motion");
		const result = await tool.handler({ phases: ["A person walks."], seconds: 2 });
		assert.equal(JSON.parse(result.content[0].text).status, "queued");
		await bounded(gate.arrived.promise); gate.release.resolve();
		const job = await bounded(published.promise);
		assert.equal(job.status, "completed", JSON.stringify(job.outcome)); assert.equal(job.outcome.motionUrl, "/ardy/motions/123456-abcdef"); assert.equal(f.generations, 1);
	} finally { setLiveHub(null); if (old === undefined) delete process.env.COZYCLAY_BRIDGE_ORIGIN; else process.env.COZYCLAY_BRIDGE_ORIGIN = old; }
}));
check("real HTTP + live hub: subscribe before start, pin origin, replay without apply", () => fixture(async f => {
	let origin = f.origin; const telemetry = []; const lifecycle = startMotionRequest({ surface: "mcp", input_mode: "prompt" }, { capture: (event, props) => telemetry.push({ event, props }) });
	const runtime = runtimeFor(f, { getBridgeOrigin: () => origin }); const input = f.input(); const job = runtime.admit({ ...input, motionRequest: lifecycle });
	assert.equal(f.generations, 0); assert.throws(() => runtime.start(job.jobId), /subscri/i);
	origin = "http://127.0.0.1:1"; const events = []; const detach = runtime.subscribe(job.jobId, e => events.push(e));
	const gate = f.setGate(); const result = runtime.start(job.jobId); await bounded(gate.arrived.promise);
	assert.equal(runtime.start(job.jobId), result); detach(); const replay = []; runtime.subscribe(job.jobId, e => replay.push(e)); gate.release.resolve();
	const receipt = await bounded(result); assert.equal(receipt.status, "installed"); assert.equal(f.state.undo, 1); assert.equal(f.generations, 1);
	assert.deepEqual(replay.filter(e => e.type === "job.state").map(e => e.state), ["queued","generating","preparing","verifying","committing","installed"]);
	assert.ok(replay.some(e => e.type === "job.progress" && e.progress === 17)); assert.ok(replay.every((e, i) => i === 0 || e.eventSeq > replay[i - 1].eventSeq));
	assert.ok(replay.every(e => e.turnId === input.turnId && e.commandId === input.commandId && e.jobId === job.jobId));
	assert.deepEqual(runtime.admit({ ...input, motionRequest: lifecycle }), job); assert.equal(runtime.start(job.jobId), result);
	assert.equal((await runtime.stop(job.jobId)).status, "already_applied"); assert.deepEqual((await runtime.stop(job.jobId)).receipt, receipt);
	assert.deepEqual(telemetry.map(e => e.event), ["motion:generate_requested","motion:preflight_passed","motion:job_started","motion:job_succeeded","motion:result_applied"]);
	assert.equal(new Set(telemetry.map(e => e.props.request_id)).size, 1);
	assert.doesNotMatch(JSON.stringify(telemetry), /char-a|workspace-1|A person|http:/);
	console.log("SURFACE", JSON.stringify({ origin: f.origin, requests: f.requests, commands: f.commands, generations: f.generations, undo: f.state.undo, receipt }));
}));
check("malformed/incomplete/missing/unreachable bridge preserves old take", () => fixture(async f => {
	const runtime = runtimeFor(f);
	for (const mode of ["malformed","incomplete","trailing-malformed","invalid-url"]) { f.setMode(mode); const { result } = begin(runtime, f.input()); const outcome = await bounded(result); assert.equal(outcome.mutated, false); assert.equal(f.state.take, "old-take"); assert.equal(f.state.undo, 0); }
	assert.throws(() => motion.createStudioMotionRuntime({ liveHub: f.hub, getBridgeOrigin: () => null }).admit(f.input()), /bridge/i);
	const other = motion.createStudioMotionRuntime({ liveHub: f.hub, getBridgeOrigin: () => "http://127.0.0.1:1" });
	try { const { result } = begin(other, f.input()); assert.equal((await bounded(result)).code, "BACKEND_UNAVAILABLE"); } finally { await other.dispose(); }
}));
check("Stop before commit aborts stream and never changes authored state", () => fixture(async f => {
	const runtime = runtimeFor(f); const gate = f.setGate(); const { job, result } = begin(runtime, f.input()); await bounded(gate.arrived.promise);
	await runtime.stop(job.jobId); gate.release.resolve(); assert.equal((await bounded(result)).code, "CANCELLED"); assert.equal(f.state.undo, 0); assert.ok(!f.commands.includes("commit_motion_candidate"));
}));
check("lost result stays unknown; reconnect reconciles without duplicate apply", () => fixture(async f => {
	const runtime = runtimeFor(f); f.state.commit = "lost-applied";
	const { job, result } = begin(runtime, f.input()); const unknown = await bounded(result);
	assert.equal(unknown.code, "UNCERTAIN_APPLY"); assert.equal(unknown.mutated, "unknown"); assert.equal(runtime.get(job.jobId).state, "reconciling"); assert.equal(f.state.undo, 1);
	await f.connect(); const receipt = await runtime.reconcile(job.jobId); assert.equal(receipt.status, "installed");
	assert.equal((await runtime.stop(job.jobId)).status, "already_applied"); assert.equal(f.generations, 1); assert.equal(f.commands.filter(n => n === "commit_motion_candidate").length, 1); assert.equal(f.state.undo, 1);
}));
check("journal absence is not proof; explicit not-applied is required", () => fixture(async f => {
	const runtime = runtimeFor(f); f.state.commit = "lost-unknown";
	let { job, result } = begin(runtime, f.input()); assert.equal((await bounded(result)).mutated, "unknown");
	assert.equal((await runtime.stop(job.jobId)).mutated, "unknown", "Stop while disconnected must not erase uncertainty"); await f.connect();
	assert.equal((await runtime.reconcile(job.jobId)).mutated, "unknown"); assert.equal(runtime.get(job.jobId).state, "reconciling");
	assert.throws(() => runtime.admit(f.input()), /busy|capacity/i);
}));
check("explicit journal cancellation proves not-applied, not installed", () => fixture(async f => {
	const runtime = runtimeFor(f); f.state.commit = "lost-not-applied"; const { job, result } = begin(runtime, f.input()); await bounded(result); await f.connect();
	assert.equal((await runtime.reconcile(job.jobId)).mutated, false); assert.equal(runtime.get(job.jobId).state, "proved-not-applied"); assert.equal(f.state.undo, 0);
}));
check("2 global / 1 workspace; receipt survives job TTL; authorization cannot replay", () => fixture(async f => {
	let now = 0; const runtime = runtimeFor(f, { clock: () => now, ttlMs: 10 }); const input = f.input(); const { job, result } = begin(runtime, input); const receipt = await bounded(result);
	now = 11; await runtime.cleanup(); assert.equal(runtime.get(job.jobId), null); assert.deepEqual(runtime.getReceipt(input.commandId), receipt);
	assert.throws(() => runtime.admit(f.input({ authorization: input.authorization })), /authoriz/i);
	const first = runtime.admit(f.input()); assert.throws(() => runtime.admit(f.input()), /busy|capacity/i);
	const secondHandle = await f.connect("workspace-2"); const second = runtime.admit(f.input({ hostBinding: { ...input.hostBinding, workspaceId: "workspace-2", workspaceHandle: secondHandle } }));
	const thirdHandle = await f.connect("workspace-3"); assert.throws(() => runtime.admit(f.input({ hostBinding: { ...input.hostBinding, workspaceId: "workspace-3", workspaceHandle: thirdHandle } })), /capacity/i);
	await runtime.stop(first.jobId); await runtime.stop(second.jobId);
}));
check("bounded repair / soft review / exact stale target and environment", () => fixture(async f => {
	const runtime = runtimeFor(f); f.state.verify = "unverified";
	let { result } = begin(runtime, f.input({ repair: "bounded" })); assert.equal((await bounded(result)).status, "installed"); assert.deepEqual(f.state.repairs, ["auto_physics","fix_collisions"]);
	f.state.verify = "unverified"; let next = begin(runtime, f.input()); assert.equal((await bounded(next.result)).status, "review_required"); assert.equal(f.state.undo, 1);
	assert.equal((await runtime.stop(next.job.jobId)).status, "cancelled");
	f.state.token = "edited-token"; f.state.verify = "verified"; next = begin(runtime, f.input()); assert.equal((await bounded(next.result)).code, "STALE_TARGET"); assert.equal(f.state.undo, 1);
}));
check("malformed installation receipt is uncertainty, not success", () => fixture(async f => {
	const runtime = runtimeFor(f); f.state.commit = "invalid-receipt"; const { job, result } = begin(runtime, f.input());
	assert.equal((await bounded(result)).code, "UNCERTAIN_APPLY"); assert.equal(runtime.get(job.jobId).state, "reconciling"); assert.equal(f.state.undo, 1);
}));
check("explicit unverified acceptance rechecks guards and commits once", () => fixture(async f => {
	const runtime = runtimeFor(f); f.state.verify = "unverified"; const { job, result } = begin(runtime, f.input());
	assert.equal((await bounded(result)).status, "review_required"); assert.equal(f.state.undo, 0);
	const receipt = await runtime.accept(job.jobId); assert.equal(receipt.status, "installed"); assert.equal(receipt.explicitUnverifiedAcceptance, true); assert.equal(receipt.verification.status, "unverified");
	await assert.rejects(runtime.accept(job.jobId)); assert.equal(f.state.undo, 1); assert.equal(f.generations, 1);
}));
check("commit-time environment fence preserves state", () => fixture(async f => {
	const runtime = runtimeFor(f); const { job, result } = begin(runtime, f.input(), e => { if (e.state === "committing") f.state.physics++; });
	assert.equal((await bounded(result)).code, "STALE_ENVIRONMENT"); assert.equal(runtime.get(job.jobId).state, "stale_environment"); assert.equal(f.state.take, "old-take"); assert.equal(f.state.undo, 0);
}));
check("unverified acceptance with stale target stays rejected", () => fixture(async f => {
	const runtime = runtimeFor(f); f.state.verify = "unverified"; const { job, result } = begin(runtime, f.input()); await bounded(result); f.state.token = "edited-token";
	await assert.rejects(runtime.accept(job.jobId), e => e.code === "STALE_TARGET"); assert.equal(runtime.get(job.jobId).state, "stale_target"); assert.equal(f.state.undo, 0);
}));
check("valid receipt for another job cannot establish application", () => fixture(async f => {
	const runtime = runtimeFor(f); f.state.commit = "wrong-job"; const { result } = begin(runtime, f.input()); assert.equal((await bounded(result)).mutated, "unknown"); assert.equal(f.state.undo, 1);
}));
check("review acceptance cannot bypass workspace capacity or candidate expiry", () => fixture(async f => {
	let now = 0; const runtime = runtimeFor(f, { clock: () => now, ttlMs: 10 }); f.state.verify = "unverified"; const { job, result } = begin(runtime, f.input()); await bounded(result);
	const other = runtime.admit(f.input()); await assert.rejects(runtime.accept(job.jobId), e => e.code === "TARGET_BUSY"); await runtime.stop(other.jobId);
	now = 11; await assert.rejects(runtime.accept(job.jobId), e => e.code === "STALE_TARGET"); assert.equal(f.state.undo, 0);
}));
let failures = 0;
for (const [name, work] of checks) { try { await work(); console.log("PASS", name); } catch (error) { failures++; console.error("FAIL", name, error.stack); } }
console.log(`Studio jobs: ${checks.length - failures}/${checks.length} passed`); process.exitCode = failures ? 1 : 0;
