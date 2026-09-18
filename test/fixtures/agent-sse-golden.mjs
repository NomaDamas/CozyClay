// Golden SSE parity fixtures, recorded from the CURRENT agent loops.
// Scenario W is the exact 4-call Workflow script test/verify-agent-routes.mjs
// uses; scenario S drives the frozen Studio envelope through inspect_studio →
// patch_elements → verify_result → final text. normaliseFrame replaces the
// nondeterministic bits (timings, telemetry ids, turn/call ids) with stable
// placeholders while keeping eventSeq — it is part of the replay contract.
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHandler } from "../../bin/agent/agent-routes.mjs";
import { contextFixture, envelopeFixture, receiptFixture } from "../verify-studio-agent-protocol.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function normaliseFrame(frame) {
	const value = JSON.parse(JSON.stringify(frame));
	if (Object.hasOwn(value, "elapsedMs")) value.elapsedMs = "<ms>";
	if (Object.hasOwn(value, "telemetry_id")) value.telemetry_id = "<telemetry>";
	if (Object.hasOwn(value, "turn_id")) value.turn_id = "<turn>";
	if (Object.hasOwn(value, "turnId")) value.turnId = "<turn>";
	if (Object.hasOwn(value, "callId")) value.callId = "<call>";
	if (value.props && Object.hasOwn(value.props, "turn_id")) value.props.turn_id = "<turn>";
	if (value.props && Object.hasOwn(value.props, "duration_bucket")) value.props.duration_bucket = "<bucket>";
	return value;
}

async function collectTurn(handlerArgs, body) {
	let server;
	const handler = createAgentHandler({ ...handlerArgs, port: () => server.address().port });
	server = createServer((req, res) => handler(req, res).catch((error) => { if (!res.headersSent) res.writeHead(500); res.end(error.message); }));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`;
	const text = await fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) }).then((response) => response.text());
	server.close();
	return [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
}

// Workflow: text "hello" → describe_workflow → add_workflow_node → run_workflow
// → text " done" — the exact 4-call script of test/verify-agent-routes.mjs.
async function recordWorkflow() {
	const fakeLive = { command: async (name) => name === "capture_framing_png" ? { dataUrl: png, width: 1920, height: 1080 } : { assetId: "a1", objectId: "o1" } };
	const calls = [];
	const fakeCodex = {
		listModels: async () => ["gpt-5"],
		parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: { hasCredits: true } }),
		streamResponses: ({ input }) => {
			calls.push(input);
			const items = calls.length === 1
				? [{ type: "message", role: "assistant" }, { type: "function_call", call_id: "c1", name: "describe_workflow", arguments: "{}" }]
				: calls.length === 2
					? [{ type: "function_call", call_id: "c2", name: "add_workflow_node", arguments: JSON.stringify({ type: "image", model: "image-generation", data: { prompt: "render" } }) }]
					: calls.length === 3
						? [{ type: "function_call", call_id: "c3", name: "run_workflow", arguments: "{}" }]
						: [{ type: "message", role: "assistant" }];
			return { headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() {
				if (calls.length !== 2) yield { type: "response.output_text.delta", delta: calls.length === 1 ? "hello" : " done" };
				for (const item of items) yield { type: "response.output_item.done", item };
				yield { type: "response.completed", response: { status: "completed" } };
			} };
		},
	};
	const turnId = "a".repeat(32);
	return collectTurn(
		{ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, liveHub: fakeLive },
		{ sessionId: "golden-w", text: "Give me a wide two-shot", attachFrame: false, turn_id: turnId },
	);
}

// Studio: the frozen envelope → inspect_studio → patch_elements (stage
// keyLight.warmth 0.3) → verify_result (returns a dataUrl) → final text.
async function recordStudio() {
	const fakeLive = {
		command: async (name) => {
			if (name === "patch_elements") return receiptFixture();
			if (name === "verify_result") return { ok: true, receiptId: "receipt-1", revision: { scene: 42, physics: 9, view: 18 }, visualRefs: [{ imageId: "capture-1" }] };
			if (name === "resolve_studio_image") return { imageId: "capture-1", dataUrl: png, revision: { scene: 42 }, receiptId: "receipt-1" };
			return { ok: true, status: "applied", receiptId: "receipt-1", revision: { before: 41, after: 42 } };
		},
		workspaceId: () => "tab-7",
		resolveWorkspace: () => "handle-12",
		handleForWorkspaceId: () => "handle-12",
		connected: true,
		workspaceHandles: ["handle-12"],
	};
	let calls = 0;
	const fakeCodex = {
		parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: { hasCredits: true } }),
		appendImageObservation(history, value) { history.push({ role: "user", content: [{ type: "input_text", text: value.label }, { type: "input_image", image_url: value.dataUrl }] }); },
		streamResponses: () => {
			calls += 1;
			const item = calls === 1
				? { type: "function_call", call_id: "s1", name: "inspect_studio", arguments: JSON.stringify({ section: "selection" }) }
				: calls === 2
					? { type: "function_call", call_id: "s2", name: "patch_elements", arguments: JSON.stringify({ ops: [{ target: { kind: "stage" }, set: { "keyLight.warmth": 0.3 } }] }) }
					: calls === 3
						? { type: "function_call", call_id: "s3", name: "verify_result", arguments: JSON.stringify({ targets: ["char-alex"], checks: ["framing"], visual: "frame" }) }
						: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] };
			return { headers: Promise.resolve(new Headers()), async *[Symbol.asyncIterator]() {
				if (calls === 4) yield { type: "response.output_text.delta", delta: "done" };
				yield { type: "response.output_item.done", item };
				yield { type: "response.completed", response: { status: "completed" } };
			} };
		},
	};
	return collectTurn(
		{ auth: { getAccessToken: async () => "token" }, codex: fakeCodex, liveHub: fakeLive, studioRuntime: { readContext: async () => contextFixture() } },
		envelopeFixture(),
	);
}

export async function recordGolden() {
	process.env.COZYCLAY_AGENT_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "cozyclay-agent-sse-golden-"));
	const W = (await recordWorkflow()).map(normaliseFrame);
	const S = (await recordStudio()).map(normaliseFrame);
	return { W, S };
}
