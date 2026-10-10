#!/usr/bin/env node
/**
 * sculpt_object end to end (#730): a real MCP client drives a real editor.
 *
 * Starts the MCP server over stdio with its own live port, waits for the
 * editor tab (opened by the caller, or by QA_OPEN=1 through the system Chrome
 * at QA_URL) to connect, sculpts the turtle fixture, re-sculpts it, frames it,
 * and saves capture_frame PNGs. The editor must render a sculpt and report it.
 *
 * Run: `COZYCLAY_LIVE_PORT=6030 npm run dev:ui -- --port 5910`, open
 * http://127.0.0.1:5910/app/ in a browser, then
 * `COZYCLAY_LIVE_PORT=6030 QA_OUT=/tmp/qa-sculpt node mcp/qa-sculpt-live.mjs`.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const livePort = String(process.env.COZYCLAY_LIVE_PORT || "6030");
const out = process.env.QA_OUT || "/tmp/qa-sculpt";
mkdirSync(out, { recursive: true });
const turtle = JSON.parse(readFileSync(new URL("../test/fixtures/sculpt-nerd-turtle.json", import.meta.url), "utf8"));
const server = fileURLToPath(new URL("./server.mjs", import.meta.url));

const client = new Client({ name: "cozyclay-qa-sculpt", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server, "--live-port", livePort], stderr: "inherit" }));
const call = async (name, args = {}) => {
	const result = await client.callTool({ name, arguments: args });
	const body = result.content?.find((part) => part.type === "text")?.text ?? "";
	if (result.isError) throw new Error(`${name}: ${body}`);
	return result;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const saveCapture = (result, file) => {
	const image = result.content.find((part) => part.type === "image");
	assert.ok(image, "capture_frame returns an image");
	writeFileSync(join(out, file), Buffer.from(image.data, "base64"));
	return join(out, file);
};

try {
	let status = "";
	for (let i = 0; i < 90; i += 1) {
		status = (await call("live_status")).content[0].text;
		if (status.startsWith("Live editor connected")) break;
		await sleep(1000);
	}
	console.log("live_status:", status.split("\n").slice(0, 4).join(" | "));
	assert.ok(status.startsWith("Live editor connected"), "an editor tab is connected");

	// A reload keeps the scene, so a previous run's turtle is still standing: clear it first.
	for (const row of (await call("describe_scene")).content[0].text.split("\n").filter((entry) => / QA turtle /.test(entry))) {
		await call("remove_object", { id: row.trim().split(/\s+/)[0] });
	}
	const made = await call("sculpt_object", { recipe: turtle, name: "QA turtle", x: -1.3, z: 1.4, facing: 15 });
	const madeText = made.content.find((part) => part.type === "text").text;
	console.log("sculpt_object:", madeText.split("\n")[0]);
	assert.match(madeText, /object\.sculpt|Sculpted|applied/i);

	const scene = (await call("describe_scene")).content[0].text;
	const receipt = JSON.parse(madeText);
	const id = receipt.affectedIds?.[0];
	assert.ok(id, "the receipt names the sculpt");
	const line = scene.split("\n").find((row) => row.trim().startsWith(`${id} `));
	assert.ok(line && / QA turtle /.test(line), "describe_scene lists the sculpt");
	console.log("describe_scene:", line.trim());

	await call("set_camera", { x: -0.6, y: 0.85, z: 3.3, look_at_x: -1.3, look_at_y: 0.45, look_at_z: 1.4, focal_mm: 40 });
	console.log("saved:", saveCapture(await call("capture_frame", { max_inline_bytes: 1_000_000 }), "sculpt-turtle.png"));

	const wider = { ...turtle, parts: turtle.parts.map((part) => (part.id === "head" ? { ...part, size: [part.size[0] * 1.15, part.size[1], part.size[2]] } : part)) };
	const again = await call("sculpt_object", { id, recipe: wider });
	console.log("re-sculpt:", again.content.find((part) => part.type === "text").text.split("\n")[0]);
	console.log("saved:", saveCapture(await call("capture_frame", { max_inline_bytes: 1_000_000 }), "sculpt-turtle-resculpt.png"));

	const refused = await client.callTool({ name: "sculpt_object", arguments: { recipe: { parts: [{ id: "head", shape: "teapot", size: [1, 1, 1] }] } } });
	assert.equal(refused.isError, true);
	console.log("refusal:", refused.content[0].text.slice(0, 160));
	console.log("PASS qa-sculpt-live");
} finally {
	await client.close();
}
