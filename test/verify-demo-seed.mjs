#!/usr/bin/env node
// The hosted demo take seeds only a session that has never seen a healthy
// bridge. A transient failed probe after a healthy one must not load it onto
// the character.
import assert from "node:assert/strict";
import { demoSeedGate } from "../src/motion-readiness.js";

const healthy = { ok: true, backend: "local_kimodo" };
const failed = { ok: false, backend: "local_kimodo", host_configured: true };
const missing = { ok: false, backend: "none", host_configured: false };

assert.deepEqual(demoSeedGate(null), { bridgeSeenOk: false, seed: false }, "no probe yet: wait");
assert.deepEqual(demoSeedGate(missing), { bridgeSeenOk: false, seed: true }, "no bridge ever: seed the demo");
assert.deepEqual(demoSeedGate(healthy), { bridgeSeenOk: true, seed: false }, "a healthy probe latches and never seeds");

// Replay a session's probes through the latch, the way the App effect does.
function replay(probes) {
	let seenOk = false;
	return probes.map((health) => {
		const gate = demoSeedGate(health, seenOk);
		seenOk = gate.bridgeSeenOk;
		return gate.seed;
	});
}
assert.deepEqual(replay([null, healthy, failed]), [false, false, false], "healthy then failed: no demo seed");
assert.deepEqual(replay([healthy, failed, null, failed]), [false, false, false, false], "the latch survives later probes");
assert.deepEqual(replay([null, failed, healthy]), [false, true, false], "a first failed probe still seeds the hosted demo");

console.log("verify-demo-seed: all checks passed");
