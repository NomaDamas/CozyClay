// Real-surface check: CozyClay's own decodeMotionNpz + applyMotionFrame (src/ardy/playback.js) drive the x-bot FBX loaded with
// three FBXLoader; compare each driven bone's world position with MorphGS joints_warped. usage: node playback-check.mjs <take.npz> <pred_joints.npy> <rig.txt>
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
globalThis.window ??= { innerWidth: 1920, innerHeight: 1080, URL };
const COZY = process.env.COZYCLAY ?? `${process.env.HOME}/CozyClay`;
const { decodeMotionNpz } = await import(`${COZY}/src/ardy/npz.js`);
const { applyMotionFrame } = await import(`${COZY}/src/ardy/playback.js`);
const [npzPath, pjPath, rigPath] = process.argv.slice(2);
const motion = await decodeMotionNpz(new Uint8Array(readFileSync(npzPath)));
const b = readFileSync(pjPath), hl = b.readUInt16LE(8), pj = new Float32Array(b.buffer.slice(b.byteOffset + 10 + hl, b.byteOffset + b.length));
const names = readFileSync(rigPath, "utf8").split("\n").map((l) => l.trim().split(/\s+/)).filter((t) => t.length === 5 && t[0] !== "fixed_joint").map((t) => t[0]);
const J = names.length, X = (f, n) => [0, 1, 2].map((a) => pj[(f * J + names.indexOf(n)) * 3 + a] * 100); // cm, x-bot frame
const fbx = readFileSync(`${COZY}/public/models/x-bot-tpose.fbx`);
const rig = new FBXLoader().parse(fbx.buffer.slice(fbx.byteOffset, fbx.byteOffset + fbx.byteLength), "");
rig.updateMatrixWorld(true);
const bone = (n) => { let hit = null; rig.traverse((o) => { if (!hit && o.isBone && o.name === `mixamorig${n}`) hit = o; }); return hit; };
const CHECK = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "HeadTop_End", ...["Left", "Right"].flatMap((s) =>
	["Shoulder", "Arm", "ForeArm", "Hand", "HandMiddle1", "UpLeg", "Leg", "Foot", "ToeBase", "Toe_End"].map((b) => s + b))];
const err = Object.fromEntries(CHECK.map((n) => [n, 0])); let off = null;
for (let f = 0; f < motion.frames; f++) {
	applyMotionFrame(rig, motion, f);
	const W = (n) => new THREE.Vector3().setFromMatrixPosition(bone(n).matrixWorld).toArray();
	if (f === 0) off = W("Hips").map((v, a) => (a === 1 ? 0 : v - X(0, "Hips")[a])); // playback anchors frame-0 root XZ at the origin
	for (const n of CHECK) { const x = X(f, n.replace("HandMiddle1", "HandEnd")), w = W(n);
		err[n] = Math.max(err[n], Math.hypot(...w.map((v, a) => v - off[a] - x[a]))); }
}
for (const n of CHECK) console.log(`${n.padEnd(18)} ${err[n].toFixed(3).padStart(8)} cm`);
console.log(`frames=${motion.frames} boneScale=${motion.boneScale ? "yes" : "no"} MAX=${Math.max(...Object.values(err)).toFixed(3)} cm`);
