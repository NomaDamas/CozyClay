#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const probe = String.raw`
import { EXTRACT_BACKEND, EXTRACT_BACKEND_SUPPORTED, handleExtract } from "./tools/ardy/extract.mjs";
const response = {
  status: 200,
  body: "",
  writeHead(status) { this.status = status; },
  end(body) { this.body += body ?? ""; },
};
if (!EXTRACT_BACKEND_SUPPORTED) await handleExtract({ headers: {} }, response, {});
console.log(JSON.stringify({ backend: EXTRACT_BACKEND, supported: EXTRACT_BACKEND_SUPPORTED, status: response.status, body: response.body }));
`;

function run(env) {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
		cwd: ROOT,
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim());
}

const defaultBackend = run({ CCLAY_EXTRACT_BACKEND: "", CCLAY_EXTRACT_CMD: "" });
assert.deepEqual(defaultBackend, { backend: "gvhmr", supported: true, status: 200, body: "" });

const alternateBackend = run({ CCLAY_EXTRACT_BACKEND: "sam", CCLAY_EXTRACT_CMD: "" });
assert.equal(alternateBackend.supported, false);
assert.equal(alternateBackend.status, 503);
assert.equal(JSON.parse(alternateBackend.body).reason, "extract-backend-unsupported");

const customCommand = run({ CCLAY_EXTRACT_BACKEND: "gvhmr", CCLAY_EXTRACT_CMD: "custom-runner" });
assert.equal(customCommand.supported, false);
assert.equal(customCommand.status, 503);
assert.equal(JSON.parse(customCommand.body).reason, "extract-backend-unsupported");

console.log("PASS GVHMR is the only extraction backend and invalid configurations return a named error");
