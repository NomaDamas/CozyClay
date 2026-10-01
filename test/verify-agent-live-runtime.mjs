#!/usr/bin/env node
// The published npm package carries no zod/three/ws at its root: those live in
// the staged MCP runtime that bin/mcp-runtime.mjs installs once per version
// under ~/.cache/cozyclay/mcp-runtime/<version>. The Studio agent handler
// therefore accepts an `mcpRuntime` whose ensure() yields that staged root and
// loads mcp/tool-handlers.mjs and mcp/live-hub.mjs from there (#576). A source
// checkout passes no runtime and keeps importing the repository's own modules.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "cozyclay-agent-live-runtime-"));
// Live endpoint files and agent sessions stay out of the real config directory.
process.env.XDG_CONFIG_HOME = join(scratch, "config");
process.env.COZYCLAY_AGENT_SESSIONS_DIR = join(scratch, "sessions");
delete process.env.CLIPROXY_API_KEY;
delete process.env.CLIPROXY_BASE_URL;
delete process.env.COZYCLAY_LIVE_OWNER;

function reservePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

// Never share the default 5184 hub with a Studio that may be running.
const repositoryHubPort = await reservePort();
process.env.COZYCLAY_LIVE_PORT = String(repositoryHubPort);

const { createAgentHandler } = await import("../bin/agent/agent-routes.mjs");
const liveDirectory = join(scratch, "config", "cozyclay", "live");
const liveFiles = () => { try { return readdirSync(liveDirectory).sort(); } catch { return []; } };

/** Resolves once `<port>.json` exists in the live directory; armed before the
 * action that publishes it, bounded so a silent hub fails the test. */
function endpointPublished(port) {
	mkdirSync(liveDirectory, { recursive: true });
	const file = `${port}.json`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { watcher.close(); reject(new Error(`live endpoint ${file} was not published`)); }, 15_000);
		const watcher = watch(liveDirectory, (event, name) => {
			if (name === file && existsSync(join(liveDirectory, file))) { clearTimeout(timer); watcher.close(); resolve(); }
		});
	});
}

/** A staged runtime root as bin/mcp-runtime.mjs lays it out: mcp/ next to the
 * installed dependencies. The modules record where they were loaded from. */
function stagedRuntime(name, hubPort) {
	const root = join(scratch, name);
	mkdirSync(join(root, "mcp"), { recursive: true });
	writeFileSync(join(root, "mcp", "tool-handlers.mjs"), `
		const trace = globalThis.__cozyclayStagedRuntime ??= {};
		trace.registryRoot = ${JSON.stringify(root)};
		export function setLiveHub(hub) { trace.hub = hub; }
		export function createToolHandlers() {
			return [{ name: "staged.fixture", inputSchema: {}, handler: async () => ({ content: [{ type: "text", text: "staged" }] }) }];
		}
		export const liveWorkspace = { run: (handle, fn) => fn() };
	`);
	writeFileSync(join(root, "mcp", "live-hub.mjs"), `
		export async function startLiveHub(port, { owner }) {
			const trace = globalThis.__cozyclayStagedRuntime ??= {};
			trace.hubStart = { port, owner, root: ${JSON.stringify(root)} };
			return {
				port: ${hubPort},
				connected: false,
				workspaceId: null,
				server: null,
				command: async () => { throw new Error("fixture hub"); },
				runExclusive: (name, handle, run) => run(handle),
			};
		}
	`);
	return root;
}

try {
	// 1. An ensured runtime root supplies both live-tool modules, and the real
	//    publication path still runs against the hub it returned.
	{
		const hubPort = 65000;
		const root = stagedRuntime("staged", hubPort);
		let ensured = 0;
		const handler = createAgentHandler({ port: () => 5180, mcpRuntime: { ensure: async () => { ensured += 1; return root; } } });
		await handler.close();
		const trace = globalThis.__cozyclayStagedRuntime;
		assert.equal(ensured, 1, "the staged runtime is ensured once per handler");
		assert.equal(trace?.registryRoot, root, "tool handlers are imported from the staged runtime");
		assert.equal(trace?.hubStart?.root, root, "the live hub is imported from the staged runtime");
		assert.equal(trace.hubStart.owner, "cozyclay", "the hub owner is the launcher, not dev-full");
		assert.ok(trace.hub, "the staged registry receives the staged hub");
		assert.deepEqual(liveFiles(), [`${hubPort}.json`], "the staged hub publishes its live endpoint");
		assert.equal(JSON.parse(readFileSync(join(liveDirectory, `${hubPort}.json`), "utf8")).owner, "cozyclay");
		rmSync(join(liveDirectory, `${hubPort}.json`));
		delete globalThis.__cozyclayStagedRuntime;
	}

	// 2. A runtime that cannot be ensured (offline first launch, damaged cache)
	//    is contained: the handler still constructs and closes, and the reason
	//    reaches the launcher's terminal instead of vanishing.
	{
		const errors = [];
		const original = console.error;
		console.error = (...args) => errors.push(args.join(" "));
		try {
			const handler = createAgentHandler({ port: () => 5180, mcpRuntime: { ensure: async () => { throw new Error("npm ci failed (exit 1). Check your network connection and retry."); } } });
			await handler.close();
		} finally {
			console.error = original;
		}
		assert.ok(
			errors.some((line) => line.includes("Studio live tools unavailable") && line.includes("npm ci failed (exit 1)")),
			`the ensure failure is reported on stderr: ${JSON.stringify(errors)}`,
		);
		assert.equal(globalThis.__cozyclayStagedRuntime, undefined, "no staged module was loaded");
		assert.deepEqual(liveFiles(), [], "no live endpoint is published without a hub");
	}

	// 3. Without a runtime (a source checkout) the repository's own mcp/ modules
	//    start the real hub on COZYCLAY_LIVE_PORT and publish it; closing the
	//    handler closes that hub and retires its endpoint file.
	{
		const published = endpointPublished(repositoryHubPort);
		const handler = createAgentHandler({ port: () => 5180 });
		await published;
		assert.equal(globalThis.__cozyclayStagedRuntime, undefined, "the repository modules are used, not a staged copy");
		assert.deepEqual(liveFiles(), [`${repositoryHubPort}.json`], "the repository hub publishes its live endpoint on the configured port");
		await handler.close();
		assert.deepEqual(liveFiles(), [], "closing the handler retires the repository hub's endpoint");
	}
	console.log("agent live runtime PASS");
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
