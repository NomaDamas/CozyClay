// Fresh upload -> worker -> retarget/skin guard -> served motion integration.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { readNpz } from "../tools/kimodo/read-npz.mjs";
const [video, output] = process.argv.slice(2), out = resolve(output);
mkdirSync(out, { recursive: true });
const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = probe.address().port; await new Promise(r => probe.close(r));
const log = createWriteStream(join(out, "http.log"));
const child = fork("tools/ardy/bridge.mjs", ["--port", String(port)], { silent: true,
	env: { ...process.env, CCLAY_KIMODO_HOST: "yun@ubuntu-baremetal", CCLAY_EXTRACT_HOST: "yun@ubuntu-baremetal",
		CCLAY_EXTRACT_BACKEND: "gvhmr", CCLAY_EXTRACT_CMD: "", CCLAY_EXTRACT_STATIC_CAM: "1", CCLAY_GVHMR_WORKER: "1", CCLAY_GVHMR_TRAJECTORY: "1" } });
child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
try {
	await once(child, "message", { signal: AbortSignal.timeout(15000) });
	const began = performance.now();
	const response = await fetch(`http://127.0.0.1:${port}/ardy/extract`, { method: "POST", headers: { "Content-Type": "application/octet-stream" },
		body: readFileSync(video), signal: AbortSignal.timeout(5 * 60_000) });
	const events = (await response.text()).trim().split("\n").map(JSON.parse), done = events.at(-1);
	writeFileSync(join(out, "http-events.json"), JSON.stringify(events, null, 2));
	assert.equal(done.event, "done", JSON.stringify(done));
	const bytes = Buffer.from(await (await fetch(`http://127.0.0.1:${port}${done.motionUrl}`)).arrayBuffer());
	writeFileSync(join(out, "http.npz"), bytes);
	const actual = readNpz(join(out, "http.npz")), expected = readNpz(join(out, "after.npz"));
	assert.deepEqual(actual, expected, "fresh HTTP result must equal numerically and visually reviewed candidate");
	assert.equal(done.performance.trajectory.status, "corrected");
	assert.equal(done.performance.trajectory.floor.status, "verified");
	writeFileSync(join(out, "http-result.json"), JSON.stringify({ ...done, httpSeconds: (performance.now() - began) / 1000, exactReviewedCandidate: true }, null, 2));
	console.log(JSON.stringify({ status: "PASS", frames: done.frames, fps: done.fps, seconds: (performance.now() - began) / 1000,
		trajectory: done.performance.trajectory, exactReviewedCandidate: true }));
} finally {
	const closed = once(child, "close"); child.kill("SIGTERM"); await closed; log.end();
}
