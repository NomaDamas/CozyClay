/**
 * rig-dump.mjs — pack a plain-JSON Studio rig dump (tools/track/export-rig.mjs
 * `dumpRig`, or the synthetic fixture test/fixtures/track-rig-dump.json) into
 * the numpy members the tracker reads (todo 6, tools/track/py/rig.py).
 *
 * Pure: no three.js, no filesystem. Everything is validated here so a bad dump
 * fails loudly instead of producing a rig the tracker silently mis-skins.
 *
 * Conventions of the packed arrays (also recorded in `meta_json`):
 *   - matrices are 4x4 ROW-major (numpy order, M @ [x, y, z, 1]); quaternions
 *     are [x, y, z, w] (three.js order).
 *   - `vertices`, `bone_rest_world`, `bone_bind_inverse`: metres, world space
 *     of the Studio rig at rest (rig root at the origin with its 0.01
 *     centimetre scale, Character scale 1, no clip-to-scene yaw). Skinning:
 *       v(pose) = sum_k w_k * boneWorld_k(pose) @ bone_bind_inverse_k @ v_rest
 *   - `bone_rest_local` and every `prep_*` array: rig units (the space BELOW
 *     the rig root, Mixamo centimetres), exactly the values
 *     src/ardy/playback.js prepOf/applyMotionFrame compute with;
 *     `rig_root_scale` (0.01) maps rig units to metres.
 *   - cskel27-indexed arrays have 27 rows; rows of joints that drive no bone
 *     are zero (vectors) / identity (matrices) with prep_bone = -1.
 *   - `meta_json` is the UTF-8 bytes of a JSON document (names, conventions),
 *     stored as int32 because writeNpz carries only float32/int32:
 *       json.loads(bytes(z["meta_json"].astype("uint8")))
 */

export const RIG_DUMP_VERSION = 1;
const CSKEL = 27;
const INFLUENCES = 4;
const WEIGHT_TOLERANCE = 1e-5;

const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function fail(code, detail) {
	throw new Error(`${code}: ${detail}`);
}

function finiteList(value, length, label) {
	if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) {
		fail("bad-rig-dump", `${label} must be ${length} finite numbers`);
	}
	return value;
}

/** Rows of a cskel27-indexed field; null rows become `fill`. */
function jointRows(rows, width, fill, label) {
	if (!Array.isArray(rows) || rows.length !== CSKEL) fail("bad-rig-dump", `${label} must have ${CSKEL} rows`);
	const out = new Float32Array(CSKEL * width);
	rows.forEach((row, j) => out.set(finiteList(row ?? fill, width, `${label}[${j}]`), j * width));
	return out;
}

function intList(value, length, label, min, max) {
	if (!Array.isArray(value) || value.length !== length || !value.every((v) => Number.isInteger(v) && v >= min && v < max)) {
		fail("bad-rig-dump", `${label} must be ${length} integers in [${min}, ${max})`);
	}
	return Int32Array.from(value);
}

function nameMask(names, label, joints) {
	if (!Array.isArray(names)) fail("bad-rig-dump", `${label} must be a list of cskel27 names`);
	const mask = new Int32Array(CSKEL);
	for (const name of names) {
		const j = joints.indexOf(name);
		if (j < 0) fail("bad-rig-dump", `${label}: ${name} is not a cskel27 joint`);
		mask[j] = 1;
	}
	return mask;
}

const member = (data, shape) => ({ data, shape });

/**
 * dump -> { members, meta }. `members` goes straight into
 * tools/ardy/npz.mjs writeNpz; `meta` is the decoded meta_json document.
 */
export function rigArraysFromDump(dump) {
	if (!dump || dump.version !== RIG_DUMP_VERSION) fail("bad-rig-dump", `version must be ${RIG_DUMP_VERSION}`);
	const { bones, meshes, prep, cskel27 } = dump;
	if (!(dump.rootScale > 0)) fail("bad-rig-dump", "rootScale must be positive");

	// --- cskel27 reference --------------------------------------------------
	if (!cskel27 || !Array.isArray(cskel27.joints) || cskel27.joints.length !== CSKEL) {
		fail("bad-rig-dump", `cskel27.joints must list ${CSKEL} joints`);
	}
	const cskelParents = intList(cskel27.parents, CSKEL, "cskel27.parents", -1, CSKEL);
	cskelParents.forEach((p, j) => { if (p >= j) fail("bad-rig-dump", `cskel27 parent ${p} of joint ${j} is not topological`); });
	const neutral = jointRows(cskel27.neutral, 3, null, "cskel27.neutral");

	// --- bones ---------------------------------------------------------------
	if (!Array.isArray(bones) || bones.length === 0) fail("bad-rig-dump", "bones must be a non-empty list");
	const B = bones.length;
	const boneParent = new Int32Array(B);
	const restLocal = new Float32Array(B * 16);
	const restWorld = new Float32Array(B * 16);
	const bindInverse = new Float32Array(B * 16);
	bones.forEach((bone, i) => {
		if (typeof bone.name !== "string" || !bone.name) fail("bad-rig-dump", `bones[${i}].name missing`);
		if (!Number.isInteger(bone.parent) || bone.parent < -1 || bone.parent >= i) {
			fail("bone-order", `bone ${i} (${bone.name}) has parent ${bone.parent}; parents must precede children`);
		}
		boneParent[i] = bone.parent;
		restLocal.set(finiteList(bone.restLocal, 16, `bones[${i}].restLocal`), i * 16);
		restWorld.set(finiteList(bone.restWorld, 16, `bones[${i}].restWorld`), i * 16);
		bindInverse.set(finiteList(bone.bindInverse, 16, `bones[${i}].bindInverse`), i * 16);
	});
	const boneNames = bones.map((b) => b.name);
	if (new Set(boneNames).size !== B) fail("bad-rig-dump", "bone names must be unique");

	// --- merged mesh -----------------------------------------------------------
	if (!Array.isArray(meshes) || meshes.length === 0) fail("bad-rig-dump", "meshes must be a non-empty list");
	let V = 0;
	let F = 0;
	for (const [m, mesh] of meshes.entries()) {
		const n = mesh.vertices?.length / 3;
		if (!Number.isInteger(n) || n < 3) fail("bad-rig-dump", `meshes[${m}].vertices must be a flat xyz list`);
		if (!Number.isInteger(mesh.faces?.length / 3)) fail("bad-rig-dump", `meshes[${m}].faces must be a flat triangle list`);
		V += n;
		F += mesh.faces.length / 3;
	}
	const vertices = new Float32Array(V * 3);
	const faces = new Int32Array(F * 3);
	const skinIndex = new Int32Array(V * INFLUENCES);
	const skinWeight = new Float32Array(V * INFLUENCES);
	const meshRanges = new Int32Array(meshes.length * 4);
	let v0 = 0;
	let f0 = 0;
	for (const [m, mesh] of meshes.entries()) {
		const n = mesh.vertices.length / 3;
		const nf = mesh.faces.length / 3;
		vertices.set(finiteList(mesh.vertices, n * 3, `meshes[${m}].vertices`), v0 * 3);
		faces.set(intList(mesh.faces, nf * 3, `meshes[${m}].faces`, 0, n).map((i) => i + v0), f0 * 3);
		skinIndex.set(intList(mesh.skinIndex, n * INFLUENCES, `meshes[${m}].skinIndex`, 0, B), v0 * INFLUENCES);
		skinWeight.set(finiteList(mesh.skinWeight, n * INFLUENCES, `meshes[${m}].skinWeight`), v0 * INFLUENCES);
		meshRanges.set([v0, n, f0, nf], m * 4);
		v0 += n;
		f0 += nf;
	}
	for (let v = 0; v < V; v += 1) {
		let sum = 0;
		for (let k = 0; k < INFLUENCES; k += 1) {
			const w = skinWeight[v * INFLUENCES + k];
			if (w < 0) fail("bad-skin-weights", `vertex ${v} has negative weight ${w}`);
			sum += w;
		}
		if (Math.abs(sum - 1) > WEIGHT_TOLERANCE) fail("bad-skin-weights", `vertex ${v} weights sum to ${sum}`);
	}

	// --- Studio positional-skinning prep (playback.js prepOf) ------------------
	if (!prep) fail("bad-rig-dump", "prep missing");
	const prepBone = intList(prep.bones, CSKEL, "prep.bones", -1, B);
	if (!prepBone.some((b) => b >= 0)) fail("bad-rig-dump", "prep.bones maps no cskel27 joint to a bone");
	const chainParent = intList(prep.chainParent, CSKEL, "prep.chainParent", -1, CSKEL);
	chainParent.forEach((p, j) => {
		if (p >= 0 && (p >= j || prepBone[p] < 0 || prepBone[j] < 0)) fail("bad-rig-dump", `prep.chainParent[${j}]=${p} must be an earlier mapped joint`);
	});
	if (!(prep.scale > 0)) fail("bad-rig-dump", "prep.scale must be positive");
	const leaves = prep.stretchedLeaves;
	if (!Array.isArray(leaves)) fail("bad-rig-dump", "prep.stretchedLeaves must be a list");
	const leafIndex = new Int32Array(leaves.length * 2);
	const leafPos = new Float32Array(leaves.length * 3);
	const leafQuat = new Float32Array(leaves.length * 4);
	leaves.forEach((leaf, i) => {
		leafIndex.set(intList([leaf.bone], 1, `prep.stretchedLeaves[${i}].bone`, 0, B), i * 2);
		leafIndex.set(intList([leaf.joint], 1, `prep.stretchedLeaves[${i}].joint`, 0, CSKEL), i * 2 + 1);
		leafPos.set(finiteList(leaf.bindLocalPos, 3, `prep.stretchedLeaves[${i}].bindLocalPos`), i * 3);
		leafQuat.set(finiteList(leaf.bindLocalQuat, 4, `prep.stretchedLeaves[${i}].bindLocalQuat`), i * 4);
	});
	const hierarchyPreserved = nameMask(prep.hierarchyPreserved, "prep.hierarchyPreserved", cskel27.joints);
	const girdle = nameMask(prep.girdleJoints, "prep.girdleJoints", cskel27.joints);
	if (!Number.isFinite(prep.ardyNeutralMinY)) fail("bad-rig-dump", "prep.ardyNeutralMinY must be finite");

	const meta = {
		version: RIG_DUMP_VERSION,
		model: dump.model ?? null,
		source: dump.source ?? null,
		boneNames,
		meshNames: meshes.map((m) => m.name ?? ""),
		cskel27Joints: cskel27.joints,
		hierarchyPreservedJoints: prep.hierarchyPreserved,
		girdleJoints: prep.girdleJoints,
		conventions: {
			matrices: "4x4 row-major, M @ [x, y, z, 1]",
			quaternions: "[x, y, z, w]",
			worldArrays: "vertices, bone_rest_world, bone_bind_inverse: metres, Studio world at rest (rig root scale applied, Character scale 1)",
			rigArrays: "bone_rest_local, prep_*: rig units below the rig root; multiply by rig_root_scale for metres",
			skinning: "v = sum_k w_k * boneWorld_k @ bone_bind_inverse_k @ v_rest",
			meshRanges: "mesh_ranges[m] = [vertexStart, vertexCount, faceStart, faceCount]",
		},
	};
	const metaBytes = Int32Array.from(new TextEncoder().encode(JSON.stringify(meta)));

	const members = {
		meta_json: member(metaBytes, [metaBytes.length]),
		rig_root_scale: member(Float32Array.of(dump.rootScale), [1]),
		vertices: member(vertices, [V, 3]),
		faces: member(faces, [F, 3]),
		skin_index: member(skinIndex, [V, INFLUENCES]),
		skin_weight: member(skinWeight, [V, INFLUENCES]),
		mesh_ranges: member(meshRanges, [meshes.length, 4]),
		bone_parent: member(boneParent, [B]),
		bone_rest_local: member(restLocal, [B, 4, 4]),
		bone_rest_world: member(restWorld, [B, 4, 4]),
		bone_bind_inverse: member(bindInverse, [B, 4, 4]),
		prep_bone: member(prepBone, [CSKEL]),
		prep_scale: member(Float32Array.of(prep.scale), [1]),
		prep_offsets: member(jointRows(prep.offsets, 3, [0, 0, 0], "prep.offsets"), [CSKEL, 3]),
		prep_bind_pos: member(jointRows(prep.bindPos, 3, [0, 0, 0], "prep.bindPos"), [CSKEL, 3]),
		prep_bind_quat: member(jointRows(prep.bindQuat, 4, [0, 0, 0, 1], "prep.bindQuat"), [CSKEL, 4]),
		prep_bind_scale: member(jointRows(prep.bindScale, 3, [1, 1, 1], "prep.bindScale"), [CSKEL, 3]),
		prep_bind_local_pos: member(jointRows(prep.bindLocalPos, 3, [0, 0, 0], "prep.bindLocalPos"), [CSKEL, 3]),
		prep_parent_bind_world: member(jointRows(prep.parentBindWorld, 16, IDENTITY16, "prep.parentBindWorld"), [CSKEL, 4, 4]),
		prep_chain_parent: member(chainParent, [CSKEL]),
		prep_chain_rel: member(jointRows(prep.chainRel, 16, IDENTITY16, "prep.chainRel"), [CSKEL, 4, 4]),
		prep_canonical_bone_length: member(Float32Array.from(finiteList(prep.canonicalBoneLength, CSKEL, "prep.canonicalBoneLength")), [CSKEL]),
		prep_rig_bone_length: member(Float32Array.from(finiteList(prep.rigBoneLength, CSKEL, "prep.rigBoneLength")), [CSKEL]),
		prep_stretched_leaves: member(leafIndex, [leaves.length, 2]),
		prep_stretched_leaf_local_pos: member(leafPos, [leaves.length, 3]),
		prep_stretched_leaf_local_quat: member(leafQuat, [leaves.length, 4]),
		hierarchy_preserved: member(hierarchyPreserved, [CSKEL]),
		girdle_joints: member(girdle, [CSKEL]),
		ardy_neutral_min_y: member(Float32Array.of(prep.ardyNeutralMinY), [1]),
		cskel27_parents: member(cskelParents, [CSKEL]),
		cskel27_neutral: member(neutral, [CSKEL, 3]),
	};
	return { members, meta };
}
