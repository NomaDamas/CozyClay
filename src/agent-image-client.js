// The sidecar's /agent/image request, shared by the Workflow (agent-client.js)
// and the Studio's Board panel Stylize, so the Studio can generate a picture
// without pulling the Workflow bundle in. Plain fetch, no React, no imports
// beyond the locale and the shot prompt.

import { ko } from "./locale.js";
import { buildShotPrompt } from "./shot-prompt.js";

const SIDECAR_ORIGIN = "";

export function sidecarUrl(path) {
	return `${SIDECAR_ORIGIN}${path}`;
}

/** One JSON request to the loopback sidecar. A refusal throws an Error whose
 * message is the sidecar's own (already sanitized) explanation, with `status`
 * and the structured error fields (`code`, ...) copied onto it. */
export async function sidecarRequest(fetchImpl, path, init) {
	const response = await fetchImpl(sidecarUrl(path), {
		headers: { "content-type": "application/json" },
		...init,
	});
	if (!response.ok) {
		let detail = null;
		try { detail = await response.clone().json(); } catch { /* preserve the status when the server did not send JSON */ }
		const message = typeof detail?.error === "string" ? detail.error : detail?.error?.message;
		const error = new Error(message || `${path} responded ${response.status}`);
		// Keep machine-readable verification evidence alongside the human message.
		// The Workflow node can show why an H3 take was rejected without exposing
		// or retaining the rejected video itself.
		error.status = response.status;
		if (detail?.error && typeof detail.error === "object") Object.assign(error, detail.error);
		if (detail?.preservation && typeof detail.preservation === "object") error.preservation = detail.preservation;
		throw error;
	}
	return response.json();
}

/** The /agent/image body. `references` are the scene's identity / environment
 * slots (#167), passed through untouched so the sidecar decides how they are
 * described to the model. */
export function agentImageBody({ prompt, imageDataUrl, referenceDataUrl, references, composition, quality = "auto" }) {
	return {
		prompt,
		imageDataUrl,
		...(referenceDataUrl ? { referenceDataUrl } : {}),
		...(Array.isArray(references) && references.length ? { references } : {}),
		...(composition ? { composition } : {}),
		quality,
	};
}

/** POST /agent/image; answers `{ dataUrl, width, height }`. */
export function requestAgentImage(payload, { fetchImpl = globalThis.fetch?.bind(globalThis), signal } = {}) {
	return sidecarRequest(fetchImpl, "/agent/image", { method: "POST", body: JSON.stringify(agentImageBody(payload)), signal });
}

// The clay-frame preamble the sidecar puts in front of a hand-framed picture
// (bin/agent/agent-routes.mjs FRAME_COMPOSITION_GUIDANCE). The browser cannot
// import the sidecar, so the words are carried here and a test keeps the two
// copies equal.
export const CLAY_FRAME_PREAMBLE = "Use the first image (a clay blocking frame) as the layout: keep its composition and camera angle, and keep the pose but make it look natural. Render it as:";

/** The request that stylizes one storyboard panel: the clay preamble, the
 * shot's labelled image prompt, then the panel's caption. */
export function panelStylizeRequest({ meta, caption, imageDataUrl }) {
	const line = typeof caption === "string" ? caption.trim() : "";
	const prompt = `${CLAY_FRAME_PREAMBLE}\n${buildShotPrompt(meta, { target: "image" })}${line ? `\n${line}` : ""}`;
	return { prompt, imageDataUrl, quality: "auto" };
}

/** What a failed Stylize tells the author: the route's explanation, with the
 * two refusals an author can act on worded for them. */
export function stylizeErrorMessage(error) {
	if (error?.code === "entitlement") return ko("This account cannot generate images.", "이 계정은 이미지를 생성할 수 없어요.");
	if (error?.status === 401 || error?.code === "auth") return ko("Sign in with ChatGPT in the Agent panel first.", "먼저 Agent 패널에서 ChatGPT로 로그인하세요.");
	const reason = error?.message || ko("unknown error", "알 수 없는 오류");
	return ko(`Stylize failed — ${reason}`, `스타일화 실패 — ${reason}`);
}

/** The generated PNG's bytes, refused past `maxBytes` with a reason. */
export function stylizedPngBytes(dataUrl, maxBytes) {
	const match = typeof dataUrl === "string" ? /^data:image\/png;base64,(.*)$/s.exec(dataUrl) : null;
	if (!match) throw new Error(ko("The image route did not return a PNG.", "이미지 경로가 PNG를 돌려주지 않았어요."));
	const binary = atob(match[1]);
	if (binary.length > maxBytes) {
		const mb = Math.round(maxBytes / (1024 * 1024));
		throw new Error(ko(`The stylized image is larger than ${mb} MB, so it was not added.`, `스타일화된 이미지가 ${mb} MB보다 커서 추가하지 않았어요.`));
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}
