// The provider call behind every model request of the agent runner (agent-runner.mjs). pi-agent-core 1.x's Agent does
// not retry a failed request (the removed AgentHarness did), so one request is retried here, in place:
//   - a transient failure, by pi-ai's own isRetryableAssistantError (429, 5xx, overload, dropped connections), up to
//     RETRY_POLICY.maxRetries times with pi-ai's backoff (1 s, 2 s, 4 s), or as long as the provider's message asks
//     ("retry after 8 s", "try again in 2.5s"), capped at RETRY_HINT_CAP_MS (#975: two quick retries lost turns to
//     overloads that cleared within ~10 s);
//   - an expired Codex sign-in (401), once per turn, after a forced credential refresh (refreshAuth, the runner's).
// An attempt is retried only while nothing of it reached the Agent: its events are held until its first content event,
// so the transcript and the panel only ever see the attempt that answered. A retried request carries the same context,
// so no failed assistant message is stored and no completed tool runs again.

const RETRY_POLICY = Object.freeze({ maxRetries: 3, baseDelayMs: 1000 });
const RETRY_HINT_CAP_MS = 20_000;
const RETRY_HINT = /(?:retry|try again)\D{0,12}?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?)\b/i;

/** The wait a failed message asks for, in ms (capped), or 0 when it names none. */
export function retryHintMs(message) {
	const match = RETRY_HINT.exec(String(message?.errorMessage ?? ""));
	if (!match) return 0;
	const ms = Number(match[1]) * (/^m/i.test(match[2]) ? 1 : 1000);
	return Number.isFinite(ms) && ms > 0 ? Math.min(ms, RETRY_HINT_CAP_MS) : 0;
}

const CONTENT_EVENT = /^(text|thinking|toolcall)_/;
const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) { resolve(); return; }
		const timer = setTimeout(done, ms);
		function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
		signal?.addEventListener("abort", done, { once: true });
	});
}

/** The thrown error's structure a string would lose: its own code, its cause's, or a fetch TypeError. Never the message. */
function structuredCode(error) {
	try {
		if (typeof error?.code === "string" && error.code) return error.code;
		if (typeof error?.cause?.code === "string" && error.cause.code) return error.cause.code;
		return error?.name === "TypeError" ? "TypeError" : undefined;
	} catch { return undefined; }
}

/** An assistant message for a request that never produced one (pi-ai throws when a request has no credential). */
function failedMessage(model, error, signal) {
	const errorCode = structuredCode(error);
	return {
		role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: EMPTY_USAGE,
		stopReason: signal?.aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		...(errorCode ? { errorCode } : {}),
		timestamp: Date.now(),
	};
}

/**
 * The Agent's streamFn. `ai` is @earendil-works/pi-ai, `models` the registry the request runs on. `refreshAuth(model,
 * message)` decides whether a failed attempt earns a credential refresh and one more try (it refreshes before answering
 * true); `onAttempt(message)` sees every attempt's final message, failed ones included.
 */
export function createRetryingStream({ ai, models, refreshAuth = async () => false, onAttempt = () => {} }) {
	return (model, context, options = {}) => {
		const { signal } = options;
		const out = ai.createAssistantMessageEventStream();
		const shouldRetry = async (message, retries) => {
			if (retries >= RETRY_POLICY.maxRetries || signal?.aborted) return false;
			if (ai.isRetryableAssistantError(message)) {
				await pause(Math.max(ai.retryDelayMs(RETRY_POLICY, retries + 1), retryHintMs(message)), signal);
				return !signal?.aborted;
			}
			return refreshAuth(model, message);
		};
		const finish = (message, held = []) => {
			for (const early of held) out.push(early);
			const failed = message.stopReason === "error" || message.stopReason === "aborted";
			out.push(failed ? { type: "error", reason: message.stopReason, error: message } : { type: "done", reason: message.stopReason, message });
			out.end();
		};
		void (async () => {
			for (let retries = 0; ; retries += 1) {
				// The Agent asks for the next request even after a cancelled tool: an aborted run makes no further model call.
				if (signal?.aborted) { finish(failedMessage(model, new Error("Request was aborted"), signal)); return; }
				const held = [];
				let forwarding = false;
				let message;
				try {
					const response = await models.streamSimple(model, context, options);
					for await (const event of response) {
						if (event.type === "done" || event.type === "error") break;
						if (forwarding) { out.push(event); continue; }
						held.push(event);
						if (CONTENT_EVENT.test(event.type)) { forwarding = true; for (const early of held.splice(0)) out.push(early); }
					}
					message = await response.result();
				} catch (error) {
					message = failedMessage(model, error, signal);
				}
				onAttempt(message);
				if (!forwarding && message.stopReason === "error" && await shouldRetry(message, retries)) continue;
				// An abort that landed during a backoff ends the request as aborted, like any other cancellation.
				finish(message.stopReason === "error" && signal?.aborted ? { ...message, stopReason: "aborted" } : message, held);
				return;
			}
		})();
		return out;
	};
}
