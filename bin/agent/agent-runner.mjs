import { summariseCanvasResult } from "./agent-tools.mjs";

const DEFAULT_MODEL = "gpt-6-astra";

function dataUrlImage(dataUrl) {
	const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || "");
	return match ? { type: "image", data: match[2], mimeType: match[1] } : null;
}

function publicDetails(result) {
	if (!result || typeof result !== "object" || Array.isArray(result)) return result;
	return Object.fromEntries(Object.entries(result).filter(([key]) => key !== "dataUrl"));
}

function errorFrame(error, aborted = false) {
	return {
		type: "error",
		code: aborted || error?.name === "AbortError" ? "aborted" : error?.code || "upstream",
		message: error?.message || "The model or live editor could not complete this turn.",
		...(Number.isInteger(error?.status) ? { status: error.status } : {}),
	};
}

class FrameQueue {
	values = [];
	waiters = [];
	closed = false;
	push(value) {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value, done: false });
		else this.values.push(value);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}
	async next() {
		if (this.values.length) return { value: this.values.shift(), done: false };
		if (this.closed) return { value: undefined, done: true };
		return new Promise((resolve) => this.waiters.push(resolve));
	}
	async *[Symbol.asyncIterator]() {
		for (;;) {
			const next = await this.next();
			if (next.done) return;
			yield next.value;
		}
	}
}

function effortLevel(effort) {
	if (effort === undefined) return undefined;
	if (effort === "none") return "off";
	if (effort === "ultra") return "max";
	return effort;
}

function attachmentMessage(attachment, index) {
	const image = dataUrlImage(attachment?.dataUrl);
	return {
		role: "user",
		content: [
			{ type: "text", text: `User attachment ${attachment?.name || index + 1}` },
			...(image ? [image] : []),
		],
	};
}

/**
 * The runner is deliberately the only module in the bin/agent chain that
 * knows about pi. Keep these imports lazy: the package-isolation checks start
 * bin/cozyclay.mjs without node_modules installed.
 */
export function createAgentRunner({ models: suppliedModels, sessionStore, tools = [], systemPrompt = "", clock = performance.now, fauxProvider, onQuota, legacyCodex } = {}) {
	const openSessions = new Map();
	let models = suppliedModels;
	let piModules;

	const loadPi = async () => {
		if (piModules) return piModules;
		const [{ AgentHarness }, context, sessionModule, ai] = await Promise.all([
			import("@earendil-works/pi-agent-core"),
			import("@earendil-works/pi-agent-core/harness/context"),
			import("@earendil-works/pi-agent-core/harness/session"),
			import("@earendil-works/pi-ai"),
		]);
		piModules = { AgentHarness, ...context, ...sessionModule, ...ai };
		return piModules;
	};

	const ensureModels = async () => {
		const pi = await loadPi();
		if (!models) {
			const faux = legacyCodex ? (await import("@earendil-works/pi-ai/providers/faux")).fauxProvider({
				provider: "openai-codex",
				models: [{ id: DEFAULT_MODEL, name: DEFAULT_MODEL, reasoning: true, input: ["text", "image"] }],
			}) : null;
			if (faux) {
				const response = async (context, options, state, model) => {
					const stream = legacyCodex.streamResponses({ input: context.messages, tools: [], instructions: systemPrompt, model: model.id, effort: options?.reasoning, signal: options?.signal });
					const headers = stream?.headers ? await stream.headers : null;
					if (headers && options?.onResponse) await options.onResponse({ status: 200, headers }, model);
					const items = [];
					let text = "";
					for await (const event of stream) {
						if (event.type === "response.output_text.delta") text += event.delta;
						if (event.type === "response.output_item.done") items.push(event.item);
						if (event.type === "error" || event.type === "response.failed") throw Object.assign(new Error("Model response failed."), { code: event.error?.code });
					}
					const content = [];
					if (text) content.push({ type: "text", text });
					for (const item of items) {
						if (item.type === "function_call") {
							let args = item.arguments;
							try { args = typeof args === "string" ? JSON.parse(args) : args; } catch {}
							content.push({ type: "toolCall", id: item.call_id, name: item.name, arguments: args });
						} else if (item.type === "message" && Array.isArray(item.content)) {
							for (const part of item.content) if (part.type === "output_text" && part.text) content.push({ type: "text", text: part.text });
						}
					}
					const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now() };
					faux.appendResponses([response]);
					return message;
				};
				faux.setResponses([response]);
				models = pi.createModels();
				models.setProvider(faux.provider);
			} else {
				const { createModels } = await import("./providers.mjs");
				models = await createModels();
			}
		}
		if (fauxProvider) {
			const provider = fauxProvider.provider || fauxProvider;
			if (typeof models.setProvider === "function") models.setProvider(provider);
		}
		return { pi, models };
	};

	const openSession = async (sessionId, { surface = "workflow" } = {}) => {
		if (openSessions.has(sessionId)) return openSessions.get(sessionId).public;
		const { pi } = await ensureModels();
		const context = pi.BACKGROUND_CONTEXT;
		const repo = new pi.MemorySessionRepo();
		const durable = await repo.create({ id: sessionId }, context);
		const state = {
			sessionId,
			surface,
			repo,
			durable,
			harness: null,
			lane: null,
			context,
			active: null,
			persisted: 0,
			lastInput: null,
			unsubscribers: [],
		};

		const persist = async () => {
			if (!state.lane || !sessionStore?.append) return;
			const entries = await state.lane.findEntries({ order: "oldestFirst" }, state.context);
			const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
			if (messages.length <= state.persisted) return;
			const pending = messages.slice(state.persisted);
			await sessionStore.append(sessionId, pending, { surface });
			state.persisted = messages.length;
		};

		const adapters = async () => {
			const { toAgentTools } = await import("./pi-tools.mjs");
			return toAgentTools(tools, { signal: state.lastInput?.signal, emit: (event) => state.lastInput?.emit?.(event) }).map((tool) => ({
				...tool,
				execute: (toolCallId, params, onUpdate) => tool.execute(toolCallId, params, state.lastInput?.signal, onUpdate),
			}));
		};

		const emitQuota = (queue, input, response, model) => {
			if (state.active?.quotaSent) return;
			if (state.active) state.active.quotaSent = true;
			const headers = response?.headers || {};
			const frame = input.quotaEvent ? input.quotaEvent(headers, model) : {
				type: "quota", plan: null,
				primary: { usedPercent: null, windowMinutes: null, resetAt: null },
				credits: { has: null },
			};
			queue.push(frame);
			for (const pending of state.active?.pendingFrames || []) queue.push(pending);
			if (state.active) state.active.pendingFrames = [];
		};

		const ensureHarness = async (input) => {
			const { pi, models: registry } = await ensureModels();
			const { resolveModel } = await import("./providers.mjs");
			const requested = input.model || DEFAULT_MODEL;
			const slash = requested.indexOf("/");
			const provider = slash === -1 ? "openai-codex" : requested.slice(0, slash);
			const modelId = slash === -1 ? requested : requested.slice(slash + 1);
			const direct = registry.getModel(provider, modelId);
			const selected = direct ? { provider, modelId, model: direct } : await resolveModel(requested, { models: registry });
			if (!state.harness) {
				state.harness = (await pi.AgentHarness.create({
					session: state.durable,
					models: registry,
					model: selected.model,
					thinkingLevel: effortLevel(input.effort),
					tools: await adapters(),
					systemPrompt,
					toolExecution: "sequential",
					steeringMode: "one-at-a-time",
					compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
					streamOptions: {},
				}, state.context)).harness;
				state.harness.hooks.on("after_response", (response) => emitQuota(state.active?.queue, state.lastInput, response, state.currentModel));
				state.lane = await state.harness.lane("main", state.context);
				const restored = sessionStore?.read?.(sessionId);
				if (restored?.history?.length) {
					for (const message of restored.history) await state.lane.appendMessage(message, state.context);
					state.persisted = restored.history.length;
				}
				state.unsubscribers.push(state.harness.events.on("turn_end", persist));
				state.unsubscribers.push(state.harness.events.on("run_end", persist));
			}
			state.currentModel = selected.model;
			await state.lane.setModel({ provider: selected.provider, modelId: selected.modelId }, state.context);
			if (input.effort !== undefined) {
				const level = pi.clampThinkingLevel(selected.model, effortLevel(input.effort));
				await state.lane.setThinkingLevel(level, state.context);
			}
			return { registry, selected };
		};

		const mapEvents = (queue, input) => {
			const toolStartedAt = new Map();
			const toolStarted = new Set();
			const toolCompleted = new Set();
			const eventUnsubscribers = [];
			const pushFrame = (frame) => {
				if (state.active && !state.active.quotaSent && frame.type !== "quota") state.active.pendingFrames.push(frame);
				else queue.push(frame);
			};
			const listen = (type, listener) => eventUnsubscribers.push(state.harness.events.on(type, listener));
			listen("message_update", (event) => {
				if (event.event?.type === "text_delta") pushFrame({ type: "text.delta", text: event.event.delta });
				if (event.event?.type === "error") pushFrame(errorFrame(event.event.error, event.event.reason === "aborted"));
			});
			listen("tool_start", (event) => {
				if (toolStarted.has(event.toolCallId)) return;
				toolStarted.add(event.toolCallId);
				toolStartedAt.set(event.toolCallId, clock());
				const tool = (Array.isArray(tools) ? tools : []).find((candidate) => candidate.name === event.toolName);
				pushFrame({ type: "tool.start", callId: event.toolCallId, name: event.toolName, label: tool?.label || event.toolName.replaceAll("_", " "), args: summariseCanvasResult(event.args) });
			});
			listen("tool_end", (event) => {
				if (toolCompleted.has(event.toolCallId)) return;
				if (!toolStarted.has(event.toolCallId)) {
					toolStarted.add(event.toolCallId);
					toolStartedAt.set(event.toolCallId, clock());
					const tool = (Array.isArray(tools) ? tools : []).find((candidate) => candidate.name === event.toolName);
					pushFrame({ type: "tool.start", callId: event.toolCallId, name: event.toolName, label: tool?.label || event.toolName.replaceAll("_", " "), args: summariseCanvasResult(event.args) });
				}
				toolCompleted.add(event.toolCallId);
				const started = toolStartedAt.get(event.toolCallId) ?? clock();
				const elapsedMs = Math.round(clock() - started);
				const details = event.result?.details;
				if (details?.image && typeof details.image === "object") pushFrame({ type: "image", ...details.image });
				if (event.isError) {
					const message = event.result?.content?.find((part) => part.type === "text")?.text || "Tool execution failed.";
					pushFrame({ type: "tool.done", callId: event.toolCallId, ok: false, elapsedMs, error: message });
				} else pushFrame({ type: "tool.done", callId: event.toolCallId, ok: true, elapsedMs, result: details });
			});
			listen("run_end", (event) => {
				if (state.active?.pendingFrames.length) { for (const pending of state.active.pendingFrames) queue.push(pending); state.active.pendingFrames = []; }
				if (event.status !== "completed") queue.push({ type: "error", code: event.status === "aborted" ? "aborted" : event.error?.code || "upstream", message: event.error?.message || (event.status === "aborted" ? "The turn was aborted." : "The model or live editor could not complete this turn.") });
				queue.push({ type: "done" });
				queue.close();
			});
			return () => { for (const unsubscribe of eventUnsubscribers) unsubscribe(); };
		};

		const start = async function* (input = {}) {
			if (state.active) {
				yield { type: "error", code: "upstream", message: "busy" };
				yield { type: "done" };
				return;
			}
			const queue = new FrameQueue();
			state.active = { queue, quotaSent: false, pendingFrames: [] };
			state.lastInput = input;
			const controller = input.signal ? null : new AbortController();
			const signal = input.signal || controller.signal;
			state.lastInput.signal = signal;
			const run = (async () => {
				let removeEventListeners;
				try {
					await ensureHarness(input);
					removeEventListeners = mapEvents(queue, input);
					for (const [index, attachment] of (Array.isArray(input.attachments) ? input.attachments : []).entries()) await state.lane.appendMessage(attachmentMessage(attachment, index), state.context);
					let text = input.text || "";
					if (input.attachFrame && tools.internal?.capture) {
						const callId = "attached-frame";
						const started = clock();
						queue.push({ type: "tool.start", callId, name: tools.internal.capture.name, label: tools.internal.capture.label || "capture blocking frame", args: {} });
						try {
							const captured = await tools.internal.capture.handler({}, { signal });
							queue.push({ type: "tool.done", callId, ok: true, elapsedMs: Math.round(clock() - started), result: publicDetails(captured) });
							text += `\nAttached frame imageId: ${captured.imageId}`;
						} catch (error) {
							queue.push({ type: "tool.done", callId, ok: false, elapsedMs: Math.round(clock() - started), error: error.message });
							throw error;
						}
					}
				const images = [];
				await state.lane.prompt(text, images, input.signal ? (await loadPi()).withAbortSignal(signal, state.context) : state.context);
				} catch (error) {
					if (!queue.closed) { queue.push(errorFrame(error, signal.aborted)); queue.push({ type: "done" }); queue.close(); }
				} finally {
					removeEventListeners?.();
				}
			})();
			try { yield* queue; } finally { await run; state.active = null; }
		};

		const publicSession = {
			start,
			steer: async (text, images = []) => state.lane?.steer(text, images, state.context),
			abort: async (reason) => { if (state.lane) return state.lane.abort(state.context); return { ok: false, reason }; },
			snapshot: async () => state.lane ? state.lane.inspectExecution(state.context) : null,
			close: async () => { for (const unsubscribe of state.unsubscribers.splice(0)) unsubscribe(); await state.harness?.close(state.context); await state.repo.close(state.context); },
		};
		state.public = publicSession;
		openSessions.set(sessionId, state);
		return publicSession;
	};

	return { openSession, close: async () => { for (const state of openSessions.values()) await state.public.close(); openSessions.clear(); } };
}
