import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVideoAdapters } from "../bin/agent/video-adapters.mjs";

const mp4Bytes = Buffer.from("000000206674797069736f6d0000020069736f6d69736f3261766331", "hex");
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const requests = [];
let promptId = 0;

const server = createServer((req, res) => {
	const respond = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
	if (req.method === "POST" && req.url.startsWith("/upload/image")) {
		let body = Buffer.alloc(0);
		req.on("data", (chunk) => body = Buffer.concat([body, chunk]));
		req.on("end", () => { requests.push({ path: req.url, size: body.length, multipart: req.headers["content-type"]?.startsWith("multipart/form-data") }); respond(200, { name: "cozyclay-frame.png" }); });
		return;
	}
	if (req.method === "POST" && req.url === "/prompt") {
		let body = "";
		req.on("data", (chunk) => body += chunk);
		req.on("end", () => { promptId += 1; requests.push({ path: req.url, body: JSON.parse(body) }); respond(200, { prompt_id: `p${promptId}` }); });
		return;
	}
	const history = req.url.match(/^\/history\/(.+)$/);
	if (req.method === "GET" && history) {
		const count = requests.filter((entry) => entry.path === req.url).length + 1;
		requests.push({ path: req.url });
		respond(200, count < 2 ? {} : { [decodeURIComponent(history[1])]: { outputs: { "7": { videos: [{ filename: "cozyclay.mp4", subfolder: "video", type: "output" }] }, "8": { gifs: [{ filename: "cozyclay.mp4", subfolder: "video", type: "output" }] } } } });
		return;
	}
	if (req.method === "GET" && req.url.startsWith("/view?")) {
		requests.push({ path: req.url });
		res.writeHead(200, { "content-type": "video/mp4" }); res.end(mp4Bytes);
		return;
	}
	res.writeHead(404); res.end("not found");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const dir = mkdtempSync(join(tmpdir(), "cozyclay-video-"));
const workflow = { "3": { class_type: "KSampler", inputs: { seed: 7, steps: 1, prompt: "PROMPT", length: 5 } }, "4": { class_type: "LoadImage", inputs: { image: "cozyclay-frame.png" } }, "5": { class_type: "VideoCombine", inputs: { width: 1024, height: 576 } } };
const workflowPath = join(dir, "workflow.json");
writeFileSync(workflowPath, JSON.stringify(workflow));
const env = { COZYCLAY_COMFY_URL: `http://127.0.0.1:${port}`, COZYCLAY_COMFY_WORKFLOW: workflowPath };
const adapters = createVideoAdapters(env);
const comfy = adapters.find((adapter) => adapter.id === "comfy");
assert.ok(comfy.configured(), "comfy is configured with env");
assert.ok(!createVideoAdapters({}).find((adapter) => adapter.id === "comfy").configured(), "comfy reports unconfigured without env");
const result = await comfy.generate({ prompt: "a slow dolly forward", imageDataUrl: png, lastFrameDataUrl: png, durationSeconds: 5, aspect: "16:9", fps: 24 });
assert.equal(Buffer.from(result.mp4Base64, "base64").toString("hex"), mp4Bytes.toString("hex"), "the adapter returns the video bytes as mp4Base64");
assert.equal(result.width, 1024); assert.equal(result.height, 576); assert.equal(result.seconds, 5);
const promptCall = requests.find((entry) => entry.path === "/prompt");
assert.equal(promptCall.body.prompt["3"].inputs.prompt, "a slow dolly forward", "the motion prompt is substituted into PROMPT inputs");
assert.equal(promptCall.body.prompt["4"].inputs.image, "cozyclay-frame.png", "the uploaded filename lands on LoadImage");
assert.equal(promptCall.body.prompt["5"].inputs.width, 1024); assert.equal(promptCall.body.prompt["5"].inputs.height, 576);
assert.ok(requests.filter((entry) => entry.path.startsWith("/history/")).length >= 2, "history is polled until outputs appear");
const viewCall = requests.find((entry) => entry.path.startsWith("/view?"));
assert.match(viewCall.path, /filename=cozyclay\.mp4&subfolder=video&type=output/, "the video is fetched through /view");
const uploadCall = requests.find((entry) => entry.path.startsWith("/upload/image"));
assert.ok(uploadCall.multipart, "the first frame is uploaded as multipart");
console.log("PASS comfy adapter: upload, prompt substitution, polling, video fetch");

const falCalls = [];
globalThis.__origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	falCalls.push({ url, init });
	if (url.startsWith("https://queue.fal.run/") && init.method === "POST") return { ok: true, json: async () => ({ status_url: "https://queue.fal.run/status/1" }) };
	if (url === "https://queue.fal.run/status/1") return { ok: true, json: async () => ({ status: "COMPLETED", video: { url: "https://cdn.fal.run/video.mp4" } }) };
	if (url === "https://cdn.fal.run/video.mp4") return { ok: true, arrayBuffer: async () => mp4Bytes };
	return { ok: false, status: 404, json: async () => ({}) };
};
const fal = createVideoAdapters({ FAL_KEY: "key-123", FAL_MODEL: "fal-ai/kling-video/v2.1/standard/image-to-video" }).find((adapter) => adapter.id === "fal");
assert.ok(fal.configured(), "fal is configured with env");
const falResult = await fal.generate({ prompt: "orbit", imageDataUrl: png, durationSeconds: 5, aspect: "9:16", fps: 24 });
assert.equal(falResult.mp4Base64, mp4Bytes.toString("base64"));
assert.equal(falCalls[0].url, "https://queue.fal.run/fal-ai/kling-video/v2.1/standard/image-to-video", "the model from options.model is used");
assert.equal(falCalls[0].init.headers.authorization, "Key key-123");
assert.equal(JSON.parse(falCalls[0].init.body).aspect_ratio, "9:16");
globalThis.fetch = globalThis.__origFetch;
console.log("PASS fal adapter: queue submit, status polling, video fetch");
server.close();
