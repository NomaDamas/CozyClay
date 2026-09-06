import { AsyncLocalStorage } from "node:async_hooks";
import * as defaultAuth from "../codex-auth.mjs";
import { createCodexClient } from "./codex-client.mjs";
import { createAgentTools, agentToolSchemas, SYSTEM_PROMPT } from "./agent-tools.mjs";

const json = (res, status, value) => {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(value));
};

export function allowAgentOrigin(req, port) {
	return [`http://127.0.0.1:${port}`, `http://${"local" + "host"}:${port}`].includes(req.headers.origin)
		|| (req.headers.origin === undefined && req.method === "GET"
			&& [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host));
}

async function readBody(req) {
	let text = "";
	for await (const chunk of req) {
		text += chunk;
		if (Buffer.byteLength(text) > 64 * 1024) throw new Error("Request too large.");
	}
	return JSON.parse(text || "{}");
}

function quotaEvent(codex, headers) {
	const quota = codex.parseQuotaHeaders(headers);
	let resetAt = quota.primary.resetAt;
	if (resetAt && /^\d+(\.\d+)?$/.test(String(resetAt))) resetAt = Number(resetAt) * 1000;
	if (!resetAt && quota.primary.resetAfterSeconds !== undefined) resetAt = Date.now() + quota.primary.resetAfterSeconds * 1000;
	return {
		type: "quota", plan: quota.planType ?? null,
		primary: { usedPercent: quota.primary.usedPercent ?? null, windowMinutes: quota.primary.windowMinutes ?? null, resetAt: resetAt ?? null },
		credits: { has: quota.credits.hasCredits },
	};
}

function errorInfo(error, quota) {
	if (error?.status === 401 || error?.code === "unauthorized") return { code: "auth", message: "Authentication required. Sign in again." };
	if (error?.status === 429) return { code: "rate_limit", message: "Rate limit exceeded.", resetAt: quota?.primary.resetAt ?? null };
	if (error?.code === "entitlement") return { code: "entitlement", message: "This account cannot generate images." };
	// Backend errors may echo credentials or image inputs. Never forward their bodies.
	return { code: "upstream", message: "The model or live editor could not complete this turn." };
}

/** Use the existing client and its request queue, retaining failure headers that
 * the client otherwise discards. A 429 belongs to the panel's paused state, not
 * the client's unbounded retry loop (which cannot be interrupted during sleep). */
function defaultClient(auth, requestContext) {
	return createCodexClient({
		getAccessToken: auth.getAccessToken, getAccountId: auth.getAccountId, originator: "cozyclay",
		fetch: async (url, init) => {
			const response = await fetch(url, init);
			requestContext.getStore()?.(response.headers);
			if (response.ok) return response;
			const detail = await response.text();
			const error = Object.assign(new Error("Codex backend request failed."), { status: response.status, headers: response.headers });
			if (url.includes("/images/") && /entitlement|plan/i.test(detail)) error.code = "entitlement";
			throw error;
		},
	});
}

/** Start the optional registry/live dependencies without making signed-out
 * startup depend on an MCP dependency install. Failures remain visible on use. */
function liveToolsRuntime() {
	return Promise.all([import("../../mcp/tool-handlers.mjs"), import("../../mcp/live-hub.mjs")]).then(async ([registry, { startLiveHub }]) => {
		const liveHub = await startLiveHub(Number(process.env.COZYCLAY_LIVE_PORT ?? 5184));
		registry.setLiveHub(liveHub);
		const handlers = registry.createToolHandlers().map((tool) => ({
			...tool,
			handler: async (args, { workspaceHandle } = {}) => {
				const parsed = Object.fromEntries(Object.entries(tool.inputSchema).map(([key, schema]) => [key, schema.parse(args[key])]));
				const run = (handle) => registry.liveWorkspace.run(handle, () => tool.handler(parsed));
				return liveHub?.connected ? liveHub.runExclusive(tool.name, workspaceHandle, run) : run(workspaceHandle);
			},
		}));
		return { liveHub, handlers };
	}).catch((error) => ({ error }));
}

export function createAgentHandler({ auth = defaultAuth, codex, handlers, liveHub, port } = {}) {
	const requestContext = new AsyncLocalStorage();
	codex ||= defaultClient(auth, requestContext);
	const runtime = handlers !== undefined || liveHub !== undefined ? Promise.resolve({ handlers: handlers ?? [], liveHub }) : liveToolsRuntime();
	const sessions = new Map();
	const unsubscribe = auth.onAuthChange?.(() => {
		for (const session of sessions.values()) session.controller?.abort();
		sessions.clear();
	});

	const handle = async (req, res, path = new URL(req.url, "http://127.0.0.1").pathname) => {
		if (!path.startsWith("/agent/")) return false;
		if (port !== undefined && !allowAgentOrigin(req, typeof port === "function" ? port() : port)) {
			json(res, 403, { error: "forbidden origin" }); return true;
		}
		if (path === "/agent/models" && req.method === "GET") {
			try {
				const result = await codex.listModels();
				const models = (Array.isArray(result) ? result : result.models).map((model) => {
					const id = typeof model === "string" ? model : model.slug || model.id;
					return { id, label: id };
				});
				models.sort((a, b) => Number(b.id === "gpt-6-astra") - Number(a.id === "gpt-6-astra"));
				json(res, 200, { models });
			} catch (error) { json(res, error.status === 401 ? 401 : 502, { error: errorInfo(error) }); }
			return true;
		}
		if (req.method !== "POST" || !["/agent/turn", "/agent/stop"].includes(path)) {
			json(res, 404, { error: "not found" }); return true;
		}
		let value;
		try {
			value = await readBody(req);
			if (!value || typeof value.sessionId !== "string" || !value.sessionId
				|| (path === "/agent/turn" && (typeof value.text !== "string"
					|| (value.attachFrame !== undefined && typeof value.attachFrame !== "boolean")
					|| (value.model !== undefined && typeof value.model !== "string")))) throw new Error("Invalid request.");
		} catch { json(res, 400, { error: "invalid request" }); return true; }
		if (path === "/agent/stop") {
			sessions.get(value.sessionId)?.controller?.abort();
			json(res, 200, { ok: true }); return true;
		}

		res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
		res.flushHeaders();
		const send = (event) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
		let session = sessions.get(value.sessionId);
		if (session?.running) {
			send({ type: "error", code: "upstream", message: "busy" }); send({ type: "done" }); res.end(); return true;
		}
		session ||= { images: new Map(), history: [] };
		sessions.set(value.sessionId, session);
		const controller = new AbortController();
		const { signal } = controller;
		Object.assign(session, { running: true, controller, signal });
		const disconnect = () => controller.abort();
		res.once("close", disconnect);
		let quota;
		const observeHeaders = (headers) => {
			const next = quotaEvent(codex, headers);
			if (!quota) send(next);
			quota = next;
		};
		let refreshed = false;
		const retryAuth = async (operation) => {
			try { signal.throwIfAborted(); return await operation(); }
			catch (error) {
				if (error.status !== 401 || refreshed || signal.aborted) throw error;
				refreshed = true;
				if (!await auth.getAccessToken()) throw error;
				signal.throwIfAborted();
				return operation();
			}
		};
		const turn = async () => {
			if (!await auth.getAccessToken()) throw Object.assign(new Error("Authentication required."), { status: 401 });
			const dependencies = await runtime;
			session.codex = { editImage: (args) => retryAuth(() => codex.editImage(args)) };
			const tools = createAgentTools({ ...dependencies, session, emit: send });
			const executeTool = async (item) => {
				signal.throwIfAborted();
				const tool = tools.find((entry) => entry.name === item.name);
				if (!tool) throw new Error("Unknown tool.");
				const args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
				send({ type: "tool.start", callId: item.call_id, name: item.name, label: item.name.replaceAll("_", " "), args });
				const started = performance.now();
				try {
					if (dependencies.error) throw dependencies.error;
					const result = await tool.handler(args);
					signal.throwIfAborted();
					send({ type: "tool.done", callId: item.call_id, ok: true, elapsedMs: Math.round(performance.now() - started), result });
					return result;
				} catch (error) {
					send({ type: "tool.done", callId: item.call_id, ok: false, elapsedMs: Math.round(performance.now() - started), error: errorInfo(error).message });
					throw error;
				}
			};
			let text = value.text;
			if (value.attachFrame) {
				const captured = await executeTool({ call_id: "attached-frame", name: "capture_blocking_frame", arguments: {} });
				text += `\nAttached frame imageId: ${captured.imageId}`;
			}
			const history = [...session.history, { role: "user", content: [{ type: "input_text", text }] }];
			// runAgentTurn closes over streamResponses and hides its headers. Drive
			// that same serial loop here so quotas are observable, and retry only
			// the failed request rather than replaying already-executed scene tools.
			while (true) {
				const output = await retryAuth(async () => {
					const stream = codex.streamResponses({ input: history, tools: agentToolSchemas(tools), instructions: SYSTEM_PROMPT, model: value.model, signal });
					const headers = stream.headers.then(observeHeaders, () => {});
					const items = [];
					try {
						for await (const event of stream) {
							signal.throwIfAborted();
							if (event.type === "response.output_text.delta") send({ type: "text.delta", text: event.delta });
							if (event.type === "response.output_item.done") items.push(event.item);
							if (event.type === "error" || event.type === "response.failed") throw new Error("Model response failed.");
						}
						await headers;
						return items;
					} finally { await headers; }
				});
				for (const item of output) {
					history.push(item); // Preserve reasoning items verbatim.
					if (item.type === "function_call") {
						const result = await executeTool(item);
						history.push({ type: "function_call_output", call_id: item.call_id, output: JSON.stringify(result) });
					}
				}
				if (!output.some((item) => item.type === "function_call")) break;
			}
			session.history = history;
		};
		try { await requestContext.run(observeHeaders, turn); }
		catch (error) {
			if (!signal.aborted) {
				if (error.headers) observeHeaders(error.headers);
				send({ type: "error", ...errorInfo(error, quota) });
			}
		} finally {
			session.running = false; send({ type: "done" }); res.end(); res.off("close", disconnect);
		}
		return true;
	};
	handle.close = async () => {
		unsubscribe?.();
		for (const session of sessions.values()) session.controller?.abort();
		sessions.clear();
		const { liveHub: hub } = await runtime;
		if (hub?.server) {
			for (const socket of hub.server.clients) socket.terminate();
			await new Promise((resolve) => hub.server.close(resolve));
		}
	};
	return handle;
}
