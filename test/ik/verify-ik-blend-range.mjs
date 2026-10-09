import * as THREE from "three";
import { correctionWeight, createIkState, ikEvaluate } from "../../src/ardy/ik.js";
import { ikKeyJson, ikTrackKeyFromJson } from "../../src/ardy/ik-key-json.js";
import { copyPhysicsKeys } from "../../src/ardy/physics-review.js";
import { studioActionDeclaration } from "../../src/studio-actions.js";
import { validateStudioSchema } from "../../src/studio-agent-protocol.js";

/* A Pose fix key may carry its own correction range (`blend`, frames). Keys
 * without one must replay exactly as before; a key with one eases over its own
 * range, and islands merge on the larger of two neighbours' ranges. */

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
	}
}

const BLEND = 6; // App.jsx IK_CORRECTION_BLEND_FRAMES
const near = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

/** Keys for one track: [[frame, blend?], ...] → Map(frame → Map(track → key)). */
function keysOf(track, list, other = []) {
	const keys = new Map();
	for (const [frame, blend] of list) {
		keys.set(frame, new Map([[track, { q: [new THREE.Quaternion()], p: null, ...(blend != null ? { blend } : {}) }]]));
	}
	for (const [frame, blend] of other) {
		let entry = keys.get(frame);
		if (!entry) keys.set(frame, (entry = new Map()));
		entry.set("other", { q: [new THREE.Quaternion()], p: null, ...(blend != null ? { blend } : {}) });
	}
	return keys;
}

/* The pre-change correctionWeight, verbatim in behaviour: the oracle for (a). */
function legacyWeight(keys, trackId, frame, blendWindow) {
	const frames = [];
	for (const [f, entry] of keys) if (entry.has(trackId)) frames.push(f);
	if (!frames.length) return 0;
	frames.sort((a, b) => a - b);
	const islands = [];
	let first = frames[0];
	let prev = frames[0];
	for (let index = 1; index < frames.length; index += 1) {
		const f = frames[index];
		if (f - prev > blendWindow) {
			islands.push([first, prev]);
			first = f;
		}
		prev = f;
	}
	islands.push([first, prev]);
	let best = 0;
	for (const [a, b] of islands) {
		if (frame >= a && frame <= b) return 1;
		const distance = frame < a ? a - frame : frame - b;
		const weight = 1 - distance / blendWindow;
		if (weight > best) best = weight;
	}
	return Math.max(0, best);
}

/* (a) keys without `blend` are bit-for-bit the old weights. */
{
	const layouts = [[50], [10, 14], [10, 16], [10, 17], [3, 40, 44, 90], [0, 6, 12, 30, 37, 120]];
	let mismatches = 0;
	let compared = 0;
	for (const window of [BLEND, 1, 3, 12]) {
		for (const layout of layouts) {
			const keys = keysOf("rightHand", layout.map((f) => [f]), [[layout[0] + 2, 30]]);
			for (let frame = -20; frame <= 150; frame += 1) {
				compared += 1;
				if (!Object.is(correctionWeight(keys, "rightHand", frame, window), legacyWeight(keys, "rightHand", frame, window))) mismatches += 1;
			}
		}
	}
	check(`(a) no-blend weights identical to legacy (${compared} samples)`, mismatches === 0, `${mismatches} mismatches`);

	// Same through ikEvaluate: a key without blend and one with blend = window
	// land the joint on bit-identical transforms around the key.
	const pose = (withBlend, frame) => {
		const bone = new THREE.Bone();
		bone.position.set(0, 1, 0);
		const bindPos = bone.position.clone();
		const key = {
			q: [new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.1, 0))], p: new THREE.Vector3(0.1, 0.9, 0.05),
			baseQ: [new THREE.Quaternion()], basePos: bindPos.clone(), ...(withBlend ? { blend: BLEND } : {}),
		};
		const state = createIkState();
		state.keys.set(100, new Map([["hips", key]]));
		state.tracked.add("hips");
		ikEvaluate(new Map(), state, frame, new Map([["hips", { bone, bindPos }]]), BLEND);
		return [...bone.position.toArray(), ...bone.quaternion.toArray()];
	};
	let evalMismatch = 0;
	for (let frame = 90; frame <= 110; frame += 1) {
		const a = pose(false, frame);
		const b = pose(true, frame);
		if (a.some((value, i) => !Object.is(value, b[i]))) evalMismatch += 1;
	}
	check("(a) ikEvaluate: no-blend key == blend 6 key at frames 90..110", evalMismatch === 0, `${evalMismatch} frames differ`);
}

/* (b) a key with blend 18 ramps over 18 frames; its blendless neighbour keeps 6. */
{
	const keys = keysOf("rightHand", [[50, 18], [100]]);
	const w = (frame) => correctionWeight(keys, "rightHand", frame, BLEND);
	check("(b) blend 18: weight 1 on the key", w(50) === 1);
	check("(b) blend 18: +9 frames is 0.5", near(w(59), 0.5), `got ${w(59)}`);
	check("(b) blend 18: -9 frames is 0.5", near(w(41), 0.5), `got ${w(41)}`);
	check("(b) blend 18: +18 frames is 0", w(68) === 0, `got ${w(68)}`);
	check("(b) blend 18: -18 frames is 0", w(32) === 0, `got ${w(32)}`);
	check("(b) blend 18: +17 frames still eases", near(w(67), 1 / 18), `got ${w(67)}`);
	check("(b) neighbour without blend: +3 is 0.5", near(w(103), 0.5), `got ${w(103)}`);
	check("(b) neighbour without blend: -3 is 0.5", near(w(97), 0.5), `got ${w(97)}`);
	check("(b) neighbour without blend: +-6 is 0", w(106) === 0 && w(94) === 0, `got ${w(106)}, ${w(94)}`);

	// End to end: the hips delta at +9 frames is half the correction.
	const bone = new THREE.Bone();
	const bindPos = new THREE.Vector3(0, 1, 0);
	const state = createIkState();
	state.keys.set(50, new Map([["hips", { q: null, p: new THREE.Vector3(0, 1.2, 0), basePos: bindPos.clone(), blend: 18 }]]));
	state.tracked.add("hips");
	const at = (frame) => {
		bone.position.copy(bindPos);
		ikEvaluate(new Map(), state, frame, new Map([["hips", { bone, bindPos }]]), BLEND);
		return bone.position.y - bindPos.y;
	};
	check("(b) ikEvaluate: hips at +9 carry half the 20 cm lift", near(at(59), 0.1, 1e-9), `got ${at(59)}`);
	check("(b) ikEvaluate: hips at +18 are back on the clip", near(at(68), 0, 1e-12), `got ${at(68)}`);
	check("(b) ikEvaluate: blendWindow 0 (no motion) still holds the key", (() => {
		bone.position.copy(bindPos);
		ikEvaluate(new Map(), state, 200, new Map([["hips", { bone, bindPos }]]), 0);
		return near(bone.position.y, 1.2, 1e-9);
	})());
}

/* (c) islands merge while the gap <= the larger of the two neighbours' blends. */
{
	const weightAt = (layout, frame) => correctionWeight(keysOf("leftFoot", layout), "leftFoot", frame, BLEND);
	// 10 (blend 18) and 25 (no blend → 6): gap 15 <= 18 → one island.
	check("(c) mixed pair gap 15 <= max(18, 6) is one island", weightAt([[10, 18], [25]], 17) === 1);
	check("(c) merged island eases out of its first key over 18", near(weightAt([[10, 18], [25]], 1), 0.5), `got ${weightAt([[10, 18], [25]], 1)}`);
	check("(c) merged island eases out of its last key over 6", near(weightAt([[10, 18], [25]], 28), 0.5) && weightAt([[10, 18], [25]], 31) === 0);
	// Order does not matter: the wide key second.
	check("(c) mixed pair, wide key second, is one island", weightAt([[10], [25, 18]], 17) === 1);
	check("(c) ... and its last edge eases over 18", near(weightAt([[10], [25, 18]], 34), 0.5));
	// Both at 6 with the same gap: two islands, the clip in between.
	check("(c) same gap with 6/6 splits (clip between)", weightAt([[10], [25]], 17) === 0);
	// Gap 20 > max(12, 12): split; the midpoint is inside both ramps.
	check("(c) gap 20 > 12 splits; midpoint weight 1 - 10/12", near(weightAt([[10, 12], [30, 12]], 20), 1 - 10 / 12), `got ${weightAt([[10, 12], [30, 12]], 20)}`);
	// Exactly at the larger blend merges (<=).
	check("(c) gap == larger blend merges", weightAt([[10, 4], [22, 12]], 16) === 1);
	// A blend on ANOTHER track never widens this one.
	const keys = keysOf("leftFoot", [[10], [25]], [[10, 30], [25, 30]]);
	check("(c) other track's blend is ignored", correctionWeight(keys, "leftFoot", 17, BLEND) === 0);
}

/* (d) blend survives ikKeyJson → character.setIkKey schema → key, and undo copies. */
{
	const setIkKey = studioActionDeclaration("character.setIkKey").input;
	const q = (x, y, z, w) => new THREE.Quaternion(x, y, z, w).normalize();
	const entry = new Map([
		["rightHand", { q: [q(0, 0, 0, 1), q(0, 0, 0.38, 0.92), q(0, 0, 0, 1)], p: null, baseQ: [q(0, 0, 0, 1), q(0, 0, 0, 1), q(0, 0, 0, 1)], blend: 18 }],
		["hips", { q: [q(0, 0.1, 0, 1)], p: new THREE.Vector3(0, 0.9, 0), basePos: new THREE.Vector3(0, 1, 0) }],
	]);
	const tracks = ikKeyJson(entry);
	check("(d) ikKeyJson writes blend", tracks.rightHand.blend === 18);
	check("(d) ikKeyJson omits blend on a key without one", !("blend" in tracks.hips));
	const args = { characterId: "char-a", frame: 100, tracks };
	let validated = null;
	try { validated = validateStudioSchema(setIkKey, args); } catch (error) { check("(d) schema accepts blend", false, error.message); }
	check("(d) schema accepts blend and keeps it", validated?.tracks.rightHand.blend === 18);
	const back = ikTrackKeyFromJson(validated.tracks.rightHand);
	const hips = ikTrackKeyFromJson(validated.tracks.hips);
	check("(d) setIkKey key keeps blend", back.blend === 18);
	check("(d) setIkKey key without blend stays without", !("blend" in hips));
	check("(d) rotations round-trip", back.q.every((value, i) => value.angleTo(entry.get("rightHand").q[i]) < 1e-6));
	const copied = copyPhysicsKeys(new Map([[100, new Map([["rightHand", back], ["hips", hips]])]]));
	check("(d) undo snapshot (copyPhysicsKeys) keeps blend", copied.get(100).get("rightHand").blend === 18 && !("blend" in copied.get(100).get("hips")));
	for (const bad of [0, 241, 2.5, -3]) {
		let refused = false;
		try { validateStudioSchema(setIkKey, { ...args, tracks: { rightHand: { ...tracks.rightHand, blend: bad } } }); } catch (error) { refused = error?.code === "INVALID_ARGUMENT"; }
		check(`(d) schema refuses blend ${bad}`, refused);
	}
	for (const good of [1, 240]) {
		let accepted = true;
		try { validateStudioSchema(setIkKey, { ...args, tracks: { rightHand: { ...tracks.rightHand, blend: good } } }); } catch { accepted = false; }
		check(`(d) schema accepts blend ${good}`, accepted);
	}
}

/* Explicit range boundaries stay connected across older interior keys and JSON. */
{
	const keys = keysOf("leftHand", [[10], [30], [70]]);
	for (const frame of [10, 70]) keys.get(frame).get("leftHand").correctionRange = { start: 10, end: 70 };
	check("range boundaries retain full correction around an older interior key", [20, 40, 60].every(frame => correctionWeight(keys, "leftHand", frame, BLEND) === 1));
	check("range boundaries still ease outside the range", correctionWeight(keys, "leftHand", 73, BLEND) === 0.5 && correctionWeight(keys, "leftHand", 76, BLEND) === 0);
	const tracks = ikKeyJson(keys.get(10));
	const args = validateStudioSchema(studioActionDeclaration("character.setIkKey").input, { characterId: "char-a", frame: 10, tracks });
	const back = ikTrackKeyFromJson(args.tracks.leftHand);
	check("range metadata survives action JSON validation and decoding", back.correctionRange.start === 10 && back.correctionRange.end === 70);
	const copied = copyPhysicsKeys(keys);
	copied.get(10).get("leftHand").correctionRange.start = 99;
	check("undo range metadata is an independent copy", keys.get(10).get("leftHand").correctionRange.start === 10);
}

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall IK blend range checks passed");
