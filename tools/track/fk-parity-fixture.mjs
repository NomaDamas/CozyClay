#!/usr/bin/env node
/**
 * fk-parity-fixture.mjs — Studio playback reference for the torch rig
 * (tools/track/py/rig.py, test_rig.py tests (a) and (e); plan mocap-rearch todo 6).
 *
 *   node tools/track/fk-parity-fixture.mjs [--model y-bot-tpose] [--out test/fixtures/track-fk-parity.json] [--seed 6]
 *
 * Loads the shipped FBX rig in node exactly like tools/track/export-rig.mjs,
 * drives it with src/ardy/playback.js applyMotionFrame on seeded random cskel27
 * poses, and records every control bone's world matrix (metres, 4x4 row-major,
 * rig at the origin with its 0.01 root scale) plus 200 fixed skinned vertices
 * (three's SkinnedMesh.getVertexPosition, indices into the export's merged
 * vertex array). Each case is a 2-frame motion: frame 0 is the anchor frame,
 * frame 1 is recorded, so anchoring is exercised. Cases 0-2 carry a per-joint
 * boneScale (mocap take: grown offsets, stretched arm chain and hands); case 3
 * has none (Studio's no-boneScale path, no stretch at all).
 * posedJoints come from tools/bench/fit/motion.mjs regenerateJoints (JS FK), so
 * the fixture also pins layer 1 (cskel27_fk) against the JS FK.
 *
 * Deterministic: a fixed-seed PRNG; numbers are float32 values printed with 9
 * significant digits (exact float32 round trip).
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three";
import { applyMotionFrame } from "../../src/ardy/playback.js";
import { canonicalCskel27Reference } from "../../src/ardy/to-cskel27.js";
import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "../../src/ardy/cskel27.js";
import { regenerateJoints } from "../bench/fit/motion.mjs";
import { loadRig, modelPath } from "./export-rig.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const J = 27;
const VERTEX_SAMPLES = 200;
const FIXTURE_VERSION = 1;

/** mulberry32: small, seedable, identical on every platform. */
export function prng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Uniform random axis, angle in [0, maxAngle], as a row-major 3x3 (three.js math). */
function randomRotation(rand, maxAngle) {
	const z = 2 * rand() - 1;
	const phi = 2 * Math.PI * rand();
	const r = Math.sqrt(1 - z * z);
	const axis = new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), z);
	const m = new THREE.Matrix4().makeRotationAxis(axis, maxAngle * rand());
	const e = m.elements; // column-major
	return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}

function randomPose(rand, rotMats, rootPos, f) {
	for (let j = 0; j < J; j += 1) {
		// Root: any heading plus a moderate tilt; limbs up to 70 degrees.
		let R = randomRotation(rand, j === 0 ? 0.35 : 1.2);
		if (j === 0) {
			const yaw = new THREE.Matrix4().makeRotationY(2 * Math.PI * rand() - Math.PI);
			const tilt = new THREE.Matrix4().set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1);
			const e = yaw.multiply(tilt).elements;
			R = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
		}
		rotMats.set(R, (f * J + j) * 9);
	}
	rootPos.set([4 * rand() - 2, 0.8 + 0.3 * rand(), 4 * rand() - 2], f * 3);
}

const f9 = (x) => Number(Math.fround(x).toPrecision(9));
const list = (a) => Array.from(a, f9);
const rowMajor = (m) => list(m.clone().transpose().toArray());

export function buildFixture({ model = "y-bot-tpose", seed = 6 } = {}) {
	const { rig, sha256 } = loadRig(modelPath(model));
	// Control bones and merged vertex order exactly as export-rig.mjs dumpRig.
	const control = [];
	const seen = new Set();
	rig.traverse((node) => { if (node.isBone && !seen.has(node.name)) { seen.add(node.name); control.push(node); } });
	const meshes = [];
	rig.traverse((node) => { if (node.isSkinnedMesh) meshes.push(node); });
	const counts = meshes.map((m) => m.geometry.attributes.position.count);
	const total = counts.reduce((a, b) => a + b, 0);

	const rand = prng(seed);
	const picked = new Set();
	while (picked.size < VERTEX_SAMPLES) picked.add(Math.floor(rand() * total));
	const vertexIndices = [...picked].sort((a, b) => a - b);
	const locate = (v) => {
		let m = 0;
		while (v >= counts[m]) { v -= counts[m]; m += 1; }
		return [meshes[m], v];
	};

	const cases = [];
	for (let c = 0; c < 4; c += 1) {
		const rotMats = new Float32Array(2 * J * 9);
		const rootPos = new Float32Array(2 * 3);
		for (let f = 0; f < 2; f += 1) randomPose(rand, rotMats, rootPos, f);
		const withScale = c < 3;
		const boneScale = Float32Array.from({ length: J }, (_, j) => (CSKEL27_PARENTS[j] === null ? 1 : 0.85 + 0.3 * rand()));
		const motion = regenerateJoints({ frames: 2, fps: 30, rotMats, rootPos, posedJoints: new Float32Array(2 * J * 3), boneScale: withScale ? boneScale : undefined, anchorFrame: 0 });
		if (!withScale) delete motion.boneScale;
		applyMotionFrame(rig, motion, 1);
		const p = new THREE.Vector3();
		cases.push({
			boneScale: withScale ? list(boneScale) : null,
			anchorFrame: 0,
			frame: 1,
			rotMats: list(rotMats),
			rootPos: list(rootPos),
			posedJoints: list(motion.posedJoints),
			boneWorld: control.flatMap((bone) => rowMajor(bone.matrixWorld)),
			vertices: vertexIndices.flatMap((v) => {
				const [mesh, local] = locate(v);
				mesh.getVertexPosition(local, p).applyMatrix4(mesh.matrixWorld);
				return [f9(p.x), f9(p.y), f9(p.z)];
			}),
		});
	}
	return {
		version: FIXTURE_VERSION,
		generator: "tools/track/fk-parity-fixture.mjs",
		model,
		fbxSha256: sha256,
		seed,
		units: "metres; matrices 4x4 row-major; rotMats row-major 3x3 per joint (npz local_rot_mats)",
		joints: [...CSKEL27_JOINTS],
		canonicalPosedJoints: canonicalCskel27Reference().posed_joints.map((row) => row.map(f9)),
		bones: control.map((bone) => bone.name),
		vertexIndices,
		cases,
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = { model: "y-bot-tpose", out: join(ROOT, "test/fixtures/track-fk-parity.json"), seed: 6 };
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i]?.replace(/^--/, "");
		if (!(key in args) || argv[i + 1] === undefined) {
			console.error("usage: fk-parity-fixture.mjs [--model <id>] [--out <path.json>] [--seed <int>]");
			process.exit(2);
		}
		args[key] = key === "seed" ? Number(argv[i + 1]) : argv[i + 1];
	}
	try {
		const fixture = buildFixture(args);
		writeFileSync(resolve(args.out), `${JSON.stringify(fixture)}\n`);
		console.log(JSON.stringify({ out: resolve(args.out), model: fixture.model, bones: fixture.bones.length, vertices: fixture.vertexIndices.length, cases: fixture.cases.length }));
	} catch (error) {
		console.error(`fk-parity-fixture: ${error.message}`);
		process.exit(1);
	}
}
