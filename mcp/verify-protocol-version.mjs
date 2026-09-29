#!/usr/bin/env node
/** The project deliberately ships one MCP protocol track: 2025-11-25. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
const timeout = (promise, label) => {
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 60_000);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};
const initialize = async (protocolVersion) => {
	const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
	const closed = once(child, "close");
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	try {
		const response = new Promise((resolve, reject) => {
			let stdout = "";
			child.once("error", reject);
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
				const newline = stdout.indexOf("\n");
				if (newline < 0) return;
				try {
					resolve(JSON.parse(stdout.slice(0, newline)));
				} catch (error) {
					reject(error);
				}
			});
			child.once("close", (code) => {
				if (code !== 0) reject(new Error(`server exited ${code}: ${stderr}`));
			});
		});
		child.stdin.end(`${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion, capabilities: {}, clientInfo: { name: "protocol-verifier", version: "1.0.0" } },
		})}\n`);
		return await timeout(response, "MCP initialize response");
	} finally {
		if (child.exitCode === null) child.kill("SIGTERM");
		if (child.exitCode === null) {
			await timeout(closed, "MCP protocol verifier shutdown");
		}
	}
};

const current = await initialize("2025-11-25");
assert.equal(current.result.protocolVersion, "2025-11-25");
const old = await initialize("2025-06-18");
assert.equal(old.error.code, -32600);
assert.match(old.error.message, /requires protocol 2025-11-25/);
console.log("MCP protocol 2025-11-25 only PASS");
