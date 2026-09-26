#!/usr/bin/env node
/** Verify the safety contract advertised by the real MCP tools/list response. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("./server.mjs", import.meta.url));
const ANNOTATION_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
const EXPECTED_ANNOTATIONS = Object.freeze({
	describe_scene: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	live_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	describe_shot: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	capture_frame: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	set_camera: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	frame_shot: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	add_character: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	place_character: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	remove_character: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	focus_character: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	place_object: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	import_mesh: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	group_objects: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	set_prompt_blocks: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	load_motion: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	generate_motion: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	update_object: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	remove_object: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	apply_batch: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	render_prompt: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	mark_camera_move: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	describe_camera_move: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	add_scene: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	switch_scene: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	open_project: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
	save_project: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
});
const SIBLING_PAIRS = [
	["place_character", "add_character"],
	["place_object", "update_object"],
	["import_mesh", "place_object"],
	["frame_shot", "set_camera"],
];

const firstSentence = (description) => description.match(/^[\s\S]*?[.!?](?:\s|$)/)?.[0].trim() ?? description.trim();
const display = (value) => value === undefined ? "absent" : String(value);
const table = (tools) => {
	console.log("tools/list response:");
	console.log("name | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | opening sentence");
	for (const tool of tools) {
		const annotations = tool.annotations ?? {};
		console.log(`${tool.name} | ${display(annotations.readOnlyHint)} | ${display(annotations.destructiveHint)} | ${display(annotations.idempotentHint)} | ${display(annotations.openWorldHint)} | ${firstSentence(tool.description ?? "")}`);
	}
};

const client = new Client({ name: "cozyclay-mcp-tool-annotations-verify", version: "1.0.0" });
try {
	// Given: a real stdio MCP server and a client initialized through the protocol.
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));

	// When: the client lists tools twice through the real MCP protocol.
	const first = await client.listTools();
	const second = await client.listTools();
	table(first.tools);

	// Then: every registered tool has the deliberate safety contract and a stable order.
	const failures = [];
	const siblingChecks = [];
	const expectedNames = Object.keys(EXPECTED_ANNOTATIONS);
	const firstNames = first.tools.map((tool) => tool.name);
	const secondNames = second.tools.map((tool) => tool.name);
	if (firstNames.length !== expectedNames.length) {
		failures.push(`tools/list returned ${firstNames.length} tools; expected ${expectedNames.length}: ${firstNames.join(", ")}`);
	}
	if (JSON.stringify(firstNames) !== JSON.stringify(expectedNames)) {
		failures.push(`tools/list order or names changed: ${firstNames.join(", ")}`);
	}
	if (JSON.stringify(firstNames) !== JSON.stringify(secondNames)) {
		failures.push(`tools/list order is not deterministic: first=${firstNames.join(", ")} second=${secondNames.join(", ")}`);
	}
	for (const tool of first.tools) {
		const expected = EXPECTED_ANNOTATIONS[tool.name];
		if (!expected) {
			failures.push(`${tool.name} is not classified by this safety contract`);
			continue;
		}
		const annotations = tool.annotations ?? {};
		for (const key of ANNOTATION_KEYS) {
			if (!Object.hasOwn(annotations, key)) failures.push(`${tool.name} has absent ${key}`);
			else if (annotations[key] !== expected[key]) failures.push(`${tool.name} has ${key}:${annotations[key]}; expected ${expected[key]}`);
		}
	}
	for (const [leftName, rightName] of SIBLING_PAIRS) {
		const left = first.tools.find((tool) => tool.name === leftName);
		const right = first.tools.find((tool) => tool.name === rightName);
		const leftOpening = firstSentence(left?.description ?? "");
		const rightOpening = firstSentence(right?.description ?? "");
		const leftDiscriminates = leftOpening.includes(leftName) && leftOpening.includes(rightName);
		const rightDiscriminates = rightOpening.includes(rightName) && rightOpening.includes(leftName);
		if (!leftDiscriminates || !rightDiscriminates || leftOpening === rightOpening) {
			failures.push(`${leftName} versus ${rightName} opening sentences are not discriminative: ${JSON.stringify(leftOpening)} / ${JSON.stringify(rightOpening)}`);
		} else {
			siblingChecks.push(`PASS ${leftName} versus ${rightName}: ${JSON.stringify(leftOpening)} / ${JSON.stringify(rightOpening)}`);
		}
	}
	const openings = new Map();
	for (const tool of first.tools) {
		const opening = firstSentence(tool.description ?? "");
		const duplicate = openings.get(opening);
		if (duplicate) failures.push(`${tool.name} and ${duplicate} share opening sentence ${JSON.stringify(opening)}`);
		else openings.set(opening, tool.name);
	}
	if (failures.length > 0) throw new Error(`G005 tools/list contract failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
	for (const check of siblingChecks) console.log(check);
	console.log(`PASS G005 tools/list safety contract (${first.tools.length} tools; deterministic order)`);
} finally {
	await client.close().catch(() => {});
}
