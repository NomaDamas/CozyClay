#!/usr/bin/env node
/**
 * check-rig.mjs — prove an exported rig npz (tools/track/export-rig.mjs) is
 * enough to reproduce Studio playback without three's rig objects.
 *
 *   node tools/track/check-rig.mjs --rig <rig.npz> --model <id> --motion <truth.npz> [--frame N]
 *
 * 1. rest joints: cskel27 joints of a rest take (the truth motion's frame-0
 *    root and bone factors, identity rotations) from the npz's neutral
 *    skeleton vs Studio's posedJoints (tools/bench/fit/motion.mjs
 *    regenerateJoints over src/ardy/convert.js FK).
 * 2. bones: every control bone's world position from a port of
 *    applyMotionFrame that reads only npz arrays vs the real rig driven by
 *    src/ardy/playback.js applyMotionFrame, for the rest take, truth frame N,
 *    and truth frame N on a body with non-unit bone factors.
 * 3. skin: world-space LBS from npz vertices/weights/bind inverses vs three's
 *    own SkinnedMesh.getVertexPosition on truth frame N (every 7th vertex).
 * Prints JSON; exits 1 when any error exceeds 1 mm.
 */
import { pathToFileURL } from "node:url";
import * as THREE from "three";
import { globalRotations } from "../../src/ardy/convert.js";
import { applyMotionFrame } from "../../src/ardy/playback.js";
import { readNpz } from "../kimodo/read-npz.mjs";
import { cloneMotion, localsAt, readMotion, regenerateJoints } from "../bench/fit/motion.mjs";
import { loadRig, modelPath } from "./export-rig.mjs";

const TOLERANCE_M = 1e-3;
const J = 27;

const m4 = (data, i) => new THREE.Matrix4().fromArray(data, i * 16).transpose(); // row-major -> three
const v3 = (data, i) => new THREE.Vector3(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
const q4 = (data, i) => new THREE.Quaternion(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]);

/** Rest cskel27 joints from the npz: root + neutral grown by boneScale. */
export function restJoints(npz, root, boneScale) {
	const parents = npz.cskel27_parents.data;
	const n = npz.cskel27_neutral.data;
	const out = [];
	for (let j = 0; j < J; j += 1) {
		const p = parents[j];
		out.push(p < 0 ? [...root] : [0, 1, 2].map((k) => out[p][k] + boneScale[j] * (n[j * 3 + k] - n[p * 3 + k])));
	}
	return out;
}

/** World matrices (metres) of every exported bone for motion frame f, from npz arrays only. */
export function boneWorlds(npz, motion, f) {
	const s = npz.prep_scale.data[0];
	const minY = npz.ardy_neutral_min_y.data[0];
	const prepBone = npz.prep_bone.data;
	const hasScale = Boolean(motion.boneScale);
	const grown = hasScale ? restJoints(npz, [0, 0, 0], motion.boneScale) : null;
	const offset = (j) => {
		if (!grown) return v3(npz.prep_offsets.data, j);
		const b = v3(npz.prep_bind_pos.data, j);
		return new THREE.Vector3(b.x - s * grown[j][0], b.y - s * (grown[j][1] - minY), b.z - s * grown[j][2]);
	};
	const stretch = (j) => {
		if (!hasScale) return 1;
		if (npz.girdle_joints.data[j]) return motion.boneScale[j];
		const canonical = npz.prep_canonical_bone_length.data[j];
		const rigBind = npz.prep_rig_bone_length.data[j];
		if (!(canonical > 1e-6) || !(rigBind > 1e-6)) return motion.boneScale[j];
		return (motion.boneScale[j] * canonical) / rigBind;
	};
	const globals = globalRotations(localsAt(motion, f));
	const anchor = Math.max(0, Math.min(motion.anchorFrame || 0, motion.frames - 1));
	const ax = motion.posedJoints[anchor * J * 3];
	const az = motion.posedJoints[anchor * J * 3 + 2];

	const desired = new Array(J).fill(null);
	const assumedParent = new Map();
	const jointOfBone = new Map();
	for (let j = 0; j < J; j += 1) {
		const b = prepBone[j];
		if (b < 0) continue;
		const G = globals[j];
		const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(
			G[0][0], G[0][1], G[0][2], 0, G[1][0], G[1][1], G[1][2], 0, G[2][0], G[2][1], G[2][2], 0, 0, 0, 0, 1));
		const po = (f * J + j) * 3;
		let pos = offset(j).applyQuaternion(q).add(new THREE.Vector3(
			s * (motion.posedJoints[po] - ax), s * motion.posedJoints[po + 1], s * (motion.posedJoints[po + 2] - az)));
		const cp = npz.prep_chain_parent.data[j];
		const parentW = cp >= 0 ? desired[cp].clone().multiply(m4(npz.prep_chain_rel.data, j)) : m4(npz.prep_parent_bind_world.data, j);
		if (npz.hierarchy_preserved.data[j]) pos = v3(npz.prep_bind_local_pos.data, j).multiplyScalar(stretch(j)).applyMatrix4(parentW);
		desired[j] = new THREE.Matrix4().compose(pos, q.multiply(q4(npz.prep_bind_quat.data, j)), v3(npz.prep_bind_scale.data, j));
		assumedParent.set(b, parentW);
		jointOfBone.set(b, j);
	}
	const leaves = new Map();
	for (let i = 0; i < npz.prep_stretched_leaves.shape[0]; i += 1) {
		leaves.set(npz.prep_stretched_leaves.data[i * 2], { joint: npz.prep_stretched_leaves.data[i * 2 + 1], i });
	}
	const B = npz.bone_parent.shape[0];
	const rigWorld = [];
	for (let b = 0; b < B; b += 1) {
		const parent = npz.bone_parent.data[b];
		const parentWorld = parent < 0 ? new THREE.Matrix4() : rigWorld[parent];
		let local;
		if (jointOfBone.has(b)) {
			local = assumedParent.get(b).clone().invert().multiply(desired[jointOfBone.get(b)]);
		} else if (leaves.has(b)) {
			const { joint, i } = leaves.get(b);
			const rest = m4(npz.bone_rest_local.data, b);
			const scale = new THREE.Vector3();
			rest.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
			local = new THREE.Matrix4().compose(
				v3(npz.prep_stretched_leaf_local_pos.data, i).multiplyScalar(stretch(joint)),
				q4(npz.prep_stretched_leaf_local_quat.data, i), scale);
		} else {
			local = m4(npz.bone_rest_local.data, b);
		}
		rigWorld.push(parentWorld.clone().multiply(local));
	}
	const root = new THREE.Matrix4().makeScale(...Array(3).fill(npz.rig_root_scale.data[0]));
	return rigWorld.map((w) => root.clone().multiply(w));
}

/** World-space LBS of npz vertex v under bone worlds W. */
export function skinVertex(npz, worlds, v) {
	const out = new THREE.Vector3();
	const rest = v3(npz.vertices.data, v);
	for (let k = 0; k < 4; k += 1) {
		const w = npz.skin_weight.data[v * 4 + k];
		if (w === 0) continue;
		const b = npz.skin_index.data[v * 4 + k];
		out.addScaledVector(rest.clone().applyMatrix4(m4(npz.bone_bind_inverse.data, b)).applyMatrix4(worlds[b]), w);
	}
	return out;
}

export function checkRig({ rig: rigPath, model, motion: motionPath, frame = 40 }) {
	const npz = readNpz(rigPath);
	const meta = JSON.parse(Buffer.from(Uint8Array.from(npz.meta_json.data)).toString("utf8"));
	const truth = readMotion(motionPath);
	const f = Math.min(frame, truth.frames - 1);

	// 1. rest take: truth frame-0 root and bone factors, identity rotations.
	const rotMats = new Float32Array(J * 9);
	for (let j = 0; j < J; j += 1) rotMats.set([1, 0, 0, 0, 1, 0, 0, 0, 1], j * 9);
	const rest = regenerateJoints({ frames: 1, fps: truth.fps, rotMats, rootPos: truth.rootPos.slice(0, 3), posedJoints: new Float32Array(J * 3), boneScale: truth.boneScale.slice(), anchorFrame: 0 });
	const fromNpz = restJoints(npz, Array.from(truth.rootPos.slice(0, 3)), truth.boneScale);
	let restJointErr = 0;
	fromNpz.forEach((p, j) => { restJointErr = Math.max(restJointErr, Math.hypot(...p.map((x, k) => x - rest.posedJoints[j * 3 + k]))); });

	// 2 + 3. bone and skin parity against the real rig under Studio playback.
	const { rig } = loadRig(modelPath(model));
	const control = new Map();
	rig.traverse((o) => { if (o.isBone && !control.has(o.name)) control.set(o.name, o); });
	const meshes = [];
	rig.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
	/** Drive the real rig with Studio playback and the npz port with the same
	 * frame; compare every bone and (optionally) every 7th skinned vertex. */
	const parity = (motion, fr, { skin = false } = {}) => {
		applyMotionFrame(rig, motion, fr);
		const worlds = boneWorlds(npz, motion, fr);
		let err = 0;
		let worst = "";
		meta.boneNames.forEach((name, b) => {
			const e = new THREE.Vector3().setFromMatrixPosition(worlds[b]).distanceTo(new THREE.Vector3().setFromMatrixPosition(control.get(name).matrixWorld));
			if (e > err) { err = e; worst = name; }
		});
		let skinErr = 0;
		let samples = 0;
		const p = new THREE.Vector3();
		if (skin) meshes.forEach((mesh, m) => {
			const [start, count] = npz.mesh_ranges.data.slice(m * 4, m * 4 + 2);
			for (let v = 0; v < count; v += 7) {
				mesh.getVertexPosition(v, p).applyMatrix4(mesh.matrixWorld);
				skinErr = Math.max(skinErr, skinVertex(npz, worlds, start + v).distanceTo(p));
				samples += 1;
			}
		});
		return { err, worst, skinErr, samples };
	};
	const restBones = parity(rest, 0);
	const posed = parity(truth, f, { skin: true });
	// The same frame on a non-canonical body (bone factors 0.85..1.15), so the
	// grown offsets and the arm/leaf stretch are exercised with factors != 1.
	const body = cloneMotion(truth);
	body.boneScale = Float32Array.from({ length: J }, (_, j) => 0.85 + 0.3 * ((j * 7) % 11) / 10);
	const scaled = parity(regenerateJoints(body), f, { skin: true });
	const result = {
		rig: rigPath, model, motion: motionPath, frame: f,
		shapes: Object.fromEntries(Object.entries(npz).map(([k, v]) => [k, `${v.dtype}[${v.shape.join(",")}]`])),
		restJointMaxErrM: restJointErr,
		restBoneMaxErrM: restBones.err, restBoneWorst: restBones.worst,
		posedBoneMaxErrM: posed.err, posedBoneWorst: posed.worst,
		posedSkinMaxErrM: posed.skinErr, skinSamples: posed.samples,
		scaledBodyBoneMaxErrM: scaled.err, scaledBodyBoneWorst: scaled.worst,
		scaledBodySkinMaxErrM: scaled.skinErr,
		toleranceM: TOLERANCE_M,
	};
	result.pass = [restJointErr, restBones.err, posed.err, posed.skinErr, scaled.err, scaled.skinErr].every((e) => e <= TOLERANCE_M);
	return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = {};
	for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
	if (!args.rig || !args.model || !args.motion) {
		console.error("usage: check-rig.mjs --rig <rig.npz> --model <id> --motion <truth.npz> [--frame N]");
		process.exit(2);
	}
	const result = checkRig({ ...args, frame: args.frame === undefined ? 40 : Number(args.frame) });
	console.log(JSON.stringify(result, null, 2));
	process.exit(result.pass ? 0 : 1);
}
