#!/usr/bin/env node
/**
 * cozyclay-mcp — an MCP surface over CozyClay's authoring core.
 *
 * This server owns NO geometry, NO film vocabulary and NO prompt text. Every
 * answer it gives is computed by the same modules the studio renders with,
 * imported straight from the published `cozyclay` package:
 *
 *   shot.js          geometry -> film vocabulary -> prompt
 *   scenes.js        the scene document + its stage envelope
 *   scene-objects.js the set: create/update/remove/normalise
 *   cuts.js          shots on a timeline
 *   camera-move.js   two framings -> a named camera move
 *   project.js       the .cclayproject envelope
 *
 * Running inside the repo, those imports are relative: this server always
 * speaks the working tree's own vocabulary, so a change to shot.js is visible
 * here on the next start with nothing to publish or reinstall.
 *
 * Keeping the maths on the other side of that import is the whole design: the
 * studio and this server can never disagree about what a 35mm medium shot is,
 * because there is only one implementation of it.
 *
 * State is one in-memory scene document plus one camera. `save_project` writes
 * the real `.cclayproject` envelope, so anything authored here opens in the
 * studio, and anything authored in the studio opens here.
 *
 * The tools themselves are not here: tool-handlers.mjs owns the registry and
 * that authoring state, so an in-process agent can call a handler without an
 * MCP server at all. What is left in this file is the MCP surface — protocol,
 * transports, the registration wrapper that applies the safety annotations and
 * the live workspace routing, and the process wiring the handlers cannot do for
 * themselves (project root, capture-artifact cleanup, motion job delivery).
 */
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, InitializeRequestSchema, LATEST_PROTOCOL_VERSION, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { LiveMutationUncertainError, MotionJobRegistry, startLiveHub } from "./live-hub.mjs";
import {
	cleanupCaptureArtifacts,
	createToolHandlers,
	liveHub,
	liveWorkspace,
	setLiveHub,
	setLivePortInfo,
	sweepCaptureArtifacts,
} from "./tool-handlers.mjs";

/* ------------------------------ process ---------------------------------- */

const motionJobs = new MotionJobRegistry();
sweepCaptureArtifacts();
process.once("exit", cleanupCaptureArtifacts);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { cleanupCaptureArtifacts(); process.exit(128 + (signal === "SIGINT" ? 2 : 15)); });
const configuredProjectRoot = resolve(process.env.COZYCLAY_PROJECT_ROOT ?? process.cwd());
const projectRootPromise = realpath(configuredProjectRoot).then((root) => {
	process.chdir(root);
	return root;
});

/* ----------------------------- motion jobs ------------------------------- */

const motionJobEvent = (job) => ({
	...motionJobs.task(job),
	...(job.outcome === null ? {} : { outcome: job.outcome }),
});

const sendMotionJobEvent = (job) => {
	try {
		if (liveHub?.sendEvent(job.workspaceId, "motion_job", motionJobEvent(job)) > 0) {
			job.deliveredWorkspaceIds.add(job.workspaceId);
		}
	} catch (error) {
		console.error(`[motion_job] lifecycle event delivery failed: ${error instanceof Error ? error.message : String(error)}`);
	}
};

const publishMotionJob = async (job) => {
	if (job.deliveredWorkspaceIds.has(job.workspaceId)) return;
	const outcome = job.outcome;
	if (!liveHub || job.status !== "completed" || typeof outcome?.motionUrl !== "string") {
		sendMotionJobEvent(job);
		return;
	}
	const installationState = job.installationStates.get(job.workspaceId);
	if (installationState === "installing") return;
	if (installationState === "installed") {
		sendMotionJobEvent(job);
		return;
	}
	const handle = liveHub.handleForWorkspaceId(job.workspaceId);
	if (!handle) return;
	job.installationStates.set(job.workspaceId, "installing");
	try {
		await liveHub.command("load_motion", {
			url: outcome.motionUrl,
			prompt: outcome.prompt ?? "",
			blocks: outcome.blocks ?? [],
			drop: outcome.drop ?? null,
			characterId: outcome.targetCharacterId,
		}, handle);
	} catch (error) {
		const uncertain = error instanceof LiveMutationUncertainError;
		job.installationStates.set(job.workspaceId, uncertain ? "uncertain" : "failed");
		motionJobs.transition(job, "failed", {
			message: uncertain
				? "The editor connection was lost while installing the completed take. Installation may have applied, so it will not be retried."
				: `The editor rejected the completed take: ${error instanceof Error ? error.message : String(error)}`,
		});
		sendMotionJobEvent(job);
		return;
	}
	job.installationStates.set(job.workspaceId, "installed");
	sendMotionJobEvent(job);
};

const cancelMotionJob = ({ workspaceId, payload }) => {
	if (payload.taskId && typeof payload.taskId !== "string") return;
	if (typeof payload.taskId !== "string") return;
	const task = motionJobs.cancel(payload.taskId, workspaceId);
	if (!task) return;
	const job = motionJobs.jobs.get(task.taskId);
	if (job) void publishMotionJob(job);
};

/* ------------------------------- server ---------------------------------- */

/** Tool registrations are counted as they happen so the HTTP status page can
 * report the real number without reaching into SDK internals. */
let registeredTools = 0;

const server = new McpServer(
	{ name: "cozyclay-mcp", version: "0.1.0" },
	{
		instructions:
			"CozyClay previs. Block a 3D scene, place the camera, then read the shot back as film " +
			"vocabulary (shot size, angle, lens) and render it into an AI image/video prompt. " +
			"Call describe_scene first to see the current state. Coordinates are metres: x is right, " +
			"z is toward the camera's default position, y is height above the floor. Rotations are " +
			"degrees of yaw. Save with save_project to a .cclayproject file the CozyClay studio opens.",
	},
);
server.server.setRequestHandler(InitializeRequestSchema, async (request) => {
	if (request.params.protocolVersion !== LATEST_PROTOCOL_VERSION) {
		throw new McpError(ErrorCode.InvalidRequest, `CozyClay MCP requires protocol ${LATEST_PROTOCOL_VERSION}.`);
	}
	return server.server._oninitialize(request);
});

const registerTool = ({ name, title, description, inputSchema, annotations, live, handler }) => {
	registeredTools += 1;
	if (!annotations) throw new Error(`Missing explicit safety annotations for ${name}.`);
	if (!live) return server.registerTool(name, { title, description, inputSchema, annotations }, handler);
	return server.registerTool(
		name,
		{
			title,
			annotations,
			description:
				`${description} Multiple editor instances are supported; when more than one is connected, ` +
				"workspace_handle is required so this command reaches only its named workspace.",
			inputSchema: {
				...inputSchema,
				workspace_handle: z.string().optional().describe("live workspace handle from live_status; required when multiple editors are connected"),
			},
		},
		async (args) => {
			const workspaceHandle = args.workspace_handle;
			if (workspaceHandle !== undefined && !liveHub?.connected) {
				throw new Error(`Unknown or stale live workspace handle \"${workspaceHandle}\".`);
			}
			if (!liveHub?.connected) return liveWorkspace.run(workspaceHandle, () => handler(args));
			return liveHub.runExclusive(name, workspaceHandle, (resolvedHandle) =>
				liveWorkspace.run(resolvedHandle, () => handler(args)),
			);
		},
	);
};

// The tools themselves live in tool-handlers.mjs so an in-process agent can run
// them without an MCP server; registration order is the registry's order, which
// is the order tools/list reports.
for (const handler of createToolHandlers({ projectRootPromise, motionJobs, publishMotionJob })) registerTool(handler);

/* -------------------------------- start ---------------------------------- */

/**
 * stdio is the default because that is how an MCP client launches a local
 * server. `--http` is for driving it by hand: a long-lived endpoint on
 * loopback that survives across client restarts and can be curled.
 */
/** Counted as the tools are registered, so the status page cannot drift. */
const TOOL_COUNT = registeredTools;

const httpFlag = process.argv.indexOf("--http");
const livePortFlag = process.argv.indexOf("--live-port");
const livePort = Number(
	livePortFlag === -1 ? process.env.COZYCLAY_LIVE_PORT ?? 5184 : process.argv[livePortFlag + 1],
);
if (!Number.isInteger(livePort) || livePort < 1 || livePort > 65535) throw new Error("--live-port must be a valid TCP port.");

const configureLiveHub = (hub) => {
	if (!hub) return;
	hub.onEvent = ({ workspaceId, name, payload }) => {
		if (name === "motion_job_cancel") cancelMotionJob({ workspaceId, payload });
	};
	hub.onWorkspaceConnected = ({ workspaceId }) => {
		for (const job of motionJobs.forWorkspace(workspaceId)) void publishMotionJob(job);
	};
};

if (httpFlag === -1) {
	const hub = await startLiveHub(livePort);
	setLivePortInfo(livePort, hub === null);
	setLiveHub(hub);
	configureLiveHub(hub);
	await server.connect(new StdioServerTransport());
} else {
	// Tools execute in the stdio children, not this HTTP front. Each child tries
	// to own the one editor port; the winner is live and later sessions see the
	// port occupied and deliberately remain memory-only rather than sharing state.
	const requestedHttpPort = process.argv[httpFlag + 1];
	const port = Number(
		requestedHttpPort && !requestedHttpPort.startsWith("--") ? requestedHttpPort : process.env.COZYCLAY_MCP_PORT ?? 5183,
	);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--http must use a valid TCP port.");

	// One MCP session per client, each backed by its own stdio child of this
	// same file. A single shared transport would let the first client's
	// initialize claim the server and refuse every later one; sharing one
	// server object would also mean two clients silently editing one scene.
	// A child process per session keeps each client's scene its own, and reuses
	// the stdio path that the tools already run on.
	const sessions = new Map();
	const allowedHttpHosts = new Set([`127.0.0.1:${port}`]);
	const allowedHttpOrigins = new Set([`http://127.0.0.1:${port}`]);
	const allowHttpRequest = (req, res) => {
		const host = req.headers.host;
		const origin = req.headers.origin;
		if (typeof host === "string" && allowedHttpHosts.has(host) && (origin === undefined || allowedHttpOrigins.has(origin))) return true;
		res.writeHead(403, { "content-type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "MCP HTTP requests require a loopback Host and Origin." }, id: null }));
		return false;
	};

	const openSession = async () => {
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			allowedHosts: [...allowedHttpHosts],
			allowedOrigins: [...allowedHttpOrigins],
			enableDnsRebindingProtection: true,
			onsessioninitialized: (id) => sessions.set(id, { transport, child }),
		});
		const child = new StdioClientTransport({
			command: process.execPath,
			args: [fileURLToPath(import.meta.url), "--live-port", String(livePort)],
			// StdioClientTransport strips the environment to a safe default set, which
			// silently discards COZYCLAY_* configuration (bridge URL, project root) in
			// HTTP mode. The children are this same file in the same trust domain, so
			// they get the full parent environment.
			env: process.env,
		});

		// Splice the two transports together: the browser-facing session and the
		// child's stdio pipe just forward each other's messages verbatim.
		transport.onmessage = (message) => child.send(message);
		child.onmessage = (message) => transport.send(message);
		transport.onclose = () => {
			if (transport.sessionId) sessions.delete(transport.sessionId);
			child.close().catch(() => {});
		};
		child.onclose = () => transport.close().catch(() => {});

		await child.start();
		await transport.start();
		return transport;
	};

	const http = createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0];

		// A browser hitting the port should get something legible rather than a
		// protocol error, so the root is a plain status page.
		if (path === "/" && req.method === "GET") {
			res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
			res.end(
				[
					"CozyClay MCP server",
					"",
					`endpoint  http://127.0.0.1:${port}/mcp`,
					"transport Streamable HTTP",
					`tools     ${TOOL_COUNT}`,
					"",
					"Point an MCP client at the endpoint above:",
					'  { "mcpServers": { "cozyclay": { "url": ' +
						`"http://127.0.0.1:${port}/mcp" } } }`,
					"",
				].join("\n"),
			);
			return;
		}

		if (path === "/mcp") {
			if (!allowHttpRequest(req, res)) return;
			const existing = sessions.get(req.headers["mcp-session-id"])?.transport;
			const ready = existing ? Promise.resolve(existing) : openSession();
			ready
				.then((transport) => transport.handleRequest(req, res))
				.catch((error) => {
					if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: String(error?.message ?? error) }));
				});
			return;
		}

		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end(`not found — the MCP endpoint is /mcp\n`);
	});

	http.listen(port, "127.0.0.1", () => {
		process.send?.({ type: "cozyclay-mcp-http-ready", port });
		console.log(`CozyClay MCP on http://127.0.0.1:${port}/mcp  (${TOOL_COUNT} tools)`);
	});
}
