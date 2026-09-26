// The mannequin's face marks are the only heading cue the 2D pose estimator
// gets (#380): fal rendered the single eye band as one visor slot, so ViTPose
// read the L/R eyes 5.6 px apart and swapped them on 74 % of frames. Two
// eyes, laterally separated, are the fix; this pins that geometry.
import assert from "node:assert/strict";
import * as THREE from "three";
import { facingMarkSpecs, addFacingMarks } from "../src/facing-marks.js";

const specs = facingMarkSpecs();
const eyes = specs.filter((s) => s.role === "eye");
assert.equal(eyes.length, 2, "two eye marks");
const [l, r] = eyes.map((s) => s.position[0]).sort((a, b) => a - b);
assert.ok(l < 0 && r > 0, "eyes sit either side of the face centreline");
// >= 5 head-units apart: at the fal reference distance the head is ~35 px
// over a ~20-unit skull, so 5 units reads as >= ~9 px between eye centres.
assert.ok(r - l >= 5, `eye separation ${r - l} >= 5 units`);
assert.ok(specs.some((s) => s.role === "nose"), "nose mark kept");

// Attached to a head bone, the marks become that bone's children.
const head = new THREE.Bone(); head.name = "mixamorigHead";
const root = new THREE.Group(); root.add(head);
addFacingMarks(root);
const meshes = head.children.filter((c) => c.isMesh);
assert.equal(meshes.length, specs.length, "every spec becomes a mesh on the head bone");
console.log("verify-facing-marks: ok");
