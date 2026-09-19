import { summariseCanvasResult } from "./agent-tools.mjs";
import { sanitizeUpstreamDetail } from "./agent-routes.mjs";

const DEFAULT_MODEL = "gpt-6-astra";

// Bounded provider retries (issue #379): the harness's own `retry` option
// drives the retry loop (pi classifies 429/5xx/network as transient via
// `isRetryableAssistantError`); this is just the budget. `maxRetryDelayMs`
// caps how long a single request sleeps for a provider-requested Retry-After
// before pi's own SDK-level retry gives up and surfaces the error to us.
const RETRY_POLICY = { enabled: true, maxRetries: 2, baseDelayMs: 1000 };
const RETRY_MAX_DELAY_MS = 20000;

const AUTH_ERROR_PATTERN = /\b(401|403)\b|unauthorized|forbidden/i;
const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too many requests/i;
const OVERLOAD_PATTERN = /\b529\b|overloaded/i;

// A numeric HTTP status, one per code. 401/403 both read as "unauthorized";
// 529 (Anthropic's overload status) reads as "overloaded"; every other 5xx
// (500, 502, 503, 504, ...) reads as the generic "upstream" — status always
// wins over whatever words happen to be in the message (an overload message
// with a 500 status is still "upstream", not "overloaded").
const STATUS_CODES = { 401: "unauthorized", 403: "unauthorized", 429: "rate_limit", 529: "overloaded" };
function statusToCode(status) {
	if (STATUS_CODES[status]) return STATUS_CODES[status];
	if (Number.isInteger(status) && status >= 500 && status <= 599) return "upstream";
	return undefined;
}

/** Classify a failed assistant message's `errorMessage` into the runner's
 * frozen error vocabulary. Providers do not hand us a structured status/code
 * here (pi folds both into one string, see `formatProviderError`), so this
 * mirrors the same pattern-matching pi itself uses to decide retryability.
 * Message-only fallback: use `classifyError` at the run_end boundary so a
 * structured status (when the error object carries one) wins first. */
export function classifyProviderError(message) {
	if (AUTH_ERROR_PATTERN.test(message)) return "unauthorized";
	if (RATE_LIMIT_PATTERN.test(message)) return "rate_limit";
	if (OVERLOAD_PATTERN.test(message)) return "overloaded";
	return "upstream";
}

export function extractStatus(message) {
	const match = /\b(401|403|429|5\d\d)\b/.exec(message);
	return match ? Number(match[1]) : undefined;
}

function extractErrorStatus(error) {
	const candidate = error?.status ?? error?.details?.status ?? error?.details?.httpStatus;
	return Number.isInteger(candidate) ? candidate : undefined;
}

/** Classify a failed run's error object into `{code, status}`. A numeric
 * status on the error boundary (a thrown Error's `.status`, or a future pi
 * `OperationError.details.status`) is checked FIRST and wins outright; the
 * message-text regex is only a fallback for the status pi actually ships
 * today (folded into the string, see `formatProviderError` in pi-ai) or for
 * an unrecognized status code. Only ever called on the run's own operation
 * error (`event.error` from `run_end`) — a tool's own failure text never
 * reaches this function, so it cannot reclassify a tool error as a provider
 * one (see the `tool_end` branch in `mapEvents`, which never calls this). */
export function classifyError(error) {
	const message = typeof error?.message === "string" ? error.message : "";
	const structuredStatus = extractErrorStatus(error);
	const status = structuredStatus ?? extractStatus(message);
	const code = (structuredStatus !== undefined ? statusToCode(structuredStatus) : undefined) ?? classifyProviderError(message);
	return { code, status };
}

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

function studioAttachmentContent(attachments) {
	return (Array.isArray(attachments) ? attachments : []).flatMap((attachment, index) => {
		const image = dataUrlImage(attachment?.dataUrl);
		return image ? [{ type: "text", text: `User attachment ${attachment?.name || index + 1}` }, image] : [];
	});
}

function studioUserMessage(input) {
	const contextText = typeof input.studioContextText === "string"
		? input.studioContextText
		: `<studio-context>\n${input.contextText || ""}\n</studio-context>`;
	return {
		role: "user",
		content: [
			...studioAttachmentContent(input.attachments),
			{ type: "text", text: `${contextText}\n${input.text || ""}` },
		],
	};
}

function studioObservationMessage(observation) {
	return {
		role: "user",
		content: [
			{ type: "text", text: `Studio frame observation revision ${JSON.stringify(observation?.revision ?? null)} receipt ${observation?.receiptId ?? "unavailable"}` },
			{ type: "image", data: observation.data, mimeType: observation.mimeType },
		],
	};
}

/**
 * The runner is deliberately the only module in the bin/agent chain that
 * knows about pi. Keep these imports lazy: the package-isolation checks start
 * bin/cozyclay.mjs without node_modules installed.
 */
export function createAgentRunner({ models: suppliedModels, sessionStore, tools = [], systemPrompt = "", clock = () => performance.now(), fauxProvider, onQuota, codexBaseUrl, auth, credentials, keys, env, compaction = { enabled: false }, pi: injectedPi } = {}) {
	const openSessions = new Map();
	let models = suppliedModels;
	let piModules = injectedPi;

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
			const { createModels } = await import("./providers.mjs");
			models = await createModels({ codexBaseUrl, auth, credentials, keys, env });
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

		// An aborted turn's assistant message must never reach sessionStore, even
		// when the generation itself finished normally before the cancellation
		// registered (pi only stops the run from starting a FURTHER turn; it does
		// not retroactively un-stream an already-committed message, so `run_end`'s
		// own `status` arrives too late — by then `turn_end` has already flushed
		// the completed turn through this same `persist`). The one reliable
		// abort signal is therefore "did THIS session's `abort()` run during the
		// still-active turn", tracked synchronously on `state.active` the instant
		// `publicSession.abort` is called (see below) — not any one event's shape.
		// The user message (and any toolResult from a tool that finished before
		// the abort) are real, completed history and ARE persisted; only the
		// assistant role is withheld.
		const persist = async (event) => {
			if (!state.lane || !sessionStore?.append) return;
			const entries = await state.lane.findEntries({ order: "oldestFirst" }, state.context);
			const messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
			if (messages.length <= state.persisted) return;
			const latest = event?.message || messages.at(-1);
			const authFailure = state.provider === "openai-codex"
				&& latest?.role === "assistant"
				&& latest?.stopReason === "error"
				&& classifyError({ message: latest.errorMessage || "" }).code === "unauthorized";
			// The first failed auth attempt is about to rewind this branch. Do not
			// advance the durable watermark or write any of its messages; the retry
			// will persist the final branch instead. If the retry also fails, keep
			// its user messages but withhold the failed assistant message.
			if (authFailure && !state.active?.authRetried) return;
			const aborted = state.active?.abortRequested === true;
			const pending = messages.slice(state.persisted).filter((message) => !(aborted && message?.role === "assistant") && !(authFailure && message?.role === "assistant"));
			state.persisted = messages.length;
			if (!pending.length) return;
			const input = state.lastInput || {};
			await sessionStore.append(sessionId, pending, { surface, ...(input.meta || {}) });
		};

		// pi calls AgentTool.execute(toolCallId, params, signal, onUpdate) — the
		// `signal` it passes is the one that fires when `session.abort()` cancels
		// the run, so tools MUST receive it as-is (not `state.lastInput.signal`,
		// which is only a fallback for callers that never wired a signal at all).
		const adapters = async (input) => {
			const { toAgentTools } = await import("./pi-tools.mjs");
			const activeTools = input?.tools || tools;
			return toAgentTools(activeTools, { signal: state.lastInput?.signal, emit: (event) => state.lastInput?.emit?.(event) });
		};

		const emitQuota = (queue, input, response, model) => {
			if (input?.surface === "studio") { if (state.active) state.active.quotaSent = true; return; }
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
			const activePrompt = input.systemPrompt || (input.surface === "studio" ? (await import("./studio-prompt.mjs")).STUDIO_SYSTEM_PROMPT : systemPrompt);
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
					tools: await adapters(input),
					systemPrompt: activePrompt,
					toolExecution: "sequential",
					steeringMode: "one-at-a-time",
					compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0, ...compaction },
					retry: RETRY_POLICY,
					streamOptions: { maxRetryDelayMs: RETRY_MAX_DELAY_MS, ...(codexBaseUrl ? { transport: "sse" } : {}) },
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
			state.registry = registry;
			state.provider = selected.provider;
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
			const subscribe = (type, listener) => eventUnsubscribers.push(state.harness.events.on(type, listener));
			subscribe("message_update", (event) => {
				if (event.event?.type === "text_delta") pushFrame({ type: "text.delta", text: event.event.delta });
				if (event.event?.type === "error") pushFrame(errorFrame(event.event.error, event.event.reason === "aborted"));
			});
			subscribe("tool_start", (event) => {
				if (toolStarted.has(event.toolCallId)) return;
				toolStarted.add(event.toolCallId);
				toolStartedAt.set(event.toolCallId, clock());
				const activeTools = state.lastInput?.tools || tools;
				const tool = (Array.isArray(activeTools) ? activeTools : []).find((candidate) => candidate.name === event.toolName);
				pushFrame({ type: "tool.start", callId: event.toolCallId, name: event.toolName, label: tool?.label || event.toolName.replaceAll("_", " "), args: summariseCanvasResult(event.args) });
			});
			subscribe("tool_end", (event) => {
				if (toolCompleted.has(event.toolCallId)) return;
				if (!toolStarted.has(event.toolCallId)) {
					toolStarted.add(event.toolCallId);
					toolStartedAt.set(event.toolCallId, clock());
					const activeTools = state.lastInput?.tools || tools;
					const tool = (Array.isArray(activeTools) ? activeTools : []).find((candidate) => candidate.name === event.toolName);
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
			// Auth failures on openai-codex get exactly one retry: force pi's own
			// `Models.getAuth` refresh (the only exposed credential-store refresh
			// path — `minOAuthValidityMs` set past any real token lifetime makes any
			// stored token look expired) and resend the same turn once. Mirrors the
			// old codex-client.mjs retryAuth: one refresh, one retry, no more.
			const retryAfterAuthRefresh = async () => {
				try { await state.registry?.getAuth?.("openai-codex", { minOAuthValidityMs: Number.MAX_SAFE_INTEGER }); } catch { /* the retried call surfaces any refresh failure itself */ }
				try {
					await state.active.resend();
				} catch (error) {
					if (!queue.closed) { queue.push(errorFrame(error, input.signal?.aborted)); queue.push({ type: "done" }); queue.close(); }
				}
			};
			subscribe("run_end", (event) => {
				if (state.active?.pendingFrames.length) { for (const pending of state.active.pendingFrames) queue.push(pending); state.active.pendingFrames = []; }
				if (event.status !== "completed") {
					const rawMessage = event.error?.message || (event.status === "aborted" ? "The turn was aborted." : "The model or live editor could not complete this turn.");
					const truncated = /ended before a terminal response event/i.test(rawMessage);
					const classified = event.status === "aborted" ? { code: "aborted", status: undefined } : classifyError(event.error || {});
					if (event.status !== "aborted" && !truncated && state.provider === "openai-codex" && classified.code === "unauthorized" && !state.active?.authRetried) {
						if (state.active) { state.active.authRetried = true; state.active.authRetryPromise = retryAfterAuthRefresh(); }
						return;
					}
					const code = event.status === "aborted" ? "aborted" : truncated ? "truncated" : classified.code;
					const status = classified.status;
					const detail = sanitizeUpstreamDetail(JSON.stringify({ message: rawMessage }));
					const fallback = code === "aborted" ? "The turn was aborted." : code === "truncated" ? "The model stream ended before a terminal response event." : "The model or live editor could not complete this turn.";
					queue.push({ type: "error", code, message: detail || fallback, ...(status ? { status } : {}) });
				}
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
			state.active = { queue, quotaSent: false, pendingFrames: [], authRetried: false, abortRequested: false, resend: async () => {} };
			state.lastInput = input;
			const controller = input.signal ? null : new AbortController();
			const signal = input.signal || controller.signal;
			state.lastInput.signal = signal;
			const run = (async () => {
				let removeEventListeners;
				try {
					await ensureHarness(input);
					removeEventListeners = mapEvents(queue, input);
					// The turn is composed ONCE (an attached frame is captured once, its
					// tool card emitted once) and then delivered; a 401 retry replays this
					// same composition after rewinding the lane, so the transcript keeps
					// exactly one copy of the user turn with its attachments.
					let composed;
					if (input.surface === "studio") {
						const studioContext = typeof input.studioContextText === "string" ? input.studioContextText : `<studio-context>\n${input.contextText || ""}\n</studio-context>`;
						const attachments = Array.isArray(input.attachments) ? input.attachments : [];
						const images = attachments.map((attachment) => dataUrlImage(attachment?.dataUrl)).filter(Boolean);
						const attachmentLabels = attachments.map((attachment, index) => `User attachment ${attachment?.name || index + 1}`).join("\n");
						if (input.frameObservation) {
							const observation = studioObservationMessage(input.frameObservation);
							composed = { appends: [studioUserMessage({ ...input, studioContextText: studioContext })], text: observation.content[0].text, images: [observation.content[1]] };
						} else {
							composed = { appends: [], text: `${attachmentLabels ? `${attachmentLabels}\n` : ""}${studioContext}\n${input.text || ""}`, images };
						}
					} else {
						let text = input.text || "";
						const activeTools = input.tools || tools;
						if (input.attachFrame && activeTools.internal?.capture) {
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
						composed = { appends: (Array.isArray(input.attachments) ? input.attachments : []).map(attachmentMessage), text, images: [] };
					}
					const deliver = async () => {
						for (const message of composed.appends) await state.lane.appendMessage(message, state.context);
						await state.lane.prompt(composed.text, composed.images, input.signal ? (await loadPi()).withAbortSignal(signal, state.context) : state.context);
					};
					// The failed turn's own messages are already committed to the lane, and
					// the harness has no "continue from this transcript" entry point for a
					// settled run (an empty prompt is refused as InvalidMessage, and a
					// settled operation has nothing to resume). Rewinding the branch to the
					// pre-turn tip and redelivering the identical turn is the one path that
					// resends the SAME user message instead of appending a duplicate.
					const tipBeforeTurn = (await state.lane.inspectExecution(state.context)).tipId;
					state.active.resend = async () => {
						await state.lane.navigateTree(tipBeforeTurn, undefined, state.context);
						const rewoundEntries = await state.lane.findEntries({ order: "oldestFirst" }, state.context);
						state.persisted = rewoundEntries.filter((entry) => entry.type === "message").length;
						await deliver();
					};
					await deliver();
				// The 401-on-openai-codex retry is fired from the `run_end` handler
				// (it needs the event to have settled first); wait for it here so the
				// `finally` below does not unsubscribe events mid-retry.
				if (state.active?.authRetryPromise) await state.active.authRetryPromise;
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
			abort: async (reason) => {
				// Set synchronously, before the (async) `lane.abort()` round-trip: any
				// `persist` that runs after this point — for the turn that is active
				// right now — must withhold its assistant message, whether or not the
				// underlying generation happens to finish before pi's cancellation
				// actually takes effect.
				if (state.active) state.active.abortRequested = true;
				if (state.lane) return state.lane.abort(state.context);
				return { ok: false, reason };
			},
			snapshot: async () => state.lane ? state.lane.inspectExecution(state.context) : null,
			close: async () => { for (const unsubscribe of state.unsubscribers.splice(0)) unsubscribe(); await state.harness?.close(state.context); await state.repo.close(state.context); },
		};
		state.public = publicSession;
		openSessions.set(sessionId, state);
		return publicSession;
	};

	return { openSession, close: async () => { for (const state of openSessions.values()) await state.public.close(); openSessions.clear(); } };
}
