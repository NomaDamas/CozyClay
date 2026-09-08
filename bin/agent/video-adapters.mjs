import { inspectH3Output } from "./h3-preservation.mjs";

const COMFY_DEFAULT_WIDTH = 1024;
const COMFY_DEFAULT_HEIGHT = 576;
const MAX_INLINE_VIDEO = 24 * 1024 * 1024;

export function comfyDimensionsForAspect(aspect) {
	if (aspect === "9:16") return { width: 576, height: 1024 };
	if (aspect === "1:1") return { width: 768, height: 768 };
	// H3's latent canvas is quantized to 32-pixel axes; 1024x598 is not a
	// valid canvas and makes MiniMaxH3ImageToVideo reject the graph.  1312x768
	// is the nearest valid 12:7 canvas under H3's 768-short-edge pixel cap.
	if (aspect === "12:7") return { width: 1312, height: 768 };
	// Keep every axis on H3's 32-pixel latent grid. These are the closest
	// representable canvases to the requested cinematic ratios.
	if (aspect === "2.39:1") return { width: 1152, height: 480 };
	if (aspect === "21:9") return { width: 1120, height: 480 };
	if (aspect === "4:3") return { width: 768, height: 576 };
	return { width: COMFY_DEFAULT_WIDTH, height: COMFY_DEFAULT_HEIGHT };
}

// MiniMax H3 is conditioned on the uploaded first frame, but the model is
// still free to invent a new set or camera unless the contract is repeated in
// every request. Keep this wording positive and structural: mentioning things
// such as windows or curtains in a negative prompt has repeatedly caused H3 to
// hallucinate those objects into the set.
export const H3_PRESERVATION_CONTRACT =
	"Treat the provided first image as an immutable scene plate for the entire video. Keep the exact background, floor, set geometry, lighting, horizon, lens, viewpoint, framing, and object positions unchanged from the first frame through the last frame. Animate only the foreground human subject. Use one continuous shot with a locked camera: no pan, tilt, orbit, dolly, zoom, crop, reframing, cut, transition, or time jump. Preserve all non-subject pixels and keep the subject's silhouette edges sharp.";

export function isH3Workflow(workflow) {
	let found = false;
	const walk = (value) => {
		if (found || !value || typeof value !== "object") return;
		if (typeof value.class_type === "string" && /minimax.?h3|h3.*video/i.test(value.class_type)) found = true;
		for (const [key, child] of Object.entries(value)) {
			if (key !== "prompt" && typeof child === "string" && /minimax.?h3|h3.*video/i.test(child)) found = true;
			else if (key !== "prompt") walk(child);
		}
	};
	walk(workflow);
	return found;
}

export function buildH3LockedPrompt(prompt) {
	const source = String(prompt ?? "").trim();
	if (!source) return H3_PRESERVATION_CONTRACT;
	if (source.includes("immutable scene plate for the entire video")) return source;
	return `${source}\n\n${H3_PRESERVATION_CONTRACT}`;
}

/** A Comfy API link is [node id, output index]. A truthy value in
 * `first_frame` is not enough: a stale graph can point H3 at an empty latent
 * or another generated image while a separate LoadImage node sits unused.
 * Follow the link back to the LoadImage node that the adapter will rewrite to
 * the uploaded clay frame. This makes the upload and the H3 condition one
 * connected path, like checking that a film reel is actually threaded through
 * the projector rather than merely present on the desk. */
function hasFirstFrameCondition(workflow) {
	if (!isH3Workflow(workflow)) return true;
	const nodes = workflow && typeof workflow === "object" ? workflow : {};
	const refId = (value) => Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
	const reachesLoadImage = (id, visiting = new Set()) => {
		if (!id || visiting.has(id)) return false;
		const node = nodes[id];
		if (!node || typeof node !== "object") return false;
		if (/loadimage/i.test(String(node.class_type || "")) && typeof node.inputs?.image === "string" && node.inputs.image.trim()) return true;
		visiting.add(id);
		return Object.values(node.inputs || {}).some((value) => reachesLoadImage(refId(value), visiting));
	};
	return Object.values(nodes).some((node) => {
		if (!node || typeof node !== "object" || !/minimax.?h3|h3.*video/i.test(String(node.class_type || ""))) return false;
		const value = (node.inputs || {}).first_frame ?? (node.inputs || {}).image;
		return reachesLoadImage(refId(value));
	});
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
	if (signal?.aborted) return reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
	const timer = setTimeout(resolve, ms);
	const abort = () => { clearTimeout(timer); reject(Object.assign(new Error("Aborted"), { name: "AbortError" })); };
	signal?.addEventListener("abort", abort, { once: true });
});

function jsonResponse(response) {
	if (!response.ok) throw new Error(`Video provider responded ${response.status}`);
	return response.json();
}

function dataUrlBlob(dataUrl) {
	const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl || "");
	if (!match) throw new Error("Image must be a base64 data URL.");
	return new Blob([Buffer.from(match[2], "base64")], { type: match[1] });
}

function findDimensions(value, fallbackWidth, fallbackHeight) {
	let width = fallbackWidth; let height = fallbackHeight; let seconds;
	const walk = (item) => {
		if (!item || typeof item !== "object") return;
		if (Number.isFinite(item.width)) width = Number(item.width);
		if (Number.isFinite(item.height)) height = Number(item.height);
		if (Number.isFinite(item.duration)) seconds = Number(item.duration);
		for (const child of Object.values(item)) if (child && typeof child === "object") walk(child);
	};
	walk(value);
	return { width, height, seconds };
}

function preferredVideoOutputNodes(workflow) {
	return new Set(Object.entries(workflow || {})
		.filter(([, node]) => /savevideo|videocombine|videooutput/i.test(String(node?.class_type || "")))
		.map(([id]) => id));
}

function replaceWorkflowInputs(value, prompt, imageName, width, height, { h3Only = false, h3Context = false } = {}) {
	if (Array.isArray(value)) return value.map((item) => replaceWorkflowInputs(item, prompt, imageName, width, height, { h3Only, h3Context }));
	if (!value || typeof value !== "object") {
		if (typeof value !== "string") return value;
		if (/PROMPT|paste your/i.test(value)) return prompt;
		return value;
	}
	const output = {};
	const h3Node = /minimax.?h3|h3.*video/i.test(String(value.class_type || ""));
	// The prompt lives under the H3 node's `inputs` object in API exports. Carry
	// a narrow target flag into that child object, while leaving prompts on
	// unrelated SAM3/tracker nodes untouched.
	const targetH3Prompt = h3Context || h3Node;
	for (const [key, item] of Object.entries(value)) {
		if (key === "image" && typeof item === "string" && /loadimage/i.test(String(value.class_type || ""))) output[key] = imageName;
		// Workflow exports often contain a real example sentence rather than the
		// literal PROMPT marker. Replace every node prompt so the H3 preservation
		// contract cannot be bypassed by a stale saved sentence.
		else if (key === "prompt" && typeof item === "string" && (!h3Only || targetH3Prompt)) output[key] = prompt;
		else if ((key === "length" || key === "width" || key === "height") && Number.isInteger(Number(item))) output[key] = key === "length" ? Number(item) : (key === "width" ? width : height);
		else output[key] = replaceWorkflowInputs(item, prompt, imageName, width, height, { h3Only, h3Context: targetH3Prompt });
	}
	return output;
}

function createComfy(env, fetchImpl) {
	const base = env.COZYCLAY_COMFY_URL?.replace(/\/$/, "");
	const workflowPath = env.COZYCLAY_COMFY_WORKFLOW;
	return {
		id: "comfy", name: "ComfyUI",
		configured: () => Boolean(base && workflowPath),
		async generate({ prompt, imageDataUrl, durationSeconds, aspect, fps = 24, signal }) {
			// Read the graph for every request. Comfy users commonly save a new
			// H3 graph (for example, after adding the compositor lock) while this
			// server stays alive; caching would silently keep submitting the old
			// topology and bypass the current first-frame/output contract.
			const workflow = JSON.parse(await (await import("node:fs/promises")).readFile(workflowPath, "utf8"));
			const h3 = isH3Workflow(workflow);
			const preferredOutputs = h3 ? preferredVideoOutputNodes(workflow) : new Set();
			if (h3 && !hasFirstFrameCondition(workflow)) {
				throw new Error("H3 workflow must connect the uploaded image to the first_frame input; refusing an unlocked camera/background run.");
			}
			if (h3 && !preferredOutputs.size) {
				throw new Error("H3 workflow must expose a final SaveVideo/VideoCombine output; refusing an unverified camera/background run.");
			}
			const form = new FormData();
			form.append("image", dataUrlBlob(imageDataUrl), "cozyclay-frame.png");
			form.append("overwrite", "true");
			const uploaded = await fetchImpl(`${base}/upload/image`, { method: "POST", body: form, signal }).then(jsonResponse);
			const imageName = uploaded.name || uploaded.filename;
			if (!imageName) throw new Error("ComfyUI did not return an uploaded filename.");
			const { width, height } = comfyDimensionsForAspect(aspect);
			const promptGraph = replaceWorkflowInputs(workflow, h3 ? buildH3LockedPrompt(prompt) : prompt, imageName, width, height, { h3Only: h3, h3Context: false });
			const queued = await fetchImpl(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: promptGraph, client_id: `cozyclay-${Date.now()}` }), signal }).then(jsonResponse);
			if (!queued.prompt_id) throw new Error("ComfyUI did not return a prompt id.");
			const deadline = Date.now() + 15 * 60 * 1000;
			let history;
			while (Date.now() < deadline) {
				history = await fetchImpl(`${base}/history/${encodeURIComponent(queued.prompt_id)}`, { signal }).then(jsonResponse);
				const entry = history[queued.prompt_id] || history;
				if (entry?.outputs && Object.keys(entry.outputs).length) {
					for (const [nodeId, node] of Object.entries(entry.outputs)) {
						if (preferredOutputs.size && !preferredOutputs.has(String(nodeId))) continue;
						for (const output of Object.values(node || {})) {
						const files = Array.isArray(output) ? output : [output];
						for (const file of files) if (file?.filename && /\.(mp4|webm|gif|mov)$/i.test(file.filename)) {
							const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
							const response = await fetchImpl(`${base}/view?${query}`, { signal });
							if (!response.ok) throw new Error(`ComfyUI video fetch failed (${response.status}).`);
							const bytes = Buffer.from(await response.arrayBuffer());
							const dimensions = findDimensions(entry, width, height);
							let preservation;
							if (h3) {
								preservation = await inspectH3Output({ imageDataUrl, videoBytes: bytes, expectedWidth: width, expectedHeight: height });
								if (!preservation.pass) {
									const { worst } = preservation;
									throw Object.assign(new Error(`H3 preservation failed: background/camera drift p95=${worst.p95Rgb.toFixed(1)} RGB, mean=${worst.meanRgb.toFixed(1)} RGB.`), { code: "h3-preservation-failed", preservation });
								}
							}
							return { mp4Base64: bytes.length <= MAX_INLINE_VIDEO ? bytes.toString("base64") : undefined, url: bytes.length > MAX_INLINE_VIDEO ? `${base}/view?${query}` : undefined, width: dimensions.width, height: dimensions.height, seconds: dimensions.seconds ?? durationSeconds, ...(preservation ? { preservation } : {}) };
						}
						}
					}
				}
				await sleep(2000, signal);
			}
			throw new Error("ComfyUI video generation timed out.");
		},
	};
}

function createFal(env, fetchImpl) {
	const model = env.FAL_MODEL || "fal-ai/bytedance/seedance/v1/pro/image-to-video";
	return {
		id: "fal", name: "Fal.ai",
		configured: () => Boolean(env.FAL_KEY),
		async generate({ prompt, imageDataUrl, durationSeconds, aspect, signal }) {
			const queued = await fetchImpl(`https://queue.fal.run/${model}`, { method: "POST", headers: { authorization: `Key ${env.FAL_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ prompt, image_url: imageDataUrl, duration: String(durationSeconds), aspect_ratio: aspect }), signal }).then(jsonResponse);
			let status = queued;
			const deadline = Date.now() + 15 * 60 * 1000;
			while (Date.now() < deadline) {
				if (status.video?.url || status.output?.video?.url) break;
				if (status.status_url) status = await fetchImpl(status.status_url, { headers: { authorization: `Key ${env.FAL_KEY}` }, signal }).then(jsonResponse);
				else if (status.response_url) status = await fetchImpl(status.response_url, { headers: { authorization: `Key ${env.FAL_KEY}` }, signal }).then(jsonResponse);
				else if (status.status === "COMPLETED") break;
				if (status.status === "FAILED") throw new Error(status.error || "Fal.ai video generation failed.");
				if (!(status.video?.url || status.output?.video?.url)) await sleep(2000, signal);
			}
			const url = status.video?.url || status.output?.video?.url || status.video_url;
			if (!url) throw new Error("Fal.ai did not return a video URL.");
			const response = await fetchImpl(url, { signal });
			if (!response.ok) throw new Error(`Fal.ai video fetch failed (${response.status}).`);
			const bytes = Buffer.from(await response.arrayBuffer());
			return { mp4Base64: bytes.length <= MAX_INLINE_VIDEO ? bytes.toString("base64") : undefined, url: bytes.length > MAX_INLINE_VIDEO ? url : undefined, width: 1024, height: aspect === "9:16" ? 1792 : 576, seconds: durationSeconds };
		},
	};
}

export function createVideoAdapters(env = process.env) {
	const fetchImpl = globalThis.fetch;
	return [createComfy(env, fetchImpl), createFal(env, fetchImpl)];
}
