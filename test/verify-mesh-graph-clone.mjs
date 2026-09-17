#!/usr/bin/env node
// Mesh props with a skeleton must clone through SkeletonUtils so the
// instance's bones stay bound. Unskinned graphs keep Object3D.clone(true).
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { cloneMeshGraph, graphHasSkinnedMesh } from "../src/mesh-graph-clone.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const geo = new THREE.BoxGeometry(1, 1, 1);
const unskinned = new THREE.Group();
unskinned.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial()));
expect("an unskinned group is not a skinned graph", graphHasSkinnedMesh(unskinned) === false);
const unskinnedClone = cloneMeshGraph(unskinned);
expect("an unskinned clone is a new root", unskinnedClone !== unskinned && unskinnedClone.isGroup);
expect("an unskinned clone's mesh is not the source mesh", unskinnedClone.children[0] !== unskinned.children[0]);
expect("an unskinned clone shares geometry the same way clone(true) does", unskinnedClone.children[0].geometry === unskinned.children[0].geometry);

const bone = new THREE.Bone();
bone.name = "root";
const skin = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
skin.add(bone);
skin.bind(new THREE.Skeleton([bone]));
const skinned = new THREE.Group();
skinned.add(skin);
expect("a group with a SkinnedMesh is a skinned graph", graphHasSkinnedMesh(skinned) === true);
const skinnedClone = cloneMeshGraph(skinned);
expect("a skinned clone is a new root", skinnedClone !== skinned);
expect("a skinned clone's mesh is a SkinnedMesh", skinnedClone.children[0]?.isSkinnedMesh === true);
expect(
	"a skinned clone gets its own skeleton — Object3D.clone(true) would share the source bones",
	skinnedClone.children[0].skeleton !== skin.skeleton,
	`clone=${Boolean(skinnedClone.children[0]?.skeleton)} source=${Boolean(skin.skeleton)}`,
);

const propsSource = readFileSync(new URL("../src/props.jsx", import.meta.url), "utf8");
expect(
	"instantiateMesh clones through cloneMeshGraph, not a raw source.clone(true)",
	propsSource.includes("cloneMeshGraph(source)") && !/source\.clone\(true\)/.test(propsSource),
);

if (failures) process.exit(1);
console.log("all mesh graph clone checks PASS");
