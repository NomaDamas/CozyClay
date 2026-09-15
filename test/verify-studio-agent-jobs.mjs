#!/usr/bin/env node
import assert from "node:assert/strict";
import { createMotionRuntime, extractNdjsonRecords } from "../bin/agent/motion-runtime.mjs";

const parsed = extractNdjsonRecords('{"event":"done"}', { final: true });
assert.deepEqual(parsed.records, [{ event: "done" }]);
assert.equal(parsed.remainder, "");
assert.throws(() => extractNdjsonRecords('{bad}', { final: true }), /Malformed final NDJSON/);

const calls = [];
const runtime = createMotionRuntime({ bridgeOrigin: "http://127.0.0.1:6271", authorize: async (value) => calls.push(value), maxJobs: 2 });
let committed = 0;
const job = runtime.create({ workspaceId: "tab-1", characterId: "char-a", token: "tok-1", run: async ({ bridgeOrigin, isCancelled }) => {
	assert.equal(bridgeOrigin, "http://127.0.0.1:6271"); assert.equal(isCancelled(), false);
	return { commit: async ({ characterId, token }) => ({ receiptId: `receipt-${++committed}`, characterId, token }) };
} });
await job.promise;
assert.equal(job.state, "completed");
assert.deepEqual(job.receipt, { receiptId: "receipt-1", characterId: "char-a", token: "tok-1" });
assert.equal(calls.length, 1);
let release;
const active = runtime.create({ workspaceId: "tab-1", characterId: "char-b", token: "tok-2", run: async () => new Promise((resolve) => { release = resolve; }) });
assert.throws(() => runtime.create({ workspaceId: "tab-1", characterId: "char-c", token: "tok-3", run: async () => ({ commit() {} }) }), /TARGET_BUSY|JOB_CAPACITY/);
await Promise.resolve(); runtime.cancel(active.id); release({ commit: async () => { throw new Error("must not commit"); } }); await active.promise; assert.equal(active.state, "cancelled");
console.log("PASS motion runtime: final NDJSON, dynamic bridge origin, single authorization, commit receipt, cancel fence and bounded registry");
