import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { claimFingertip, pickFingertip } from "../src/motion/fingertip-pick.js";
import { exposureProbe } from "../src/motion/ik-exposure.js";

const tips = (...rows) => rows.map(([id, gap, reach = 10]) => ({ id, gap, reach }));
const pressEvent = () => {
	const calls = [];
	return { calls, stopImmediatePropagation: () => calls.push("immediate"), stopPropagation: () => calls.push("stop"), preventDefault: () => calls.push("default") };
};

test("a tip the body hides is skipped and the next visible tip in range is picked", () => {
	const hidden = new Set(["index"]);
	const picked = pickFingertip(tips(["middle", 6], ["index", 2], ["ring", 9], ["pinky", 30]), ({ id }) => !hidden.has(id));
	assert.equal(picked?.id, "middle");
});

test("no exposed tip in range: no pick, and the press is not swallowed", () => {
	const event = pressEvent();
	const picked = claimFingertip(event, tips(["index", 2], ["middle", 5], ["thumb", 40]), ({ id }) => id === "thumb");
	assert.equal(picked, null, "the exposed thumb is out of range, the in-range tips are hidden");
	assert.deepEqual(event.calls, [], "IkHandles still gets the press");
	assert.equal(claimFingertip(event, [], () => true), null);
	assert.deepEqual(event.calls, []);
});

test("exposed tips keep nearest-first order, and a pick claims the press", () => {
	const asked = [];
	const event = pressEvent();
	const picked = claimFingertip(event, tips(["ring", 8], ["thumb", 3], ["index", 5]), ({ id }) => { asked.push(id); return true; });
	assert.equal(picked.id, "thumb");
	assert.deepEqual(asked, ["thumb"], "the nearest exposed tip wins without probing the rest");
	assert.deepEqual(event.calls, ["immediate", "stop", "default"]);
	const order = [];
	pickFingertip(tips(["ring", 8], ["thumb", 3], ["index", 5]), ({ id }) => { order.push(id); return false; });
	assert.deepEqual(order, ["thumb", "index", "ring"]);
});

test("the exposure probe applies the IK controls' rule to the blockers of the last pass", () => {
	const camera = new THREE.PerspectiveCamera();
	camera.position.set(0, 0, 1);
	camera.updateMatrixWorld();
	const tip = new THREE.Vector3(0, 0, 0);
	const occluders = { current: null };
	const probe = exposureProbe(camera, occluders);
	assert.equal(probe(tip, 0.018), true, "before any exposure pass nothing is in front");
	const palm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.03), new THREE.MeshBasicMaterial());
	palm.position.set(0, 0, 0.05);
	palm.updateMatrixWorld();
	occluders.current = { blockers: [palm] };
	assert.equal(probe(tip, 0.018), false, "a palm 3.5 cm in front hides the tip");
	palm.position.set(0, 0, 0.002);
	palm.updateMatrixWorld();
	assert.equal(probe(tip, 0.018), true, "skin 1.7 cm over the tip centre is within the allowance");
	palm.position.set(0.2, 0, 0.05);
	palm.updateMatrixWorld();
	assert.equal(probe(tip, 0.018), true, "a blocker off the line of sight hides nothing");
});
