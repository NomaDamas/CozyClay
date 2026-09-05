import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";

const port = 5300 + Math.floor(Math.random() * 300);
const child = spawn(process.execPath, ["tools/workflow-bridge.mjs"], {
  env: { ...process.env, COZYCLAY_WORKFLOW_BRIDGE_PORT: String(port), COZYCLAY_MUAPI_KEY: "", COZYCLAY_MUAPI_URL: "http://127.0.0.1:9" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`workflow bridge did not start: ${output}`)), 5000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("[workflow-bridge] listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
  });
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), {
    ok: false,
    enabled: false,
    provider: "muapi",
    configured: { key: false, url: true },
  });

  const disabled = await fetch(`http://127.0.0.1:${port}/workflow/create`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).code, "muapi-key-missing");

  const nodeRun = await fetch(`http://127.0.0.1:${port}/workflow/cozyclay-scene/node/scene-1/run`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  assert.equal(nodeRun.status, 503);
  assert.equal((await nodeRun.json()).code, "muapi-key-missing");

  const missing = await fetch(`http://127.0.0.1:${port}/workflow/unknown`, { method: "POST" });
  assert.equal(missing.status, 404);
} finally {
  child.kill("SIGTERM");
  await once(child, "close").catch(() => {});
}

const requests = [];
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
  const body = JSON.stringify({ workflow_id: "mock-workflow" });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;
const proxyPort = 5600 + Math.floor(Math.random() * 200);
const enabledChild = spawn(process.execPath, ["tools/workflow-bridge.mjs"], {
  env: { ...process.env, COZYCLAY_WORKFLOW_BRIDGE_PORT: String(proxyPort), COZYCLAY_MUAPI_KEY: "test-key", COZYCLAY_MUAPI_URL: `http://127.0.0.1:${upstreamPort}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let enabledOutput = "";
enabledChild.stdout.on("data", (chunk) => { enabledOutput += chunk.toString(); });
enabledChild.stderr.on("data", (chunk) => { enabledOutput += chunk.toString(); });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`enabled workflow bridge did not start: ${enabledOutput}`)), 5000);
    enabledChild.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("[workflow-bridge] listening")) { clearTimeout(timer); resolve(); }
    });
    enabledChild.once("error", reject);
  });
  const body = { name: "bridge-contract" };
  const response = await fetch(`http://127.0.0.1:${proxyPort}/workflow/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).workflow_id, "mock-workflow");
  assert.equal(requests[0].headers["x-api-key"], "test-key");
  assert.deepEqual(JSON.parse(requests[0].body), body);
} finally {
  enabledChild.kill("SIGTERM");
  await once(enabledChild, "close").catch(() => {});
  await new Promise((resolve) => upstream.close(resolve));
}
console.log("workflow bridge health/disabled behavior: ok");
