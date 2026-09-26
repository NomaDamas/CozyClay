import * as THREE from "three";

/** Optimize the WHOLE root track against limb reach and knee acceleration.
 * Neighbour costs are re-evaluated together, so a locally perfect plant may
 * not buy itself a knee pop or a root jump on the following frame. */
export function relaxPhysicsRoot(samples, targets, roots, protectedFrames = [], limit = .18) {
	const locks = new Set(protectedFrames), n = samples.length;
	const seed = roots.map((r) => r.slice(0, 3)), values = seed.map((r) => [...r]);
	const constraints = samples.map((s, f) => targets[f].map((t) => {
		const c = s.chains[t.site.chain];
		const offset = c.root.clone().sub(s.root).applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(roots[f][3], 0, roots[f][4]))).add(s.root);
		return { id: t.site.id, kind: t.site.kind, start: offset.toArray(), end: t.target.toArray(), lengths: c.lengths };
	}));
	const derived = (f) => {
		let reach = 0; const knees = {};
		for (const c of constraints[f]) {
			const d = Math.hypot(...c.start.map((v, j) => v + values[f][j] - c.end[j]));
			const [a, b] = c.lengths;
			const error = c.kind === "knee" ? d - a : Math.max(0, d - a - b + .0005);
			reach += error * error;
			if (c.kind === "foot") knees[c.id] = locks.has(f) ? samples[f].knees[c.id] * Math.PI / 180 : Math.acos(THREE.MathUtils.clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1));
		}
		return { reach, knees };
	};
	let cache = values.map((_, f) => derived(f));
	const cost = (f) => {
		let value = 20000 * cache[f].reach + 2 * values[f].reduce((s, v, j) => s + (v - seed[f][j]) ** 2, 0);
		for (let i = Math.max(1, f - 1); i <= Math.min(n - 2, f + 1); i += 1) {
			for (let j = 0; j < 3; j += 1) {
				const axis = ["x", "y", "z"][j];
				const a = samples[i - 1].root[axis] + values[i - 1][j], b = samples[i].root[axis] + values[i][j], c = samples[i + 1].root[axis] + values[i + 1][j];
				value += 600 * (a - 2 * b + c) ** 2;
			}
			for (const id of ["leftFoot", "rightFoot"]) {
				const a = cache[i - 1].knees[id], b = cache[i].knees[id], c = cache[i + 1].knees[id];
				if ([a, b, c].every(Number.isFinite)) value += .3 * (a - 2 * b + c) ** 2;
			}
		}
		return value;
	};
	for (const step of [.008, .003, .001, .0003]) for (let sweep = 0; sweep < 4; sweep += 1) {
		for (let k = 0; k < n; k += 1) {
			const f = sweep % 2 ? n - 1 - k : k; if (locks.has(f)) continue;
			let best = cost(f);
			for (let j = 0; j < 3; j += 1) for (const sign of [-1, 1]) {
				const old = values[f][j], oldCache = cache[f]; values[f][j] += sign * step;
				if (Math.hypot(...values[f]) > limit) { values[f][j] = old; continue; }
				cache[f] = derived(f); const next = cost(f);
				if (next < best) best = next; else { values[f][j] = old; cache[f] = oldCache; }
			}
		}
	}
	return roots.map((r, f) => [...values[f], r[3], r[4]]);
}
