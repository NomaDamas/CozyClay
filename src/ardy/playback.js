/**
 * Drive a CozyClay rig from a decoded ARDY motion (see npz.js) with
 * POSITIONAL SKINNING — the same method the viser demo's Mixamo avatar uses
 * (interactive_demo/mixamo_avatar.py compute_bone_transforms):
 *
 *     boneWorldPos[j]  = posed[f][j] + R[f][j] @ (mixamoBind[j] - ardyNeutral[j])
 *     boneWorldQuat[j] = R[f][j] @ bindQuat[j]
 *
 * where R[f][j] is the ARDY joint's GLOBAL rotation (FK over local_rot_mats)
 * and ardyNeutral is CoreSkeleton27's neutral pose (cskel27-neutral.js,
 * exported from the box). The Mixamo bind offset is measured against the
 * ARDY neutral joint, so no assumption about the rig's local rotation axes
 * or rest-frame orientation is ever made — the failure mode of the old
 * local-rotation retarget (basis = Rb^T @ L @ Rb), which rotated limbs
 * around slightly wrong axes and let the proportion gap drift the feet off
 * the npz's own contact points.
 *
 * Two deliberate deviations from the viser avatar, both scene-related:
 *
 *   1. Uniform scale s. The avatar assets are metre-scale like ARDY; the
 *      CozyClay rigs keep their own proportions instead of deforming onto
 *      the ARDY skeleton's. s = rig leg height / ARDY neutral leg height
 *      (measured per rig from the bind pose), so posed_joints map into rig
 *      units with feet planting exactly when the npz puts them on the floor.
 *   2. Anchoring. The viser demo plays every clip at its own origin;
 *      CozyClay anchors the clip's root to the blocking (waypoint /
 *      Subject 1 position). The whole clip is shifted so the anchor frame's
 *      root sits at the rig origin — the Character group stays static at the
 *      scene anchor during playback (rotation still comes from the group's
 *      `rot`, the clip-to-scene yaw), and the full root trajectory, vertical
 *      included, now lives in the bones.
 *
 * Joint->bone mapping follows the viser avatar (_MIXAMO_TO_CORE): Mixamo's
 * three spine bones map onto core Spine1/Spine2/Spine3 (core Spine and the
 * HandEnd leaves drive no bone — their motion folds into the mapped joints'
 * global transforms, and HeadTop_End/Toe_End/finger bones simply follow
 * their parents). Bones the map does not touch keep their bind transforms.
 * Shoulder and arm chains keep their Mixamo bind translations and consume
 * ARDY rotations only, avoiding clavicle shear between incongruent rigs.
 * Path-fix takes opt into a reference-pose correction: edited wrists retain
 * their rendered orientation and edited legs retain their rendered lengths.
 */

import * as THREE from "three";
import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "./cskel27.js";
import { CSKEL27_NEUTRAL } from "./cskel27-neutral.js";
import { globalRotations } from "./convert.js";
import { normalizeBoneName } from "../poses.js";

/** cskel27 joint -> Mixamo bone name, mirroring the viser avatar's
 * _MIXAMO_TO_CORE (null = no bone is driven by this joint).
 *
 * Deliberate deviation: the wrist (Hand) and thumb root (HandThumb1) are
 * NOT driven. The viser avatar collapses all hand skin weights rigidly, so
 * ARDY's wrist orientation is invisible there; on the real finger rig it
 * rotates the whole hand and presents the curled fingers from a different
 * palm angle than the rest state (a constant convention offset, most
 * visible as "fist on one side, flat hand on the other"). Riding the
 * forearm at the bind-relative wrist keeps the hand's presentation exactly
 * the natural relaxed hand at all times; the lost wrist flexion is a few
 * degrees in these clips and reads worse than it helps. */
const SKINNING_MAP = CSKEL27_JOINTS.map((name) => {
	switch (name) {
		case "Spine":
		case "RightHandEnd":
		case "LeftHandEnd":
		case "RightHand":
		case "LeftHand":
		case "RightHandThumb1":
		case "LeftHandThumb1":
			return null;
		case "Spine1":
			return "Spine";
		case "Spine2":
			return "Spine1";
		case "Spine3":
			return "Spine2";
		default:
			return name;
	}
});

// CoreSkeleton27 and the Mixamo bots are not congruent around the clavicles:
// their neutral shoulder directions differ by about 30 degrees. Positional
// skinning therefore moves the arm root away from the direction encoded by
// the parent bone's rotation and visibly shears the shoulder. Keep the
// Mixamo arm chains' authored local translations and retarget rotations only;
// the rest of the body still uses ARDY positional skinning for root motion
// and foot placement.
export const HIERARCHY_PRESERVED_JOINTS = new Set([
	"RightShoulder", "RightArm", "RightForeArm",
	"LeftShoulder", "LeftArm", "LeftForeArm",
]);

export const ARDY_NEUTRAL_MIN_Y = -0.9544128; // toe depth under the hips-origin neutral pose

/* No finger forcing: ARDY's cskel27 stops at the wrist, and the fingers
 * simply keep the rig's own bind pose at all times (the same presentation
 * as the viser avatar, which has no finger articulation either). Nothing
 * in this module writes finger bones. */

/* --- rig preparation ------------------------------------------------------ */

/** The project's bone-matching rule: normalised names equal, or one is a
 * suffix of the other (`mixamorighips` vs bare `hips`). First depth-first
 * match wins — Mixamo FBX nests an identity "skinned" copy of every bone
 * under the control bone, and the nested copies are never written (same
 * rule poses.js and export.js use). */
function findBone(rig, mixamoName) {
	const target = normalizeBoneName(mixamoName);
	let found = null;
	rig.traverse((object) => {
		if (found || !object.isBone) return;
		const norm = normalizeBoneName(object.name);
		if (norm === target || norm.endsWith(target)) found = object;
	});
	return found;
}

/** Bind-pose quaternions per bone, from the poseBind snapshot primed at clone
 * time; a lazy fallback mirrors export.js's restOf() for rigs that never
 * mounted Character. */
const bindFallback = new WeakMap();

function bindsOf(rig) {
	const primed = rig.userData && rig.userData.poseBind;
	if (primed) return primed;
	let map = bindFallback.get(rig);
	if (!map) {
		map = new Map();
		rig.traverse((object) => {
			if (object.isBone) {
				const q = object.quaternion;
				map.set(object, { x: q.x, y: q.y, z: q.z, w: q.w });
			}
		});
		bindFallback.set(rig, map);
	}
	return map;
}

/** Per-rig positional-skinning preparation, computed once from the bind
 * pose and cached. */
const rigPreps = new WeakMap();

export function prepOf(rig) {
	let prep = rigPreps.get(rig);
	if (prep) return prep;
	const binds = bindsOf(rig);

	// Rig-space bind transform of every node on the path to each mapped
	// bone: bind local rotations (poseBind) composed with the current —
	// never re-positioned outside this module — local translations. Computed
	// BEFORE this module ever writes a bone transform, so positions are the
	// FBX bind translations.
	// Rig-space = the space BELOW the rig root: the root's own transform
	// (Character's position/rotation and the 0.01 centimetre scale) is
	// applied by the scene on top and must never leak into bind transforms —
	// with a scaled root it would shrink every bind matrix and bone locals
	// would be written in metres into a centimetre hierarchy.
	const worldByNode = new Map();
	// Bind TRANSLATIONS come from the same primed snapshot as the rotations.
	// This module writes bone positions (positional skinning, stretched
	// leaves), so a prep computed after any playback — a second take on the
	// same character, a body swap — would read a posed rig as its bind and
	// build every offset on it (measured: hips 101.6 vs bind 104.3, arms
	// 8.9 vs 10.8, and the skin sat off the bones for the rest of the
	// session). Only a rig that was never primed falls back to live values.
	const bindPositionOf = (node) => {
		const b = node.isBone ? binds.get(node) : null;
		return b?.position ? new THREE.Vector3(b.position.x, b.position.y, b.position.z) : node.position;
	};
	const walk = (node, parentMat) => {
		const b = node.isBone ? binds.get(node) : null;
		const q = b
			? new THREE.Quaternion(b.x, b.y, b.z, b.w)
			: node.quaternion;
		const local = new THREE.Matrix4().compose(bindPositionOf(node), q, node.scale);
		const world = parentMat.clone().multiply(local);
		worldByNode.set(node, world);
		for (const child of node.children) walk(child, world);
	};
	for (const child of rig.children) walk(child, new THREE.Matrix4());

	// Mapped bones and their bind transforms, in cskel27 index order.
	const bones = new Array(CSKEL27_JOINTS.length).fill(null);
	const bindPos = new Array(CSKEL27_JOINTS.length).fill(null);
	const bindQuat = new Array(CSKEL27_JOINTS.length).fill(null);
	const bindScale = new Array(CSKEL27_JOINTS.length).fill(null);
	const bindLocalPos = new Array(CSKEL27_JOINTS.length).fill(null);
	const parentBindWorld = new Array(CSKEL27_JOINTS.length).fill(null);
	for (let j = 0; j < CSKEL27_JOINTS.length; j += 1) {
		const mixamoName = SKINNING_MAP[j];
		if (!mixamoName) continue;
		const bone = findBone(rig, mixamoName);
		if (!bone) continue;
		const world = worldByNode.get(bone);
		bones[j] = bone;
		bindPos[j] = new THREE.Vector3().setFromMatrixPosition(world);
		bindQuat[j] = new THREE.Quaternion().setFromRotationMatrix(world);
		bindScale[j] = bone.scale.clone();
		bindLocalPos[j] = bindPositionOf(bone).clone();
		parentBindWorld[j] = worldByNode.get(bone.parent) ?? new THREE.Matrix4();
	}

	// Uniform scale s: the rig's own leg height over ARDY's, so posed_joints
	// map into rig units keeping the character's authored proportions (the
	// viser avatar deforms onto the ARDY skeleton instead; both plant the
	// feet exactly). Leg height = hips bind Y minus the lowest mapped bind
	// Y, against ARDY's neutral toe depth of 0.9544128 m.
	const hipsIndex = CSKEL27_JOINTS.indexOf("Hips");
	const hipsY = bindPos[hipsIndex] ? bindPos[hipsIndex].y : 0;
	let lowestY = hipsY;
	for (let j = 0; j < bindPos.length; j += 1) {
		if (bindPos[j] && bindPos[j].y < lowestY) lowestY = bindPos[j].y;
	}
	const legHeight = hipsY - lowestY;
	const scale = legHeight > 1e-6 ? legHeight / -ARDY_NEUTRAL_MIN_Y : 1;

	// Per-joint bind offset against the floor-shifted ARDY neutral pose
	// (viser: bind_joints[:, 1] -= bind_joints[:, 1].min()).
	const offsets = new Array(CSKEL27_JOINTS.length).fill(null);
	for (let j = 0; j < CSKEL27_JOINTS.length; j += 1) {
		if (!bones[j]) continue;
		const neutral = CSKEL27_NEUTRAL[j];
		offsets[j] = new THREE.Vector3(
			bindPos[j].x - scale * neutral[0],
			bindPos[j].y - scale * (neutral[1] - ARDY_NEUTRAL_MIN_Y),
			bindPos[j].z - scale * neutral[2],
		);
	}

	// Chain parents for local conversion: the cskel parent is NOT always the
	// bone's parent (core Spine drives no bone, so the driven Spine bone's
	// real parent is the driven Hips bone). For every mapped bone find the
	// nearest MAPPED ancestor bone and the bind-space relative matrix from
	// that ancestor to the bone's parent; bones without a mapped ancestor
	// hang off a static node whose bind world stays valid all playback.
	const boneIndex = new Map();
	for (let j = 0; j < bones.length; j += 1) {
		if (bones[j]) boneIndex.set(bones[j], j);
	}
	const chainParent = new Array(CSKEL27_JOINTS.length).fill(-1);
	const chainRel = new Array(CSKEL27_JOINTS.length).fill(null);
	for (let j = 0; j < bones.length; j += 1) {
		const bone = bones[j];
		if (!bone) continue;
		for (let node = bone.parent; node && node !== rig; node = node.parent) {
			if (node.isBone && boneIndex.has(node)) {
				chainParent[j] = boneIndex.get(node);
				chainRel[j] = new THREE.Matrix4()
					.copy(worldByNode.get(node))
					.invert()
					.multiply(worldByNode.get(bone.parent));
				break;
			}
		}
	}

	// The wrists are deliberately not driven (SKINNING_MAP), but a hand bone's
	// local translation IS the forearm's length, so a mocap take's forearm
	// factor has to be written there or the hand stays at the canonical
	// distance while posedJoints say otherwise. Kept separately so the
	// mocap supplies no wrist rotation. Explicitly restore their bind rotation
	// before the IK layer: otherwise a based wrist correction is multiplied
	// onto yesterday's correction on every seek, accumulating a hand flip.
	const stretchedLeaves = [];
	for (const name of ["LeftHand", "RightHand"]) {
		const bone = findBone(rig, name);
		if (bone) {
			const bind = binds.get(bone);
			stretchedLeaves.push({ bone, joint: CSKEL27_JOINTS.indexOf(name), bindLocalPos: bindPositionOf(bone).clone(),
				bindWorldQuat: new THREE.Quaternion().setFromRotationMatrix(worldByNode.get(bone)),
				parentBindQuat: new THREE.Quaternion().setFromRotationMatrix(worldByNode.get(bone.parent)),
				bindLocalQuat: bind ? new THREE.Quaternion(bind.x, bind.y, bind.z, bind.w) : bone.quaternion.clone() });
		}
	}

	// Bone lengths in rig units for the re-basing above: the canonical cskel27
	// bone (neutral pose, scaled into the rig) and the rig's own bind bone.
	const canonicalBoneLength = new Array(CSKEL27_JOINTS.length).fill(0);
	const rigBoneLength = new Array(CSKEL27_JOINTS.length).fill(0);
	for (let j = 1; j < CSKEL27_JOINTS.length; j += 1) {
		const parent = CSKEL27_PARENTS[j];
		const a = CSKEL27_NEUTRAL[j];
		const b = CSKEL27_NEUTRAL[parent];
		canonicalBoneLength[j] = scale * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		const bone = bones[j] ?? stretchedLeaves.find((leaf) => leaf.joint === j)?.bone;
		if (bone) rigBoneLength[j] = bindPositionOf(bone).length();
	}

	prep = {
		bones,
		bindPos,
		stretchedLeaves,
		canonicalBoneLength,
		rigBoneLength,
		bindQuat,
		bindScale,
		bindLocalPos,
		parentBindWorld,
		chainParent,
		chainRel,
		scale,
		offsets,
	};
	rigPreps.set(rig, prep);
	return prep;
}

/** cskel27 index -> control Bone (null where no bone is driven), kept as a
 * public introspection hook for tests and snapshot/restore. */
export function motionBones(rig) {
	return prepOf(rig).bones;
}

/** QA introspection: expose the cached per-rig prep (scale, offsets, chain
 * parents) so headless checks can compare app-side prep against node-side
 * expectations. Not used by the app itself. */
/** Recover the current ARDY-space root from the live retargeted rig.
 *
 * Positional skinning writes each mapped bone as
 *   bone = scale * root + globalRotation * bindOffset
 * in rig space. Inverting that equation captures generated root motion plus
 * any IK hips translation, so pose constraints never borrow placement from an
 * unrelated reference clip. */
export function captureArdyRoot(rig) {
	const prep = prepOf(rig);
	if (!prep) throw new Error("captureArdyRoot: rig is not prepared for ARDY playback");
	const rootIndex = CSKEL27_JOINTS.indexOf("Hips");
	const bone = prep.bones[rootIndex];
	if (!bone) throw new Error("captureArdyRoot: mapped Hips bone is unavailable");

	rig.updateMatrixWorld(true);
	const rigInverse = new THREE.Matrix4().copy(rig.matrixWorld).invert();
	const boneInRig = new THREE.Matrix4().multiplyMatrices(rigInverse, bone.matrixWorld);
	const position = new THREE.Vector3();
	const boneRotation = new THREE.Quaternion();
	boneInRig.decompose(position, boneRotation, new THREE.Vector3());

	const globalRotation = boneRotation.multiply(prep.bindQuat[rootIndex].clone().invert()).normalize();
	const bindOffset = prep.offsets[rootIndex].clone().applyQuaternion(globalRotation);
	// The scale the last applyMotionFrame used (1 for a performer-sized take).
	const s = prep.lastScale ?? prep.scale;
	return [
		(position.x - bindOffset.x) / s,
		(position.y - bindOffset.y) / s,
		(position.z - bindOffset.z) / s,
	];
}

/** Bind offsets against the canonical neutral grown by a take's bone
 *  factors: neutral joint j = parent + boneScale[j] * (neutral[j] - neutral[parent]),
 *  floor-shifted the same way prepOf does, in rig units via prep.scale.
 *  Cached per (rig, boneScale array) — one take, one skeleton. */
const scaledOffsetCache = new WeakMap();
export function scaledOffsets(prep, boneScale) {
	let cached = scaledOffsetCache.get(boneScale);
	if (cached && cached.prep === prep) return cached.offsets;
	const grown = new Array(CSKEL27_JOINTS.length);
	for (let j = 0; j < CSKEL27_JOINTS.length; j += 1) {
		const parent = CSKEL27_PARENTS[j];
		const n = CSKEL27_NEUTRAL[j];
		if (parent === null) { grown[j] = [n[0], n[1], n[2]]; continue; }
		const q = CSKEL27_NEUTRAL[parent];
		const g = grown[parent];
		grown[j] = [g[0] + boneScale[j] * (n[0] - q[0]), g[1] + boneScale[j] * (n[1] - q[1]), g[2] + boneScale[j] * (n[2] - q[2])];
	}
	// Same frame and scale as prepOf's offsets: only the per-bone growth
	// differs, so an all-ones boneScale reproduces prep.offsets exactly.
	const offsets = new Array(CSKEL27_JOINTS.length).fill(null);
	for (let j = 0; j < CSKEL27_JOINTS.length; j += 1) {
		if (!prep.bones[j]) continue;
		const g = grown[j];
		offsets[j] = new THREE.Vector3(
			prep.bindPos[j].x - prep.scale * g[0],
			prep.bindPos[j].y - prep.scale * (g[1] - ARDY_NEUTRAL_MIN_Y),
			prep.bindPos[j].z - prep.scale * g[2],
		);
	}
	scaledOffsetCache.set(boneScale, { prep, offsets });
	return offsets;
}

/** Factor to apply to a rotation-driven bone's BIND translation so the bone
 *  comes out at the performer's length. boneScale is performer/canonical; the
 *  rig's own bind bone is not the canonical length (Mixamo forearm 27.6 cm
 *  against cskel27's 23.3), so the factor is re-based onto the rig:
 *  performer / rigBind = boneScale * canonical / rigBind, all in rig units. */
export function boneStretch(prep, motion, j) {
	if (!motion.boneScale) return 1;
	// The shoulder girdle is character geometry, like the neck: the rig's
	// clavicle+arm-root (21 cm straight) is deliberately shorter than
	// cskel27's 34 cm (HIERARCHY_PRESERVED_JOINTS exists to keep it), so
	// re-basing onto the canonical length would push a 33 cm-wide performer
	// out to 41 cm. The performer/canonical ratio applies to the rig's own
	// girdle as-is: a narrow performer narrows the character's shoulders.
	if (GIRDLE_JOINTS.has(CSKEL27_JOINTS[j])) return motion.boneScale[j];
	const canonical = prep.canonicalBoneLength[j];
	const rigBind = prep.rigBoneLength[j];
	if (!(canonical > 1e-6) || !(rigBind > 1e-6)) return motion.boneScale[j];
	return (motion.boneScale[j] * canonical) / rigBind;
}
export const GIRDLE_JOINTS = new Set(["LeftShoulder", "RightShoulder", "LeftArm", "RightArm"]);

/* --- per-frame application -------------------------------------------------- */

const frameLocals = new Array(CSKEL27_JOINTS.length);
for (let j = 0; j < frameLocals.length; j += 1) {
	frameLocals[j] = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	];
}

const mGlobal = new THREE.Matrix3();
const mWorld = new THREE.Matrix4();
const mLocal = new THREE.Matrix4();
const mParentInv = new THREE.Matrix4();
const qGlobal = new THREE.Quaternion();
const qWorld = new THREE.Quaternion();
const vOffset = new THREE.Vector3();
const vWorld = new THREE.Vector3();
const vDecompPos = new THREE.Vector3();
const qDecomp = new THREE.Quaternion();
const vDecompScale = new THREE.Vector3();
const desiredWorld = new Array(CSKEL27_JOINTS.length).fill(null);

function rotationsAt(motion, f) {
	for (let j = 0; j < frameLocals.length; j += 1) {
		const o = (f * frameLocals.length + j) * 9;
		const L = frameLocals[j];
		for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) L[r][c] = motion.rotMats[o + r * 3 + c];
	}
	return globalRotations(frameLocals);
}

function rotationQuat(G, target = new THREE.Quaternion()) {
	mGlobal.set(...G[0], ...G[1], ...G[2]);
	return target.setFromRotationMatrix(mWorld.setFromMatrix3(mGlobal));
}

/** Reference corrections need FK and a few transforms, not a second rig pose. */
function trailReference(prep, { base, chains }, f) {
	const globals = rotationsAt(base, f);
	const offsets = base.boneScale ? scaledOffsets(prep, base.boneScale) : prep.offsets;
	const anchor = Math.max(0, Math.min(base.anchorFrame || 0, base.frames - 1)) * 27 * 3;
	const worlds = new Map(), positions = new Map(), wrists = new Map();
	const world = (j) => {
		if (!worlds.has(j)) {
			const q = rotationQuat(globals[j]);
			const p = new THREE.Vector3().fromArray(base.posedJoints, (f * 27 + j) * 3);
			p.x -= base.posedJoints[anchor]; p.z -= base.posedJoints[anchor + 2];
			p.multiplyScalar(prep.scale).add(offsets[j].clone().applyQuaternion(q));
			worlds.set(j, new THREE.Matrix4().compose(p, q.multiply(prep.bindQuat[j]), prep.bindScale[j]));
		}
		return worlds.get(j);
	};
	for (const track of chains) {
		const side = track.startsWith("left") ? "Left" : "Right";
		if (track.endsWith("Hand")) {
			const leaf = prep.stretchedLeaves.find((item) => CSKEL27_JOINTS[item.joint] === `${side}Hand`);
			if (leaf) wrists.set(leaf.bone, rotationQuat(globals[CSKEL27_PARENTS[leaf.joint]]).multiply(leaf.bindWorldQuat));
		} else {
			for (const suffix of ["UpLeg", "Leg", "Foot", "ToeBase"]) {
				const j = CSKEL27_JOINTS.indexOf(side + suffix), bone = prep.bones[j];
				if (!bone) continue;
				const parent = prep.chainParent[j];
				const parentWorld = parent < 0 ? prep.parentBindWorld[j].clone() : world(parent).clone().multiply(prep.chainRel[j]);
				positions.set(bone, new THREE.Vector3().setFromMatrixPosition(world(j)).applyMatrix4(parentWorld.invert()));
			}
		}
	}
	return { positions, wrists };
}

/**
 * Apply one motion frame to the rig with positional skinning: every mapped
 * bone's rig-space world transform is set to
 *
 *     pos  = s * (posed[f][j] - anchorRootXZ) + R[f][j] @ offset[j]
 *     quat = R[f][j] @ bindQuat[j]
 *
 * and then converted to bone-local against the (already updated) parent.
 * `frame` is clamped into range. The clip-to-scene yaw is NOT applied here —
 * the Character group's `rot` carries it, exactly like before.
 */
export function applyMotionFrame(rig, motion, frame) {
	if (!rig || !motion) return;
	const f = Math.max(0, Math.min(Math.round(frame) || 0, motion.frames - 1));
	const prep = prepOf(rig);
	const joints = CSKEL27_JOINTS.length;
	// Opt-in only; unedited takes keep their existing retargeting policy.
	const trail = motion.trailRetarget ? trailReference(prep, motion.trailRetarget, f) : null;
	const globals = rotationsAt(motion, f);

	// Anchor: the anchor frame's root stays at the rig origin (the Character
	// group sits at the scene anchor); height stays floor-absolute.
	const anchorFrame = Math.max(0, Math.min(motion.anchorFrame || 0, motion.frames - 1));
	const anchorX = motion.posedJoints[(anchorFrame * joints) * 3];
	const anchorZ = motion.posedJoints[(anchorFrame * joints) * 3 + 2];
	// A take with boneScale already IS a body: its posedJoints are the
	// performer's metres, so they map into the rig 1:1 (0.01 cm units aside,
	// which the root applies). prep.scale exists to keep the CANONICAL body
	// on this rig's leg length and would shrink a filmed performer by the
	// rig/canonical ratio (9 % on the x-bot).
	// The same unit conversion for BOTH kinds of take. prep.scale carries the
	// rig's leg-length over the canonical one (109 % on the x-bot, 102 % on
	// the y-bot): every bind offset below was measured in that scaled frame,
	// and a performer-sized take mapped 1:1 in metres instead lands its hips
	// 9 cm above the rig's own pelvis geometry on the x-bot (the y-bot hid it
	// at 1.6 cm). The performer's PROPORTIONS still come through untouched —
	// this is a uniform factor, the rig's own size — and the bone factors
	// keep them.
	const s = prep.scale;
	prep.lastScale = s;
	// The bind offsets were measured against the CANONICAL neutral; a
	// performer-sized take moves every joint by its bone factors, and an
	// offset that still points at the canonical joint pulls the skin off
	// the bone by the difference (measured: neck/head 7-10 cm low on a
	// 0.84x torso). Re-measure against the neutral grown by boneScale.
	const offsets = motion.boneScale ? scaledOffsets(prep, motion.boneScale) : prep.offsets;

	for (let j = 0; j < joints; j += 1) {
		const bone = prep.bones[j];
		desiredWorld[j] = null;
		if (!bone) continue;

		const G = globals[j];
		mGlobal.set(
			G[0][0], G[0][1], G[0][2],
			G[1][0], G[1][1], G[1][2],
			G[2][0], G[2][1], G[2][2],
		);
		qGlobal.setFromRotationMatrix(mWorld.setFromMatrix3(mGlobal));

		const po = (f * joints + j) * 3;
		vOffset.copy(offsets[j]).applyQuaternion(qGlobal);
		vWorld.set(
			s * (motion.posedJoints[po] - anchorX) + vOffset.x,
			s * motion.posedJoints[po + 1] + vOffset.y,
			s * (motion.posedJoints[po + 2] - anchorZ) + vOffset.z,
		);
		qWorld.copy(qGlobal).multiply(prep.bindQuat[j]);

		// Convert the rig-space world transform to bone-local. The parent
		// world is the nearest mapped ancestor's desired world (already
		// written this frame — cskel index order is topological along every
		// Mixamo chain) times the bind-relative chain matrix, or the static
		// bind parent world when no mapped ancestor exists.
		const chainParentJ = prep.chainParent[j];
		if (chainParentJ >= 0) {
			mParentInv.copy(desiredWorld[chainParentJ]).multiply(prep.chainRel[j]);
		} else {
			mParentInv.copy(prep.parentBindWorld[j]);
		}

		if (trail?.positions.has(bone)) {
			// Swing the original rendered segment, rather than re-placing its
			// endpoints with different rotated bind offsets (which stretches it).
			vWorld.copy(trail.positions.get(bone)).applyMatrix4(mParentInv);
		} else if (HIERARCHY_PRESERVED_JOINTS.has(CSKEL27_JOINTS[j])) {
			// A mocap take carries the performer's bone lengths (boneScale, see
			// npz.js). Positionally skinned bones already sit where the scaled
			// posedJoints put them; the arm chain rides its own bind
			// translation, so the performer's arm length is applied HERE by
			// stretching that translation by the factor of the bone ending at
			// this joint. Bone scale is never touched: it would scale the skin.
			vWorld.copy(prep.bindLocalPos[j]).multiplyScalar(boneStretch(prep, motion, j)).applyMatrix4(mParentInv);
		}

		mWorld.compose(vWorld, qWorld, prep.bindScale[j]);
		desiredWorld[j] = mWorld.clone();
		mLocal.copy(mParentInv).invert().multiply(mWorld);
		mLocal.decompose(vDecompPos, qDecomp, vDecompScale);
		bone.position.copy(vDecompPos);
		bone.quaternion.copy(qDecomp);
	}
	for (const leaf of prep.stretchedLeaves) {
		leaf.bone.position.copy(leaf.bindLocalPos).multiplyScalar(boneStretch(prep, motion, leaf.joint));
		const orientation = trail?.wrists.get(leaf.bone);
		if (orientation) {
			// Work below the rig root: placement, yaw and export clones must
			// not leak into the wrist's local compensation.
			rotationQuat(globals[CSKEL27_PARENTS[leaf.joint]], qGlobal).multiply(leaf.parentBindQuat);
			leaf.bone.quaternion.copy(qGlobal.invert().multiply(orientation));
		} else leaf.bone.quaternion.copy(leaf.bindLocalQuat);
	}
	rig.updateMatrixWorld(true);
}

/* --- read-only sampling ---------------------------------------------------- */

/** Bones-only copy of a rig for off-screen sampling, keyed to the live rig.
 *  It carries the live rig's bind snapshot, so its prep is the live prep. */
const samplerCopies = new WeakMap();

function samplerCopyOf(rig) {
	let copy = samplerCopies.get(rig);
	if (copy) return copy;
	// Never create the live rig's fallback here: that would freeze its bind
	// at whatever pose it holds now. Unprimed rigs read the current rotations.
	const binds = rig.userData?.poseBind ?? bindFallback.get(rig) ?? new Map();
	const copyBinds = new Map();
	const hasBone = (node) => node.isBone || node.children.some(hasBone);
	const clone = (node) => {
		const out = node.isBone ? new THREE.Bone() : new THREE.Object3D();
		out.name = node.name;
		out.position.copy(node.position);
		out.quaternion.copy(node.quaternion);
		out.scale.copy(node.scale);
		const bind = node.isBone ? binds.get(node) : null;
		const q = node.quaternion;
		// Without a recorded bind position the copied live position stands in,
		// exactly as bindPositionOf does for the live rig.
		if (node.isBone) copyBinds.set(out, bind ?? { x: q.x, y: q.y, z: q.z, w: q.w });
		for (const child of node.children) if (hasBone(child)) out.add(clone(child));
		return out;
	};
	// The root stays identity: samples are in rig space, below the root.
	copy = new THREE.Object3D();
	for (const child of rig.children) if (hasBone(child)) copy.add(clone(child));
	copy.userData.poseBind = copyBinds;
	samplerCopies.set(rig, copy);
	return copy;
}

/** Per (rig, motion) cache of rendered joint positions. */
const jointSamples = new WeakMap();

/** Pose the sampler copy at frame f and write every driven bone's rig-space
 *  position into out[offset..offset+81] (NaN where no bone is driven). */
function sampleFrame(rig, motion, f, out, offset) {
	const copy = samplerCopyOf(rig);
	const prep = prepOf(copy);
	if (!prep.driven) {
		prep.driven = CSKEL27_JOINTS.map((_, j) => prep.bones[j] ?? prep.stretchedLeaves.find((leaf) => leaf.joint === j)?.bone ?? null);
	}
	applyMotionFrame(copy, motion, f);
	for (let j = 0; j < prep.driven.length; j += 1) {
		const bone = prep.driven[j];
		const o = offset + j * 3;
		if (!bone) {
			out[o] = out[o + 1] = out[o + 2] = NaN;
			continue;
		}
		const e = bone.matrixWorld.elements;
		out[o] = e[12];
		out[o + 1] = e[13];
		out[o + 2] = e[14];
	}
}

/** One frame of motionJointPositions (uncached): Float32Array(27*3), rig space. */
export function motionJointPositionsAt(rig, motion, frame) {
	if (!rig || !motion?.rotMats || !(motion.frames > 0)) return null;
	const out = new Float32Array(CSKEL27_JOINTS.length * 3);
	sampleFrame(rig, motion, Math.max(0, Math.min(Math.round(frame) || 0, motion.frames - 1)), out, 0);
	return out;
}

/**
 * Rig-space position of every driven cskel27 joint's bone at every frame,
 * exactly as applyMotionFrame places it, without touching the live rig.
 * Returns { positions: Float32Array(frames*27*3) } (NaN where no bone is
 * driven). Cached per rig + motion; treat as read-only.
 */
export function motionJointPositions(rig, motion) {
	if (!rig || !motion?.rotMats || !(motion.frames > 0)) return null;
	let byRig = jointSamples.get(motion);
	if (!byRig) {
		byRig = new WeakMap();
		jointSamples.set(motion, byRig);
	}
	const cached = byRig.get(rig);
	if (cached) return cached;
	const joints = CSKEL27_JOINTS.length;
	const positions = new Float32Array(motion.frames * joints * 3);
	for (let f = 0; f < motion.frames; f += 1) sampleFrame(rig, motion, f, positions, f * joints * 3);
	const result = { positions };
	byRig.set(rig, result);
	return result;
}

/* --- snapshot / restore ----------------------------------------------------- */

/**
 * Capture the current transform of every bone playback touches — the
 * skinning-mapped bones (position AND quaternion: applyMotionFrame drives
 * both) — so clearing a motion restores the prior CozyClay pose exactly.
 */
export function snapshotPlaybackBones(rig) {
	const out = [];
	const prep = prepOf(rig);
	for (const bone of [...prep.bones, ...prep.stretchedLeaves.map((leaf) => leaf.bone)]) {
		if (!bone) continue;
		out.push([
			bone,
			bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w,
			bone.position.x, bone.position.y, bone.position.z,
		]);
	}
	return out;
}

/** Restore transforms captured by snapshotPlaybackBones. */
export function restorePlaybackBones(rig, snapshot) {
	if (!rig || !snapshot) return;
	for (const entry of snapshot) {
		entry[0].quaternion.set(entry[1], entry[2], entry[3], entry[4]);
		if (entry.length > 5) entry[0].position.set(entry[5], entry[6], entry[7]);
	}
	rig.updateMatrixWorld(true);
}
