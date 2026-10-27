// The closed `agent:turn_failed.failure_code` vocabulary, sidecar side. Kept
// self-contained (minimal sidecar installs omit src/); it gives the same answers
// as src/workflow/agent-failure-codes.js, whose header defines each code, and
// test/verify-agent-execution.mjs holds the two tables to that. Only the
// error's name, structured code and HTTP status are read, never a message.
//   upstream  HTTP 5xx, or the runner's overloaded/upstream/truncated (and server_error)
//   network   no HTTP answer: a fetch TypeError or a socket code (ECONNRESET,
//             ENOTFOUND, ...) on the error or its `cause`
//   unknown   anything else, including an error whose fields throw
// Rows before the network/unknown split carry `upstream` for all three.
const BY_CODE = {
	unauthorized: "key_refused", auth: "auth", AUTH_REQUIRED: "auth", rate_limit: "rate_limited", RATE_LIMITED: "rate_limited",
	STALE_SCENE: "stale_scene", STALE_TARGET: "stale_scene", STALE_ENVIRONMENT: "stale_scene",
	CAPABILITY_MISSING: "capability_missing", LIVE_HUB_UNAVAILABLE: "capability_missing",
	busy: "busy", TARGET_BUSY: "busy", SCOPE_BUSY: "busy", TARGET_NOT_READY: "busy",
	overloaded: "upstream", upstream: "upstream", truncated: "upstream", server_error: "upstream",
};
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE",
	"ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const codeOf = (value) => (typeof value?.code === "string" ? value.code : "");

/** `{ name, code, status }` (a thrown error or a runner `error` frame) -> failure code. */
export function failureCodeOf(error) {
	try {
		const code = codeOf(error);
		const status = error?.status;
		if (Object.hasOwn(BY_CODE, code)) return BY_CODE[code];
		if (code.startsWith("INVALID_")) return "invalid_request";
		if (status === 401 || status === 403) return "auth";
		if (status === 429) return "rate_limited";
		if (Number.isInteger(status) && status >= 400 && status < 500) return "invalid_request";
		if (Number.isInteger(status) && status >= 500 && status < 600) return "upstream";
		if (Number.isInteger(status)) return "unknown";
		if (NETWORK_CODES.has(code) || NETWORK_CODES.has(codeOf(error?.cause)) || error?.name === "TypeError") return "network";
		return "unknown";
	} catch { return "unknown"; }
}

// After a tool failed, a turn that dies without a more specific code is the tool's failure.
const TOOL_FALLBACK = new Set(["upstream", "network", "unknown"]);

/** A turn that threw: an abort wins, then the error's own code, then a tool failure. */
export const agentFailureCode = (error, signal, tool = false) => {
	try { if (signal.aborted || error?.name === "AbortError") return "aborted"; } catch { /* foreign getter */ }
	const code = failureCodeOf(error);
	return tool && TOOL_FALLBACK.has(code) ? "tool_failed" : code;
};
