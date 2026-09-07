import { AsyncLocalStorage } from "node:async_hooks";
import * as defaultAuth from "../codex-auth.mjs";
import { createCodexClient } from "./codex-client.mjs";
import { createAgentTools, agentToolSchemas, SYSTEM_PROMPT, pickWorkspace } from "./agent-tools.mjs";
import { createVideoAdapters } from "./video-adapters.mjs";

// Values the codex backend accepts for reasoning.effort (its own 400 lists them).
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const json = (res, status, value) => {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(value));
};

export function allowAgentOrigin(req, port) {
	return [`http://127.0.0.1:${port}`, `http://${"local" + "host"}:${port}`].includes(req.headers.origin)
		|| (req.headers.origin === undefined && req.method === "GET"
			&& [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host));
}

// Two 1920x1080 PNG data URLs (frame + reference) fit comfortably in this.
const IMAGE_BODY_LIMIT = 24 * 1024 * 1024;

// Attached scene references (#167): identity sheets and the environment
// reference. Capped because every one of them is another full image the
// backend has to read, and a shot with seven of them is a prompt nobody wrote.
const IMAGE_REFERENCES_MAX = 6;

/** Reject anything that is not a list of {role, name?, dataUrl} inline images. */
function validReferences(references) {
	if (references === undefined) return true;
	if (!Array.isArray(references) || references.length > IMAGE_REFERENCES_MAX) return false;
	return references.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
		&& typeof entry.role === "string" && entry.role
		&& (entry.name === undefined || typeof entry.name === "string")
		&& typeof entry.dataUrl === "string" && entry.dataUrl.startsWith("data:image/"));
}

/**
 * What the attached pictures MEAN, in the order they are attached. Without
 * this the backend sees a pile of images and guesses; with it the clay frame
 * owns the geometry, each character sheet owns one performer's look and the
 * environment reference owns the location.
 */
export function referenceGuidance(references = []) {
	const list = Array.isArray(references) ? references : [];
	if (!list.length) return "";
	const lines = ["Geometry, camera and blocking come from the first image (the clay frame)."];
	for (const entry of list) {
		if (entry.role === "character") {
			lines.push(`Character ${entry.name || "reference"}: match the identity, face, hair and wardrobe from the attached character sheet.`);
		} else if (entry.role === "environment") {
			lines.push("Environment: take the location look, materials, palette and lighting from the attached environment reference.");
		}
	}
	return `\n${lines.join("\n")}`;
}

async function readBody(req, limit = 64 * 1024) {
	let text = "";
	for await (const chunk of req) {
		text += chunk;
		if (Buffer.byteLength(text) > limit) throw new Error("Request too large.");
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
	if (error?.code === "overloaded") return { code: "overloaded", message: "The model service is overloaded right now. Try again in a moment." };
	if (error?.code === "server_error") return { code: "overloaded", message: "The model service hit an internal error. Try again in a moment." };
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

export function createAgentHandler({ auth = defaultAuth, codex, handlers, liveHub, port, retryDelayMs = 2000 } = {}) {
	const requestContext = new AsyncLocalStorage();
	codex ||= defaultClient(auth, requestContext);
	const runtime = handlers !== undefined || liveHub !== undefined ? Promise.resolve({ handlers: handlers ?? [], liveHub }) : liveToolsRuntime();
	const renderGuidance = async (environment) => {
		try {
			const { handlers: tools, liveHub: hub } = await runtime;
			const tool = tools.find((entry) => entry.name === "render_prompt");
			if (!tool || !hub?.connected) return "";
			const workspaceHandle = pickWorkspace(hub);
			const result = await tool.handler({ mode: "image", environment }, { workspaceHandle });
			if (result?.isError) return "";
			const text = typeof result === "string" ? result : (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
			return text ? `\n${text}` : "";
		} catch { return ""; }
	};
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
					const efforts = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels.map((level) => (typeof level === "string" ? level : level.effort)).filter(Boolean) : [];
					return { id, label: id, efforts, defaultEffort: typeof model.default_reasoning_level === "string" ? model.default_reasoning_level : efforts[0] ?? null };
				});
				models.sort((a, b) => Number(b.id === "gpt-6-astra") - Number(a.id === "gpt-6-astra"));
				json(res, 200, { models });
			} catch (error) { json(res, error.status === 401 ? 401 : 502, { error: errorInfo(error) }); }
			return true;
		}
		if (path === "/agent/image" && req.method === "POST") {
			let value;
			try {
				value = await readBody(req, IMAGE_BODY_LIMIT);
				if (typeof value.prompt !== "string" || !value.prompt.trim() || typeof value.imageDataUrl !== "string" || !value.imageDataUrl.startsWith("data:image/") || (value.referenceDataUrl !== undefined && (typeof value.referenceDataUrl !== "string" || !value.referenceDataUrl.startsWith("data:image/"))) || !validReferences(value.references) || (value.quality !== undefined && !["auto", "low", "medium", "high"].includes(value.quality))) throw new Error("Invalid request.");
			} catch { json(res, 400, { error: "invalid request" }); return true; }
			if (!await auth.getAccessToken()) { json(res, 401, { error: { code: "auth", message: "Sign in with ChatGPT in the Agent panel." } }); return true; }
			try {
				// Same composition guidance the agent's render_from_frame appends: the
				// node's prompt is intent only; camera, cast and set come from the scene.
				// Scene references (#167) are appended after the frame/reference pair,
				// and the prompt says what each attachment is for.
				const references = Array.isArray(value.references) ? value.references : [];
				const prompt = `${value.prompt}${await renderGuidance(value.prompt)}${referenceGuidance(references)}`;
				const result = await codex.editImage({ ...value, prompt, extraImages: references.map((entry) => entry.dataUrl) });
				json(res, 200, { dataUrl: `data:image/png;base64,${result.pngBase64}`, width: result.width, height: result.height });
			} catch (error) { json(res, error.status === 401 ? 401 : 502, { error: errorInfo(error) }); }
			return true;
		}
		if (path === "/agent/video/providers" && req.method === "GET") {
			json(res, 200, { providers: createVideoAdapters().map((adapter) => ({ id: adapter.id, name: adapter.name, configured: adapter.configured() })) });
			return true;
		}
		if (path === "/agent/video" && req.method === "POST") {
			let value;
			try {
				value = await readBody(req, IMAGE_BODY_LIMIT);
				if (!value || typeof value.provider !== "string" || typeof value.prompt !== "string" || !value.prompt.trim() || typeof value.imageDataUrl !== "string" || !value.imageDataUrl.startsWith("data:image/") || (value.lastFrameDataUrl !== undefined && (typeof value.lastFrameDataUrl !== "string" || !value.lastFrameDataUrl.startsWith("data:image/"))) || !Number.isFinite(Number(value.durationSeconds)) || Number(value.durationSeconds) < 1 || Number(value.durationSeconds) > 15 || typeof value.aspect !== "string" || (value.model !== undefined && typeof value.model !== "string")) throw new Error("Invalid request.");
			} catch { json(res, 400, { error: "invalid request" }); return true; }
			const adapter = createVideoAdapters().find((entry) => entry.id === value.provider);
			if (!adapter || !adapter.configured()) { json(res, 409, { error: "video provider is not configured" }); return true; }
			try {
				const result = await adapter.generate({ ...value, durationSeconds: Number(value.durationSeconds) });
				json(res, 200, { ...(result.mp4Base64 ? { dataUrl: `data:video/mp4;base64,${result.mp4Base64}` } : { url: result.url }), width: result.width, height: result.height, seconds: result.seconds });
			} catch (error) { json(res, 502, { error: error?.message || "video provider failed" }); }
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
					|| (value.model !== undefined && typeof value.model !== "string")
					|| (value.effort !== undefined && !REASONING_EFFORTS.includes(value.effort))))) throw new Error("Invalid request.");
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
		// A stream that fails with server_is_overloaded usually succeeds on the
		// next attempt; retry twice before reporting it.
		const retryOverloaded = async (operation, attempts = 2) => {
			for (let attempt = 0; ; attempt += 1) {
				try { return await operation(); } catch (error) {
					if (!["overloaded", "server_error"].includes(error.code) || attempt >= attempts || signal.aborted) throw error;
					await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
				}
			}
		};
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
			const executeTool = async (item, override) => {
				signal.throwIfAborted();
				const tool = override ?? tools.find((entry) => entry.name === item.name);
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
					if (process.env.COZYCLAY_AGENT_DEBUG) console.error("[agent] tool", item.name, "failed:", error?.message);
					send({ type: "tool.done", callId: item.call_id, ok: false, elapsedMs: Math.round(performance.now() - started), error: errorInfo(error).message });
					throw error;
				}
			};
			let text = value.text;
			if (value.attachFrame) {
				const captured = await executeTool({ call_id: "attached-frame", name: "capture_blocking_frame", arguments: {} }, tools.internal.capture);
				text += `\nAttached frame imageId: ${captured.imageId}`;
			}
			const history = [...session.history, { role: "user", content: [{ type: "input_text", text }] }];
			// runAgentTurn closes over streamResponses and hides its headers. Drive
			// that same serial loop here so quotas are observable, and retry only
			// the failed request rather than replaying already-executed scene tools.
			while (true) {
				const output = await retryOverloaded(() => retryAuth(async () => {
					const stream = codex.streamResponses({ input: history, tools: agentToolSchemas(tools), instructions: SYSTEM_PROMPT, model: value.model, effort: value.effort, signal });
					const headers = stream.headers.then(observeHeaders, () => {});
					const items = [];
					try {
						for await (const event of stream) {
							signal.throwIfAborted();
							if (event.type === "response.output_text.delta") send({ type: "text.delta", text: event.delta });
							if (event.type === "response.output_item.done") items.push(event.item);
							if (event.type === "error" || event.type === "response.failed") {
								if (process.env.COZYCLAY_AGENT_DEBUG) console.error("[agent] model event:", JSON.stringify(event).slice(0, 600));
								const code = event.error?.code ?? event.response?.error?.code;
								throw Object.assign(new Error("Model response failed."), code === "server_is_overloaded" ? { code: "overloaded" } : code === "server_error" ? { code: "server_error" } : {});
							}
						}
						await headers;
						return items;
					} finally { await headers; }
				}));
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
				if (process.env.COZYCLAY_AGENT_DEBUG) console.error("[agent] turn failed:", error?.status, error?.message, String(error?.body ?? "").slice(0, 300));
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
