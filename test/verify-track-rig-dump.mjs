/**
 * tools/track/rig-dump.mjs rigArraysFromDump on the committed synthetic
 * 3-bone dump (test/fixtures/track-rig-dump.json): member shapes, merged-mesh
 * face offsets, skin weights, topological bone order, the 27-row cskel27
 * map, an npz write/read round trip, and the validation failures the
 * tracker relies on (bad weights, bone order, short cskel27 map).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeNpz } from "../tools/ardy/npz.mjs";
import { readNpz } from "../tools/kimodo/read-npz.mjs";
import { rigArraysFromDump } from "../tools/track/rig-dump.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/track-rig-dump.json", import.meta.url), "utf8"));
const clone = () => structuredClone(fixture);
let checks = 0;
const check = (label, fn) => { fn(); checks += 1; console.log(`PASS ${label}`); };

const { members, meta } = rigArraysFromDump(clone());
const shape = (name) => members[name].shape;

check("shapes of the merged mesh, bones and prep", () => {
	assert.deepEqual(shape("vertices"), [7, 3]);
	assert.deepEqual(shape("faces"), [3, 3]);
	assert.deepEqual(shape("skin_index"), [7, 4]);
	assert.deepEqual(shape("skin_weight"), [7, 4]);
	assert.deepEqual(shape("mesh_ranges"), [2, 4]);
	assert.deepEqual(shape("bone_parent"), [3]);
	for (const m of ["bone_rest_local", "bone_rest_world", "bone_bind_inverse"]) assert.deepEqual(shape(m), [3, 4, 4]);
	for (const m of ["prep_offsets", "prep_bind_pos", "prep_bind_scale", "prep_bind_local_pos", "cskel27_neutral"]) assert.deepEqual(shape(m), [27, 3]);
	for (const m of ["prep_parent_bind_world", "prep_chain_rel"]) assert.deepEqual(shape(m), [27, 4, 4]);
	assert.deepEqual(shape("prep_bind_quat"), [27, 4]);
	assert.deepEqual(shape("prep_stretched_leaves"), [1, 2]);
	for (const [name, { data, shape: s }] of Object.entries(members)) {
		assert.equal(data.length, s.reduce((a, b) => a * b, 1), name);
	}
});

check("second mesh faces are offset into the merged vertex array", () => {
	assert.deepEqual(Array.from(members.faces.data), [0, 1, 2, 2, 1, 3, 4, 5, 6]);
	assert.deepEqual(Array.from(members.mesh_ranges.data), [0, 4, 0, 2, 4, 3, 2, 1]);
	assert.deepEqual(meta.meshNames, ["Alpha_Surface", "Alpha_Joints"]);
});

check("skin weight rows sum to 1 and indices address bones", () => {
	const w = members.skin_weight.data;
	for (let v = 0; v < shape("skin_weight")[0]; v += 1) {
		assert.ok(Math.abs(w[v * 4] + w[v * 4 + 1] + w[v * 4 + 2] + w[v * 4 + 3] - 1) <= 1e-5, `vertex ${v}`);
	}
	assert.ok(members.skin_index.data.every((b) => b >= 0 && b < 3));
});

check("bone parents are topological and cskel27 maps have 27 rows", () => {
	members.bone_parent.data.forEach((p, i) => assert.ok(p < i));
	assert.equal(members.prep_bone.data.length, 27);
	assert.equal(members.cskel27_parents.data.length, 27);
	members.cskel27_parents.data.forEach((p, j) => assert.ok(p < j));
	assert.deepEqual(Array.from(members.prep_bone.data).filter((b) => b >= 0), [0, 1]);
	assert.equal(members.prep_chain_parent.data[2], 0);
	// null rows: identity matrices, zero vectors, identity quaternions
	assert.deepEqual(Array.from(members.prep_chain_rel.data.slice(0, 16)), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	assert.deepEqual(Array.from(members.prep_bind_quat.data.slice(4, 8)), [0, 0, 0, 1]);
	assert.equal(members.hierarchy_preserved.data.reduce((a, b) => a + b, 0), 6);
	assert.equal(members.girdle_joints.data.reduce((a, b) => a + b, 0), 4);
});

check("npz round trip keeps dtypes, shapes and meta_json", () => {
	const dir = mkdtempSync(join(tmpdir(), "track-rig-dump-"));
	try {
		const path = join(dir, "rig.npz");
		writeNpz(path, members);
		const back = readNpz(path);
		for (const [name, { data, shape: s }] of Object.entries(members)) {
			assert.deepEqual(back[name].shape, s, name);
			assert.equal(back[name].dtype, data instanceof Int32Array ? "<i4" : "<f4", name);
		}
		const decoded = JSON.parse(Buffer.from(Uint8Array.from(back.meta_json.data)).toString("utf8"));
		assert.deepEqual(decoded.boneNames, ["mixamorigHips", "mixamorigSpine", "mixamorigSpine1"]);
		assert.equal(decoded.cskel27Joints.length, 27);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

check("weights that do not sum to 1 are rejected", () => {
	const dump = clone();
	dump.meshes[1].skinWeight[0] = 0.9;
	assert.throws(() => rigArraysFromDump(dump), /^Error: bad-skin-weights: vertex 4/);
});

check("a child listed before its parent is rejected", () => {
	const dump = clone();
	dump.bones[1].parent = 2;
	assert.throws(() => rigArraysFromDump(dump), /^Error: bone-order/);
});

check("a short cskel27 map or out-of-range skin index is rejected", () => {
	const short = clone();
	short.prep.bones.pop();
	assert.throws(() => rigArraysFromDump(short), /prep\.bones must be 27/);
	const index = clone();
	index.meshes[0].skinIndex[0] = 3;
	assert.throws(() => rigArraysFromDump(index), /skinIndex must be/);
});

console.log(`verify-track-rig-dump: ${checks} checks passed`);
