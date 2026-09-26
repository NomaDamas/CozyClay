import * as THREE from "three";
import { ikEvaluate, solveIk, solveHipsTranslate } from "./ik.js";
import { relaxPhysicsRoot } from "./physics-temporal.js";

// Feed the surfaces actually reached by IK back into the temporal solve.
// The first solve's ideal foot target can differ from the real skinned sole;
// smoothing against the measured target avoids a final projection undoing
// the temporal solution at contact boundaries.
export async function refinePhysicsCandidate({ rig, chains, fkJoints, samples, after, contacts, candidate, base, roots, sites, applyRaw, read, strength, protectedFrames, yieldFrame, floorY = 0, onProgress = () => {} }) {
	if (strength <= 0) return;
	const hips = fkJoints.get("hips"), locks = new Set(protectedFrames);
	const targets = after.map((row, f) => sites.filter((s) => s.kind === "foot" || contacts.masks[f].has(s.id)).map((site) => ({ site, target: row.support[site.id].position.clone() })));
	const seeds = after.map((row, f) => [...row.root.clone().sub(samples[f].root).toArray(), roots[f][3], roots[f][4]]);
	const optimized = relaxPhysicsRoot(samples, targets, seeds, protectedFrames);
	const prior = [...after];
	const aim = (bone, child, target) => {
		const p = bone.getWorldPosition(new THREE.Vector3());
		const from = child.getWorldPosition(new THREE.Vector3()).sub(p).normalize(), to = target.clone().sub(p).normalize();
		const delta = new THREE.Quaternion().setFromUnitVectors(from, to);
		const world = bone.getWorldQuaternion(new THREE.Quaternion());
		bone.quaternion.copy(bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(delta).multiply(world));
		bone.updateMatrixWorld(true);
	};
	for (let f = 0; f < samples.length; f += 1) {
		if (locks.has(f)) continue;
		applyRaw(f); ikEvaluate(chains, candidate, f, fkJoints, 6); rig.updateMatrixWorld(true);
		const root = hips.bone.getWorldPosition(new THREE.Vector3());
		const desired = samples[f].root.clone().add(new THREE.Vector3(...optimized[f]));
		let influence = strength;
		for (const p of protectedFrames) { const t = Math.min(1, Math.abs(f - p) / 4); influence = Math.min(influence, t * t * (3 - 2 * t)); }
		solveHipsTranslate(hips, desired.sub(root).multiplyScalar(influence), hips.bone.position.clone());
		for (const [id, chain] of chains) {
			const endTarget = targets[f].find((t) => t.site.chain === id && t.site.kind !== "knee");
			if (!endTarget) continue;
			const knee = targets[f].find((t) => t.site.chain === id && t.site.kind === "knee");
			if (knee) {
				aim(chain.bones[0], chain.bones[1], knee.target);
				aim(chain.bones[1], chain.bones[2], endTarget.target);
			} else solveIk({ ...chain, bindPositions: base[f].chains.get(id).map((b) => b.p), lengths: samples[f].chains[id].lengths }, endTarget.target, endTarget.site.kind === "foot" ? { maxExtension: samples[f].chains[id].distance + 0.01, softening: 0.01 } : undefined);
			const end = chain.bones[2]; rig.updateMatrixWorld(true);
			end.quaternion.copy(end.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(prior[f].support[id].rotation));
			rig.updateMatrixWorld(true);
		}
		const entry = candidate.keys.get(f);
		entry.get("hips").p.copy(hips.bone.position);
		for (const [id, chain] of chains) entry.get(id).q = chain.bones.map((b) => b.quaternion.clone());
		applyRaw(f); ikEvaluate(chains, candidate, f, fkJoints, 6); after[f] = read();
		if (f % 12 === 0) { onProgress(80 + Math.round(8 * f / samples.length)); await yieldFrame(); }
	}
	// A swing foot is not a pinned constraint. Use that remaining freedom to
	// smooth knee acceleration instead of forcing the pelvis to absorb every
	// knee-speed change. Planted feet and protected poses remain untouched.
	const angles = {};
	for (const id of ["leftFoot", "rightFoot"]) {
		const original = after.map((s) => s.knees[id] * Math.PI / 180), values = [...original];
		for (let sweep = 0; sweep < 24; sweep += 1) for (let k = 2; k < values.length - 2; k += 1) {
			const f = sweep % 2 ? values.length - 1 - k : k;
			if (locks.has(f) || contacts.masks[f].has(id)) continue;
			const next = (original[f] + 2 * (4 * (values[f - 1] + values[f + 1]) - values[f - 2] - values[f + 2])) / 13;
			values[f] = THREE.MathUtils.clamp(next, original[f] - .14, original[f] + .14);
		}
		angles[id] = values;
	}
	for (let f = 0; f < samples.length; f += 1) {
		if (locks.has(f)) continue;
		applyRaw(f); ikEvaluate(chains, candidate, f, fkJoints, 6); rig.updateMatrixWorld(true);
		const backups = new Map();
		for (const id of ["leftFoot", "rightFoot"]) {
			if (contacts.masks[f].has(id)) continue;
			const chain = chains.get(id), [upper, lower, foot] = chain.bones;
			const h = upper.getWorldPosition(new THREE.Vector3()), k = lower.getWorldPosition(new THREE.Vector3()), p = foot.getWorldPosition(new THREE.Vector3());
			const axis = h.sub(k).normalize(), dir = p.clone().sub(k).normalize();
			const tangent = dir.clone().addScaledVector(axis, -dir.dot(axis)).normalize();
			if (tangent.lengthSq() < .5) continue;
			const from = after[f].knees[id] * Math.PI / 180, to = angles[id][f];
			const targetAt = (w) => axis.clone().multiplyScalar(Math.cos(from + (to - from) * w)).addScaledVector(tangent, Math.sin(from + (to - from) * w)).multiplyScalar(samples[f].chains[id].lengths[1]).add(k);
			let weight = strength;
			for (const lock of protectedFrames) { const t = Math.min(1, Math.abs(f - lock) / 4); weight = Math.min(weight, t * t * (3 - 2 * t)); }
			if (after[f].support[id].floor - floorY + targetAt(weight).y - p.y < .001) {
				let lo = 0, hi = weight;
				for (let n = 0; n < 12; n += 1) { const mid = (lo + hi) / 2; if (after[f].support[id].floor - floorY + targetAt(mid).y - p.y >= .001) lo = mid; else hi = mid; }
				weight = lo;
			}
			backups.set(id, candidate.keys.get(f).get(id).q.map((q) => q.clone()));
			aim(lower, foot, targetAt(weight));
			foot.quaternion.copy(foot.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(after[f].support[id].rotation));
			candidate.keys.get(f).get(id).q = chain.bones.map((b) => b.quaternion.clone());
		}
		applyRaw(f); ikEvaluate(chains, candidate, f, fkJoints, 6); let measured = read();
		// A skin-blended ankle is not perfectly rigid. Reject a smoothing move
		// if the actual surface violates the floor, not just its bone proxy.
		let restored = false;
		for (const [id, q] of backups) if (measured.support[id].floor < floorY - .002) {
			const key = candidate.keys.get(f).get(id), proposed = key.q.map((v) => v.clone());
			const threshold = Math.min(floorY - .002, after[f].support[id].floor);
			let lo = 0, hi = 1;
			// A continuous constrained blend avoids an all-or-nothing knee pop
			// when the exact skinned ankle just crosses the floor threshold.
			for (let pass = 0; pass < 7; pass += 1) {
				const w = (lo + hi) / 2;
				key.q = q.map((v, i) => v.clone().slerp(proposed[i], w));
				applyRaw(f); ikEvaluate(chains, candidate, f, fkJoints, 6);
				if (read().support[id].floor >= threshold) lo = w; else hi = w;
			}
			key.q = q.map((v, i) => v.clone().slerp(proposed[i], lo)); restored = true;
		}
		if (restored) { applyRaw(f); ikEvaluate(chains, candidate, f, fkJoints, 6); measured = read(); }
		after[f] = measured;
		if (f % 12 === 0) { onProgress(88 + Math.round(9 * f / samples.length)); await yieldFrame(); }
	}
}
