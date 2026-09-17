#!/usr/bin/env node
/** Three-free mesh classification for MCP import_mesh: fixtures, not loaders. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/mesh-sniff.js", import.meta.url), "utf8");
assert.equal(/\bfrom ["']three/.test(source), false, "mesh-sniff.js must not import three");
assert.equal(/\bfrom ["']three\//.test(source), false, "mesh-sniff.js must not import three addons");

const { classifyMeshBytes, meshMimeForKind } = await import("../src/mesh-sniff.js");
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

assert.equal(classifyMeshBytes(fixture("unit-cube.glb")), "glb");
assert.equal(classifyMeshBytes(fixture("unit-cube.obj")), "obj");
assert.equal(classifyMeshBytes(fixture("unit-cube.fbx")), "fbx", "ASCII FBX must classify as fbx");
assert.equal(classifyMeshBytes(Buffer.from("not a model\n")), null);
assert.equal(classifyMeshBytes(Buffer.from("v 0 1 2\n")), "obj");

const binaryMagic = Buffer.from("Kaydara FBX Binary  \0", "latin1");
assert.equal(classifyMeshBytes(binaryMagic), "fbx");

const oldAscii = Buffer.from("; FBX 6.1.0 project file\nFBXVersion: 6100\n");
assert.equal(classifyMeshBytes(oldAscii), "fbx-old");

assert.equal(meshMimeForKind("glb"), "model/gltf-binary");
assert.equal(meshMimeForKind("obj"), "model/obj");
assert.equal(meshMimeForKind("fbx"), "model/fbx");
console.log("PASS verify-mesh-sniff: glTF/OBJ/ASCII-FBX/binary-FBX/old-FBX without three");
