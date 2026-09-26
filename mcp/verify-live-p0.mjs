#!/usr/bin/env node
/** MCP P0 live protocol regression checks over real stdio and WebSocket transports. */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { LiveHub, LiveMutationUncertainError } from "./live-hub.mjs";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));

const reservePort = () =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Could not reserve a TCP port."));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});

const timeout = (promise, label) =>
	Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 2_000)),
	]);

const once = (target, event) =>
	timeout(
		new Promise((resolve, reject) => {
			target.once(event, resolve);
			target.once("error", reject);
		}),
		event,
	);

const clone = (value) => JSON.parse(JSON.stringify(value));
const livePort = await reservePort();
const bridgePort = await reservePort();
const bridge = createHttpServer((request, response) => {
	if (request.url === "/ardy/health") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ ok: true }));
		return;
	}
	response.writeHead(404).end();
});
await new Promise((resolve, reject) => {
	bridge.once("error", reject);
	bridge.listen(bridgePort, "127.0.0.1", resolve);
});
const editor = {
	sceneName: "MCP P0 LIVE",
	camera: { x: 0, y: 1.6, z: 4.5, focalMm: 35, sensorId: "super35", aspectRatio: 1.78 },
	stage: { shotAspect: "2.39:1", sensorId: "super35", hasCharSheet: true },
	timeline: { currentFrame: 17, frameCount: 240, fps: 24 },
	characters: [{ id: "char-a", model: "y-bot-tpose", subject: "a performer", x: 0, y: 0, z: 0, rot: 0, hidden: false }],
	objects: [],
};
let rejectDescribe = false;
let rejectAfterMutation = false;
const executionTelemetry = [];
let disconnectBeforeDescribe = false;
let omitCharacterFields = true;

const handle = (name, args) => {
	switch (name) {
		case "describe":
			if (rejectDescribe) {
				rejectDescribe = false;
				throw new Error("Describe unavailable after mutation");
			}
			const description = clone(editor);
			return omitCharacterFields
				? { ...description, characters: description.characters.map(({ model, ...character }) => character) }
				: description;
		case "add_character": {
			if (rejectAfterMutation) { rejectDescribe = true; rejectAfterMutation = false; }
			const id = `char-${String.fromCharCode(97 + editor.characters.length)}`;
			editor.characters.push({
				id,
				model: args.model ?? "y-bot-tpose",
				subject: args.subject,
				x: args.x ?? 0,
				y: 0,
				z: args.z ?? 0,
				rot: args.rot ?? 0,
				hidden: false,
			});
			return { id, disconnectBeforeDescribe };
		}
		case "update_character":
			throw new Error(`Character not found: ${args.ref}`);
		case "load_motion":
			rejectDescribe = true;
			return { loaded: true };
		default:
			throw new Error(`Unknown command ${name}`);
	}
};

const client = new Client({ name: "cozyclay-mcp-live-p0-verify", version: "1.0.0" });
const projectDirectory = await mkdtemp(join(tmpdir(), "cozyclay-mcp-live-p0-"));
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [SERVER, "--live-port", String(livePort)],
	env: { ...process.env, COZYCLAY_BRIDGE: `http://127.0.0.1:${bridgePort}`, COZYCLAY_PROJECT_ROOT: projectDirectory },
});
let socket;
try {
	await client.connect(transport);
	socket = new WebSocket(`ws://127.0.0.1:${livePort}/live`);
	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		if (frame.type === "event" && frame.name === "telemetry") executionTelemetry.push(frame.payload);
		if (frame.type !== "cmd") return;
		try {
			const value = handle(frame.name, frame.args);
			socket.send(JSON.stringify({ type: "result", id: frame.id, ok: true, value }));
			if (value.disconnectBeforeDescribe) socket.close();
		} catch (error) {
			socket.send(JSON.stringify({ type: "result", id: frame.id, ok: false, error: error.message }));
		}
	});
	await once(socket, "open");
	socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1 }));

	const call = (name, args = {}) => client.callTool({ name, arguments: args });

	// Given a live character and object whose authored fields differ from defaults
	omitCharacterFields = false;
	editor.characters[0] = {
		id: "char-a", model: "x-bot-tpose", subject: "a prior performer", x: 1, y: 0, z: 2, rot: 30, hidden: false,
		tint: "#123456", pose: { label: "Walking", bones: { hips: [1, 2, 3] } }, scale: 1.4,
		layer: { waypoints: [{ frame: 12, x: 1, z: 2 }], promptClips: [{ startFrame: 0, endFrame: 24, text: "Walk." }] },
		motionRef: { url: "/ardy/motions/123456-abcdef", prompt: "Walk.", rotationDeg: 30, anchorX: 1, anchorZ: 2 },
	};
	editor.objects = [{
		id: "cube-1", name: "Cube", renderer: "cube", x: 1, y: 0, z: -2, rot: 15,
		rotX: 12, rotZ: -8, scaleX: 1, scaleY: 1, scaleZ: 1, color: "#d9b18c",
		parent: null, footprint: { width: 1, depth: 1 }, height: 1,
	}];
	const seededReport = await call("describe_scene");
	assert.equal(seededReport.isError, undefined, JSON.stringify(seededReport));
	assert.match(
		seededReport.content[0].text,
		/"label":"Walking"[\s\S]*tint: #123456[\s\S]*scale: 1\.4[\s\S]*"url":"\/ardy\/motions\/123456-abcdef"[\s\S]*"waypoints":\[\{"frame":12,"x":1,"z":2(?:,"id":"[^"]+")?}\][\s\S]*"promptClips":\[\{"startFrame":0,"endFrame":24,"text":"Walk\."(?:,"id":"[^"]+")?}\][\s\S]*rotX: 12[\s\S]*rotZ: -8[\s\S]*color: #d9b18c[\s\S]*shotAspect: 2\.39:1[\s\S]*sensorId: super35[\s\S]*hasCharSheet: true[\s\S]*currentFrame: 17[\s\S]*frameCount: 240[\s\S]*fps: 24/,
		"describe missing fields: pose, tint, scale, motionRef, layer.waypoints, layer.promptClips, object.rotX, object.rotZ, object.color, stage.shotAspect, stage.sensorId, stage.hasCharSheet, timeline.currentFrame, timeline.frameCount, timeline.fps",
	);

	// Given fields that are honestly absent, describe must keep their explicit null or empty shape.
	editor.characters[0] = {
		id: "char-a", model: "y-bot-tpose", subject: "an unposed performer", x: 0, y: 0, z: 0, rot: 0, hidden: false,
		tint: null, pose: null, scale: 1, layer: { waypoints: [], promptClips: [] }, motionRef: null,
	};
	editor.objects = [{
		id: "cube-1", name: "Cube", renderer: "cube", x: 0, y: 0, z: 0, rot: 0,
		rotX: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1, color: null,
		parent: null, footprint: { width: 1, depth: 1 }, height: 1,
	}];
	const absentReport = await call("describe_scene");
	assert.equal(absentReport.isError, undefined, JSON.stringify(absentReport));
	assert.match(absentReport.content[0].text, /pose: null[\s\S]*tint: null[\s\S]*scale: 1[\s\S]*motionRef: null[\s\S]*"waypoints":\[\][\s\S]*"promptClips":\[\][\s\S]*rotX: 0[\s\S]*rotZ: 0[\s\S]*color: null/);

	// Given an empty scene, camera, stage and timeline sections remain well formed.
	editor.characters = [];
	editor.objects = [];
	const emptyReport = await call("describe_scene");
	assert.equal(emptyReport.isError, undefined, JSON.stringify(emptyReport));
	assert.match(emptyReport.content[0].text, /CAMERA[\s\S]*STAGE[\s\S]*TIMELINE/);

	// Restore authored fields, then send a partial report to prove the existing
	// omitted-field preservation seam still keeps every omitted value.
	editor.characters = [{
		id: "char-a", model: "x-bot-tpose", subject: "a prior performer", x: 1, y: 0, z: 2, rot: 30, hidden: false,
		tint: "#123456", pose: { label: "Walking", bones: { hips: [1, 2, 3] } }, scale: 1.4,
		layer: { waypoints: [{ frame: 12, x: 1, z: 2 }], promptClips: [{ startFrame: 0, endFrame: 24, text: "Walk." }] },
		motionRef: { url: "/ardy/motions/123456-abcdef", prompt: "Walk.", rotationDeg: 30, anchorX: 1, anchorZ: 2 },
	}];
	await call("describe_scene");
	editor.characters = [{ id: "char-a", subject: "the described performer", x: 7 }];
	editor.objects = [];
	omitCharacterFields = false;
	// When the editor reports only its authoritative subject and x fields
	const projectPath = join(projectDirectory, "description-merge.cclayproject");
	const merged = await call("save_project", { path: projectPath });
	assert.equal(merged.isError, undefined, JSON.stringify(merged));
	assert.match(merged.content[0].text, /^Saved/, JSON.stringify(merged));
	const saved = JSON.parse(await readFile(projectPath, "utf8"));
	const mergedCharacter = saved.scenes.scenes[0].stage.characters[0];
	// Then reported values update, while every omitted prior field survives normalization.
	assert.equal(mergedCharacter.subject, "the described performer");
	assert.equal(mergedCharacter.x, 7);
	assert.equal(mergedCharacter.model, "x-bot-tpose");
	assert.equal(mergedCharacter.layer.waypoints[0].frame, 12);
	assert.equal(mergedCharacter.layer.promptClips[0].text, "Walk.");
	assert.equal(mergedCharacter.motionRef.url, "/ardy/motions/123456-abcdef");
	omitCharacterFields = true;

	// Given a requested non-default mannequin
	// When the live add command is acknowledged and described
	const added = await call("add_character", { subject: "an x-bot performer", model: "x-bot-tpose" });
	// Then the editor model survives the round trip.
	assert.equal(added.isError, undefined, JSON.stringify(added));
	assert.match(added.content[0].text, /\[x-bot-tpose\]/, added.content[0].text);
	const described = await call("describe_scene");
	assert.match(described.content[0].text, /\[x-bot-tpose\]/, described.content[0].text);

	// Given an editor that applies add_character but cannot describe afterward
	// When the MCP mutation is called
	rejectAfterMutation = true;
	const ambiguousOffset = executionTelemetry.length;
	const ambiguous = await call("add_character", { subject: "a second performer", model: "x-bot-tpose" });
	// Then MCP marks the result failed and explicitly prevents duplicate retry.
	assert.equal(ambiguous.isError, true, JSON.stringify(ambiguous));
	assert.match(ambiguous.content[0].text, /may have been applied/i, ambiguous.content[0].text);
	assert.match(ambiguous.content[0].text, /do not retry/i, ambiguous.content[0].text);

	// Given a live editor that rejects a command
	// When a tool forwards that command
	const rejected = await call("place_character", { character: "missing", x: 1 });
	// Then the MCP tool result uses the protocol error state.
	assert.equal(rejected.isError, true, JSON.stringify(rejected));
	assert.match(rejected.content[0].text, /Character not found: missing/, rejected.content[0].text);
	const uncertainEvents = executionTelemetry.slice(ambiguousOffset);
	const uncertainRequest = uncertainEvents.find(({ event }) => event === "mcp:tool_requested");
	const lifecycle = uncertainEvents.filter(({ props }) => props.request_id === uncertainRequest.props.request_id);
	assert.deepEqual(lifecycle.map(({ event }) => event), ["mcp:tool_requested", "mcp:tool_executed"]);
	assert.equal(lifecycle[1].props.outcome, "uncertain", "transport observation preserves uncertainty hidden by handler isError prose");

	// Given an already-generated take
	// When generate_motion schedules its internal job
	const motionJob = await call("generate_motion", {
		phases: ["A person walks forward.", "A person stops."],
		motion_url: "/ardy/motions/123456-abcdef",
	});
	// Then it returns promptly with a push-only task identity.
	assert.equal(motionJob.isError, undefined, JSON.stringify(motionJob));
	assert.deepEqual(Object.keys(JSON.parse(motionJob.content[0].text)).sort(), ["createdAt", "lastUpdatedAt", "pollIntervalMs", "status", "taskId", "ttlMs"]);

	// Given an accepted mutation whose editor disconnects before verification
	// When the MCP tool cannot refresh its live description
	disconnectBeforeDescribe = true;
	const disconnected = await call("add_character", { subject: "a disconnected performer", model: "x-bot-tpose" });
	// Then it is uncertain-applied rather than a successful mutation result.
	assert.equal(disconnected.isError, true, JSON.stringify(disconnected));
	assert.match(disconnected.content[0].text, /may have been applied/i, disconnected.content[0].text);
	assert.match(disconnected.content[0].text, /do not retry/i, disconnected.content[0].text);

	// Given the editor-side load path can decode and install a generated take
	// When its timeout policy is selected
	// Then it receives the dedicated processing timeout, not the generic command timeout.
	assert.equal(LiveHub.commandTimeoutMs("load_motion"), 30_000);
	assert.equal(LiveHub.commandTimeoutMs("capture_frame"), 30_000);
	assert.equal(LiveHub.commandTimeoutMs("import_asset"), 30_000);
	for (const name of [
		"inspect_studio", "operate_studio", "arrange_objects", "arrange_characters", "patch_elements",
		"frame_shot", "verify_result", "undo_edit", "read_studio_context", "resolve_studio_image",
		"capture_framing_png", "reconcile_studio_command", "run_action",
	]) {
		assert.equal(LiveHub.commandTimeoutMs(name), 30_000, `${name} uses the Studio command timeout`);
	}
	assert.equal(LiveHub.commandTimeoutMs("describe"), 5_000);

	console.log(JSON.stringify({
		livePort,
		modelRoundTrip: { isError: added.isError ?? false, described: /\[x-bot-tpose\]/.test(described.content[0].text) },
		rejected: { isError: rejected.isError === true },
		uncertainAfterFailedVerification: { isError: ambiguous.isError === true, doNotRetry: /do not retry/i.test(ambiguous.content[0].text) },
		uncertainAfterDisconnect: { isError: disconnected.isError === true, doNotRetry: /do not retry/i.test(disconnected.content[0].text) },
		loadMotion: { isError: motionJob.isError ?? false, timeoutMs: LiveHub.commandTimeoutMs("load_motion") },
		defaultCommandTimeoutMs: LiveHub.commandTimeoutMs("describe"),
		seededDescribe: seededReport,
		emptyDescribe: emptyReport,
		descriptionMerge: {
			before: { model: "x-bot-tpose", pose: "Walking", tint: "#123456", scale: 1.4, layer: true, motionRef: "/ardy/motions/123456-abcdef" },
			describe: { subject: "the described performer", x: 7 },
			after: { model: mergedCharacter.model, pose: mergedCharacter.pose?.label, tint: mergedCharacter.tint, scale: mergedCharacter.scale, layer: mergedCharacter.layer.promptClips.length, motionRef: mergedCharacter.motionRef?.url, subject: mergedCharacter.subject, x: mergedCharacter.x },
		},
	}));
} finally {
	if (socket && socket.readyState === WebSocket.OPEN) socket.close();
	await client.close().catch(() => {});
	await new Promise((resolve, reject) => bridge.close((error) => (error ? reject(error) : resolve())));
	await rm(projectDirectory, { recursive: true, force: true });
}

// Read-only transport loss is retryable; mutation transport loss is not.
const unitHub = new LiveHub();
const unitSocket = { readyState: WebSocket.OPEN, send() {} };
unitHub.editors.set("unit-workspace", unitSocket);
const readOnlyFailure = unitHub.command("describe", {}, "unit-workspace");
unitHub.disconnect(unitSocket);
await assert.rejects(readOnlyFailure, (error) => !(error instanceof LiveMutationUncertainError));
unitHub.editors.set("unit-workspace", unitSocket);
const mutationFailure = unitHub.command("add_character", {}, "unit-workspace");
unitHub.disconnect(unitSocket);
await assert.rejects(mutationFailure, (error) => error instanceof LiveMutationUncertainError && /do not retry/i.test(error.message));
