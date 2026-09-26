import assert from "node:assert/strict";
import * as THREE from "three";
import { resolveIkRig, ikEvaluate } from "../../src/ardy/ik.js";
import { SUPPORT_SITES, copyPhysicsKeys, physicsKeyStamp, supportIntervals, physicsMetrics, smoothPhysicsTrack, reviewAutoPhysics } from "../../src/ardy/physics-review.js";
import { relaxPhysicsRoot } from "../../src/ardy/physics-temporal.js";

function makeRig() {
	const rig = new THREE.Group(); rig.scale.setScalar(.01);
	const bone = (name, parent, x, y, z = 0) => { const b = new THREE.Bone(); b.name = `mixamorig${name}`; b.position.set(x, y, z); parent.add(b); return b; };
	const hips = bone("Hips", rig, 0, 93), spine = bone("Spine", hips, 0, 15), chest = bone("Spine1", spine, 0, 15);
	bone("Spine2", chest, 0, 15); const neck = bone("Neck", chest, 0, 30), head = bone("Head", neck, 0, 15); bone("HeadTop_End", head, 0, 20);
	for (const [side, dir] of [["Left", 1], ["Right", -1]]) {
		const shoulder = bone(`${side}Shoulder`, chest, dir * 10, 25), arm = bone(`${side}Arm`, shoulder, dir * 10, -10), fore = bone(`${side}ForeArm`, arm, dir * 30, 0);
		bone(`${side}Hand`, fore, dir * 30, 0);
		const up = bone(`${side}UpLeg`, hips, dir * 10, 0), shin = bone(`${side}Leg`, up, 0, -45), foot = bone(`${side}Foot`, shin, 0, -45);
		bone(`${side}ToeBase`, foot, 0, -5, 12);
	}
	rig.updateMatrixWorld(true); return rig;
}

const rows = Array.from({ length: 30 }, (_, f) => ({ support: Object.fromEntries(SUPPORT_SITES.map((s) => [s.id, { floor: s.kind === "foot" ? 0 : 1, position: new THREE.Vector3(f < 12 ? 0 : (f - 11) * .02, .05, 0) }])) }));
let contacts = supportIntervals(rows, 30, [{ site: "leftHand", start: 15, end: 17, mode: "plant" }, { site: "leftKnee", start: 10, end: 12, mode: "plant" }, { site: "leftFoot", start: 0, end: 29, mode: "free" }]);
assert.equal(contacts.masks[0].has("leftFoot"), false);
assert(contacts.masks[16].has("leftHand")); assert(contacts.masks[11].has("leftKnee"));
assert(!contacts.masks[20].has("rightFoot"), "moving low feet are not contacts");
console.log("PASS hand/knee contact overrides, free intervals, and moving-foot detection");
{
	const toeRows = (toeAt, ankleAt = () => 0) => Array.from({ length: 60 }, (_, f) => ({ root: new THREE.Vector3(), support: { leftFoot: { floor: 0, position: new THREE.Vector3(ankleAt(f), .05, 0) } }, toes: { leftFoot: new THREE.Vector3(toeAt(f), .05, 0) }, knees: { leftFoot: 0, rightFoot: 0 } }));
	const moving = supportIntervals(toeRows((f) => f * .005), 30);
	assert(moving.rejected.some((s) => s.site === "leftFoot" && s.reason === "moving-contact"));
	const ankleDrift = supportIntervals(toeRows(() => 0, (f) => f * .005), 30);
	assert(ankleDrift.spans.some((s) => s.site === "leftFoot"));
	const mask = Array.from({ length: 60 }, () => new Map([["leftFoot", ankleDrift.spans[0]]]));;
	const metrics = physicsMetrics(toeRows(() => .031), mask, 30);
	assert(Math.abs(metrics.slide - .031) < 1e-9, "foot slide is measured from toe");
	console.log("PASS foot contacts, wander, and slide use toe positions");
}
{
	const boxRows = Array.from({ length: 12 }, () => ({ root: new THREE.Vector3(), support: { leftFoot: { floor: .2, position: new THREE.Vector3(0, .2, 0) } }, toes: { leftFoot: new THREE.Vector3(0, .2, 0) }, ground: { leftFoot: .2 }, knees: { leftFoot: 0, rightFoot: 0 } }));
	const boxContacts = supportIntervals(boxRows, 30);
	const boxSpan = boxContacts.spans.find((s) => s.site === "leftFoot");
	assert(boxSpan && Math.abs(boxSpan.anchor.y - .2) < 1e-9, "box top is used for the foot span anchor");
	assert.equal(physicsMetrics(boxRows, boxContacts.masks, 30).penetration, 0, "box contact has no penetration");
	console.log("PASS a character standing on a box uses the box top anchor and has zero penetration");
}
const smooth = smoothPhysicsTrack(Array.from({ length: 20 }, (_, f) => [f < 10 ? 0 : .1]), 3, [12]);
assert.equal(smooth[12][0], 0); assert(smooth[10][0] > 0 && smooth[10][0] < .1);
console.log("PASS temporal correction eases into protected poses");
{
	const sample = Array.from({ length: 25 }, (_, f) => {
		const root = new THREE.Vector3(f === 10 ? .025 : 0, .9, 0);
		return { root, knees: { leftFoot: 130, rightFoot: 130 }, chains: Object.fromEntries(["leftFoot", "rightFoot"].map((id, i) => [id, { root: root.clone().add(new THREE.Vector3(i ? -.1 : .1, 0, 0)), lengths: [.5, .5] }])) };
	});
	const targets = sample.map(() => SUPPORT_SITES.filter((s) => s.kind === "foot").map((site, i) => ({ site, target: new THREE.Vector3(i ? -.1 : .1, .02, 0) })));
	const adjusted = relaxPhysicsRoot(sample, targets, sample.map(() => [0, 0, 0, 0, 0]), [15]);
	const acceleration = (p) => Math.max(...p.slice(2).map((v, i) => Math.abs(v - 2 * p[i + 1] + p[i])));
	assert(acceleration(sample.map((s, f) => s.root.x + adjusted[f][0])) < acceleration(sample.map((s) => s.root.x)) * .5);
	assert.deepEqual(adjusted[15], [0, 0, 0, 0, 0]);
	console.log("PASS whole-track constraints reduce root acceleration and preserve the protected root");
}

const rig = makeRig(), { chains, fkJoints } = resolveIkRig(rig), hips = fkJoints.get("hips").bone;
const rest = []; rig.traverse((b) => { if (b.isBone) rest.push([b, b.position.clone(), b.quaternion.clone()]); });
const applyRaw = (f) => {
	for (const [b, p, q] of rest) { b.position.copy(p); b.quaternion.copy(q); }
	hips.position.x = .4 * Math.sin(f / 5); hips.position.y = 93 + .5 * Math.cos(f / 4);
	// Non-bind motion translations are precisely the case that used to pop.
	chains.get("leftFoot").bones[1].position.y += .7 * Math.sin(f / 3);
	rig.updateMatrixWorld(true);
};
const sourceKeys = new Map(), params = { rig, chains, fkJoints, sourceKeys, motion: { frames: 24, fps: 30 }, applyRaw };
const stamp = physicsKeyStamp(sourceKeys);
const result = await reviewAutoPhysics({ ...params, protectedFrames: [12] });
const resultExplicitEmpty = await reviewAutoPhysics({ ...params, sceneObjects: [], protectedFrames: [12] });
assert.deepEqual(result.evaluated, resultExplicitEmpty.evaluated, "omitted sceneObjects preserves evaluated output");
assert.equal(physicsKeyStamp(sourceKeys), stamp, "review must not mutate keys");
assert(result.changedFrames.length > 0);
const footSpan = result.contacts.spans.find((s) => s.site === "leftFoot");
if (footSpan) {
	const toeMedian = [...result.samples.slice(footSpan.start, footSpan.end + 1)].map((r) => r.toes.leftFoot.x).sort((a, b) => a - b)[Math.floor((footSpan.end - footSpan.start) * .5)];
	assert(Math.abs(footSpan.anchor.x - toeMedian) < 1e-6, "foot span anchor is the source toe median");
}
assert(result.samples.every((r) => r.toes?.leftFoot && r.toes?.rightFoot), "review samples toes");
assert(result.after.penetration < result.before.penetration);
assert.equal(result.after.surfaceMeasured, false, "bone fallback must not claim mesh measurements");
applyRaw(12); const protectedPose = rest.map(([b]) => [...b.position.toArray(), ...b.quaternion.toArray()]);
ikEvaluate(chains, result.candidate, 12, fkJoints, 6);
rest.forEach(([b], i) => [...b.position.toArray(), ...b.quaternion.toArray()].forEach((n, j) => assert(Math.abs(n - protectedPose[i][j]) < 1e-8)));
console.log("PASS review is non-mutating, protected pose exact, and floor depth improves");
const zero = await reviewAutoPhysics({ ...params, strength: 0 });
assert.equal(zero.changedFrames.length, 0);
assert(Math.abs(zero.before.penetration - zero.after.penetration) < 1e-8);
for (let f = 0; f < 24; f += 1) {
	applyRaw(f); const positions = chains.get("leftFoot").bones.map((b) => b.position.clone());
	ikEvaluate(chains, zero.candidate, f, fkJoints, 6);
	positions.forEach((p, i) => assert(p.distanceTo(chains.get("leftFoot").bones[i].position) < 1e-8));
}
console.log("PASS zero strength is the original clip, including non-bind limb translations");
const clone = copyPhysicsKeys(result.candidate.keys), key = clone.get(0).get("leftFoot");
assert(key.keepTranslations); assert(key.chainP); key.baseQ[0].x += .1; key.chainP[1].y += 1;
assert.notEqual(physicsKeyStamp(clone), physicsKeyStamp(result.candidate.keys));
assert.notEqual(key.chainP[1].y, result.candidate.keys.get(0).get("leftFoot").chainP[1].y);
console.log("PASS undo copies preserve correction metadata without sharing references");
console.log("all pass");
