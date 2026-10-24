// The closed `agent:turn_failed.failure_code` vocabulary, browser side. The
// sidecar keeps an identical table in bin/agent/agent-failure-codes.mjs (it
// cannot import src/); test/verify-agent-execution.mjs holds both to the same
// answers. Only the structured code and HTTP status are read, never a message.
//
//   key_refused         the model provider rejected the credentials (provider
//                       401/403, structured or message-only: runner `unauthorized`)
//   auth                the sidecar itself has no usable sign-in, or refused the
//                       session's ownership (AUTH_REQUIRED, `auth`, refusal 401/403)
//   rate_limited        provider or sidecar 429 (`rate_limit`, RATE_LIMITED)
//   stale_scene         the scene moved under the turn (STALE_SCENE/TARGET/ENVIRONMENT)
//   capability_missing  the sidecar cannot run this turn here (CAPABILITY_MISSING:
//                       Studio runtime absent, live hub port in use;
//                       LIVE_HUB_UNAVAILABLE: no connected editor)
//   busy                a turn is already running, or the target is busy
//   invalid_request     the sidecar rejected the request (400, INVALID_*, other 4xx)
//   upstream            provider outage, overload, 5xx, network or unclassified
//   aborted / tool_failed / unknown  are assigned by the turn, not by this table
export const AGENT_FAILURE_CODES = new Set(["aborted", "auth", "rate_limited", "tool_failed", "upstream", "unknown",
	"key_refused", "stale_scene", "capability_missing", "busy", "invalid_request"]);

const BY_CODE = {
	unauthorized: "key_refused", auth: "auth", AUTH_REQUIRED: "auth", rate_limit: "rate_limited", RATE_LIMITED: "rate_limited",
	STALE_SCENE: "stale_scene", STALE_TARGET: "stale_scene", STALE_ENVIRONMENT: "stale_scene",
	CAPABILITY_MISSING: "capability_missing", LIVE_HUB_UNAVAILABLE: "capability_missing",
	busy: "busy", TARGET_BUSY: "busy", SCOPE_BUSY: "busy", TARGET_NOT_READY: "busy",
};

/** `{ code, status }` -> failure code. Foreign getters fall back to upstream. */
export function transportFailureCode(error) {
	try {
		const code = typeof error?.code === "string" ? error.code : "";
		const status = error?.status;
		if (Object.hasOwn(BY_CODE, code)) return BY_CODE[code];
		if (code.startsWith("INVALID_")) return "invalid_request";
		if (status === 401 || status === 403) return "auth";
		if (status === 429) return "rate_limited";
		return Number.isInteger(status) && status >= 400 && status < 500 ? "invalid_request" : "upstream";
	} catch { return "upstream"; }
}

/** A refused turn: the sidecar's `{ error: { code } }` body plus the HTTP status. */
export async function refusalFailureCode(response) {
	let code;
	try { const body = await response.clone().json(); code = typeof body?.error?.code === "string" ? body.error.code : undefined; } catch { /* status alone */ }
	try { return transportFailureCode({ code, status: response?.status }); } catch { return "upstream"; }
}
