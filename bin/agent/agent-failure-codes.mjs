// The closed `agent:turn_failed.failure_code` vocabulary, sidecar side. Kept
// self-contained (minimal sidecar installs omit src/); it gives the same answers
// as src/workflow/agent-failure-codes.js, whose header defines each code, and
// test/verify-agent-execution.mjs holds the two tables to that. Only the
// structured code and HTTP status are read, never a message.
const BY_CODE = {
	unauthorized: "key_refused", auth: "auth", AUTH_REQUIRED: "auth", rate_limit: "rate_limited", RATE_LIMITED: "rate_limited",
	STALE_SCENE: "stale_scene", STALE_TARGET: "stale_scene", STALE_ENVIRONMENT: "stale_scene",
	CAPABILITY_MISSING: "capability_missing", LIVE_HUB_UNAVAILABLE: "capability_missing",
	busy: "busy", TARGET_BUSY: "busy", SCOPE_BUSY: "busy", TARGET_NOT_READY: "busy",
};

/** `{ code, status }` (a thrown error or a runner `error` frame) -> failure code.
 * The runner's `overloaded`/`upstream`/`truncated` and every 5xx read as upstream. */
export function failureCodeOf(error, fallback = "upstream") {
	try {
		const code = typeof error?.code === "string" ? error.code : "";
		const status = error?.status;
		if (Object.hasOwn(BY_CODE, code)) return BY_CODE[code];
		if (code.startsWith("INVALID_")) return "invalid_request";
		if (status === 401 || status === 403) return "auth";
		if (status === 429) return "rate_limited";
		return Number.isInteger(status) && status >= 400 && status < 500 ? "invalid_request" : fallback;
	} catch { return fallback; }
}

/** A turn that threw: an abort wins, then the error's own code, then a tool failure. */
export const agentFailureCode = (error, signal, tool = false) => {
	try { if (signal.aborted || error?.name === "AbortError") return "aborted"; } catch { /* foreign getter */ }
	return failureCodeOf(error, tool ? "tool_failed" : "upstream");
};
