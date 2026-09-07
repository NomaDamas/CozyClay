const COMFY_DEFAULT_WIDTH = 1024;
const COMFY_DEFAULT_HEIGHT = 576;
const MAX_INLINE_VIDEO = 24 * 1024 * 1024;

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

function replaceWorkflowInputs(value, prompt, imageName, width, height) {
	if (Array.isArray(value)) return value.map((item) => replaceWorkflowInputs(item, prompt, imageName, width, height));
	if (!value || typeof value !== "object") {
		if (typeof value !== "string") return value;
		if (/PROMPT|paste your/i.test(value)) return prompt;
		return value;
	}
	const output = {};
	for (const [key, item] of Object.entries(value)) {
		if (key === "image" && typeof item === "string" && /loadimage/i.test(String(value.class_type || ""))) output[key] = imageName;
		else if ((key === "length" || key === "width" || key === "height") && Number.isInteger(Number(item))) output[key] = key === "length" ? Number(item) : (key === "width" ? width : height);
		else output[key] = replaceWorkflowInputs(item, prompt, imageName, width, height);
	}
	return output;
}

function createComfy(env, fetchImpl) {
	const base = env.COZYCLAY_COMFY_URL?.replace(/\/$/, "");
	const workflowPath = env.COZYCLAY_COMFY_WORKFLOW;
	let workflow;
	return {
		id: "comfy", name: "ComfyUI",
		configured: () => Boolean(base && workflowPath),
		async generate({ prompt, imageDataUrl, durationSeconds, aspect, fps = 24, signal }) {
			if (!workflow) workflow = JSON.parse(await (await import("node:fs/promises")).readFile(workflowPath, "utf8"));
			const form = new FormData();
			form.append("image", dataUrlBlob(imageDataUrl), "cozyclay-frame.png");
			form.append("overwrite", "true");
			const uploaded = await fetchImpl(`${base}/upload/image`, { method: "POST", body: form, signal }).then(jsonResponse);
			const imageName = uploaded.name || uploaded.filename;
			if (!imageName) throw new Error("ComfyUI did not return an uploaded filename.");
			const width = aspect === "9:16" ? 576 : aspect === "1:1" ? 768 : 1024;
			const height = aspect === "9:16" ? 1024 : aspect === "1:1" ? 768 : 576;
			const promptGraph = replaceWorkflowInputs(workflow, prompt, imageName, width, height);
			const queued = await fetchImpl(`${base}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: promptGraph, client_id: `cozyclay-${Date.now()}` }), signal }).then(jsonResponse);
			if (!queued.prompt_id) throw new Error("ComfyUI did not return a prompt id.");
			const deadline = Date.now() + 15 * 60 * 1000;
			let history;
			while (Date.now() < deadline) {
				history = await fetchImpl(`${base}/history/${encodeURIComponent(queued.prompt_id)}`, { signal }).then(jsonResponse);
				const entry = history[queued.prompt_id] || history;
				if (entry?.outputs && Object.keys(entry.outputs).length) {
					for (const node of Object.values(entry.outputs)) for (const output of Object.values(node || {})) {
						const files = Array.isArray(output) ? output : [output];
						for (const file of files) if (file?.filename && /\.(mp4|webm|gif|mov)$/i.test(file.filename)) {
							const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
							const response = await fetchImpl(`${base}/view?${query}`, { signal });
							if (!response.ok) throw new Error(`ComfyUI video fetch failed (${response.status}).`);
							const bytes = Buffer.from(await response.arrayBuffer());
							const dimensions = findDimensions(entry, width, height);
							return { mp4Base64: bytes.length <= MAX_INLINE_VIDEO ? bytes.toString("base64") : undefined, url: bytes.length > MAX_INLINE_VIDEO ? `${base}/view?${query}` : undefined, width: dimensions.width, height: dimensions.height, seconds: dimensions.seconds ?? durationSeconds };
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
