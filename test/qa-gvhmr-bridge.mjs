// GPU integration QA: private bridge, original vs cold/warm worker, full
// upload -> extract -> retarget -> served NPZ equality. Not in CPU CI.
// node test/qa-gvhmr-bridge.mjs <local-video> <new-evidence-directory>
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { readNpz } from "../tools/kimodo/read-npz.mjs";

const [video, evidence] = process.argv.slice(2);
assert.ok(video && evidence, "provide video and evidence directory");
const directory = resolve(evidence);
mkdirSync(directory, { recursive: true });
const bytes = readFileSync(video);
const rows = [];
let reference;
for (const mode of ["reference", "fast"]) {
	const probe = createServer();
	probe.listen(0, "127.0.0.1");
	await once(probe, "listening");
	const port = probe.address().port;
	await new Promise((resolvePromise) => probe.close(resolvePromise));
	const log = createWriteStream(join(directory, `${mode}.log`));
	const child = fork("tools/ardy/bridge.mjs", ["--port", String(port)], {
		silent: true, env: { ...process.env, CCLAY_KIMODO_HOST: "yun@ubuntu-baremetal",
			CCLAY_EXTRACT_HOST: "yun@ubuntu-baremetal", CCLAY_EXTRACT_BACKEND: "gvhmr",
			CCLAY_EXTRACT_CMD: "", CCLAY_EXTRACT_STATIC_CAM: "1", CCLAY_GVHMR_TRAJECTORY: "0", CCLAY_GVHMR_WORKER: mode === "fast" ? "1" : "0" },
	});
	child.stdout.pipe(log, { end: false });
	child.stderr.pipe(log, { end: false });
	try {
		const [ready] = await once(child, "message", { signal: AbortSignal.timeout(15_000) });
		assert.equal(ready.type, "cozyclay-bridge-ready");
		for (let index = 0; index < (mode === "fast" ? 2 : 1); index++) {
			const started = performance.now();
			const response = await fetch(`http://127.0.0.1:${port}/ardy/extract`, {
				method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes,
				signal: AbortSignal.timeout(10 * 60_000),
			});
			const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
			const done = events.at(-1);
			assert.equal(done.event, "done", JSON.stringify(done));
			const motion = await fetch(`http://127.0.0.1:${port}${done.motionUrl}`);
			assert.equal(motion.status, 200);
			const path = join(directory, `${mode}-${index}.npz`);
			writeFileSync(path, Buffer.from(await motion.arrayBuffer()));
			const parsed = readNpz(path);
			if (mode === "reference") reference = parsed;
			else assert.deepEqual(parsed, reference, "all retargeted NPZ arrays must be exactly identical");
			const row = { mode, index, wallSeconds: (performance.now() - started) / 1000,
				frames: done.frames, fps: done.fps, exact: mode === "fast", performance: done.performance };
			rows.push(row);
			writeFileSync(join(directory, "metrics.json"), JSON.stringify(rows, null, 2));
			console.log(JSON.stringify(row));
		}
	} finally {
		const closed = once(child, "close");
		child.kill("SIGTERM");
		await closed;
		log.end();
	}
}
console.log("PASS original/cold/warm HTTP extraction and exact retargeted motion equality");
