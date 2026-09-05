/**
 * Browser-side client for the ARDY dev sidecar (tools/ardy/bridge.mjs).
 *
 * The sidecar is an OPTIONAL dev companion: it listens on 127.0.0.1:5181 and
 * Vite proxies /ardy to it during development only. The production build is
 * a static SPA with no server at all, so every function here treats a missing
 * sidecar as an expected state and reports it as data — never as a thrown
 * error — so the UI can degrade to a hint instead of crashing.
 */
import { ko, isKo } from "../locale.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

// Bounded wait so a hung proxy or a slow-but-alive bridge cannot wedge the
// panel behind a spinner forever. Long enough to not mislabel a healthy
// bridge that answers in a couple of seconds, short enough to keep the
// no-sidecar state snappy.
const PROBE_TIMEOUT_MS = 5000;

/**
 * Prefer the sidecar's {"reason": "..."} error body; fall back to `fallback`
 * when the body is not JSON (e.g. the dev proxy's own error page).
 */
async function reasonOf(res, fallback) {
	try {
		const payload = await res.json();
		if (payload && typeof payload.reason === "string" && payload.reason) return payload.reason;
	} catch {
		// non-JSON error body — keep the caller's fallback
	}
	return fallback;
}

/**
 * Probe the sidecar once. Resolves to { ok:true, host, encoder, device } on a
 * healthy 200, otherwise { ok:false, reason }. Never rejects: the most common
 * failure (no sidecar running) is a UI state, not a crash.
 */
export async function checkBridge() {
	try {
		const res = await fetch("/ardy/health", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		if (!res.ok) {
			return { ok: false, reason: await reasonOf(res, isKo ? `브리지 상태가 좋지 않아요(HTTP ${res.status})` : `bridge unhealthy (HTTP ${res.status})`) };
		}
		const payload = await res.json();
		return {
			ok: true,
			host: payload.host,
			encoder: payload.encoder,
			device: payload.device,
		};
	} catch (err) {
		return { ok: false, reason: err?.message || ko("bridge unreachable", "브리지에 연결할 수 없어요") };
	}
}

/**
 * List base motions the box reported. Returns [] when the sidecar is down —
 * the caller renders an empty state, it does not crash.
 */
export async function listBases() {
	try {
		const res = await fetch("/ardy/bases", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		if (!res.ok) return [];
		const payload = await res.json();
		return payload && Array.isArray(payload.bases) ? payload.bases : [];
	} catch {
		return [];
	}
}

/**
 * POST a generation and stream the ndjson answer.
 *
 * The response is read incrementally with a streaming reader and every parsed
 * line is handed to `onEvent(event)`. Lines may be split at any byte — text is
 * buffered until the trailing newline arrives, so a JSON object broken across
 * two chunks is still delivered as one event.
 *
 * Resolves with the terminal `done` event ({event, output, bytes}); rejects on
 * a terminal `error` event, a malformed line, a non-200 response, or an
 * aborted signal (the AbortError propagates so callers can tell cancellation
 * apart from failure). `signal` is optional.
 */
/** Fill between IK-keyed poses with the distilled inbetweener (dev sidecar
 * → box). Plain JSON round trip; resolves to { motionUrl, window, keys, fitErrCm, ms }. */
export async function inbetween(body, { signal } = {}) {
	const res = await fetch("/ardy/inbetween", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body), signal });
	if (!res.ok) throw new Error(await reasonOf(res, `inbetween failed (HTTP ${res.status})`));
	return res.json();
}

export async function generate(body, onEvent, { signal } = {}) {
	const res = await fetch("/ardy/generate", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) {
		throw new Error(await reasonOf(res, `generate failed (HTTP ${res.status})`));
	}
	if (!res.body) throw new Error(ko("generate: response has no body stream", "생성 응답에 본문 스트림이 없어요"));

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		// Drain complete lines only; a chunk may end mid-line, in which case
		// the remainder stays in the buffer until its newline arrives.
		let nl = buffer.indexOf("\n");
		while (nl !== -1) {
			const terminal = applyLine(buffer.slice(0, nl).trim());
			buffer = buffer.slice(nl + 1);
			if (terminal) return terminal;
			nl = buffer.indexOf("\n");
		}
	}
	// Flush the decoder so a multi-byte char split by the final chunk boundary
	// is complete, then treat a non-empty tail as one last line: the contract
	// does not promise a trailing newline on the terminal event.
	buffer += decoder.decode();
	if (buffer.trim()) {
		const terminal = applyLine(buffer.trim());
		if (terminal) return terminal;
	}
	throw new Error(ko("generate: stream ended without a done or error event", "완료 또는 오류 이벤트 없이 생성 스트림이 끝났어요"));

	/** Parse one ndjson line; returns the done event, throws on error/bad line. */
	function applyLine(line) {
		let event;
		try {
			event = JSON.parse(line);
		} catch (err) {
			throw new Error(`generate: bad ndjson line: ${err.message}`);
		}
		onEvent(event);
		if (event.event === "error") {
			throw new Error(
				typeof event.message === "string" && event.message ? event.message : "generate: generator reported an error",
			);
		}
		if (event.event === "done") return event;
		return null;
	}
}
