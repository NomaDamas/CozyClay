import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

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
console.log("workflow bridge health/disabled behavior: ok");
