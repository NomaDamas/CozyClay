#!/usr/bin/env node
// x-bot FBX -> MorphGS target: <out>/mesh.obj + <out>/rigging/mesh_ori_rig.txt (compact format, no skin -> heat skinning)
// usage: node fbx2morphgs.mjs <in.fbx> <outDir> [--all-bones]
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
globalThis.window ??= { innerWidth: 1920, innerHeight: 1080, URL };

const [inPath, outDir] = process.argv.slice(2);
const allBones = process.argv.includes("--all-bones");
const FIXED_JOINTS = ["Spine", "LeftUpLeg", "RightUpLeg", "Neck", "LeftShoulder", "RightShoulder", "LeftHandEnd", "RightHandEnd"];
const SCALE = 0.01; // FBX is centimetres -> metres; Y-up, faces +Z already (pytorch3d look_at defaults)
const buf = readFileSync(inPath);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
root.updateMatrixWorld(true);

// Control skeleton = skinned skeleton whose root bone hangs off a non-bone (same rule as tools/ardy/extract-rest.mjs);
// FBXLoader also nests same-name zero-length copies of every bone, which must not reach the rig (zero-length bone -> NaN).
const meshes = [];
root.traverse((o) => o.isSkinnedMesh && meshes.push(o));
const skel = meshes.find((m) => m.skeleton.bones.some((b) => !b.parent?.isBone)).skeleton;
const bones = skel.bones.filter((b, i, a) => a.findIndex((c) => c.name === b.name) === i);
const strip = (n) => n.replace(/^mixamorig:?/, "");
const KEEP = new Set(["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "HeadTop_End",
	...["Left", "Right"].flatMap((s) => [`${s}Shoulder`, `${s}Arm`, `${s}ForeArm`, `${s}Hand`, `${s}HandMiddle1`,
		`${s}UpLeg`, `${s}Leg`, `${s}Foot`, `${s}ToeBase`, `${s}Toe_End`])]);
const kept = bones.filter((b) => allBones || KEEP.has(strip(b.name)));
const keptSet = new Set(kept);
const pos = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).multiplyScalar(SCALE);
const lines = kept.map((b) => {
	let p = b.parent;
	while (p?.isBone && !keptSet.has(p)) p = p.parent; // skip dropped joints (fingers) up to nearest kept ancestor
	const name = allBones ? strip(b.name) : strip(b.name).replace(/HandMiddle1$/, "HandEnd");
	const v = pos(b);
	return { b, name, line: `${name} ${v.x.toFixed(6)} ${v.y.toFixed(6)} ${v.z.toFixed(6)} ` };
});
const nameOf = new Map(lines.map((l) => [l.b, l.name]));
const rig = lines.map(({ b, line }) => {
	let p = b.parent;
	while (p?.isBone && !keptSet.has(p)) p = p.parent;
	return line + (p?.isBone ? nameOf.get(p) : "-1");
});

// Mesh: skin every vertex at the loaded (T-)pose into world space, weld the triangle soup FBXLoader emits.
const soup = [];
const v = new THREE.Vector3();
for (const m of meshes) {
	const g = m.geometry;
	const idx = g.index ? g.index.array : null;
	const n = idx ? idx.length : g.attributes.position.count;
	for (let k = 0; k < n; k++) {
		m.getVertexPosition(idx ? idx[k] : k, v);
		v.applyMatrix4(m.matrixWorld).multiplyScalar(SCALE);
		soup.push(v.x, v.y, v.z);
	}
}
const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.Float32BufferAttribute(soup, 3));
const welded = mergeVertices(geo, 1e-5);
const P = welded.attributes.position.array, I = welded.index.array;
let obj = "";
for (let k = 0; k < P.length; k += 3) obj += `v ${P[k].toFixed(6)} ${P[k + 1].toFixed(6)} ${P[k + 2].toFixed(6)}\n`;
for (let k = 0; k < I.length; k += 3) obj += `f ${I[k] + 1} ${I[k + 1] + 1} ${I[k + 2] + 1}\n`;
mkdirSync(`${outDir}/rigging`, { recursive: true });
writeFileSync(`${outDir}/mesh.obj`, obj);
writeFileSync(`${outDir}/rigging/mesh_ori_rig.txt`, rig.join("\n") + `\nfixed_joint ${FIXED_JOINTS.join(" ")}\n`);
console.log(`meshes=${meshes.map((m) => m.name)} verts=${P.length / 3} faces=${I.length / 3} joints=${rig.length}`);
