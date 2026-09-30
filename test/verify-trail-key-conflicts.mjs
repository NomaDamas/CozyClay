#!/usr/bin/env node
import assert from "node:assert/strict";
import { findAbsoluteIkKeyConflicts } from "../src/trail-key-conflicts.js";

const keys = new Map([
	[8, new Map([["rightHand", { q: ["absolute"] }]])],
	[10, new Map([["rightHand", { q: ["delta"], baseQ: ["clip"] }]])],
	[12, new Map([["RightHand", { q: ["absolute-chain"] }]])],
	[20, new Map([["rightHand", { q: ["outside"] }]])],
]);

assert.deepEqual(
	findAbsoluteIkKeyConflicts({ keys, track: "rightHand", startFrame: 9, endFrame: 20 }),
	[12],
	"only in-range absolute keys for the effector chain conflict",
);
assert.deepEqual(
	findAbsoluteIkKeyConflicts({ keys, track: "rightHand", startFrame: 8, endFrame: 13 }),
	[8, 12],
	"direct and effector-name chain keys are reported in frame order",
);
assert.deepEqual(
	findAbsoluteIkKeyConflicts({ keys, track: "rightHand", startFrame: 0, endFrame: 30 }),
	[8, 12, 20],
	"delta keys with baseQ do not conflict",
);
assert.deepEqual(
	findAbsoluteIkKeyConflicts({ keys, track: { id: "rightHand", chain: "rightHand" }, startFrame: 0, endFrame: 30 }),
	[8, 12, 20],
	"track descriptors resolve their chain id",
);

console.log("all trail key conflict checks passed");
