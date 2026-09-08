import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildH3LockedPrompt, comfyDimensionsForAspect, createVideoAdapters, H3_PRESERVATION_CONTRACT, hasH3SceneComposite, isH3Workflow } from "../bin/agent/video-adapters.mjs";
import { compareH3FrameStability, compareH3Plate, inspectH3Output } from "../bin/agent/h3-preservation.mjs";

assert.equal(buildH3LockedPrompt("walk").includes(H3_PRESERVATION_CONTRACT), true, "H3 prompts carry the immutable plate contract");
assert.equal(buildH3LockedPrompt(buildH3LockedPrompt("walk")), buildH3LockedPrompt("walk"), "H3 contract injection is idempotent");
assert.equal(isH3Workflow({ "1": { class_type: "MiniMaxH3ImageToVideo", inputs: {} } }), true, "H3 workflow detection recognizes the MiniMax node");
assert.equal(isH3Workflow({ "1": { class_type: "KSampler", inputs: {} } }), false, "non-H3 workflows are left untouched");
for (const aspect of ["2.39:1", "21:9", "12:7", "9:16", "1:1", "4:3"]) {
	const dimensions = comfyDimensionsForAspect(aspect);
	assert.equal(dimensions.width % 32, 0, `${aspect} width stays on H3 latent grid`);
	assert.equal(dimensions.height % 32, 0, `${aspect} height stays on H3 latent grid`);
}
const plate = new Uint8Array(4 * 4 * 3).fill(12);
const same = compareH3Plate(plate, plate, 4, 4);
assert.equal(same.p95Rgb, 0, "plate comparison accepts unchanged border pixels");
const changed = compareH3Plate(plate, new Uint8Array(4 * 4 * 3).fill(255), 4, 4);
assert.ok(changed.p95Rgb > 200, "plate comparison exposes a changed background");

// Camera alignment must use the perimeter, where the actor is expected to be
// absent. A moving foreground block should not look like a camera move, while
// a one-pixel translation across a textured plate must be measurable.
const sceneWidth = 32; const sceneHeight = 24;
const scene = new Uint8Array(sceneWidth * sceneHeight * 3);
for (let y = 0; y < sceneHeight; y += 1) for (let x = 0; x < sceneWidth; x += 1) {
	const i = (y * sceneWidth + x) * 3; scene[i] = (x * 17 + y * 3) % 251; scene[i + 1] = (x * 7 + y * 19) % 251; scene[i + 2] = (x * 13 + y * 11) % 251;
}
const actorOnly = scene.slice();
for (let y = 8; y < 16; y += 1) for (let x = 12; x < 20; x += 1) {
	const i = (y * sceneWidth + x) * 3; actorOnly[i] = 250; actorOnly[i + 1] = 30; actorOnly[i + 2] = 30;
}
const actorStability = compareH3FrameStability(scene, actorOnly, sceneWidth, sceneHeight);
assert.equal(actorStability.cameraDriftPx, 0, "foreground subject motion is excluded from camera-shift evidence");
const shifted = new Uint8Array(scene.length);
for (let y = 0; y < sceneHeight; y += 1) for (let x = 0; x < sceneWidth; x += 1) {
	const sourceX = Math.max(0, Math.min(sceneWidth - 1, x - 2));
	const source = (y * sceneWidth + sourceX) * 3; const target = (y * sceneWidth + x) * 3;
	shifted[target] = scene[source]; shifted[target + 1] = scene[source + 1]; shifted[target + 2] = scene[source + 2];
}
const shiftStability = compareH3FrameStability(scene, shifted, sceneWidth, sceneHeight);
assert.ok(shiftStability.cameraDriftPx > 0, "textured perimeter movement is reported as camera drift");
console.log("PASS H3 validator: perimeter-only camera evidence separates subject motion from plate translation");

const fixturePath = join(tmpdir(), `cozyclay-video-fixture-${process.pid}.mp4`);
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=2x2:r=2:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", fixturePath]);
const mp4Bytes = readFileSync(fixturePath);
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

// A long-lived agent process must pick up a newly saved Comfy graph instead of
// submitting the first graph it happened to read at startup.
writeFileSync(workflowPath, JSON.stringify({ ...workflow, "3": { ...workflow["3"], inputs: { ...workflow["3"].inputs, prompt: "stale replacement" } } }));
await comfy.generate({ prompt: "fresh graph prompt", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" });
const refreshedPromptCall = requests.filter((entry) => entry.path === "/prompt").at(-1);
assert.equal(refreshedPromptCall.body.prompt["3"].inputs.prompt, "fresh graph prompt", "adapter reloads a graph saved while the process is running");
console.log("PASS comfy adapter: saved graph changes are picked up per request");

const h3WorkflowPath = join(dir, "h3-workflow.json");
writeFileSync(h3WorkflowPath, JSON.stringify({
	"1": { class_type: "MiniMaxH3ImageToVideo", inputs: { first_frame: ["2", 0], prompt: "stale saved example sentence" } },
	"2": { class_type: "LoadImage", inputs: { image: "cozyclay-frame.png" } },
	"9": { class_type: "SAM3_VideoTrack", inputs: { prompt: "person" } },
	"8": { class_type: "VAEDecode", inputs: { samples: ["1", 0] } },
	"10": { class_type: "SAM3_TrackToMask", inputs: { track: ["9", 0] } },
	"6": { class_type: "ImageCompositeMasked", inputs: { destination: ["2", 0], source: ["8", 0], mask: ["10", 0] } },
	"7": { class_type: "SaveVideo", inputs: { video: ["6", 0] } },
}));
assert.equal(hasH3SceneComposite(JSON.parse(readFileSync(h3WorkflowPath, "utf8")), new Set(["7"])).pass, true, "H3 graph has an uploaded-plate compositor on the final output path");
assert.equal(hasH3SceneComposite(JSON.parse(readFileSync(h3WorkflowPath, "utf8")), new Set(["7", "1"])).pass, false, "every final video output must pass through the compositor");
const h3 = createVideoAdapters({ COZYCLAY_COMFY_URL: `http://127.0.0.1:${port}`, COZYCLAY_COMFY_WORKFLOW: h3WorkflowPath }).find((adapter) => adapter.id === "comfy");
await h3.generate({ prompt: "a person climbs onto the chair", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" });
const h3PromptCall = requests.filter((entry) => entry.path === "/prompt").at(-1);
assert.match(h3PromptCall.body.prompt["1"].inputs.prompt, /immutable scene plate/);
assert.match(h3PromptCall.body.prompt["1"].inputs.prompt, /locked camera/);
assert.equal(h3PromptCall.body.prompt["9"].inputs.prompt, "person", "H3 prompt replacement does not overwrite tracker prompts");
console.log("PASS H3 adapter: immutable background/camera contract and compositor are enforced");

const plainH3WorkflowPath = join(dir, "h3-plain-with-output.json");
writeFileSync(plainH3WorkflowPath, JSON.stringify({
	"1": { class_type: "MiniMaxH3ImageToVideo", inputs: { first_frame: ["2", 0], prompt: "stale" } },
	"2": { class_type: "LoadImage", inputs: { image: "cozyclay-frame.png" } },
	"7": { class_type: "SaveVideo", inputs: { video: ["1", 0] } },
}));
const plainH3 = createVideoAdapters({ COZYCLAY_COMFY_URL: `http://127.0.0.1:${port}`, COZYCLAY_COMFY_WORKFLOW: plainH3WorkflowPath }).find((adapter) => adapter.id === "comfy");
await assert.rejects(() => plainH3.generate({ prompt: "walk", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" }), /must composite the generated subject over the uploaded plate/);
console.log("PASS H3 adapter: graph without deterministic compositor is rejected before queue");

const genericMaskWorkflowPath = join(dir, "h3-generic-mask.json");
writeFileSync(genericMaskWorkflowPath, JSON.stringify({
	"1": { class_type: "MiniMaxH3ImageToVideo", inputs: { first_frame: ["2", 0], prompt: "stale" } },
	"2": { class_type: "LoadImage", inputs: { image: "cozyclay-frame.png" } },
	"6": { class_type: "ImageCompositeMasked", inputs: { destination: ["2", 0], source: ["1", 0], mask: ["5", 0] } },
	"5": { class_type: "SolidMask", inputs: { value: 1 } },
	"7": { class_type: "SaveVideo", inputs: { video: ["6", 0] } },
}));
const genericMask = createVideoAdapters({ COZYCLAY_COMFY_URL: `http://127.0.0.1:${port}`, COZYCLAY_COMFY_WORKFLOW: genericMaskWorkflowPath }).find((adapter) => adapter.id === "comfy");
await assert.rejects(() => genericMask.generate({ prompt: "walk", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" }), /must composite the generated subject over the uploaded plate/);
console.log("PASS H3 adapter: untracked generic mask is rejected");

// Exercise the fail-closed output guard with real ffmpeg-decoded frames. The
// tiny plate is black; replacing it with a red plate must be rejected.
const stableVideo = join(dir, "stable.mp4");
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=2x2:r=2:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", stableVideo]);
const stableCheck = await inspectH3Output({ imageDataUrl: png, videoBytes: readFileSync(stableVideo), expectedWidth: 1, expectedHeight: 1 });
assert.equal(stableCheck.pass, true, "H3 output guard accepts an unchanged plate");
const driftVideo = join(dir, "drift.mp4");
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=2x2:r=2:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", driftVideo]);
const driftCheck = await inspectH3Output({ imageDataUrl: png, videoBytes: readFileSync(driftVideo), expectedWidth: 1, expectedHeight: 1 });
assert.equal(driftCheck.pass, false, "H3 output guard rejects a changed plate");
console.log("PASS H3 output guard: decoded plate drift is fail-closed");

const unlockedWorkflowPath = join(dir, "h3-unlocked.json");
writeFileSync(unlockedWorkflowPath, JSON.stringify({ "1": { class_type: "MiniMaxH3ImageToVideo", inputs: { prompt: "stale" } } }));
const unlocked = createVideoAdapters({ COZYCLAY_COMFY_URL: `http://127.0.0.1:${port}`, COZYCLAY_COMFY_WORKFLOW: unlockedWorkflowPath }).find((adapter) => adapter.id === "comfy");
await assert.rejects(() => unlocked.generate({ prompt: "walk", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" }), /must connect the uploaded image/);
console.log("PASS H3 adapter: unlocked graph is rejected before queue");

const miswiredWorkflowPath = join(dir, "h3-miswired.json");
writeFileSync(miswiredWorkflowPath, JSON.stringify({
	"1": { class_type: "MiniMaxH3ImageToVideo", inputs: { first_frame: ["3", 0], prompt: "stale" } },
	"2": { class_type: "LoadImage", inputs: { image: "cozyclay-frame.png" } },
	"3": { class_type: "EmptyImage", inputs: { width: 1024, height: 576 } },
}));
const miswired = createVideoAdapters({ COZYCLAY_COMFY_URL: `http://127.0.0.1:${port}`, COZYCLAY_COMFY_WORKFLOW: miswiredWorkflowPath }).find((adapter) => adapter.id === "comfy");
await assert.rejects(() => miswired.generate({ prompt: "walk", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" }), /must connect the uploaded image/);
console.log("PASS H3 adapter: a first_frame link that bypasses LoadImage is rejected before upload");

const emptyImageWorkflowPath = join(dir, "h3-empty-loadimage.json");
writeFileSync(emptyImageWorkflowPath, JSON.stringify({
	"1": { class_type: "MiniMaxH3ImageToVideo", inputs: { first_frame: ["2", 0], prompt: "stale" } },
	"2": { class_type: "LoadImage", inputs: {} },
}));
const emptyImage = createVideoAdapters({ COZYCLAY_COMFY_URL: `http://127.0.0.1:${port}`, COZYCLAY_COMFY_WORKFLOW: emptyImageWorkflowPath }).find((adapter) => adapter.id === "comfy");
await assert.rejects(() => emptyImage.generate({ prompt: "walk", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" }), /must connect the uploaded image/);
console.log("PASS H3 adapter: a LoadImage node without an image input is rejected");

const branchedWorkflowPath = join(dir, "h3-branched-first-frame.json");
writeFileSync(branchedWorkflowPath, JSON.stringify({
	"1": { class_type: "MiniMaxH3ImageToVideo", inputs: { first_frame: ["2", 0], prompt: "stale" } },
	"2": { class_type: "ImageBatch", inputs: { dead: ["3", 0], valid: ["4", 0] } },
	"3": { class_type: "ImageScale", inputs: { image: ["5", 0] } },
	"4": { class_type: "ImageScale", inputs: { image: ["5", 0] } },
	"5": { class_type: "LoadImage", inputs: { image: "cozyclay-frame.png" } },
}));
const branched = createVideoAdapters({ COZYCLAY_COMFY_URL: `http://127.0.0.1:${port}`, COZYCLAY_COMFY_WORKFLOW: branchedWorkflowPath }).find((adapter) => adapter.id === "comfy");
await assert.rejects(() => branched.generate({ prompt: "walk", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" }), /final SaveVideo\/VideoCombine output/);
console.log("PASS H3 adapter: branched first_frame links retain the valid LoadImage path");

const noOutputWorkflowPath = join(dir, "h3-no-output.json");
writeFileSync(noOutputWorkflowPath, JSON.stringify({
	"1": { class_type: "MiniMaxH3ImageToVideo", inputs: { first_frame: ["2", 0], prompt: "stale" } },
	"2": { class_type: "LoadImage", inputs: { image: "cozyclay-frame.png" } },
}));
const noOutput = createVideoAdapters({ COZYCLAY_COMFY_URL: `http://127.0.0.1:${port}`, COZYCLAY_COMFY_WORKFLOW: noOutputWorkflowPath }).find((adapter) => adapter.id === "comfy");
await assert.rejects(() => noOutput.generate({ prompt: "walk", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" }), /final SaveVideo\/VideoCombine output/);
console.log("PASS H3 adapter: a graph without an explicit final video output is rejected");

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
