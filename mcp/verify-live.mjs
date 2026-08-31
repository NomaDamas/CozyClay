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
			for (const key of ["x", "y", "z", "rot", "scale", "color"]) if (args[key] !== undefined) object[key] = args[key];
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
