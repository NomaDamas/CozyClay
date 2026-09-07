import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";

const mp4Bytes = Buffer.from("000000206674797069736f6d0000020069736f6d69736f3261766331", "hex");
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
let promptId = 0;
let historyPolls = 0;

const comfy = createServer((req, res) => {
	const respond = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
	if (req.method === "POST" && req.url.startsWith("/upload/image")) { let body = Buffer.alloc(0); req.on("data", (chunk) => body = Buffer.concat([body, chunk])); req.on("end", () => respond(200, { name: "cozyclay-frame.png" })); return; }
	if (req.method === "POST" && req.url === "/prompt") { promptId += 1; respond(200, { prompt_id: `p${promptId}` }); return; }
	if (req.method === "GET" && req.url.startsWith("/history/")) { historyPolls += 1; respond(200, historyPolls < 2 ? {} : { [req.url.split("/")[2]]: { outputs: { "7": { videos: [{ filename: "cozyclay.mp4", subfolder: "video", type: "output" }] } } } }); return; }
	if (req.method === "GET" && req.url.startsWith("/view?")) { res.writeHead(200, { "content-type": "video/mp4" }); res.end(mp4Bytes); return; }
	res.writeHead(404); res.end("not found");
});
comfy.listen(0, "127.0.0.1");
await once(comfy, "listening");
const dir = mkdtempSync(join(tmpdir(), "cozyclay-video-route-"));
writeFileSync(join(dir, "workflow.json"), JSON.stringify({ "1": { class_type: "LoadImage", inputs: { image: "cozyclay-frame.png" } } }));
process.env.COZYCLAY_COMFY_URL = `http://127.0.0.1:${comfy.address().port}`;
process.env.COZYCLAY_COMFY_WORKFLOW = join(dir, "workflow.json");

let server;
const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, liveHub: { command: async () => ({}) }, port: () => server.address().port });
server = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const post = (body) => fetch(`http://127.0.0.1:${port}/agent/video`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify(body) });

assert.equal((await post({})).status, 400, "empty request is rejected");
assert.equal((await post({ provider: "comfy", prompt: "", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" })).status, 400, "empty prompt is rejected");
assert.equal((await post({ provider: "comfy", prompt: "x", imageDataUrl: "https://example.com/a.png", durationSeconds: 5, aspect: "16:9" })).status, 400, "only data URLs are accepted");
assert.equal((await post({ provider: "comfy", prompt: "x", imageDataUrl: png, durationSeconds: 0, aspect: "16:9" })).status, 400, "duration below 1 is rejected");
assert.equal((await post({ provider: "comfy", prompt: "x", imageDataUrl: png, durationSeconds: 16, aspect: "16:9" })).status, 400, "duration above 15 is rejected");
assert.equal((await post({ provider: "fal", prompt: "x", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" })).status, 409, "unconfigured provider is 409");
assert.equal((await post({ provider: "bogus", prompt: "x", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" })).status, 409, "unknown provider is 409");
console.log("PASS /agent/video: 400 validation and 409 unconfigured provider");

const ok = await post({ provider: "comfy", prompt: "slow pan", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" });
assert.equal(ok.status, 200);
const body = await ok.json();
assert.ok(body.dataUrl.startsWith("data:video/mp4;base64,"), "200 returns a video data URL");
assert.equal(Buffer.from(body.dataUrl.split(",")[1], "base64").toString("hex"), mp4Bytes.toString("hex"));
assert.equal(body.width, 1024); assert.equal(body.height, 576); assert.equal(body.seconds, 5);
console.log("PASS /agent/video: 200 returns data:video/mp4");

const failing = createServer((req, res) => { res.writeHead(500); res.end("boom"); });
failing.listen(0, "127.0.0.1");
await once(failing, "listening");
process.env.COZYCLAY_COMFY_URL = `http://127.0.0.1:${failing.address().port}`;
const fail = await post({ provider: "comfy", prompt: "slow pan", imageDataUrl: png, durationSeconds: 5, aspect: "16:9" });
assert.equal(fail.status, 502, "adapter failure is 502");
const failBody = await fail.json();
assert.ok(typeof failBody.error === "string");
console.log("PASS /agent/video: 502 on adapter failure");

const providers = await fetch(`http://127.0.0.1:${port}/agent/video/providers`, { headers: { origin: `http://127.0.0.1:${port}` } });
assert.equal(providers.status, 200);
const list = await providers.json();
assert.equal(list.providers.find((entry) => entry.id === "comfy").configured, true);
assert.equal(list.providers.find((entry) => entry.id === "fal").configured, false);
console.log("PASS /agent/video/providers: configured flags");

process.env.COZYCLAY_COMFY_URL = `http://127.0.0.1:${comfy.address().port}`;
failing.close();
server.close();
comfy.close();
