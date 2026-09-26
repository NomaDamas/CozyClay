import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { resolveIkRig, solveHipsTranslate } from "../src/ardy/ik.js";
import { applyMotionFrame } from "../src/ardy/playback.js";
import { decodeMotionNpz } from "../src/ardy/npz.js";
import { reviewAutoPhysics } from "../src/ardy/physics-review.js";

const source = await decodeMotionNpz(readFileSync("tools/ardy/out/extract-fOE1MA/motion-0.npz"));
const results = [], out = process.env.QA_OUT || "/tmp/cozyclay-support-regressions";
mkdirSync(out, { recursive: true });
for (const model of ["y-bot-tpose", "x-bot-tpose"]) {
	const bytes = readFileSync(`public/models/${model}.fbx`), rig = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
	rig.scale.setScalar(.01); rig.updateMatrixWorld(true); const { chains, fkJoints } = resolveIkRig(rig);
	for (const [name, poseFrame, frames, offset] of [
		["standing-offset", 0, 36, () => .3], ["bow-offset", 210, 36, () => .3],
		["kneeling-offset", 245, 36, () => .3], ["ballistic-tuck", 210, 20, (f) => 1 + 3 * f / 24 - .5 * 9.81 * (f / 24) ** 2],
	]) {
		const motion = { frames, fps: 24 }, cache = { value: null };
		const applyRaw = (f) => { applyMotionFrame(rig, source, poseFrame); solveHipsTranslate(fkJoints.get("hips"), new THREE.Vector3(0, offset(f), 0), fkJoints.get("hips").bone.position.clone()); rig.updateMatrixWorld(true); };
		const options = { rig, motion, chains, fkJoints, sourceKeys: new Map(), applyRaw, cache, ...(process.env.ALIGNMENT_SCALE ? { alignmentScale: Number(process.env.ALIGNMENT_SCALE) } : {}) };
		const result = await reviewAutoPhysics(options);
		const entry = { model, name, before: result.before, after: result.after, shifts: result.support.shifts, seconds: result.performance.totalMs / 1000, performance: result.performance, unresolved: result.unresolved.length };
		if (name === "ballistic-tuck") {
			assert(result.support.shifts.every((v) => v === 0));
			assert.equal(result.support.before.unsupportedFrames, 0);
			assert.equal(result.support.after.unsupportedFrames, 0);
			assert(Math.abs(result.after.rootAcceleration - result.before.rootAcceleration) < 1e-8);
			assert(result.evaluated.every((r, f) => r.root.distanceTo(result.samples[f].root) < 1e-8));
		} else {
			entry.improved = result.after.unsupportedFrames < result.before.unsupportedFrames;
			assert(entry.improved, `${model} ${name}: support must improve`);
			assert.equal(result.after.unsupportedFrames, 0, `${model} ${name}: must reach support`);
			assert(result.after.penetration <= .005 && result.after.float <= .025);
			assert(result.after.forceResidual < .01 && result.after.momentResidual < .01);
		}
		if (name === "standing-offset") {
			const repeated = await reviewAutoPhysics({ ...options, strength: .5, protectedFrames: [18] });
			assert(repeated.performance.cacheHit); assert.equal(repeated.support.shifts[18], 0);
			assert(repeated.evaluated[18].root.distanceTo(repeated.samples[18].root) < 1e-8);
			const zero = await reviewAutoPhysics({ ...options, strength: 0 });
			assert.equal(zero.changedFrames.length, 0); assert(zero.performance.cacheHit);
			assert.equal(zero.candidate.keys.size, 0);
		}
		results.push(entry); console.log(JSON.stringify(entry));
	}
}
writeFileSync(`${out}/metrics.json`, JSON.stringify(results, null, 2));
console.log(out);
