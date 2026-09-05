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

  // Exercise the route allowlist copied from Vibe's FastAPI router. These are
  // intentionally one request each: a 404 here means the UI would silently
  // lose that Vibe capability behind the loopback bridge.
  const routeCases = [
    ["GET", "/workflow/get-workflow-defs", "/workflow/get-workflow-defs"],
    ["GET", "/workflow/get-workflow-def/wf-1", "/workflow/get-workflow-def/wf-1"],
    ["GET", "/workflow/wf-1/node-schemas", "/workflow/wf-1/node-schemas"],
    ["GET", "/workflow/wf-1/api-node-schemas", "/workflow/wf-1/api-node-schemas"],
    ["DELETE", "/workflow/delete-workflow-def/wf-1", "/workflow/delete-workflow-def/wf-1"],
    ["POST", "/workflow/update-name/wf-1", "/workflow/update-name/wf-1"],
    ["POST", "/workflow/wf-1/run", "/workflow/wf-1/run"],
    ["GET", "/workflow/run/run-1/status", "/workflow/run/run-1/status"],
    ["POST", "/workflow/wf-1/node/node-1/run", "/workflow/wf-1/node/node-1/run"],
    ["POST", "/workflow/workflow/wf-1/publish", "/workflow/workflow/wf-1/publish"],
    ["POST", "/workflow/workflow/wf-1/template", "/workflow/workflow/wf-1/template"],
    ["POST", "/workflow/cloudfront-signed-url", "/workflow/cloudfront-signed-url"],
    ["POST", "/workflow/wf-1/thumbnail", "/workflow/wf-1/thumbnail"],
    ["GET", "/workflow/get-workflow-last-run/wf-1", "/workflow/get-workflow-last-run/wf-1"],
    ["POST", "/workflow/architect", "/workflow/architect"],
    ["GET", "/workflow/poll-architect/request-1/result", "/workflow/poll-architect/request-1/result"],
    ["DELETE", "/workflow/node-run/node-run-1", "/workflow/node-run/node-run-1"],
    ["POST", "/workflow/update-category/wf-1", "/workflow/update-category/wf-1"],
    ["GET", "/workflow/wf-1/api-inputs", "/workflow/wf-1/api-inputs"],
    ["POST", "/workflow/wf-1/api-execute", "/workflow/wf-1/api-execute"],
    ["GET", "/workflow/run/run-1/api-outputs", "/workflow/run/run-1/api-outputs"],
    ["POST", "/app/calculate_dynamic_cost", "/app/calculate_dynamic_cost"],
  ];
  for (const [method, path, expectedUpstream] of routeCases) {
    const routeResponse = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    });
    assert.equal(routeResponse.status, 200, `${method} ${path}`);
    const request = requests.at(-1);
    assert.equal(request.method, method, `${method} ${path} method`);
    assert.equal(request.url, expectedUpstream, `${method} ${path} upstream path`);
  }

  const bodyRun = await fetch(`http://127.0.0.1:${proxyPort}/workflow/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflow_id: "wf-body", cost: 0 }),
  });
  assert.equal(bodyRun.status, 200);
  assert.equal(requests.at(-1).url, "/workflow/wf-body/run");

  const upload = await fetch(`http://127.0.0.1:${proxyPort}/app/get_file_upload_url?filename=clip%20one.mp4`, { method: "GET" });
  assert.equal(upload.status, 200);
  assert.equal(requests.at(-1).url, "/app/get_file_upload_url?filename=clip%20one.mp4");

  const prefixed = await fetch(`http://127.0.0.1:${proxyPort}/workflow-api/workflow/wf-1/node-schemas`);
  assert.equal(prefixed.status, 200);
  assert.equal(requests.at(-1).url, "/workflow/wf-1/node-schemas");

  const originalVibePath = await fetch(`http://127.0.0.1:${proxyPort}/api/workflow/wf-1/node-schemas`);
  assert.equal(originalVibePath.status, 200);
  assert.equal(requests.at(-1).url, "/workflow/wf-1/node-schemas");
} finally {
  enabledChild.kill("SIGTERM");
  await once(enabledChild, "close").catch(() => {});
  await new Promise((resolve) => upstream.close(resolve));
}
console.log("workflow bridge health/disabled behavior: ok");
