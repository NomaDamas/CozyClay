/**
 * Ask the embedded Studio for a shot's keyframe pack (#168).
 *
 * The Workflow page never builds a pack itself: the zip is assembled inside
 * the Scene node's <iframe>, where the rig, the timeline and the renderer
 * actually live. This module owns the postMessage handshake and nothing else,
 * so the request can be tested without a DOM: the caller injects the target
 * window and the listener pair.
 */

export const KEYFRAME_PACK_REQUEST = "cozyclay:export-keyframe-pack";
export const KEYFRAME_PACK_RESULT = "cozyclay:export-keyframe-pack-result";

/**
 * Post an export request to `iframeWindow` and resolve with that frame's reply.
 *
 * Resolves `{ name, bytes, entries }`, rejects on a `{ error }` reply or when
 * the pack takes longer than `timeoutMs` (packs encode a video clip, so the
 * default is generous). The message listener is removed on every path.
 */
export function requestKeyframePack(iframeWindow, {
	shotId = null,
	timeoutMs = 120000,
	addListener = typeof window === "undefined" ? null : window.addEventListener.bind(window),
	removeListener = typeof window === "undefined" ? null : window.removeEventListener.bind(window),
	setTimer = typeof setTimeout === "function" ? setTimeout : null,
	clearTimer = typeof clearTimeout === "function" ? clearTimeout : null,
} = {}) {
	return new Promise((resolve, reject) => {
		if (!iframeWindow || typeof iframeWindow.postMessage !== "function") {
			reject(new Error("Scene preview is unavailable."));
			return;
		}
		let timer = null;
		const finish = (error, value) => {
			removeListener?.("message", onMessage);
			if (timer !== null) clearTimer?.(timer);
			if (error) reject(error); else resolve(value);
		};
		const onMessage = (event) => {
			// Only this frame's reply counts: a Workflow page can hold several
			// Scene nodes, each with its own embedded Studio.
			if (event?.source !== iframeWindow || event?.data?.type !== KEYFRAME_PACK_RESULT) return;
			if (event.data.error) { finish(new Error(event.data.error)); return; }
			finish(null, { name: event.data.name, bytes: event.data.bytes, entries: Array.isArray(event.data.entries) ? event.data.entries : [] });
		};
		addListener?.("message", onMessage);
		if (timeoutMs > 0) timer = setTimer?.(() => finish(new Error("The keyframe pack timed out.")), timeoutMs) ?? null;
		iframeWindow.postMessage({ type: KEYFRAME_PACK_REQUEST, ...(shotId ? { shotId } : {}) }, "*");
	});
}

/** Save a pack the browser already holds in memory. */
export function downloadPack({ name, bytes }) {
	const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = name || "cozyclay-shot.zip";
	anchor.click();
	// Revoking synchronously can race the download in some browsers; one task
	// later is enough for the click to have been handed off.
	setTimeout(() => URL.revokeObjectURL(url), 0);
	return { name: anchor.download, url };
}
