#!/usr/bin/env node
// Host contract for the shared Agent chat (#292).
//
// test/verify-agent-panel.mjs pins the dock's source/layout contract. This
// suite drives the ACTUAL transport and chat store: real SSE bytes through
// createHttpTransport, the frozen task-1 Studio envelope/receipt validators,
// job progress, reconnect-by-cursor, acknowledged image actions and the
// explicit acceptance of an unverified motion candidate.
//
//   node test/verify-agent-host.mjs --case embedded-session-and-receipts
//   node test/verify-agent-host.mjs --case failed-action-and-reconnect
import { readFileSync } from "node:fs";
// Namespace import on purpose: this suite must still run, and fail for the
// behaviour it checks, against a client that has not grown the host API yet.
import * as client from "../src/workflow/agent-client.js";
import {
	isUuid,
	validateReceipt,
	validateStudioStopEnvelope,
	validateStudioTurnEnvelope,
} from "../src/studio-agent-protocol.js";

const CASES = ["embedded-session-and-receipts", "failed-action-and-reconnect"];
const index = process.argv.indexOf("--case");
const requested = index === -1 ? null : process.argv[index + 1];
// No --case runs every case (the suite runner takes no arguments); an unknown
// case is an error, never a silent empty pass.
if (index !== -1 && !CASES.includes(requested)) {
	console.error(`usage: node test/verify-agent-host.mjs [--case <${CASES.join("|")}>]`);
	process.exit(2);
}
const selectedCases = requested ? [requested] : CASES;
const selected = requested ?? CASES.join(" + ");
const runs = (name) => selectedCases.includes(name);

const panelSource = readFileSync(new URL("../src/workflow/AgentPanel.jsx", import.meta.url), "utf8");
const panelCss = readFileSync(new URL("../src/workflow/agent-panel.css", import.meta.url), "utf8");

const { createHttpTransport } = client;
const createStudioSessionId = (...args) => {
	if (typeof client.createStudioSessionId !== "function") throw new Error("agent-client.js exposes no createStudioSessionId(); the chat has no UUID session identity");
	return client.createStudioSessionId(...args);
};
const createAgentChatStore = (options) => {
	if (typeof client.createAgentChatStore !== "function") throw new Error("agent-client.js exposes no createAgentChatStore(); the panel still owns chat/session/job state privately");
	return client.createAgentChatStore(options);
};

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
async function group(name, run) {
	try {
		await run();
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${name} threw — ${error?.stack || error}`);
	}
}

// --- fixtures ---------------------------------------------------------------

const HOST = { workspaceId: "tab-7", documentEpoch: "doc-3", sceneId: "scene-main", sceneEpoch: "scene-open-4" };

function studioContext(sceneRevision = 41) {
	return {
		schema: "studio-context-v1",
		host: { surface: "studio", ...HOST, workspaceHandle: "handle-12" },
		revision: { scene: sceneRevision, physics: 9, view: 18 },
		units: { distance: "m", angle: "deg", up: "+Y", yawZero: "+Z", yawPositiveToward: "+X", fps: 24, rangeEnd: "exclusive" },
		scene: { name: "Workshop", aspect: "16:9", floorY: 0, frameCount: 144, objectCount: 1, characterCount: 1 },
		selection: { kind: "character", id: "char-alex" },
		activeCharacterId: "char-alex",
		view: { mode: "scene", frame: 0, playing: false, lookThrough: false, grid: false, autoColor: false },
		shot: { id: "shot-1", name: "Wide", range: { startFrame: 0, endFrameExclusive: 144 }, mode: "keys" },
		camera: { position: { x: 0, y: 1.6, z: 5 }, lookAt: { x: 0, y: 1, z: 0 }, focalMm: 35, sensorId: "sensor-super35", slate: "wide shot" },
		entities: [
			{ id: "char-alex", kind: "character", token: "ct-11", name: "Alex", position: { x: 0, y: 0, z: 0 }, yawDeg: 0, scale: 1 },
			{ id: "chair", kind: "object", token: "ot-4", name: "Chair", position: { x: 1, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
		],
		entityPage: { returned: 2, total: 2, truncated: false, nextCursor: null },
		shots: [{ id: "shot-1", name: "Wide", range: { startFrame: 0, endFrameExclusive: 144 }, keyCount: 1 }],
		shotsTruncated: false,
		assets: [],
		recentReceipts: [],
		jobs: [],
		capabilities: { profile: "studio-slice-1", tools: ["inspect_studio", "operate_studio", "arrange_objects", "arrange_characters", "frame_shot", "generate_motion", "verify_result", "undo_edit"] },
	};
}

const installedReceipt = (overrides = {}) => ({
	ok: true,
	commandId: "cmd-1",
	receiptId: "receipt-1",
	host: { ...HOST },
	status: "installed",
	authored: true,
	revision: { before: 41, after: 42 },
	affectedIds: ["char-alex"],
	delta: [{ id: "char-alex", after: { takeId: "take-9" } }],
	checks: { coverage: "whole-clip" },
	undo: { historyEntryId: "h-42", entries: 1, canUndoDirect: true },
	warnings: [],
	jobId: "job-1",
	artifactId: "artifact-1",
	installed: { characterId: "char-alex", beforeTakeId: "take-old", takeId: "take-9", targetToken: "ct-11", frameCount: 96, fps: 24, durationSeconds: 4, blocks: [{ sourceBeat: 0, startFrame: 0, endFrameExclusive: 96 }], selectionChanged: false },
	verification: { id: "ver-1", status: "verified", profile: "studio-motion-v1", range: { startFrame: 0, endFrameExclusive: 96 }, evaluatedFrames: 96, physicsRevision: 9, limitations: [] },
	...overrides,
});

const unverifiedReceipt = () => installedReceipt({
	receiptId: "receipt-2",
	explicitUnverifiedAcceptance: true,
	verification: { id: "ver-2", status: "unverified", profile: "studio-motion-v1", range: { startFrame: 0, endFrameExclusive: 96 }, evaluatedFrames: 96, physicsRevision: 9, limitations: ["elevated support is not certifiable"] },
});

const failureReceipt = () => ({
	ok: false,
	commandId: "cmd-9",
	host: { ...HOST },
	code: "STALE_TARGET",
	phase: "commit",
	affectedIds: ["char-alex"],
	expectedTargets: [{ ...HOST, targetId: "char-alex", token: "ct-11" }],
	currentTargets: [{ ...HOST, targetId: "char-alex", token: "ct-12" }],
	mutated: false,
	preserved: { authoredState: "unchanged" },
	recovery: { action: "new_intent", retryAllowed: false },
	message: "The target changed while the job was running.",
});

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;

/** A real streamed body: chunk list in, ReadableStream-like reader out. */
function sseBody(chunks, { drop = false } = {}) {
	const encoder = new TextEncoder();
	let at = 0;
	return {
		getReader() {
			return {
				async read() {
					if (at < chunks.length) return { value: encoder.encode(chunks[at++]), done: false };
					if (drop) throw new Error("stream dropped before the terminal event");
					return { value: undefined, done: true };
				},
				releaseLock() {},
			};
		},
	};
}

/** Loopback sidecar double. Every call is recorded with its parsed body. */
function fakeSidecar(routes) {
	const calls = [];
	const fetchImpl = async (url, init = {}) => {
		const path = String(url);
		const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : null;
		calls.push({ path, method: init.method || "GET", body });
		const route = Object.keys(routes).find((pattern) => new RegExp(pattern).test(path));
		if (!route) throw new Error(`unrouted sidecar call ${path}`);
		return routes[route]({ path, body, calls });
	};
	return { fetchImpl, calls };
}

const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload, clone: () => ({ json: async () => payload }) });
const streamResponse = (chunks, options) => ({ ok: true, status: 200, body: sseBody(chunks, options) });

const settled = (store, predicate) => new Promise((resolve, reject) => {
	if (predicate(store.getState())) { resolve(store.getState()); return; }
	const unsubscribe = store.subscribe((state) => {
		if (!predicate(state)) return;
		unsubscribe();
		resolve(state);
	});
	// A store that never reaches the state is a defect, not a slow test.
	setTimeout(() => { unsubscribe(); reject(new Error("store never reached the expected state")); }, 5000).unref?.();
});

const items = (store, kind) => store.getState().items.filter((item) => item.kind === kind);

// --- case: embedded-session-and-receipts ------------------------------------

if (runs("embedded-session-and-receipts")) {
	await group("studio session identity", () => {
		const id = createStudioSessionId();
		expect("the client mints canonical UUID session identities", isUuid(id), String(id));
		expect("every minted session identity is distinct", createStudioSessionId() !== id);
	});

	await group("studio send", async () => {
		let revision = 41;
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "text.delta", text: "Framing the shot." }),
				frame({ type: "done" }),
			]),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext(revision) });
		expect("the store opens with a UUID session", isUuid(store.getState().sessionId), store.getState().sessionId);
		await store.send("frame a wide two-shot", { attachFrame: false, model: "gpt-5.1-codex" });
		const body = sidecar.calls.find((call) => call.path === "/agent/turn").body;
		let accepted = true;
		try { validateStudioTurnEnvelope(body); } catch (error) { accepted = false; expect("the Studio turn body satisfies the frozen task-1 envelope", false, `${error.code} ${error.message} ${JSON.stringify(error.details)} body=${JSON.stringify(Object.keys(body || {}))}`); }
		if (accepted) expect("the Studio turn body satisfies the frozen task-1 envelope", true);
		expect("the Studio turn carries a UUID turnId, not an analytics id", isUuid(body?.turnId) && !Object.hasOwn(body || {}, "turn_id"), JSON.stringify(Object.keys(body || {})));
		expect("the Studio turn carries the session UUID", body?.sessionId === store.getState().sessionId);
		revision = 42;
		await store.send("now key it", { attachFrame: false });
		const second = sidecar.calls.filter((call) => call.path === "/agent/turn").at(-1).body;
		expect("context is rebuilt at send, not cached from the first turn", second?.context?.revision?.scene === 42, JSON.stringify(second?.context?.revision));
		expect("each turn mints a fresh turnId", second?.turnId !== body?.turnId && isUuid(second?.turnId));
	});

	await group("synchronous receipts inside tool.done reach the host", async () => {
		// #362: arrange_*/frame_shot/patch_elements/undo_edit return their receipt
		// as the tool result, not as a `receipt` frame — the host highlight must
		// still fire for them, and must not fire for a plain inspect result.
		const applied = { ok: true, commandId: "cmd-p", receiptId: "receipt-p-1", status: "applied", authored: true, revision: { before: 1, after: 2 }, affectedIds: ["char-a"], delta: [], checks: { coverage: "declared-element-readback" }, undo: { historyEntryId: "h-1", entries: 1, canUndoDirect: true }, warnings: [] };
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "tool.start", callId: "c-1", name: "inspect_studio", label: "Read the scene", args: {} }),
				frame({ type: "tool.done", callId: "c-1", ok: true, elapsedMs: 2, result: { context: {}, entities: [] } }),
				frame({ type: "tool.start", callId: "c-2", name: "patch_elements", label: "Edit properties", args: {} }),
				frame({ type: "tool.done", callId: "c-2", ok: true, elapsedMs: 3, result: applied }),
				frame({ type: "done" }),
			]),
		});
		const seen = [];
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext(7), onReceipt: (receipt) => seen.push(receipt) });
		await store.send("tint her teal", { attachFrame: false, model: "gpt-5.1-codex" });
		expect("an applied receipt returned by tool.done is handed to the host exactly once", seen.length === 1 && seen[0]?.receiptId === "receipt-p-1", JSON.stringify(seen.map((r) => r?.receiptId)));
		expect("the host receipt carries the affected ids the rows are looked up by", JSON.stringify(seen[0]?.affectedIds) === JSON.stringify(["char-a"]));
		expect("a plain tool result does not masquerade as a receipt", !seen.some((r) => r && r.receiptId === undefined));
		expect("the transcript keeps the tool card and adds no duplicate receipt card", store.getState().items.filter((item) => item.kind === "receipt").length === 0, JSON.stringify(store.getState().items.map((item) => item.kind)));
	});

	await group("dock defaults are unchanged", async () => {
		const sidecar = fakeSidecar({ "/agent/turn$": () => streamResponse([frame({ type: "done" })]) });
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "workflow", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "workflow" });
		await store.send("add a node", { attachFrame: false, model: "gpt-5.1" });
		const body = sidecar.calls.find((call) => call.path === "/agent/turn").body;
		expect("the Workflow dock keeps the legacy turn body", ["sessionId", "text", "attachFrame", "model"].every((key) => Object.hasOwn(body, key)) && !Object.hasOwn(body, "surface") && !Object.hasOwn(body, "context"), JSON.stringify(Object.keys(body)));
		expect("the Workflow dock keeps its separate turn_id telemetry identifier", /^[a-f0-9]{32}$/.test(String(body.turn_id)));
	});

	await group("job progress, stop and installed receipt", async () => {
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "job.state", eventSeq: 1, jobId: "job-1", commandId: "cmd-1", state: "queued", progress: null, phase: "queued" }),
				frame({ type: "job.state", eventSeq: 2, jobId: "job-1", commandId: "cmd-1", state: "generating", progress: null, phase: "generating" }),
				frame({ type: "job.progress", eventSeq: 3, jobId: "job-1", commandId: "cmd-1", state: "generating", progress: 0.4, phase: "generating" }),
				frame({ type: "receipt", eventSeq: 4, receipt: installedReceipt() }),
				frame({ type: "receipt", eventSeq: 5, receipt: installedReceipt() }),
				frame({ type: "done" }),
			]),
			"/agent/stop$": () => jsonResponse({ ok: true }),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext() });
		await store.send("walk to the chair and sit", {});
		const jobs = items(store, "job");
		expect("one job card tracks the whole generation", jobs.length === 1, JSON.stringify(jobs.map((job) => job.jobId)));
		expect("the job card reports the actual forwarded progress", jobs[0]?.progress === 0.4, String(jobs[0]?.progress));
		expect("the job card ends in its terminal installed state", jobs[0]?.state === "installed", String(jobs[0]?.state));
		const receipts = items(store, "receipt");
		expect("the installed receipt renders exactly one card", receipts.length === 1, String(receipts.length));
		expect("a duplicate receipt does not create a second card", items(store, "receipt").filter((item) => item.receiptId === "receipt-1").length === 1, JSON.stringify(store.getState().items.map((item) => item.kind)));
		expect("the rendered receipt is the validated task-1 receipt", (() => { try { validateReceipt(receipts[0]?.receipt); return true; } catch { return false; } })());
		expect("the store stops streaming at the terminal event", store.getState().streaming === false);
	});

	await group("Stop identifies the turn and the job", async () => {
		let release;
		const held = new Promise((resolve) => { release = resolve; });
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "job.state", eventSeq: 1, jobId: "job-7", commandId: "cmd-7", state: "generating", progress: null, phase: "generating" }),
			], { drop: false }),
			"/agent/stop$": () => { release(); return jsonResponse({ ok: true }); },
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext() });
		const turn = store.send("generate a walk", {});
		await settled(store, (state) => state.items.some((item) => item.kind === "job" && item.jobId === "job-7"));
		store.stop();
		await held;
		await turn.catch(() => {});
		const stop = sidecar.calls.find((call) => call.path === "/agent/stop");
		let valid = true;
		try { validateStudioStopEnvelope(stop?.body); } catch (error) { valid = false; expect("Stop sends the frozen task-1 stop envelope", false, `${error.code} ${error.message} body=${JSON.stringify(stop?.body)}`); }
		if (valid) expect("Stop sends the frozen task-1 stop envelope", true);
		expect("Stop names the running job", stop?.body?.jobId === "job-7", JSON.stringify(stop?.body));
		expect("Stop leaves the panel idle", store.getState().streaming === false);
	});

	await group("explicit acceptance of an unverified candidate", async () => {
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "job.state", eventSeq: 1, jobId: "job-1", commandId: "cmd-1", state: "verifying", progress: null, phase: "verifying" }),
				frame({ type: "job.state", eventSeq: 2, jobId: "job-1", commandId: "cmd-1", state: "review_required", progress: null, phase: "contact verification failed" }),
				frame({ type: "done" }),
			]),
			"/agent/jobs/.*/accept$": () => jsonResponse({ ok: true, receipt: unverifiedReceipt() }),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext() });
		await store.send("generate a walk", {});
		const job = items(store, "job")[0];
		expect("a soft failure stops at review_required", job?.state === "review_required", String(job?.state));
		expect("the candidate is never labelled verified", job?.verified !== true && job?.acceptance?.status === "required", JSON.stringify(job?.acceptance));
		await store.acceptJob("job-1");
		const accept = sidecar.calls.find((call) => /\/accept$/.test(call.path));
		expect("Apply with warnings posts the job accept route", accept?.path === "/agent/jobs/job-1/accept" && accept.method === "POST", JSON.stringify(accept?.path));
		expect("acceptance is explicit in the request body", accept?.body?.explicitUnverifiedAcceptance === true && accept?.body?.surface === "studio" && isUuid(accept?.body?.sessionId), JSON.stringify(accept?.body));
		const accepted = items(store, "job")[0];
		expect("the accepted job installs with its unverified label intact", accepted?.state === "installed" && accepted?.verification?.status === "unverified", JSON.stringify({ state: accepted?.state, verification: accepted?.verification?.status }));
		expect("the acceptance receipt is recorded once", items(store, "receipt").filter((item) => item.receiptId === "receipt-2").length === 1);
	});

	await group("restore rebuilds the transcript and preserves identity", async () => {
		const store = createAgentChatStore({ transport: { turn: async () => {} }, surface: "studio" });
		store.restore([
			{ kind: "user", text: "frame a wide shot" },
			{ kind: "assistant", text: "I will frame it." },
			{ kind: "tool", name: "frame_shot", label: "Frame the shot", ok: true, elapsedMs: 12 },
			{ kind: "receipt", receiptId: "receipt-restore", summary: "Applied to the scene" },
		], "restored-session");
		expect("restore rebuilds user, assistant, tool and receipt items", store.getState().items.map((item) => item.kind).join(",") === "user,assistant,tool,receipt");
		expect("restore keeps the server session id", store.getState().sessionId === "restored-session");
		const before = store.getState().sessionId;
		store.newSession();
		expect("New mints a different UUID after restore", store.getState().sessionId !== before && isUuid(store.getState().sessionId));
	});

	await group("coherent Clear / New and a persistent draft", async () => {
		const sidecar = fakeSidecar({ "/agent/turn$": () => streamResponse([frame({ type: "text.delta", text: "ok" }), frame({ type: "done" })]) });
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext() });
		const first = store.getState().sessionId;
		await store.send("hello", {});
		store.setDraft("half written instruction");
		store.clearContext();
		expect("Clear context empties the transcript", store.getState().items.length === 0, String(store.getState().items.length));
		expect("Clear context also starts a new server session", isUuid(store.getState().sessionId) && store.getState().sessionId !== first, store.getState().sessionId);
		expect("Clear context keeps the unsent draft", store.getState().draft === "half written instruction", store.getState().draft);
		const cleared = store.getState().sessionId;
		await store.send("again", {});
		expect("sending consumes the draft", store.getState().draft === "", store.getState().draft);
		store.setDraft("half written instruction");
		store.newSession();
		expect("New starts another session", store.getState().sessionId !== cleared && isUuid(store.getState().sessionId));
		expect("New empties the transcript", store.getState().items.length === 0);
		expect("New keeps the unsent draft", store.getState().draft === "half written instruction");
	});

	await group("embedded host contract", () => {
		expect("the panel accepts an embedded host mode", /embedded\s*=\s*false/.test(panelSource));
		expect("embedded mode relinquishes the width and the resize handle to the host", /embedded \?[^\n]*undefined|!embedded && <div[^\n]*agent-resize|embedded \? null : <div/.test(panelSource) && /!embedded/.test(panelSource));
		expect("embedded mode relinquishes the global Cmd/Ctrl+B shortcut", /if \(embedded\) return;[\s\S]{0,400}metaKey \|\| event\.ctrlKey/.test(panelSource) || /embedded[^\n]*keydown/.test(panelSource));
		expect("a hidden embedded panel stays mounted and keeps its chat", /hidden=\{hidden\}|hidden=\{embedded && hidden\}/.test(panelSource));
		expect("the panel never renders a collapsed rail for an embedded host", /embedded[\s\S]{0,200}collapsed/.test(panelSource));
		expect("the chat state lives in the shared store, not a second emitter", panelSource.includes("createAgentChatStore") && panelSource.includes("useSyncExternalStore"));
	});
}

// --- case: failed-action-and-reconnect --------------------------------------

if (runs("failed-action-and-reconnect")) {
	await group("a refused image action stays unapplied", async () => {
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "image", imageId: "img-1", dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 8, height: 8, prompt: "wide two-shot" }),
				frame({ type: "done" }),
			]),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const requests = [];
		const store = createAgentChatStore({
			transport,
			surface: "studio",
			buildContext: () => studioContext(),
			requestImageAction: async (request) => { requests.push(request); return { ok: false, error: "The scene refused the image." }; },
		});
		await store.send("render it", {});
		const image = items(store, "image")[0];
		expect("the image result renders one card", Boolean(image), JSON.stringify(items(store, "image").length));
		await store.applyImage(image.id);
		const applied = items(store, "image")[0];
		expect("the host is asked to apply the image with a request identity", requests.length === 1 && Boolean(requests[0].requestId), JSON.stringify(requests));
		expect("a refused apply is NOT reported as placed", applied.placed === false, JSON.stringify({ placed: applied.placed, apply: applied.apply }));
		expect("the refusal is visible on the card", applied.apply?.status === "failed" && /refused/.test(applied.apply?.error || ""), JSON.stringify(applied.apply));
		store.acknowledgeImageAction({ requestId: requests[0].requestId, ok: true });
		expect("a late duplicate acknowledgement cannot flip a settled card", items(store, "image")[0].placed === false, JSON.stringify(items(store, "image")[0].apply));
	});

	await group("an unclaimed image action fails honestly", async () => {
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "image", imageId: "img-2", dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 8, height: 8 }),
				frame({ type: "done" }),
			]),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext(), requestImageAction: null });
		await store.send("render it", {});
		await store.applyImage(items(store, "image")[0].id);
		const image = items(store, "image")[0];
		expect("no host means no placement", image.placed === false && image.apply?.status === "failed", JSON.stringify(image.apply));
	});

	await group("reconnect resumes from the event cursor", async () => {
		let turns = 0;
		let resumes = 0;
		const sidecar = fakeSidecar({
			"/agent/turn$": () => {
				turns += 1;
				return streamResponse([
					frame({ type: "job.state", eventSeq: 1, jobId: "job-1", commandId: "cmd-1", state: "generating", progress: null, phase: "generating" }),
					frame({ type: "job.progress", eventSeq: 2, jobId: "job-1", commandId: "cmd-1", state: "generating", progress: 0.25, phase: "generating" }),
				], { drop: true });
			},
			"/agent/turn/.*/events": ({ path }) => {
				resumes += 1;
				const after = Number(new URL(path, "http://127.0.0.1").searchParams.get("after"));
				const replay = [
					{ type: "job.state", eventSeq: 1, jobId: "job-1", commandId: "cmd-1", state: "generating", progress: null, phase: "generating" },
					{ type: "job.progress", eventSeq: 2, jobId: "job-1", commandId: "cmd-1", state: "generating", progress: 0.25, phase: "generating" },
					{ type: "job.progress", eventSeq: 3, jobId: "job-1", commandId: "cmd-1", state: "committing", progress: 0.9, phase: "committing" },
					{ type: "receipt", eventSeq: 4, receipt: installedReceipt() },
					{ type: "done", eventSeq: 5 },
				];
				return { ok: true, status: 200, body: sseBody(replay.map(frame)), resumeAfter: after };
			},
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext() });
		await store.send("generate a walk", {});
		const resume = sidecar.calls.find((call) => /\/agent\/turn\/.*\/events/.test(call.path));
		expect("a dropped stream resumes through the events cursor route", Boolean(resume), JSON.stringify(sidecar.calls.map((call) => call.path)));
		expect("the cursor is the last event actually delivered", /after=2$/.test(resume?.path || ""), resume?.path);
		expect("resuming never re-runs the generation", turns === 1 && resumes === 1, JSON.stringify({ turns, resumes }));
		const jobs = items(store, "job");
		expect("replayed events do not duplicate the job card", jobs.length === 1, JSON.stringify(jobs.map((job) => job.jobId)));
		expect("the job finishes on the replayed terminal receipt", jobs[0]?.state === "installed", String(jobs[0]?.state));
		expect("the replayed receipt is recorded exactly once", items(store, "receipt").length === 1, String(items(store, "receipt").length));
		expect("the turn is settled after the resume", store.getState().streaming === false);
	});

	await group("a failure receipt keeps its structured recovery", async () => {
		const sidecar = fakeSidecar({
			"/agent/turn$": () => streamResponse([
				frame({ type: "job.state", eventSeq: 1, jobId: "job-1", commandId: "cmd-9", state: "committing", progress: null, phase: "committing" }),
				frame({ type: "receipt", eventSeq: 2, receipt: failureReceipt() }),
				frame({ type: "done" }),
			]),
		});
		const transport = createHttpTransport({ fetchImpl: sidecar.fetchImpl, surface: "studio", capture: () => {}, now: () => 0 });
		const store = createAgentChatStore({ transport, surface: "studio", buildContext: () => studioContext() });
		await store.send("generate a walk", {});
		const failure = items(store, "failure")[0];
		expect("the failure is shown as a structured failure, not 'upstream failed'", failure?.failure?.code === "STALE_TARGET", JSON.stringify(failure?.failure?.code));
		expect("the failure keeps its recovery action", failure?.failure?.recovery?.action === "new_intent");
		expect("a failed command reports no authored change", failure?.failure?.preserved?.authoredState === "unchanged");
		expect("the job card follows the failure", items(store, "job")[0]?.state === "failed", String(items(store, "job")[0]?.state));
	});

	await group("hidden embedded chat keeps state and refuses focus", () => {
		expect("the hidden panel keeps its draft and transcript mounted", /hidden=\{/.test(panelSource) && !/if \(hidden\) return null/.test(panelSource));
		expect("focus never moves to a hidden composer, and leaves one that is hidden", /if \(hidden\) \{[\s\S]{0,320}composerRef\.current\.blur\(\);[\s\S]{0,40}return;\s*\}\s*\n\s*if \(!collapsed\) composerRef\.current\?\.focus\(\)/.test(panelSource));
		expect("the hidden panel is inert for assistive technology and the focus order", /hidden=\{embedded && hidden\}/.test(panelSource) && /\.agent-panel\[hidden\]\s*\{[^}]*display:\s*none/.test(panelCss));
	});
}

if (failures) {
	console.error(`${failures} FAILURES in --case ${selected}`);
	process.exitCode = 1;
} else {
	console.log(`all agent host checks PASS (--case ${selected})`);
}
