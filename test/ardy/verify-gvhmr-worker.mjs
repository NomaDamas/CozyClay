import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { PersistentGvhmrWorker } from "../../tools/ardy/runners/gvhmr-worker.mjs";

const fake = `
const readline = require('node:readline');
console.log(JSON.stringify({event:'ready', protocol:1, pid:process.pid, startupSeconds:0.01, runnerSha256:'fixture'}));
let count = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
 const job = JSON.parse(line);
 if (job.mode === 'hang') return;
 if (job.mode === 'crash') return process.exit(2);
 if (job.mode === 'bad') return console.log('not-json');
 if (job.mode === 'error') return console.log(JSON.stringify({event:'error',id:job.id,message:'test-error'}));
 console.error('[cclay] stage track');
 setTimeout(() => console.log(JSON.stringify({event:'done', id:job.id, performance:{pid:process.pid,jobsInProcess:++count}})), 5);
}).on('close', () => process.exit(0));
`;
const clients = [];
let starts = 0;
const make = (options = {}) => {
	const worker = new PersistentGvhmrWorker({
		start: () => { starts++; return spawn(process.execPath, ["-e", fake], { detached: true, stdio: ["pipe", "pipe", "pipe"] }); },
		...options,
	});
	clients.push(worker);
	return worker;
};
try {
	const worker = make();
	const logs = [];
	const first = await worker.run({}, { onLine: (line) => logs.push(line) });
	const second = await worker.run({});
	assert.equal(first.pid, second.pid);
	assert.equal(second.jobsInProcess, 2);
	assert.equal(second.workerStartupSeconds, 0);
	assert.equal(first.runnerSha256, "fixture");
	assert.ok(logs.some((line) => line.includes("stage track")));
	const abort = new AbortController();
	const hanging = worker.run({ mode: "hang" }, { signal: abort.signal });
	const rejected = assert.rejects(hanging, /extract-cancelled/);
	await assert.rejects(worker.run({}), /extract-worker-busy/);
	abort.abort();
	await rejected;
	const restarted = await worker.run({});
	assert.notEqual(first.pid, restarted.pid);
	assert.equal(restarted.jobsInProcess, 1);
	for (const [mode, message] of [["crash", /exited/], ["bad", /protocol/], ["error", /test-error/]]) {
		await assert.rejects(worker.run({ mode }), message);
		assert.equal((await worker.run({})).jobsInProcess, 1);
	}
	await assert.rejects(worker.run({ mode: "hang" }, { timeoutMs: 30 }), /extract-timeout/);
	assert.equal(worker.child, null);
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(worker.run({}, { signal: cancelled.signal }), /extract-cancelled/);
	let release;
	const pending = make({ prepare: () => new Promise((resolve) => { release = resolve; }) });
	const abortPreparing = new AbortController();
	const preparation = pending.run({}, { signal: abortPreparing.signal });
	const preparationRejected = assert.rejects(preparation, /extract-cancelled/);
	const before = starts;
	abortPreparing.abort();
	await preparationRejected;
	release();
	await delay(10);
	assert.equal(starts, before, "cancelled deployment must not spawn a worker later");
	const idle = make({ idleMs: 20 });
	await idle.run({});
	await delay(50);
	assert.equal(idle.child, null, "idle worker must release CPU models");
	console.log("PASS GVHMR worker reuse, isolation, busy, crash, protocol, cancellation, timeout, idle shutdown");
} finally {
	for (const client of clients) client.stop();
}
