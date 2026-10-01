#!/usr/bin/env node
/**
 * export-rig.mjs — export a shipped Studio character rig for the known-character
 * tracker (plan mocap-rearch todo 3).
 *
 *   node tools/track/export-rig.mjs --model y-bot-tpose [--out <path.npz>]
 *
 * Loads public/models/<model>.fbx in node with three's FBXLoader exactly as
 * tools/bench/obs-bench.mjs characterStandingAnkle does (rig root scale 0.01,
 * bind pose primed like Studio's app-stage clone), and writes one npz with the
 * merged skinned mesh (both SkinnedMeshes, rest pose, metres), the rig's
 * control bones, and the positional-skinning preparation playback.js
 * computes for this rig (prepOf), plus the canonical cskel27 skeleton. Array
 * layout and units: tools/track/rig-dump.mjs.
 *
 * Mixamo FBX nests an identity copy of every bone under its control bone and
 * a mesh's skeleton may reference either; playback only ever writes control
 * bones, so every skeleton bone is canonicalised onto the control bone of the
 * same name (the copy's local transform is asserted to be identity).
 *
 * Default output: node_modules/.cache/cozyfit/rig-<model>.npz (never committed).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { writeNpz } from "../ardy/npz.mjs";
import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "../../src/ardy/cskel27.js";
import { CSKEL27_NEUTRAL } from "../../src/ardy/cskel27-neutral.js";
import { ARDY_NEUTRAL_MIN_Y, GIRDLE_JOINTS, HIERARCHY_PRESERVED_JOINTS, prepOf } from "../../src/ardy/playback.js";
import { primeBindPose } from "../../src/poses.js";
import { CHARACTER_MODEL_IDS } from "../../src/scenes.js";
import { rigArraysFromDump, RIG_DUMP_VERSION } from "./rig-dump.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const ROOT_SCALE = 0.01; // app-stage.jsx: model.scale = 0.01 * character scale (1)
const BIND_TOLERANCE = 1e-5;

/** 4x4 row-major list from a three.js (column-major) Matrix4. */
const rowMajor = (m) => m.clone().transpose().toArray();
const vec = (v) => (v ? [v.x, v.y, v.z] : null);
const quat = (q) => (q ? [q.x, q.y, q.z, q.w] : null);

export function modelPath(model) {
	if (!CHARACTER_MODEL_IDS.includes(model)) {
		throw new Error(`unknown character model: ${model} (known: ${CHARACTER_MODEL_IDS.join(", ")})`);
	}
	const path = ["public", "dist"].map((d) => join(ROOT, d, "models", `${model}.fbx`)).find(existsSync);
	if (!path) throw new Error(`character model ${model}.fbx not found under public/models or dist/models`);
	return path;
}

/** The Studio rig as the app holds it: FBX parse, 0.01 root scale, primed bind. */
export function loadRig(path) {
	const bytes = readFileSync(path);
	const rig = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
	rig.scale.setScalar(ROOT_SCALE);
	primeBindPose(rig);
	rig.updateMatrixWorld(true);
	return { rig, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const isIdentityLocal = (bone) =>
	bone.position.lengthSq() < 1e-12 &&
	Math.abs(Math.abs(bone.quaternion.w) - 1) < 1e-9 &&
	bone.scale.distanceToSquared(new THREE.Vector3(1, 1, 1)) < 1e-12;

/** Plain-JSON dump of a loaded, untouched rig (rigArraysFromDump input). */
export function dumpRig(rig, { model = null, source = null } = {}) {
	rig.updateMatrixWorld(true);

	// Control bones: the first depth-first bone of every name (playback's findBone rule).
	const control = [];
	const byName = new Map();
	rig.traverse((node) => {
		if (node.isBone && !byName.has(node.name)) {
			byName.set(node.name, control.length);
			control.push(node);
		}
	});
	const indexOf = new Map(control.map((bone, i) => [bone, i]));
	const canonical = (bone) => {
		const i = byName.get(bone.name);
		if (i === undefined) throw new Error(`bone ${bone.name} has no control bone`);
		if (control[i] !== bone) {
			// A nested copy: only valid when it sits (transitively) at its control bone.
			for (let node = bone; node !== control[i]; node = node.parent) {
				if (!node || !node.isBone || !isIdentityLocal(node)) {
					throw new Error(`skeleton bone ${bone.name} is not an identity copy of its control bone`);
				}
			}
		}
		return i;
	};
	const parentIndex = (bone) => {
		for (let node = bone.parent; node && node !== rig; node = node.parent) {
			if (node.isBone && indexOf.has(node)) return indexOf.get(node);
		}
		return -1;
	};
	const bones = control.map((bone) => {
		const world = bone.matrixWorld.clone();
		return {
			name: bone.name,
			parent: parentIndex(bone),
			restLocal: rowMajor(bone.matrix),
			restWorld: rowMajor(world),
			bindInverse: rowMajor(world.clone().invert()),
		};
	});

	const meshes = [];
	let maxBindDeviation = 0;
	rig.traverse((node) => {
		if (!node.isSkinnedMesh) return;
		const { geometry, skeleton } = node;
		const remap = skeleton.bones.map(canonical);
		// Studio's skinning uses bone.matrixWorld @ boneInverse; the export's
		// world-space LBS uses controlWorld @ inverse(controlWorld at rest). The
		// two agree only when every bone's rest product is the same matrix.
		const reference = new THREE.Matrix4().multiplyMatrices(skeleton.bones[0].matrixWorld, skeleton.boneInverses[0]).multiply(node.bindMatrix);
		skeleton.bones.forEach((bone, k) => {
			const product = new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, skeleton.boneInverses[k]).multiply(node.bindMatrix);
			product.elements.forEach((x, e) => { maxBindDeviation = Math.max(maxBindDeviation, Math.abs(x - reference.elements[e])); });
		});
		const count = geometry.attributes.position.count;
		const vertices = new Array(count * 3);
		const skinIndex = new Array(count * 4);
		const skinWeight = new Array(count * 4);
		const p = new THREE.Vector3();
		const si = geometry.attributes.skinIndex;
		const sw = geometry.attributes.skinWeight;
		for (let v = 0; v < count; v += 1) {
			node.getVertexPosition(v, p).applyMatrix4(node.matrixWorld);
			vertices[v * 3] = p.x; vertices[v * 3 + 1] = p.y; vertices[v * 3 + 2] = p.z;
			for (let k = 0; k < 4; k += 1) {
				const w = sw.getComponent(v, k);
				skinWeight[v * 4 + k] = w;
				// A zero-weight slot's index is irrelevant; point it at a real bone.
				skinIndex[v * 4 + k] = w === 0 ? remap[0] : remap[si.getComponent(v, k)];
			}
		}
		const faces = geometry.index
			? Array.from(geometry.index.array)
			: Array.from({ length: count }, (_, i) => i);
		meshes.push({ name: node.name, vertices, faces, skinIndex, skinWeight });
	});
	if (meshes.length === 0) throw new Error("rig has no skinned mesh");
	if (maxBindDeviation > BIND_TOLERANCE) {
		throw new Error(`bind pose is not the rest pose (max boneWorld*boneInverse deviation ${maxBindDeviation})`);
	}

	const prep = prepOf(rig);
	const boneOf = (bone) => {
		if (!bone) return -1;
		if (!indexOf.has(bone)) throw new Error(`prep bone ${bone.name} is not a control bone`);
		return indexOf.get(bone);
	};
	const mat = (m) => (m ? rowMajor(m) : null);
	return {
		version: RIG_DUMP_VERSION,
		model,
		source,
		rootScale: ROOT_SCALE,
		bones,
		meshes,
		prep: {
			bones: prep.bones.map(boneOf),
			scale: prep.scale,
			offsets: prep.offsets.map(vec),
			bindPos: prep.bindPos.map(vec),
			bindQuat: prep.bindQuat.map(quat),
			bindScale: prep.bindScale.map(vec),
			bindLocalPos: prep.bindLocalPos.map(vec),
			parentBindWorld: prep.parentBindWorld.map(mat),
			chainParent: [...prep.chainParent],
			chainRel: prep.chainRel.map(mat),
			canonicalBoneLength: [...prep.canonicalBoneLength],
			rigBoneLength: [...prep.rigBoneLength],
			stretchedLeaves: prep.stretchedLeaves.map((leaf) => ({
				bone: boneOf(leaf.bone),
				joint: leaf.joint,
				bindLocalPos: vec(leaf.bindLocalPos),
				bindLocalQuat: quat(leaf.bindLocalQuat),
			})),
			hierarchyPreserved: [...HIERARCHY_PRESERVED_JOINTS],
			girdleJoints: [...GIRDLE_JOINTS],
			ardyNeutralMinY: ARDY_NEUTRAL_MIN_Y,
		},
		cskel27: {
			joints: [...CSKEL27_JOINTS],
			parents: CSKEL27_PARENTS.map((p) => (p === null ? -1 : p)),
			neutral: CSKEL27_NEUTRAL.map((row) => [...row]),
		},
		maxBindDeviation,
	};
}

/** Export `model` to `out`; returns a summary. The file is replaced atomically. */
export function exportRig(model, out) {
	const path = modelPath(model);
	const { rig, sha256 } = loadRig(path);
	const dump = dumpRig(rig, { model, source: { fbx: relative(ROOT, path), sha256 } });
	const { members } = rigArraysFromDump(dump);
	mkdirSync(dirname(out), { recursive: true });
	const partial = `${out}.partial-${process.pid}`;
	try {
		writeNpz(partial, members);
		renameSync(partial, out);
	} finally {
		rmSync(partial, { force: true });
	}
	return {
		model,
		out,
		bytes: statSync(out).size,
		vertices: members.vertices.shape[0],
		faces: members.faces.shape[0],
		bones: members.bone_parent.shape[0],
		meshes: dump.meshes.map((m) => `${m.name}:${m.vertices.length / 3}`),
		mappedJoints: dump.prep.bones.filter((b) => b >= 0).length,
		prepScale: dump.prep.scale,
		maxBindDeviation: dump.maxBindDeviation,
	};
}

function parseArgs(argv) {
	const args = { model: null, out: null };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		if ((flag === "--model" || flag === "--out") && value && !value.startsWith("--")) {
			args[flag.slice(2)] = value;
			i += 1;
		} else {
			throw new Error(`usage: export-rig.mjs --model <${CHARACTER_MODEL_IDS.join("|")}> [--out <path.npz>] (bad argument ${flag})`);
		}
	}
	if (!args.model) throw new Error("usage: export-rig.mjs --model <id> [--out <path.npz>] (--model is required)");
	args.out = resolve(args.out ?? join(ROOT, "node_modules/.cache/cozyfit", `rig-${args.model}.npz`));
	return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	try {
		const { model, out } = parseArgs(process.argv.slice(2));
		const summary = exportRig(model, out);
		console.log(JSON.stringify(summary, null, 2));
	} catch (error) {
		console.error(`export-rig: ${error.message}`);
		process.exit(1);
	}
}
