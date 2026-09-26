#!/usr/bin/env node
/** Exercise live mode over the real MCP stdio and WebSocket transports. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));
const LIVE_PORT = await new Promise((resolve, reject) => {
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		server.close((error) => error ? reject(error) : resolve(address.port));
	});
});
const LIVE_URL = `ws://127.0.0.1:${LIVE_PORT}/live`;

const timeout = (promise, label) =>
	Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 2_000)),
	]);
const once = (target, event) => timeout(new Promise((resolve, reject) => {
	target.once(event, resolve);
	target.once("error", reject);
}), event);
const clone = (value) => JSON.parse(JSON.stringify(value));

const names = { cube: "Cube", chair: "Chair", car: "Car", sphere: "Sphere", capsule: "Capsule", cylinder: "Cylinder", cone: "Cone", plane: "Plane", "small-plane": "Plane (aircraft)" };
const editor = {
	sceneName: "LIVE TEST",
	camera: { x: 0, y: 1.6, z: 4.5, focalMm: 35, sensorId: "super35", aspectRatio: 2.39 },
	characters: [{ id: "char-a", subject: "a live-test performer", x: 0, z: 0, rot: 0, hidden: false }],
	objects: [],
	activeCharacterId: "char-a",
};
const commands = [];
const telemetry = [];

const describe = () => clone(editor);
const characterFor = (ref) => {
	const key = String(ref ?? "");
	return editor.characters.find((character) => character.id === key) ??
		editor.characters[/^[A-Za-z]$/.test(key) ? key.toUpperCase().charCodeAt(0) - 65 : Number(key) - 1];
};
const result = (id, ok, valueOrError) =>
	ok ? { type: "result", id, ok: true, value: valueOrError } : { type: "result", id, ok: false, error: valueOrError };

function handle(name, args) {
	commands.push({ name, args });
	switch (name) {
		case "ping": return { pong: true };
		case "describe": return describe();
		case "set_camera":
			for (const key of ["x", "y", "z", "focalMm"]) if (args[key] !== undefined) editor.camera[key] = args[key];
			return { camera: clone(editor.camera) };
			case "add_character": {
			const id = `char-${String.fromCharCode(97 + editor.characters.length)}`;
			editor.characters.push({ id, model: args.model ?? "y-bot-tpose", subject: args.subject, x: args.x ?? 0, z: args.z ?? 0, rot: args.rot ?? 0, hidden: false });
			return { id };
		}
		case "update_character": {
			const character = characterFor(args.ref);
			if (!character) throw new Error(`No character ${args.ref}`);
			for (const key of ["x", "z", "rot", "subject", "hidden"]) if (args[key] !== undefined) character[key] = args[key];
			return { id: character.id };
		}
		case "remove_character": {
			const character = characterFor(args.ref);
			if (!character || editor.characters.length === 1) throw new Error("Cannot remove character");
			editor.characters = editor.characters.filter((entry) => entry !== character);
			return { id: character.id };
		}
		case "place_object": {
			const id = `${args.kind}-${editor.objects.length + 1}`;
			editor.objects.push({ id, name: names[args.kind] ?? args.kind, x: args.x ?? 0, y: args.y ?? 0, z: args.z ?? 0, rot: args.rot ?? 0 });
			return { id };
		}
		case "update_object": {
			const object = editor.objects.find((entry) => entry.id === args.id);
			if (!object) throw new Error(`No object ${args.id}`);
			for (const key of ["x", "y", "z", "rot", "scale", "color", "hidden"]) if (args[key] !== undefined) object[key] = args[key];
			return { id: object.id };
		}
		case "remove_object": {
			const object = editor.objects.find((entry) => entry.id === args.id);
			if (!object) throw new Error(`No object ${args.id}`);
			editor.objects = editor.objects.filter((entry) => entry !== object);
			return { id: object.id };
		}
		case "load_scenes": {
			const scene = args.document.scenes.find((entry) => entry.id === args.document.activeSceneId) ?? args.document.scenes[0];
			editor.sceneName = scene.name;
			editor.characters = scene.stage.characters.map(({ id, model, subject, x, z, rot, hidden }) => ({ id, model, subject, x, z, rot, hidden }));
			editor.objects = clone(scene.objects);
			return {
				sceneName: editor.sceneName,
				activeSceneId: args.document.activeSceneId,
				scenes: args.document.scenes.map((entry) => ({ id: entry.id, name: entry.name })),
			};
		}
		default: throw new Error(`Unknown command ${name}`);
	}
}

const client = new Client({ name: "cozyclay-mcp-live-verify", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, "--live-port", String(LIVE_PORT)] });
let socket;
try {
	await client.connect(transport);
	socket = new WebSocket(LIVE_URL);
	socket.on("message", (raw) => {
		const frame = JSON.parse(raw.toString());
		if (frame.type === "event" && frame.name === "telemetry") {
			telemetry.push(frame.payload);
			return;
		}
		if (frame.type !== "cmd") return;
		try {
			socket.send(JSON.stringify(result(frame.id, true, handle(frame.name, frame.args))));
		} catch (error) {
			socket.send(JSON.stringify(result(frame.id, false, error.message)));
		}
	});
	await once(socket, "open");
	socket.send(JSON.stringify({ type: "hello", role: "editor", version: 1 }));

	const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
	const assert = (condition, message) => {
		if (!condition) throw new Error(message);
	};

	assert((await call("live_status")).includes("Live editor connected. Workspaces:"), "live_status did not report the editor connection");
	await call("set_camera", { x: 3.25, y: 2, z: 6, focal_mm: 50 });
	assert(commands.some(({ name, args }) => name === "set_camera" && args.x === 3.25 && args.focalMm === 50), "set_camera was not forwarded");
	assert(JSON.stringify(telemetry.map(({ event }) => event)) === JSON.stringify(["mcp:tool_requested", "mcp:tool_executed", "mcp:result_applied"]), "MCP telemetry has no request/outcome/application lifecycle");
	assert(telemetry[0].props.request_id === telemetry[1].props.request_id, "MCP request and outcome were not correlated");
	assert(telemetry[0].props.tool_category === telemetry[1].props.tool_category, "MCP request and outcome categories differ");
	assert(/^[a-f0-9]{32}$/.test(telemetry[0].props.request_id), "MCP request ID is not ephemeral hexadecimal");
	assert(telemetry[0].props.tool_category === "camera", "MCP camera category was not normalized");
	assert(telemetry[1].props.outcome === "succeeded", "MCP outcome was not normalized");
	assert(telemetry[1].props.request_id === telemetry[0].props.request_id, "MCP applied result was not correlated");
	assert(!/private|set_camera|focalMm/.test(JSON.stringify(telemetry)), "MCP telemetry leaked command details");
	const added = await call("add_character", { subject: "an x-bot performer", model: "x-bot-tpose" });
	assert(commands.some(({ name, args }) => name === "add_character" && args.model === "x-bot-tpose"), "add_character did not forward the requested model");
	assert(added.includes("[x-bot-tpose]"), "add_character did not report the requested model");
	assert((await call("describe_scene")).includes("[x-bot-tpose]"), "describe_scene did not retain the requested model");
	// Given focus_character chooses B for the MCP server
	// When the editor later reports its independently active A character
	// Then MCP framing remains on its explicitly selected B character.
	const focused = await call("focus_character", { character: "B" });
	assert(focused.includes('Framing B "an x-bot performer"'), "focus_character did not select the requested character");
	editor.activeCharacterId = "char-a";
	const refreshed = await call("describe_scene");
	assert(/char-b[\s\S]*<- framed/.test(refreshed), "editor activeCharacterId silently replaced the MCP focus after live refresh");
	assert(!refreshed.split("\n").some((line) => line.includes("char-a") && line.includes("<- framed")), "the editor activeCharacterId remained authoritative after MCP focus_character");
	const placed = await call("place_object", { kind: "chair", x: 1.5, z: -2, facing: 30 });
	assert(commands.some(({ name, args }) => name === "place_object" && args.kind === "chair" && args.rot === 30), "place_object was not forwarded");
	assert(placed.includes("chair-1"), "place_object did not return the live object id");
	const scene = await call("describe_scene");
	assert(scene.includes("LIVE TEST") && scene.includes("Chair") && scene.includes("x 3.25"), "describe_scene did not render the live description");
	commands.length = 0;
	const hiddenLive = await call("update_object", { id: "chair-1", hidden: true });
	assert(commands.some(({ name, args }) => name === "update_object" && args.hidden === true), "update_object did not forward hidden");
	assert(hiddenLive.split("\n").some((line) => line.includes("chair-1") && line.includes(" hidden")), "describe_scene did not mark the hidden object");

	// frame_shot must AIM the lens, not only place it. Every view except `front`
	// orbits the camera off the subject's facing axis, and a position-only command
	// leaves a live editor pointing wherever the last human gesture left it: the
	// subject drops out of frame — behind the lens for profile/rear/back — while
	// the slate still reports it filling the frame. Runs after the assertions
	// above because it moves the camera they pin at x 3.25.
	for (const view of ["front", "front three-quarter", "profile", "rear three-quarter", "back"]) {
		commands.length = 0;
		await call("frame_shot", { size: "medium shot", view, level: "eye", side: "right", focal_mm: 35 });
		const moved = commands.find(({ name }) => name === "set_camera");
		assert(moved, `frame_shot (${view}) did not forward set_camera`);
		const { x, y, z, lookAtX, lookAtY, lookAtZ } = moved.args;
		assert([lookAtX, lookAtY, lookAtZ].every(Number.isFinite), `frame_shot (${view}) placed the camera without an aim target`);
		// The aim target is the framing pivot the shot vocabulary is measured
		// against: the framed character's floor position at pivot height.
		const framed = editor.characters.find((character) => character.id === editor.activeCharacterId) ?? editor.characters[0];
		const off = Math.hypot(lookAtX - framed.x, lookAtZ - framed.z);
		assert(off < 1e-6 && Math.abs(lookAtY - 1.3) < 1e-6, `frame_shot (${view}) aimed at (${lookAtX}, ${lookAtY}, ${lookAtZ}), not the framing pivot`);
		assert(Math.hypot(x - lookAtX, y - lookAtY, z - lookAtZ) > 0.01, `frame_shot (${view}) put the camera on top of its own aim target`);
	}
	commands.length = 0;

	const closed = once(socket, "close");
	socket.close();
	await closed;
	// The client-side close resolves before the hub has necessarily processed
	// the disconnect; on a slow runner the next command can still race down
	// the live path. Wait until the hub itself reports the editor gone — the
	// fallback assertions below then test fallback, not close latency.
	const disconnectDeadline = Date.now() + 5_000;
	while (!(await call("live_status")).includes("No live editor")) {
		if (Date.now() > disconnectDeadline) throw new Error("live hub never noticed the editor disconnect");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const fallback = await call("set_camera", { x: 9 });
	assert(fallback.includes("Camera set") && !(fallback.includes("Live editor error")), "tools did not fall back to memory after disconnect");
	assert((await call("describe_scene")).includes("x 9"), "memory fallback did not retain the camera update");
	assert((await call("live_status")).includes("No live editor"), "live_status did not report fallback mode");
	console.log("live status, forwarding, live describe, and disconnect fallback passed");
} finally {
	if (socket && socket.readyState === WebSocket.OPEN) socket.close();
	await client.close().catch(() => {});
}
