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
 */

import * as THREE from "three";
import { CSKEL27_JOINTS } from "./cskel27.js";
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
const HIERARCHY_PRESERVED_JOINTS = new Set([
	"RightShoulder", "RightArm", "RightForeArm",
	"LeftShoulder", "LeftArm", "LeftForeArm",
]);

const ARDY_NEUTRAL_MIN_Y = -0.9544128; // toe depth under the hips-origin neutral pose

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

function prepOf(rig) {
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
	const walk = (node, parentMat) => {
		const b = node.isBone ? binds.get(node) : null;
		const q = b
			? new THREE.Quaternion(b.x, b.y, b.z, b.w)
			: node.quaternion;
		const local = new THREE.Matrix4().compose(node.position, q, node.scale);
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
		bindLocalPos[j] = bone.position.clone();
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

	prep = {
		bones,
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
	return [
		(position.x - bindOffset.x) / prep.scale,
		(position.y - bindOffset.y) / prep.scale,
		(position.z - bindOffset.z) / prep.scale,
	];
}

/** Build (and cache) the positional-skinning prep from the rig's bind pose NOW.
 * prepOf() snapshots the CURRENT bone translations as the bind translations,
 * so it must run before anything (an IK hips drag, a pose tool) moves a bone.
 * A rig that is posed before its first motion loads would otherwise bake the
 * posed hips into its bind offsets — captureArdyRoot then reports the
 * canonical root no matter where the hips are, and every later clip plays
 * back offset by the drag. Call once when the rig mounts. */
export function preparePlayback(rig) {
	return !!prepOf(rig);
}

export function debugPrep(rig) {
	const p = prepOf(rig);
	return {
		scale: p.scale,
		offsets: p.offsets.map((o) => (o ? [o.x, o.y, o.z] : null)),
		hipsBone: p.bones[0] ? { name: p.bones[0].name, uuid: p.bones[0].uuid, parent: p.bones[0].parent?.name ?? null } : null,
	};
}

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
	const base = f * joints * 9;

	// Global (world) rotations of every cskel27 joint at this frame: FK over
	// the npz local rotations down the parent chain.
	for (let j = 0; j < joints; j += 1) {
		const o = base + j * 9;
		const L = frameLocals[j];
		L[0][0] = motion.rotMats[o]; L[0][1] = motion.rotMats[o + 1]; L[0][2] = motion.rotMats[o + 2];
		L[1][0] = motion.rotMats[o + 3]; L[1][1] = motion.rotMats[o + 4]; L[1][2] = motion.rotMats[o + 5];
		L[2][0] = motion.rotMats[o + 6]; L[2][1] = motion.rotMats[o + 7]; L[2][2] = motion.rotMats[o + 8];
	}
	const globals = globalRotations(frameLocals);

	// Anchor: the anchor frame's root stays at the rig origin (the Character
	// group sits at the scene anchor); height stays floor-absolute.
	const anchorFrame = Math.max(0, Math.min(motion.anchorFrame || 0, motion.frames - 1));
	const anchorX = motion.posedJoints[(anchorFrame * joints) * 3];
	const anchorZ = motion.posedJoints[(anchorFrame * joints) * 3 + 2];

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
		vOffset.copy(prep.offsets[j]).applyQuaternion(qGlobal);
		vWorld.set(
			prep.scale * (motion.posedJoints[po] - anchorX) + vOffset.x,
			prep.scale * motion.posedJoints[po + 1] + vOffset.y,
			prep.scale * (motion.posedJoints[po + 2] - anchorZ) + vOffset.z,
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

		if (HIERARCHY_PRESERVED_JOINTS.has(CSKEL27_JOINTS[j])) {
			vWorld.copy(prep.bindLocalPos[j]).applyMatrix4(mParentInv);
		}

		mWorld.compose(vWorld, qWorld, prep.bindScale[j]);
		desiredWorld[j] = mWorld.clone();
		mLocal.copy(mParentInv).invert().multiply(mWorld);
		mLocal.decompose(vDecompPos, qDecomp, vDecompScale);
		bone.position.copy(vDecompPos);
		bone.quaternion.copy(qDecomp);
	}
	rig.updateMatrixWorld(true);
}

/* --- snapshot / restore ----------------------------------------------------- */

/**
 * Capture the current transform of every bone playback touches — the
 * skinning-mapped bones (position AND quaternion: applyMotionFrame drives
 * both) — so clearing a motion restores the prior CozyClay pose exactly.
 */
export function snapshotPlaybackBones(rig) {
	const out = [];
	for (const bone of motionBones(rig)) {
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
