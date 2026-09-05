import * as THREE from "three";
import { normalizeBoneName } from "../poses.js";

/**
 * Frame-based IK layer for direct character posing, following the DCC
 * standard (Blender / Maya / Cascadeur):
 *
 * - Non-destructive: enabling IK never changes the pose. Only a chain the
 *   user actually drags is ever solved; everything else keeps the FK pose.
 * - Manipulation solves: dragging a handle solves the limb backward
 *   (two-bone analytic IK) with BEND CONTINUITY — the elbow/knee keeps its
 *   current side of the bone line, so it never snaps mid-drag.
 * - Keys store FK LOCAL ROTATIONS of the solved chain bones (b0/b1), not
 *   effector targets — Cascadeur's "FK keyframe". Interpolation is plain
 *   quaternion slerp between keys, no re-solve at playback. Because the
 *   stored values are local, a moved or rotated character needs no
 *   re-anchoring at all.
 */

/** Contact radii measured from the bind-pose skinned mesh. The limb/head
 * entries drive floor contact; the Arm/UpLeg/Spine/Neck entries exist so
 * fix-collisions.js can build per-segment capsules from the same measured
 * radii instead of guessing body thickness. */
const CONTACT_JOINTS = [
	"LeftHand", "RightHand", "LeftFoot", "RightFoot",
	"LeftForeArm", "RightForeArm", "LeftLeg", "RightLeg", "Hips", "Head",
	"LeftArm", "RightArm", "LeftUpLeg", "RightUpLeg", "Spine", "Neck",
];
const CONTACT_RADIUS_MIN = 0.01;
const CONTACT_RADIUS_MAX = 0.25;
const CONTACT_RADIUS_FALLBACK = 0.01;
const CONTACT_HEIGHT_MAX = 0.25;
const contactRadiusCache = new WeakMap();
const contactHeightCache = new WeakMap();

function pointSegmentDistance(point, start, end) {
	const segment = end.clone().sub(start);
	const lengthSq = segment.lengthSq();
	if (lengthSq < 1e-12) return point.distanceTo(start);
	const t = Math.max(0, Math.min(1, point.clone().sub(start).dot(segment) / lengthSq));
	return point.distanceTo(start.clone().addScaledVector(segment, t));
}

/** Measure each contact joint's capsule radius from dominant (>0.4) bind-pose
 * skin weights. The result is cached on the character object. */
export function measureContactRadii(rig) {
	if (!rig) return {};
	const cached = contactRadiusCache.get(rig);
	if (cached) return cached;
	rig.updateMatrixWorld(true);
	// Segment endpoints use the bones' CURRENT world matrices, matching the
	// frame getVertexPosition reports (current skinning), not the bind pose:
	// with dominant-weight (>0.4) vertices the vertex→bone distance is nearly
	// pose-invariant, while mixing a bind-pose segment with a posed vertex
	// inflates every rotated limb to the radius clamp.
	const segments = new Map();
	for (const name of CONTACT_JOINTS) {
		const bone = findBone(rig, `mixamorig${name}`);
		if (!bone) continue;
		const start = bone.getWorldPosition(new THREE.Vector3());
		const child = (name === "Hips" || name === "Head") ? null : bone.children.find((node) => node.isBone);
		const end = child ? child.getWorldPosition(new THREE.Vector3()) : start.clone();
		segments.set(name, [start, end]);
	}
	// Distances are collected PER MESH: Mixamo-style exports often carry a
	// body mesh plus a joint-sphere debug mesh (Alpha_Surface/Alpha_Joints),
	// and the joint balls inflate every radius to the clamp. The final radius
	// is the MIN of each mesh's 90th percentile — the tightest fit that every
	// mesh agrees on, so fat debug geometry can never fatten the capsules.
	const perMeshDistances = [];
	rig.traverse((mesh) => {
		if (!mesh.isSkinnedMesh || !mesh.skeleton || !mesh.geometry?.attributes?.position) return;
		const indices = mesh.geometry.attributes.skinIndex;
		const weights = mesh.geometry.attributes.skinWeight;
		if (!indices || !weights) return;
		const distances = new Map(CONTACT_JOINTS.map((name) => [name, []]));
		const names = mesh.skeleton.bones.map((bone) => normalizeBoneName(bone.name));
		const vertex = new THREE.Vector3();
		for (let index = 0; index < indices.count; index += 1) {
			let dominant = -1;
			let dominantWeight = 0;
			for (let slot = 0; slot < 4; slot += 1) {
				const weight = weights.getComponent(index, slot);
				if (weight > dominantWeight) {
					dominantWeight = weight;
					dominant = indices.getComponent(index, slot);
				}
			}
			if (dominantWeight <= 0.4) continue;
			const normalized = names[dominant];
			const name = CONTACT_JOINTS.find((candidate) => {
				const target = normalizeBoneName(`mixamorig${candidate}`);
				return normalized === target || normalized.endsWith(target) || target.endsWith(normalized);
			});
			const segment = segments.get(name);
			if (!segment) continue;
			mesh.getVertexPosition(index, vertex);
			mesh.localToWorld(vertex);
			distances.get(name).push(pointSegmentDistance(vertex, segment[0], segment[1]));
		}
		perMeshDistances.push(distances);
	});
	// 90th-percentile per mesh, NOT the max: stray weights and props put a
	// few vertices far outside the limb and a max clamps every joint to
	// CONTACT_RADIUS_MAX, fat enough to flag permanent false contacts.
	const radii = {};
	for (const name of CONTACT_JOINTS) {
		let radius = CONTACT_RADIUS_FALLBACK;
		for (const distances of perMeshDistances) {
			const samples = distances.get(name);
			if (!samples.length) continue;
			samples.sort((a, b) => a - b);
			const p90 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.9))];
			radius = radius === CONTACT_RADIUS_FALLBACK ? p90 : Math.min(radius, p90);
		}
		radii[name] = Math.max(CONTACT_RADIUS_MIN, Math.min(CONTACT_RADIUS_MAX, radius));
	}
	const result = Object.freeze(radii);
	contactRadiusCache.set(rig, result);
	return result;
}

/** Measure the vertical amount of mesh below each contact bone in the bind
 * pose. Unlike a capsule radius this is the exact quantity needed when a
 * handle is dragged straight down: the bone can reach floorY + height while
 * the weighted mesh rests on the floor. */
export function measureContactHeights(rig) {
	if (!rig) return {};
	const cached = contactHeightCache.get(rig);
	if (cached) return cached;
	rig.updateMatrixWorld(true);
	const points = new Map();
	for (const name of CONTACT_JOINTS) {
		const bone = findBone(rig, `mixamorig${name}`);
		if (bone) points.set(name, bone.getWorldPosition(new THREE.Vector3()));
	}
	const drops = new Map(CONTACT_JOINTS.map((name) => [name, 0]));
	rig.traverse((mesh) => {
		if (!mesh.isSkinnedMesh || !mesh.skeleton || !mesh.geometry?.attributes?.position) return;
		const indices = mesh.geometry.attributes.skinIndex;
		const weights = mesh.geometry.attributes.skinWeight;
		if (!indices || !weights) return;
		const names = mesh.skeleton.bones.map((bone) => normalizeBoneName(bone.name));
		const vertex = new THREE.Vector3();
		for (let index = 0; index < indices.count; index += 1) {
			let dominant = -1;
			let dominantWeight = 0;
			for (let slot = 0; slot < 4; slot += 1) {
				const weight = weights.getComponent(index, slot);
				if (weight > dominantWeight) { dominantWeight = weight; dominant = indices.getComponent(index, slot); }
			}
			if (dominantWeight <= 0.4 || !names[dominant]) continue;
			const name = CONTACT_JOINTS.find((candidate) => {
				const target = normalizeBoneName(`mixamorig${candidate}`);
				return names[dominant] === target || names[dominant].endsWith(target) || target.endsWith(names[dominant]);
			});
			const point = points.get(name);
			if (!point) continue;
			mesh.getVertexPosition(index, vertex);
			mesh.localToWorld(vertex);
			drops.set(name, Math.max(drops.get(name), point.y - vertex.y));
		}
	});
	const heights = {};
	for (const name of CONTACT_JOINTS) {
		heights[name] = Math.max(CONTACT_RADIUS_MIN, Math.min(CONTACT_HEIGHT_MAX, drops.get(name) || CONTACT_RADIUS_FALLBACK));
	}
	const result = Object.freeze(heights);
	contactHeightCache.set(rig, result);
	return result;
}

export const IK_TRACKS = [
	{ id: "leftHand", label: "Left Hand", kind: "arm", side: "Left", visibilityDepth: 0.14 },
	{ id: "rightHand", label: "Right Hand", kind: "arm", side: "Right", visibilityDepth: 0.14 },
	{ id: "leftFoot", label: "Left Foot", kind: "leg", side: "Left", visibilityDepth: 0.14 },
	{ id: "rightFoot", label: "Right Foot", kind: "leg", side: "Right", visibilityDepth: 0.14 },
];

/** Mid-joint position handles: dragging repositions the elbow/knee with
 * BOTH ends pinned (shoulder+wrist / hip+ankle) — the classic mid-chain
 * handle. `chain` links to the IK chain whose bones it edits. */
export const MID_TRACKS = [
	{ id: "leftElbow", label: "Left Elbow", chain: "leftHand", visibilityDepth: 0.12 },
	{ id: "rightElbow", label: "Right Elbow", chain: "rightHand", visibilityDepth: 0.12 },
	{ id: "leftKnee", label: "Left Knee", chain: "leftFoot", visibilityDepth: 0.12 },
	{ id: "rightKnee", label: "Right Knee", chain: "rightFoot", visibilityDepth: 0.12 },
];

/** FK swing handles: dragging swings the part toward the pointer (rotation
 * only, around the joint itself). `child` gives the bone that defines the
 * swing direction; null means use the bone's own +Y (Mixamo head). Colours
 * follow the FK PoseHandles coding: torso yellow, head purple, arms orange,
 * legs blue. */
export const FK_TRACKS = [
	{ id: "hips", label: "Hips", bone: "mixamorigHips", child: "mixamorigSpine", color: "#ffd23d", group: "torso", visibilityDepth: 0.34 },
	{ id: "spine", label: "Spine", bone: "mixamorigSpine", child: "mixamorigSpine1", color: "#ffd23d", group: "torso", visibilityDepth: 0.32 },
	{ id: "chest", label: "Chest", bone: "mixamorigSpine1", child: "mixamorigSpine2", color: "#ffd23d", group: "torso", visibilityDepth: 0.3 },
	{ id: "neck", label: "Neck", bone: "mixamorigNeck", child: "mixamorigHead", color: "#b98cff", group: "head", visibilityDepth: 0.2 },
	{ id: "head", label: "Head", bone: "mixamorigHead", child: null, color: "#b98cff", group: "head", visibilityDepth: 0.24 },
	{ id: "leftShoulder", label: "Left Shoulder", bone: "mixamorigLeftShoulder", child: "mixamorigLeftArm", color: "#ff8a3d", group: "shoulder", visibilityDepth: 0.2 },
	{ id: "rightShoulder", label: "Right Shoulder", bone: "mixamorigRightShoulder", child: "mixamorigRightArm", color: "#ff8a3d", group: "shoulder", visibilityDepth: 0.2 },
];

/** Whether a control centre is close enough to the first visible surface.
 * Centreline controls (torso/head) intentionally have larger allowances than
 * side-specific limbs, so front-facing body controls remain available while
 * the far shoulder/arm/leg is rejected. */
export function ikControlIsExposed(targetDistance, blockerDistance, visibilityDepth) {
	if (!Number.isFinite(targetDistance) || targetDistance <= 0) return false;
	if (!Number.isFinite(blockerDistance)) return true;
	return targetDistance - blockerDistance <= visibilityDepth;
}

/** Bone chains per handle, root → effector. Mixamo spelling; the matcher
 * accepts the `mixamorig:` prefix and prefix-less rigs. Shoulder stays out of
 * the arm chain — clavicle rotation swings the whole shoulder mass and reads
 * wrong for a blocking tool. */
const CHAINS = {
	arm: (side) => [`mixamorig${side}Arm`, `mixamorig${side}ForeArm`, `mixamorig${side}Hand`],
	leg: (side) => [`mixamorig${side}UpLeg`, `mixamorig${side}Leg`, `mixamorig${side}Foot`],
};

export function findBone(root, name) {
	const target = normalizeBoneName(name);
	let found = null;
	root.traverse((object) => {
		if (found || !object.isBone) return;
		const norm = normalizeBoneName(object.name);
		if (norm === target || norm.endsWith(target)) found = object;
	});
	return found;
}

/**
 * Resolve the IK rig against a character: the four two-bone chains, plus
 * the FK swing joints. Returns null when any chain is short a bone — the
 * caller then hides IK mode entirely rather than half-posing. Captures
 * per-chain segment lengths and a character-local POLE used ONLY as the
 * bend hint when the chain is perfectly straight. Elbows bend backward-
 * down, knees forward-down.
 */
export function resolveIkRig(rig) {
	if (!rig) return null;
	rig.updateMatrixWorld(true);
	// Character facing, from the toes: the toe sticks out of the foot in the
	// facing direction at any upright pose. Falls back to the group's +Z.
	const charQ = rig.quaternion;
	let forward = null;
	for (const side of ["Left", "Right"]) {
		const foot = findBone(rig, `mixamorig${side}Foot`);
		const toe = findBone(rig, `mixamorig${side}ToeBase`);
		if (foot && toe) {
			const f = foot.getWorldPosition(new THREE.Vector3());
			const t = toe.getWorldPosition(new THREE.Vector3());
			if (f.distanceTo(t) > 1e-6) {
				forward = t.sub(f).normalize();
				break;
			}
		}
	}
	if (!forward) forward = new THREE.Vector3(0, 0, 1).applyQuaternion(charQ);
	const invCharQ = charQ.clone().invert();
	const armPoleLocal = forward.clone().multiplyScalar(-1).add(new THREE.Vector3(0, -0.5, 0)).normalize().applyQuaternion(invCharQ);
	const legPoleLocal = forward.clone().add(new THREE.Vector3(0, -0.2, 0)).normalize().applyQuaternion(invCharQ);

	const contactRadii = measureContactRadii(rig);
	const out = new Map();
	const rootPos = new THREE.Vector3();
	const childPos = new THREE.Vector3();
	for (const track of IK_TRACKS) {
		const names = CHAINS[track.kind](track.side);
		const bones = names.map((n) => findBone(rig, n));
		if (bones.some((b) => !b)) return null;
		const lengths = [];
		for (let i = 0; i < bones.length - 1; i += 1) {
			bones[i].getWorldPosition(rootPos);
			bones[i + 1].getWorldPosition(childPos);
			const len = rootPos.distanceTo(childPos);
			if (len < 1e-6) return null;
			lengths.push(len);
		}
		out.set(track.id, {
			track,
			bones,
			contactRadii,
			contactHeights: measureContactHeights(rig),
			bindPositions: bones.map((bone) => {
				const saved = rig.userData?.poseBind?.get(bone)?.position;
				return saved
					? new THREE.Vector3(saved.x, saved.y, saved.z)
					: bone.position.clone();
			}),
			lengths,
			poleLocal: track.kind === "arm" ? armPoleLocal : legPoleLocal,
			rig,
		});
	}
	// FK swing joints: bone + the child that defines the swing direction. The
	// hips also carries its bind LOCAL position — the body root control
	// (height/lean translation for crouching and lying poses) works in
	// parent-local space, and keys must restore the exact bind spot.
	const fkJoints = new Map();
	for (const track of FK_TRACKS) {
		const bone = findBone(rig, track.bone);
		if (!bone) return null;
		const child = track.child ? findBone(rig, track.child) : null;
		fkJoints.set(track.id, {
			track,
			bone,
			child,
			bindPos: (() => {
				const saved = rig.userData?.poseBind?.get(bone)?.position;
				return saved
					? new THREE.Vector3(saved.x, saved.y, saved.z)
					: bone.position.clone();
			})(),
		});
	}
	return { chains: out, fkJoints, contactRadii, contactHeights: measureContactHeights(rig) };
}

/** Back-compat wrapper for callers that only need the chains map. */
export function resolveIkChains(rig) {
	const resolved = resolveIkRig(rig);
	return resolved ? resolved.chains : null;
}

/**
 * Two-bone analytic IK for one 3-bone chain (shoulder/hip → elbow/knee →
 * wrist/ankle). `target` is a world-space effector position. The root bone
 * is pinned; the elbow/knee is placed exactly by the law of cosines, so the
 * effector ALWAYS reaches a reachable target in one step.
 *
 * BEND CONTINUITY (the elbow-flip rule): the hinge direction follows the
 * elbow's CURRENT offset from the root→target line whenever one exists, so
 * a dragged limb keeps its own side and never mirror-flips when the target
 * crosses the bone line. Only a perfectly straight chain (no offset to
 * continue) falls back to the character-local pole hint.
 */
export function solveIk(chain, targetWorld) {
	restoreChainPositions(chain);
	const { bones, lengths, poleLocal, rig } = chain;
	const [b0, b1, b2] = bones;
	const p0 = b0.getWorldPosition(new THREE.Vector3());
	const p1cur = b1.getWorldPosition(new THREE.Vector3());
	const t = targetWorld.clone();
	const l0 = lengths[0];
	const l1 = lengths[1];
	let d = p0.distanceTo(t);

	const dir = t.clone().sub(p0);
	if (dir.lengthSq() < 1e-12) {
		dir.copy(b2.getWorldPosition(new THREE.Vector3())).sub(p0);
		if (dir.lengthSq() < 1e-12) dir.set(0, -1, 0);
	}
	dir.normalize();

	// Clamp into the annulus [|l0-l1|, l0+l1] so the law of cosines is exact:
	// an unreachable target stretches straight at it, never overshoots.
	const maxD = l0 + l1 - 1e-6;
	const minD = Math.abs(l0 - l1) + 1e-6;
	if (d > maxD) {
		d = maxD;
		t.copy(p0).addScaledVector(dir, d);
	} else if (d < minD) {
		d = minD;
		t.copy(p0).addScaledVector(dir, d);
	}

	// Law of cosines: the elbow sits at p0 + dir·proj + bend·off.
	const cosA = Math.max(-1, Math.min(1, (l0 * l0 + d * d - l1 * l1) / (2 * l0 * d)));
	const proj = l0 * cosA;
	const off = Math.sqrt(Math.max(0, l0 * l0 - proj * proj));

	const linePoint = p0.clone().addScaledVector(dir, proj);
	// Is the chain currently BENT? Only a bent chain has an elbow side worth
	// continuing — a straight chain's offset from the new target line is an
	// artifact of the line direction, not a hinge, so it must not be reused.
	const seg0 = p1cur.clone().sub(p0).normalize();
	const seg1 = b2.getWorldPosition(new THREE.Vector3()).sub(p1cur).normalize();
	const isBent = seg0.dot(seg1) < 0.999;
	let bend;
	if (isBent) {
		// Continuity: reuse the elbow's current offset from the line.
		bend = p1cur.clone().sub(linePoint);
	}
	if (!bend || bend.lengthSq() < 1e-8) {
		// Straight chain — no side to continue; use the pole hint.
		const poleWorld = poleLocal.clone().applyQuaternion(rig.quaternion);
		bend = poleWorld.clone().addScaledVector(dir, -poleWorld.dot(dir));
		if (bend.lengthSq() < 1e-8) {
			bend = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y);
			if (bend.lengthSq() < 1e-8) bend = new THREE.Vector3(0, 0, 1).addScaledVector(dir, -dir.z);
		}
	}
	bend.normalize();

	const p1 = linePoint.clone().addScaledVector(bend, off);
	const p2 = p0.clone().addScaledVector(dir, d);
	aimChain(bones, [p0, p1, p2]);
}

/** Re-aim each bone so its bone→child direction points at the solved joint
 * positions. Only b0 and b1 rotate; the effector (b2) keeps its local
 * rotation, so the hand follows the forearm and the foot follows the shin —
 * the same convention for every limb. */
function aimChain(bones, points) {
	const qDeltaWorld = new THREE.Quaternion();
	const qWorld = new THREE.Quaternion();
	const qParentWorldInv = new THREE.Quaternion();
	const currentDir = new THREE.Vector3();
	const wantedDir = new THREE.Vector3();
	const bonePos = new THREE.Vector3();
	const childPos = new THREE.Vector3();
	for (let i = 0; i < bones.length - 1; i += 1) {
		const bone = bones[i];
		bone.updateMatrixWorld(true);
		bone.getWorldPosition(bonePos);
		bones[i + 1].getWorldPosition(childPos);
		currentDir.subVectors(childPos, bonePos);
		if (currentDir.lengthSq() < 1e-10) continue;
		currentDir.normalize();
		wantedDir.subVectors(points[i + 1], points[i]);
		if (wantedDir.lengthSq() < 1e-10) continue;
		wantedDir.normalize();
		qDeltaWorld.setFromUnitVectors(currentDir, wantedDir);
		// New world orientation = delta ⊗ current world, expressed in the
		// parent's frame: qLocal = qParentWorldInv ⊗ qDelta ⊗ qWorld. The
		// parent frame must be the parent's WORLD rotation — on a real Mixamo
		// rig the bind locals are NOT identity (shoulder aims down the arm),
		// and reading parent.quaternion alone drops the ancestors' rotation,
		// which folds the chain instead of aiming it. getWorldQuaternion is
		// safe here: the rig's cm scale is uniform, so decompose extracts a
		// clean rotation, and the parent's matrixWorld is fresh from the
		// previous iteration's updateMatrixWorld.
		bone.getWorldQuaternion(qWorld);
		bone.parent.getWorldQuaternion(qParentWorldInv).invert();
		bone.quaternion.copy(qParentWorldInv.multiply(qDeltaWorld).multiply(qWorld));
		bone.updateMatrixWorld(true);
	}
}

/**
 * Mid-joint drag: reposition the elbow/knee directly. The mid joint sits on
 * the sphere of radius l0 around the pinned root, so the dragged point is
 * clamped radially onto it; the forearm/shin KEEPS ITS CURRENT WORLD
 * DIRECTION and the effector follows (Cascadeur's grab-the-point model:
 * dragging a mid point bends the limb and the end comes along). This always
 * works — crucially on a STRAIGHT chain too, where both-ends-pinned
 * models (and Maya's pole plane) have zero elbow freedom and read as
 * "the elbow doesn't move". Segment lengths are preserved exactly.
 */

/** Clamp a dragged IK position to the floor marker for its effector or
 * mid-joint. Kept pure so the editor and deterministic tests share the rule. */
export function clampIkTargetToFloor(trackId, targetWorld, floorY = 0, contactHeights = null) {
	if (!targetWorld || !Number.isFinite(targetWorld.y)) return targetWorld;
	const key = trackId?.endsWith("Hand")
		? trackId.replace(/^(left|right)/, (_, side) => side[0].toUpperCase() + side.slice(1))
		: trackId?.endsWith("Foot")
			? trackId.replace(/^(left|right)/, (_, side) => side[0].toUpperCase() + side.slice(1))
			: trackId?.endsWith("Elbow")
			? `${trackId.startsWith("left") ? "Left" : "Right"}ForeArm`
			: trackId?.endsWith("Knee")
				? `${trackId.startsWith("left") ? "Left" : "Right"}Leg`
				: null;
	const height = contactHeights?.[key];
	if (!Number.isFinite(height)) return targetWorld;
	return targetWorld.clone().setY(Math.max(targetWorld.y, floorY + height));
}

/** Translate hips to an absolute drag target and keep the measured pelvis
 * extent on the safe side of the floor. The correction is applied in world Y
 * after the normal parent-space translation, so it also works on yawed rigs. */
export function solveHipsTranslateToFloor(joint, worldDelta, startLocalPos, floorY = 0, contactHeights = null) {
	solveHipsTranslate(joint, worldDelta, startLocalPos);
	const height = contactHeights?.Hips;
	if (!Number.isFinite(height)) return;
	const root = joint.bone;
	const y = root.getWorldPosition(new THREE.Vector3()).y;
	if (y >= floorY + height) return;
	const parent = root.parent;
	const localLift = new THREE.Vector3(0, floorY + height - y, 0)
		.applyQuaternion(parent.getWorldQuaternion(new THREE.Quaternion()).invert())
		.divideScalar(parent.getWorldScale(new THREE.Vector3()).x || 1);
	root.position.add(localLift);
	root.updateMatrixWorld(true);
}

export function solveMidJoint(chain, midTargetWorld) {
	restoreChainPositions(chain);
	const { bones, lengths } = chain;
	const [b0, b1, b2] = bones;
	const p0 = b0.getWorldPosition(new THREE.Vector3());
	const p1cur = b1.getWorldPosition(new THREE.Vector3());
	const p2cur = b2.getWorldPosition(new THREE.Vector3());
	// Mid joint at the drag point, clamped to the root sphere (|p0→p1| = l0).
	const dir = midTargetWorld.clone().sub(p0);
	if (dir.lengthSq() < 1e-12) dir.copy(p1cur).sub(p0);
	dir.normalize();
	const p1 = p0.clone().addScaledVector(dir, lengths[0]);
	// Forearm keeps its current world direction; the wrist/ankle follows.
	const foreDir = p2cur.clone().sub(p1cur);
	if (foreDir.lengthSq() < 1e-12) foreDir.copy(dir);
	foreDir.normalize();
	const p2 = p1.clone().addScaledVector(foreDir, lengths[1]);
	aimChain(bones, [p0, p1, p2]);
	return p1; // the clamped position the caller should snap the handle to
}

/**
 * FK swing drag as a TRACKBALL rotation (three.js TransformControls rotate
 * model): the drag layer supplies a world rotation axis (drag direction ×
 * the joint→camera eye) and an angle (offset · tangent × speed/camDist),
 * and the rotation applies ABSOLUTELY from the drag-start orientation, so
 * repeated pointer moves never compound. Sensitivity is normalised by the
 * camera distance, so every joint responds identically in screen space —
 * the fix for the old aim-at-pointer model, whose sensitivity swung with
 * each joint's child-bone length (hips lurching 1.6 m on a small drag).
 */
export function solveSwingAngle(joint, axisWorld, angleRad, startQuat, startParentQuat) {
	const { bone } = joint;
	if (!Number.isFinite(angleRad) || Math.abs(angleRad) < 1e-9) return;
	if (joint.track.id !== "hips" && joint.bindPos) bone.position.copy(joint.bindPos);
	const qDelta = new THREE.Quaternion().setFromAxisAngle(axisWorld.clone().normalize(), angleRad);
	const qWorldStart = startParentQuat.clone().multiply(startQuat);
	const qParentInv = startParentQuat.clone().invert();
	bone.quaternion.copy(qParentInv.multiply(qDelta).multiply(qWorldStart));
	bone.updateMatrixWorld(true);
}

/**
 * Effector swing: rotate a chain's end bone (the hand/foot) around its own
 * centre — the IK solve positions the wrist/ankle, this orients it. Same
 * absolute-from-drag-start trackball math as solveSwingAngle, but nothing
 * else moves: b0/b1 keep their solved pose, so the limb stays put while the
 * hand or foot tilts, twists and turns.
 */
export function solveEffectorSwing(chain, axisWorld, angleRad, startQuat, startParentQuat) {
	if (!Number.isFinite(angleRad) || Math.abs(angleRad) < 1e-9) return;
	const bone = chain.bones[2];
	const qDelta = new THREE.Quaternion().setFromAxisAngle(axisWorld.clone().normalize(), angleRad);
	const qWorldStart = startParentQuat.clone().multiply(startQuat);
	const qParentInv = startParentQuat.clone().invert();
	bone.quaternion.copy(qParentInv.multiply(qDelta).multiply(qWorldStart));
	bone.updateMatrixWorld(true);
}

/**
 * Body-root translate: set the hips bone's parent-local position to
 * `startLocalPos` plus a world delta (height for crouching/kneeling,
 * lean-shift for lying). Absolute from the drag start, so repeated pointer
 * moves never compound. The whole skeleton follows (legs, spine, arms are
 * children), so this is how flat-on-floor poses become possible at all —
 * the Character blocking (charA) is untouched. The world delta is converted
 * through the parent's yaw and its cm scale (Mixamo rigs are 100× in
 * bone-local units).
 */
export function solveHipsTranslate(joint, worldDelta, startLocalPos) {
	const { bone } = joint;
	const parentInv = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
	// Parent world scale (uniform on a Mixamo rig): world → parent-local
	const scale = bone.parent.getWorldScale(new THREE.Vector3()).x || 1;
	const local = worldDelta.clone().applyQuaternion(parentInv).divideScalar(scale);
	bone.position.copy(startLocalPos).add(local);
	bone.updateMatrixWorld(true);
}

/* --- state ----------------------------------------------------------------- */

/** Mutable per-rig IK layer state. `targets` are the live handle positions
 * (world space) the handles render at and the solver reaches for. `keys`
 * maps frame → Map(trackId → {q, p}) — FK LOCAL rotations of the solved
 * chain bones (+ hips local position), stored only for parts the user has
 * dragged. `plants` holds the captured ankle positions for foot snapping. */
export function createIkState() {
	return { chains: null, targets: new Map(), keys: new Map(), tracked: new Set(), plants: new Map() };
}

/** Mark a chain as user-dragged (focused). Only tracked chains are keyed or
 * evaluated — everything else stays on the pure FK pose. */
export function ikTouch(ikState, trackId) {
	ikState.tracked.add(trackId);
}

/** Initialise the live targets from the rig's CURRENT effector positions.
 * Runs when IK mode opens: handles appear exactly on the wrists/ankles and
 * nothing moves. */
export function ikSeedTargets(chains, ikState) {
	const pos = new THREE.Vector3();
	for (const [id, chain] of chains) {
		chain.bones[2].getWorldPosition(pos);
		ikState.targets.set(id, pos.clone());
	}
}

/** Snapshot the current local rotations of every chain and FK bone — plus
 * the hips' LOCAL POSITION (the body root's height/lean) — the pre-IK state
 * restored when IK mode closes. */
export function ikSnapshot(rig, fkJoints) {
	const out = new Map();
	for (const [id, chain] of rig) {
		out.set(id, { quats: chain.bones.map((b) => b.quaternion.clone()), pos: null });
	}
	if (fkJoints) {
		for (const [id, joint] of fkJoints) {
			out.set(id, {
				quats: [joint.bone.quaternion.clone()],
				pos: joint.bindPos ? joint.bone.position.clone() : null,
			});
		}
	}
	return out;
}

/** Restore a snapshot taken by ikSnapshot. */
export function ikRestore(rig, snapshot, fkJoints) {
	if (!snapshot) return;
	for (const [id, saved] of snapshot) {
		const chain = rig.get(id);
		if (chain) {
			chain.bones.forEach((b, i) => {
				if (saved.quats[i]) b.quaternion.copy(saved.quats[i]);
			});
			chain.bones[0].updateMatrixWorld(true);
			continue;
		}
		const joint = fkJoints?.get(id);
		if (joint) {
			if (saved.quats[0]) joint.bone.quaternion.copy(saved.quats[0]);
			if (saved.pos && joint.bindPos) joint.bone.position.copy(saved.pos);
			joint.bone.updateMatrixWorld(true);
		}
	}
}

/** Bake the CURRENT local rotations of every TRACKED part into the key at
 * `frame`: solved chain bones (b0, b1) for chains, the single bone for FK
 * joints — and the hips' LOCAL POSITION when the body root was moved.
 * Entries are uniform { q: [...quats], p: localPos | null }. Local values
 * are character-position independent, so keys need no re-anchoring ever. */
export function ikBakeKeyframe(rig, ikState, frame, fkJoints) {
	let entry = ikState.keys.get(frame);
	for (const id of ikState.tracked) {
		const chain = rig.get(id);
		const joint = fkJoints?.get(id);
		let q = null;
		let p = null;
		if (chain) q = [chain.bones[0].quaternion.clone(), chain.bones[1].quaternion.clone(), chain.bones[2].quaternion.clone()];
		else if (joint) {
			q = [joint.bone.quaternion.clone()];
			if (joint.bindPos) p = joint.bone.position.clone();
		}
		if (!q) continue;
		if (!entry) ikState.keys.set(frame, (entry = new Map()));
		entry.set(id, { q, p });
	}
}

/** Drop the whole key at `frame`. */
export function ikRemoveKeyframe(ikState, frame) {
	ikState.keys.delete(frame);
}

/* --- foot planting (ground snap) -------------------------------------------- */

/** The two leg chains that get planted. */
const LEG_IDS = ["leftFoot", "rightFoot"];

/** Capture the current ankle world positions as the plant points. Called
 * once when a body (hips) drag starts, BEFORE the hips move — the feet
 * then stay exactly here for the whole drag (Cascadeur's always-active
 * ankle controllers / UE's foot-pin, over the existing two-bone solver). */
export function ikPlantFeet(chains, ikState) {
	const pos = new THREE.Vector3();
	for (const id of LEG_IDS) {
		const chain = chains.get(id);
		if (!chain) continue;
		chain.bones[2].getWorldPosition(pos);
		ikState.plants.set(id, pos.clone());
	}
}

/** Re-solve each planted leg chain so its ankle returns to its plant point.
 * Runs after every hips transform while the body drag is active: the hips
 * move, the feet stay, the knees bend. Legs that cannot reach their plant
 * stretch toward it and the foot comes off — the natural reach limit. */
export function ikSolvePlantedFeet(chains, ikState) {
	for (const id of LEG_IDS) {
		const plant = ikState.plants.get(id);
		const chain = chains.get(id);
		if (!plant || !chain) continue;
		solveIk(chain, plant);
	}
}

function liftChainContact(chain, marker, markerName, floorY, heights) {
	if (!chain || !marker) return false;
	const markerPos = new THREE.Vector3();
	const effector = new THREE.Vector3();
	const height = heights[markerName] ?? CONTACT_RADIUS_FALLBACK;
	if (!Number.isFinite(height)) return false;
	let changed = false;
	for (let pass = 0; pass < 3; pass += 1) {
		marker.getWorldPosition(markerPos);
		const penetration = floorY + height - markerPos.y;
		if (penetration <= 1e-7) break;
		chain.bones[2].getWorldPosition(effector);
		effector.y += penetration;
		solveIk(chain, effector);
		changed = true;
	}
	return changed;
}

/** Apply the live chain portion of Body contact during a hips drag. Feet are
 * omitted when requested because the separate planted-foot solve owns them. */
export function applyBodyContact(chains, fkJoints, floorY = 0, { skipFeet = false } = {}) {
	if (!chains || !fkJoints) return false;
	const chain = [...chains.values()][0];
	const rig = chain?.rig;
	if (!rig) return false;
	const heights = chain.contactHeights ?? measureContactHeights(rig);
	let changed = false;
	const contacts = skipFeet
		? [["leftHand", "LeftHand"], ["rightHand", "RightHand"]]
		: [["leftHand", "LeftHand"], ["rightHand", "RightHand"], ["leftFoot", "LeftFoot"], ["rightFoot", "RightFoot"]];
	for (const [id, name] of contacts) {
		const marker = chains.get(id)?.bones[2];
		if (marker && liftChainContact(chains.get(id), marker, name, floorY, heights)) changed = true;
	}
	const mids = skipFeet
		? [["leftHand", "LeftForeArm"], ["rightHand", "RightForeArm"]]
		: [["leftHand", "LeftForeArm"], ["rightHand", "RightForeArm"], ["leftFoot", "LeftLeg"], ["rightFoot", "RightLeg"]];
	for (const [id, name] of mids) {
		const chainForMid = chains.get(id);
		const current = chainForMid?.bones[1];
		if (!current) continue;
		const pos = current.getWorldPosition(new THREE.Vector3());
		const height = heights[name] ?? CONTACT_RADIUS_FALLBACK;
		if (pos.y < floorY + height - 1e-7) {
			solveMidJoint(chainForMid, pos.clone().setY(floorY + height));
			changed = true;
		}
	}
	for (const [id, name] of contacts) {
		const marker = chains.get(id)?.bones[2];
		if (marker && liftChainContact(chains.get(id), marker, name, floorY, heights)) changed = true;
	}
	return changed;
}

/** Frames with an authored key, sorted — the timeline markers. */
export function ikKeyframes(ikState) {
	return [...ikState.keys.keys()].sort((a, b) => a - b);
}

/**
 * Evaluate the IK layer at `frame`: for every TRACKED part with keys,
 * slerp each stored bone's local rotation between the nearest keyed frames
 * and apply it — chain bones (b0, b1) and FK joints alike. No re-solve:
 * playback reproduces exactly what was dragged. Untracked parts, and
 * tracked parts with no keys, are never written.
 *
 * `blendWindow` > 0 turns the layer into a LOCAL correction (used when a
 * generated motion plays underneath): the correction eases from full
 * strength at the edge keys down to zero over that many frames outside the
 * keyed range, blending against whatever pose is already on the bone (the
 * motion). Between keys the weight stays 1 — both endpoints are authored,
 * so the slerp is the design. With the default 0 the keys hold forever
 * (constant extrapolation), the no-motion behaviour.
 */
export function ikEvaluate(rig, ikState, frame, fkJoints, blendWindow = 0) {
	if (!rig) return;
	for (const id of ikState.tracked) {
		const sampled = sampleChain(ikState.keys, id, frame);
		if (!sampled) continue;
		const chain = rig.get(id);
		const joint = fkJoints?.get(id);
		const w = blendWindow > 0 ? correctionWeight(ikState.keys, id, frame, blendWindow) : 1;
		if (w <= 0) continue;
		if (chain) {
			restoreChainPositions(chain, w);
			if (w >= 1) {
				chain.bones[0].quaternion.copy(sampled.q[0]);
				chain.bones[1].quaternion.copy(sampled.q[1]);
				// The effector's authored rotation rides along when the key has it
				// (pre-rotation keys hold only b0/b1 — apply whatever is stored).
				if (sampled.q[2]) chain.bones[2].quaternion.copy(sampled.q[2]);
			} else {
				// current quats are the base layer's (motion) — ease toward the key
				chain.bones[0].quaternion.slerp(sampled.q[0], w);
				chain.bones[1].quaternion.slerp(sampled.q[1], w);
				if (sampled.q[2]) chain.bones[2].quaternion.slerp(sampled.q[2], w);
			}
			chain.bones[0].updateMatrixWorld(true);
		} else if (joint) {
			if (!sampled.p && joint.bindPos) joint.bone.position.lerp(joint.bindPos, w);
			if (w >= 1) joint.bone.quaternion.copy(sampled.q[0]);
			else joint.bone.quaternion.slerp(sampled.q[0], w);
			if (sampled.p && joint.bindPos) {
				if (w >= 1) joint.bone.position.copy(sampled.p);
				else joint.bone.position.lerp(sampled.p, w);
			}
			joint.bone.updateMatrixWorld(true);
		}
	}
}

/**
 * ARDY playback positions mapped joints independently. Once IK authors a
 * chain's rotations, those generated translations no longer describe the
 * same FK pose and can visually separate the limb. Return the edited chain
 * to its Mixamo bind translations before applying IK rotations so parent
 * rotation and fixed segment lengths own all descendants.
 */
function restoreChainPositions(chain, weight = 1) {
	if (!chain?.bindPositions) return;
	for (let index = 0; index < chain.bones.length; index += 1) {
		const bone = chain.bones[index];
		const bind = chain.bindPositions[index];
		if (weight >= 1) bone.position.copy(bind);
		else bone.position.lerp(bind, weight);
	}
	chain.bones[0].updateMatrixWorld(true);
}

/**
 * Correction strength at `frame` for one track: 1 inside the keyed range
 * (both neighbours authored), easing 1 → 0 across `blendWindow` frames
 * outside it, so a single key at frame 39 stops stomping the whole earlier
 * motion and instead blends back to the clip.
 */
function correctionWeight(keys, trackId, frame, blendWindow) {
	let first = null;
	let last = null;
	for (const f of keys.keys()) {
		if (!keys.get(f).has(trackId)) continue;
		if (first == null || f < first) first = f;
		if (last == null || f > last) last = f;
	}
	if (first == null) return 0;
	if (frame >= first && frame <= last) return 1;
	const d = frame < first ? first - frame : frame - last;
	return Math.max(0, 1 - d / blendWindow);
}

function sampleChain(keys, trackId, frame) {
	let prevFrame = null;
	let nextFrame = null;
	for (const f of keys.keys()) {
		if (!keys.get(f).has(trackId)) continue;
		if (f <= frame && (prevFrame == null || f > prevFrame)) prevFrame = f;
		if (f >= frame && (nextFrame == null || f < nextFrame)) nextFrame = f;
	}
	if (prevFrame == null && nextFrame == null) return null;
	if (prevFrame == null) return keys.get(nextFrame).get(trackId);
	if (nextFrame == null || prevFrame === nextFrame) return keys.get(prevFrame).get(trackId);
	const a = keys.get(prevFrame).get(trackId);
	const b = keys.get(nextFrame).get(trackId);
	const t = (frame - prevFrame) / (nextFrame - prevFrame);
	return {
		q: a.q.map((q, i) => q.clone().slerp(b.q[i], t)),
		p: a.p && b.p ? a.p.clone().lerp(b.p, t) : (a.p || b.p || null),
	};
}
