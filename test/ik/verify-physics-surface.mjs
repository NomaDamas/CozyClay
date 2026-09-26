import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { resolveIkRig, findBone } from "../../src/ardy/ik.js";
import { SUPPORT_SITES, createSupportSampler } from "../../src/ardy/physics-review.js";

// Independent reference: original THREE CPU skinning, all duplicate vertices.
function reference(rig) {
	const groups = [];
	rig.traverse((m) => {
		if (!m.isSkinnedMesh) return;
		const idx = m.geometry.attributes.skinIndex, w = m.geometry.attributes.skinWeight;
		const lists = {};
		for (const s of SUPPORT_SITES) {
			lists[s.id] = [];
			for (let v = 0; v < idx.count; v += 1) { let influence = 0; for (let j = 0; j < 4; j += 1) if (s.match.test(m.skeleton.bones[idx.getComponent(v, j)].name)) influence += w.getComponent(v, j); if (influence >= .5) lists[s.id].push(v); }
		}
		groups.push({ m, lists });
	});
	return () => {
		rig.updateMatrixWorld(true); const out = {}, p = new THREE.Vector3();
		for (const s of SUPPORT_SITES) {
			const position = findBone(rig, `mixamorig${s.bone}`).getWorldPosition(new THREE.Vector3());
			let floor = Infinity, vertices = 0;
			for (const { m, lists } of groups) for (const v of lists[s.id]) {
				m.getVertexPosition(v, p); m.localToWorld(p);
				if (s.kind === "knee" && p.distanceTo(position) > .14) continue;
				floor = Math.min(floor, p.y); vertices += 1;
			}
			out[s.id] = { floor, vertices };
		}
		return out;
	};
}
for (const model of ["y-bot-tpose", "x-bot-tpose"]) {
	const buf = readFileSync(`public/models/${model}.fbx`), rig = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
	rig.scale.setScalar(.01); rig.updateMatrixWorld(true); resolveIkRig(rig);
	const sample = createSupportSampler(rig), slow = reference(rig);
	const rest = []; rig.traverse((b) => { if (b.isBone) rest.push({ bone: b, q: b.quaternion.clone(), p: b.position.clone() }); });
	assert(sample.stats.uniqueVertices < sample.stats.inputVertices / 2);
	let worst = 0;
	for (const f of [0, 42, 159, 245, 283, 361]) {
		for (const { bone, q, p } of rest) { bone.position.copy(p); bone.quaternion.copy(q); }
		for (const name of ["LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg", "LeftArm", "RightForeArm"]) findBone(rig, `mixamorig${name}`).quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(.2 * Math.sin(f / 20), .1, .1 * Math.cos(f / 25))));
		rig.position.set(.13, .17, -.21); rig.rotation.y = .5; rig.updateMatrixWorld(true);
		const a = sample(), b = slow();
		for (const s of SUPPORT_SITES) { worst = Math.max(worst, Math.abs(a[s.id].floor - b[s.id].floor)); assert.equal(a[s.id].vertices, b[s.id].vertices); }
		assert(a.pelvis.vertices > 0 && a.chest.vertices > 0);
	}
	assert(worst < 1e-6, `exact surface mismatch ${worst}`);
	console.log(`PASS ${model} exact skinning vs THREE: ${worst} m; ${sample.stats.inputVertices} → ${sample.stats.uniqueVertices} vertex evaluations`);
}
console.log("all pass");
