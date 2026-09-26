import assert from "node:assert/strict";
import { motionReadiness, hasLineEditCapability } from "../src/motion-readiness.js";
import { checkBridge } from "../src/ardy/client.js";
import { createKimodoRunner } from "../tools/kimodo/runner.mjs";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const healthy = { ok: true, backend: "local_kimodo", host: "local", device: "local", capabilities: { lineEdit: true } };

assert.equal(motionReadiness(null), "loading");
assert.equal(motionReadiness({ ok: false, backend: "none", host_configured: false }), "not_configured");
assert.equal(motionReadiness({ ok: false, backend: "local_kimodo", host_configured: true }), "unavailable");
assert.equal(motionReadiness(healthy), "ready");
assert.equal(motionReadiness(healthy, { body: { lineEdit: {} } }), "ready");
assert.equal(motionReadiness({ ...healthy, capabilities: { lineEdit: false } }, { body: { lineEdit: {} } }), "unsupported_route");
assert.equal(motionReadiness(healthy, { body: { segments: [{}, {}] } }), "unsupported_route");
assert.equal(hasLineEditCapability(healthy), true);
assert.equal(hasLineEditCapability({ ...healthy, capabilities: ["lineEdit"] }), true);
assert.equal(hasLineEditCapability({ ok: true, features: ["lineEdit"] }), true);
assert.equal(hasLineEditCapability({ ...healthy, capabilities: { lineEdit: false } }), false);
assert.equal(hasLineEditCapability({ ok: false, capabilities: { lineEdit: true } }), false);
assert.equal(motionReadiness({ ...healthy, capabilities: { lineEdit: false } }, { lineEditSupported: true, body: { lineEdit: {} } }), "ready");

const originalFetch = globalThis.fetch;
try {
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, backend: "local_kimodo", host_configured: true, capabilities: { lineEdit: false }, reason: "configured probe failed" }) });
	assert.deepEqual(await checkBridge(), { ok: false, backend: "local_kimodo", host_configured: true, capabilities: { lineEdit: false }, reason: "configured probe failed" });
	globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ ok: false, backend: "local_kimodo", host_configured: true, capabilities: { lineEdit: false }, reason: "unreachable" }) });
	assert.deepEqual(await checkBridge(), { ok: false, backend: "local_kimodo", host_configured: true, capabilities: { lineEdit: false }, reason: "unreachable" });
	globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
	assert.deepEqual(await checkBridge(), { ok: false, reason: "invalid health response" });
} finally {
	globalThis.fetch = originalFetch;
}

const launcher = readFileSync(new URL("../bin/cozyclay.mjs", import.meta.url), "utf8");
const proxyStart = launcher.indexOf("function proxyToBridge(");
const proxySource = launcher.slice(proxyStart, launcher.indexOf("\n}\n", proxyStart) + 2);
for (const [motion, host, reason] of [[false, "fixture@host", "unconfigured"], [true, "", "unconfigured"], [true, "fixture@host", "unreachable"]]) {
	let response;
	const proxy = new Function("bridge", "bridgePort", `return ${proxySource}`)(null, null);
	proxy({ url: "/ardy/health", resume() {} }, {
		writeHead(status) { assert.equal(status, 503); },
		end(body) { response = JSON.parse(body); },
	}, motion && Boolean(host));
	assert.equal(response.reason, reason, "--no-motion overrides an inherited configured host");
	assert.equal(response.host_configured, reason === "unreachable");
}

const savedEnv = { ...process.env };
const artifactDir = mkdtempSync(join(tmpdir(), "cozyclay-motion-readiness-"));
try {
	delete process.env.CCLAY_KIMODO_HOST;
	process.env.CCLAY_KIMODO_BACKEND = "kimodo-mlx";
	process.env.HOME = artifactDir;
	const runtimePath = join(artifactDir, ".cozyclay", "kimodo-mlx-venv", "bin", "python");
	mkdirSync(join(artifactDir, ".cozyclay", "kimodo-mlx-venv", "bin"), { recursive: true });
	writeFileSync(runtimePath, "runtime");
	process.env.CCLAY_KIMODO_MLX_MOTION = join(artifactDir, "motion.bin");
	process.env.CCLAY_KIMODO_MLX_TEXT = join(artifactDir, "text.bin");
	const localRunner = createKimodoRunner();
	assert.equal((await localRunner.probeHealth()).ok, false, "installed local route is not ready without model artifacts");
	writeFileSync(process.env.CCLAY_KIMODO_MLX_MOTION, "motion");
	writeFileSync(process.env.CCLAY_KIMODO_MLX_TEXT, "text");
	assert.equal((await localRunner.probeHealth()).ok, true, "local route becomes ready with both artifacts");
	for (const key of Object.keys(process.env)) if (key.startsWith("CCLAY_KIMODO_")) delete process.env[key];
	for (const [backend, paths] of [
		["kimodo-mlx", [".cozyclay/kimodo-mlx-venv/bin/python", ".cozyclay/kimodo-mlx/models/nvidia-soma-rp-v1.1", ".cozyclay/kimodo-mlx/models/llm2vec-text-bundle"]],
		["kimodo.cpp-metal", [".cozyclay/kimodo.cpp/build-metal/kmd-generate", ".cozyclay/kimodo.cpp/models/kimodo-soma-rp-v1.1-f32.gguf", ".cozyclay/kimodo.cpp/generated/llm2vec-text-bundle"]],
		["kimodo.cpp-cpu", [".cozyclay/kimodo.cpp/build-cpu/kmd-generate", ".cozyclay/kimodo.cpp/models/kimodo-soma-rp-v1.1-f32.gguf", ".cozyclay/kimodo.cpp/generated/llm2vec-text-bundle"]],
	]) {
		process.env.CCLAY_KIMODO_BACKEND = backend;
		for (const relative of paths) {
			const path = join(artifactDir, relative);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "fixture");
		}
		assert.equal((await createKimodoRunner().probeHealth()).ok, true, `${backend}: generation's default artifacts are ready without overrides`);
		rmSync(join(artifactDir, paths[0]));
		assert.equal((await createKimodoRunner().probeHealth()).ok, false, `${backend}: missing runtime remains unavailable`);
	}
} finally {
	rmSync(artifactDir, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
}

console.log("PASS motion readiness states, structured bridge health, and local artifact boundary");
