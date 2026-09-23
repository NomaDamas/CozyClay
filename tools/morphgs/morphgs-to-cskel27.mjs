#!/usr/bin/env node
// MorphGS render outputs (rot_params.npy [T,J,3], pred_joints.npy [T,J,3]; src/render.py:606-618) + x-bot rig txt -> cskel27 take npz.
// usage: node morphgs-to-cskel27.mjs <mesh_ori_rig.txt> <rot_params.npy> <pred_joints.npy> <out.npz> [--fps 30] [--check]
import { readFileSync } from "node:fs";
const COZY = process.env.COZYCLAY ?? new URL("../..", import.meta.url).pathname;
const { CSKEL27_JOINTS: CJ, CSKEL27_PARENTS: CP } = await import(`${COZY}/src/ardy/cskel27.js`);
const { CSKEL27_NEUTRAL: NEU } = await import(`${COZY}/src/ardy/cskel27-neutral.js`);
const { deriveBoneOffsets, forwardKinematics, matMul, matTranspose } = await import(`${COZY}/src/ardy/convert.js`);
const { canonicalCskel27Reference } = await import(`${COZY}/src/ardy/to-cskel27.js`);
const { motionArraysToNpzMembers, writeNpz } = await import(`${COZY}/tools/ardy/npz.mjs`);

const [rigPath, rotPath, jointsPath, outPath] = process.argv.slice(2);
const fps = Number(process.argv[process.argv.indexOf("--fps") + 1]) || 30;
const npy = (p) => { // float32 little-endian C-order .npy
	const b = readFileSync(p), hl = b.readUInt16LE(8), h = b.toString("latin1", 10, 10 + hl);
	if (!h.includes("'<f4'") || h.includes("True")) throw new Error(`${p}: need <f4 C-order`);
	return { shape: h.match(/\(([^)]*)\)/)[1].split(",").filter(Boolean).map(Number), d: new Float32Array(b.buffer.slice(b.byteOffset + 10 + hl, b.byteOffset + b.length)) };
};
// Rig: compact "<name> x y z <parent|-1>" (file order == MorphGS joint index, root first) + fixed_joint lines.
const names = [], parent = [], rest = [], fixed = new Set();
for (const t of readFileSync(rigPath, "utf8").split("\n").map((l) => l.trim().split(/\s+/))) {
	if (t[0] === "fixed_joint") t.slice(1).forEach((n) => fixed.add(n));
	else if (t.length === 5) { names.push(t[0]); rest.push(t.slice(1, 4).map(Number)); parent.push(t[4] === "-1" ? -1 : names.indexOf(t[4])); }
}
const J = names.length, ix = (n) => names.indexOf(n), kids = names.map((_, j) => parent.flatMap((p, k) => (p === j ? [k] : [])));
// cskel27 joint -> x-bot bone it drives: playback.js SKINNING_MAP / cskel27.js (Mixamo Spine,Spine1,Spine2 -> Spine1,Spine2,Spine3).
const SRC = { Hips: "Hips", Spine1: "Spine", Spine2: "Spine1", Spine3: "Spine2", Neck: "Neck", Head: "Head" };
for (const s of ["Left", "Right"]) for (const b of ["Shoulder", "Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot", "ToeBase"]) SRC[s + b] = s + b;
const ARM = /Shoulder|Arm|Hand/; // playback: arm chain = bind translation + rotation; wrist undriven; rest positional
for (const x of Object.values(SRC)) {
	const free = kids[ix(x)].filter((k) => !fixed.has(names[k]));
	if (kids[ix(x)].length > 1 && free.length && !process.env.ALLOW_FREE) throw new Error(`${x} has ${kids[ix(x)].length} children; add fixed_joint ${free.map((k) => names[k]).join(" ")}`);
}
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], mv = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const rod = (v) => {
	const a = Math.hypot(...v); if (a < 1e-12) return I3;
	const [x, y, z] = v.map((u) => u / a), s = Math.sin(a), c = Math.cos(a), t = 1 - c;
	return [[t * x * x + c, t * x * y - s * z, t * x * z + s * y], [t * x * y + s * z, t * y * y + c, t * y * z - s * x], [t * x * z - s * y, t * y * z + s * x, t * z * z + c]];
};
const rot = npy(rotPath), pj = npy(jointsPath), T = rot.shape[0];
if (rot.shape[1] !== J || pj.shape[1] !== J) throw new Error(`rig has ${J} joints, npy has ${rot.shape[1]}/${pj.shape[1]}`);
const P = (f, j) => [0, 1, 2].map((a) => pj.d[(f * J + j) * 3 + a]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const len = (a, b) => dist(P(0, ix(a)), P(0, ix(b))); // MorphGS (morphed) bone length; rigid motion keeps it
// Playback constants for the x-bot (playback.js prepOf): bind = FBX world cm; s = leg height / 0.9544128.
const bind = (x) => rest[ix(x)].map((v) => v * 100), MINY = -0.9544128;
const s = (bind("Hips")[1] - Math.min(...Object.values(SRC).filter((x) => !/Hand$/.test(x)).map((x) => bind(x)[1]))) / -MINY;
const nf = (c) => { const n = NEU[CJ.indexOf(c)]; return [n[0], n[1] - MINY, n[2]]; };
// bone_scale only on the arm chain (playback boneStretch): girdle joints take morphed/bind, ForeArm/Hand morphed/(s*canonical).
const boneScale = new Float32Array(27).fill(1);
for (const c of CJ) {
	if (!ARM.test(c) || !SRC[c] || /Thumb|End/.test(c)) continue;
	const x = SRC[c], px = names[parent[ix(x)]], i = CJ.indexOf(c), m = len(x, px) * 100;
	boneScale[i] = /Shoulder|^(Left|Right)Arm$/.test(c) ? m / dist(bind(x), bind(px)) : m / (s * dist(NEU[i], NEU[CP[i]]));
}
const canon = deriveBoneOffsets(canonicalCskel27Reference().posed_joints, canonicalCskel27Reference().local_rot_mats);
const rotMats = new Float32Array(T * 243), rootPos = new Float32Array(T * 3), posed = new Float32Array(T * 81), frames = [];
for (let f = 0; f < T; f++) {
	const Gm = []; // MorphGS parent-pivot: R_j swings segment parent(j)->j; its world rotation is the chain product
	for (let j = 0; j < J; j++) {
		const R = fixed.has(names[j]) ? I3 : rod([0, 1, 2].map((a) => rot.d[(f * J + j) * 3 + a]));
		Gm[j] = parent[j] < 0 ? R : matMul(Gm[parent[j]], R);
	}
	const G = [], pos = [];
	CJ.forEach((c, i) => { G[i] = SRC[c] ? Gm[kids[ix(SRC[c])][0]] : G[CP[i]]; }); // outgoing segment of the driven bone
	const L = CJ.map((_, i) => (CP[i] === null ? G[i] : matMul(matTranspose(G[CP[i]]), G[i])));
	CJ.forEach((c, i) => { // posed_joints = inverse of playback's positional skinning; unskinned joints hang off their parent
		if (SRC[c] && !ARM.test(c)) { const b = bind(SRC[c]), g = mv(G[i], b.map((v, a) => v - s * nf(c)[a])); pos[i] = P(f, ix(SRC[c])).map((v, a) => (v * 100 - g[a]) / s); }
		else { const o = mv(G[CP[i]], canon[i]); pos[i] = pos[CP[i]].map((v, a) => v + o[a]); }
	});
	L.forEach((m, i) => rotMats.set(m.flat(), (f * 27 + i) * 9));
	pos.forEach((p, i) => posed.set(p, (f * 27 + i) * 3));
	rootPos.set(pos[0], f * 3);
	frames.push({ G, L, pos });
}
writeNpz(outPath, motionArraysToNpzMembers({ frames: T, fps, rotMats, rootPos, posedJoints: posed, boneScale }));
console.log(`wrote ${outPath}: ${T} frames, fixed=[${[...fixed]}], s=${s.toFixed(3)}`);

// ---- --check: compare against MorphGS joints_warped (truth), per mapped x-bot joint, max over frames, in cm ----
if (process.argv.includes("--check")) {
	// (a) CozyClay convert.js forwardKinematics over the exported local_rot_mats with the x-bot's own morphed offsets
	const xr = CJ.map((c) => (SRC[c] ? rest[ix(SRC[c])] : null));
	xr[CJ.indexOf("Spine")] = rest[0].map((v, a) => (v + rest[ix("Spine")][a]) / 2);
	CJ.forEach((c, i) => { if (!xr[i]) xr[i] = c.endsWith("HandEnd") ? rest[ix(c)] : xr[CP[i]]; });
	const xOff = xr.map((p, i) => { if (CP[i] === null) return [0, 0, 0]; const d = p.map((v, a) => v - xr[CP[i]][a]), n = Math.hypot(...d);
		const x = SRC[CJ[i]] ?? (CJ[i].endsWith("HandEnd") ? CJ[i] : null), px = SRC[CJ[CP[i]]];
		const l = CJ[i] === "Spine" || CJ[i] === "Spine1" ? len("Spine", "Hips") / 2 : x && px ? len(x, px) : n; return n > 0 ? d.map((v) => (v / n) * l) : d; });
	// (b) previous iteration: canonical cskel27 FK (what posed_joints would be if written as plain FK)
	// (c) playback.js simulated on the x-bot with the written npz arrays (positional skinning + arm chain), /100 -> m
	const stretch = (i) => /Shoulder|^(Left|Right)Arm$/.test(CJ[i]) ? boneScale[i] : boneScale[i] * s * dist(NEU[i], NEU[CP[i]]) / dist(bind(SRC[CJ[i]]), bind(names[parent[ix(SRC[CJ[i]])]]));
	const rows = Object.entries(SRC).map(([c, x]) => ({ c, x, i: CJ.indexOf(c), a: 0, b: 0, cc: 0 }));
	frames.forEach(({ G, L, pos }, f) => {
		const fa = forwardKinematics(L, xOff, P(f, 0)), fb = forwardKinematics(L, canon, P(f, 0)), W = [];
		CJ.forEach((c, i) => {
			if (!SRC[c]) return;
			if (!ARM.test(c)) { const g = mv(G[i], bind(SRC[c]).map((v, a) => v - s * nf(c)[a])); W[i] = pos[i].map((v, a) => (s * v + g[a]) / 100); return; }
			const pi = /Shoulder/.test(c) ? CJ.indexOf("Spine3") : CP[i], o = mv(G[pi], bind(SRC[c]).map((v, a) => (v - bind(SRC[CJ[pi]])[a]) * stretch(i)));
			W[i] = W[pi].map((v, a) => v + o[a] / 100);
		});
		for (const r of rows) { const t = P(f, ix(r.x)); r.a = Math.max(r.a, dist(fa[r.i], t) * 100); r.b = Math.max(r.b, dist(fb[r.i], t) * 100); r.cc = Math.max(r.cc, dist(W[r.i], t) * 100); }
	});
	console.log("cskel27 <- x-bot        (a)FK x-bot offs  (b)canonical FK  (c)playback sim   bone_scale");
	for (const r of rows) console.log(`${r.c.padEnd(14)}<- ${r.x.padEnd(14)} ${r.a.toFixed(4).padStart(8)} ${r.b.toFixed(3).padStart(15)} ${r.cc.toFixed(4).padStart(15)} ${boneScale[r.i].toFixed(3).padStart(10)}`);
	for (const k of ["a", "b", "cc"]) console.log(`MAX ${k} = ${Math.max(...rows.map((r) => r[k])).toFixed(4)} cm`);
}
