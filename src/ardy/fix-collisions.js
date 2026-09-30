import * as THREE from "three";
import {
	findBone,
	solveIk,
	solveMidJoint,
	solveSwingAngle,
	ikTouch,
	ikBakeKeyframe,
	measureContactRadii,
	hasBindPose,
	bindWorldPosition,
	restWorldPosition,
} from "./ik.js";

/**
 * Self-collision cleanup for generated motion: detect body parts that pass
 * through each other (a hand through the thigh, a forearm through the
 * chest) and push them apart with the existing two-bone IK solver.
 *
 * Standard character-cleanup technique (capsule proxies + iterative
 * projection, as in classic mocap-clean literature and DCC plugins), built
 * entirely on CozyClay's own pieces:
 *
 * - Each body segment gets a CAPSULE proxy (bone → child bone axis, radius
 *   measured from the bind-pose skinned mesh by measureContactRadii).
 * - Torso/head capsules are STATIC blockers; limb capsules are MOVABLE.
 * - A penetration is resolved by moving the limb — mid joint (elbow/knee)
 *   for the upper segment, effector (wrist/ankle) for the lower — out by
 *   (depth + offset) along the separation normal BIASED TOWARD THE REST POSE,
 *   so a deep hit escapes to the side the limb belongs on instead of taking
 *   the shortest way out (see REST-BIASED ESCAPE). solveIk's bend continuity
 *   keeps the elbow/knee on its own side, so the fix never flips a hinge.
 * - Passes repeat until nothing penetrates or maxIterations is hit — the
 *   same projected-gauss-seidel loop physics engines use, but with IK as
 *   the projection step.
 *
 * The result is baked through ikBakeKeyframe, so a fix is an ordinary IK
 * correction key: undoable, scrubbable, and blended back to the clip
 * outside its keyed range by ikEvaluate's blend window.
 */

/* --- capsule table ---------------------------------------------------------- */

/**
 * Body capsules. `movable.chain`/`movable.joint` name the IK chain and the
 * joint of that chain to drive ("mid" = elbow/knee, "effector" = wrist/
 * ankle). Torso, chest and head have no chain: they are blockers the limbs
 * get pushed out of. `radiusJoint` keys into the measured contact radii.
 *
 * `endOptional` marks an end bone the rig is allowed not to have: the hands
 * span wrist → middle-finger base so a fingertip driven into a thigh is
 * judged at the FINGERS, not at the wrist a palm's length behind them (a
 * wrist-only sphere reads that pose as clean). Rigs exported without finger
 * bones simply fall back to the wrist sphere instead of disqualifying the
 * whole tool.
 */
// `maxRadius` caps the measured radius where the mesh extent is not a
// thickness: the head measurement runs crown-to-chin (a length), the foot
// measurement follows the toe (also a length). Uncapped, those fat capsules
// flag permanent false contacts with the torso and with the other foot at
// any normal stance.
const CAPSULE_DEFS = [
	{ id: "torso", start: "mixamorigHips", end: "mixamorigSpine1", radiusJoint: "Spine", maxRadius: 0.17, movable: null },
	{ id: "chest", start: "mixamorigSpine1", end: "mixamorigSpine2", radiusJoint: "Spine", maxRadius: 0.16, movable: null },
	{ id: "head", start: "mixamorigNeck", end: "mixamorigHead", radiusJoint: "Head", maxRadius: 0.11, movable: null },
	{ id: "leftUpperArm", start: "mixamorigLeftArm", end: "mixamorigLeftForeArm", radiusJoint: "LeftArm", movable: { chain: "leftHand", joint: "mid" }, priority: 2 },
	{ id: "leftForeArm", start: "mixamorigLeftForeArm", end: "mixamorigLeftHand", radiusJoint: "LeftForeArm", movable: { chain: "leftHand", joint: "effector" }, priority: 2 },
	{ id: "leftHand", start: "mixamorigLeftHand", end: "mixamorigLeftHandMiddle1", endOptional: true, radiusJoint: "LeftHand", maxRadius: 0.06, movable: { chain: "leftHand", joint: "effector" }, priority: 2 },
	{ id: "rightUpperArm", start: "mixamorigRightArm", end: "mixamorigRightForeArm", radiusJoint: "RightArm", movable: { chain: "rightHand", joint: "mid" }, priority: 2 },
	{ id: "rightForeArm", start: "mixamorigRightForeArm", end: "mixamorigRightHand", radiusJoint: "RightForeArm", movable: { chain: "rightHand", joint: "effector" }, priority: 2 },
	{ id: "rightHand", start: "mixamorigRightHand", end: "mixamorigRightHandMiddle1", endOptional: true, radiusJoint: "RightHand", maxRadius: 0.06, movable: { chain: "rightHand", joint: "effector" }, priority: 2 },
	{ id: "leftThigh", start: "mixamorigLeftUpLeg", end: "mixamorigLeftLeg", radiusJoint: "LeftUpLeg", movable: { chain: "leftFoot", joint: "mid" }, priority: 1 },
	{ id: "leftShin", start: "mixamorigLeftLeg", end: "mixamorigLeftFoot", radiusJoint: "LeftLeg", movable: { chain: "leftFoot", joint: "effector" }, priority: 1 },
	{ id: "leftFoot", start: "mixamorigLeftFoot", end: "mixamorigLeftToeBase", radiusJoint: "LeftFoot", maxRadius: 0.07, movable: { chain: "leftFoot", joint: "effector" }, priority: 1 },
	{ id: "rightThigh", start: "mixamorigRightUpLeg", end: "mixamorigRightLeg", radiusJoint: "RightUpLeg", movable: { chain: "rightFoot", joint: "mid" }, priority: 1 },
	{ id: "rightShin", start: "mixamorigRightLeg", end: "mixamorigRightFoot", radiusJoint: "RightLeg", movable: { chain: "rightFoot", joint: "effector" }, priority: 1 },
	{ id: "rightFoot", start: "mixamorigRightFoot", end: "mixamorigRightToeBase", radiusJoint: "RightFoot", maxRadius: 0.07, movable: { chain: "rightFoot", joint: "effector" }, priority: 1 },
];

/* --- fingers ---------------------------------------------------------------- */

/**
 * FINGER CAPSULES. The hand capsule spans wrist → middle-finger base, which is
 * a palm: it still reads a pose where the FINGERS are buried in a thigh and the
 * palm is not as clean, because the fingers stick out another 8 cm past its end
 * cap. Mixamo hands carry mixamorig{Side}Hand{Finger}1..4, so each finger gets
 * its own thin capsule from the base joint to the tip.
 *
 * OPTIONAL, ONE FINGER AT A TIME. Game rigs ship every mixture of these bones:
 * all four joints, three, a thumb only, none at all. A finger falls back from
 * 1→4 to 1→3 and, failing both, is simply left out — `optional` means a MISSING
 * finger is not a missing capsule but a missing entry, so a fingerless rig is
 * still fully supported (supportsCollisionCleanup ignores optional defs) and
 * every other proxy is built exactly as before.
 *
 * RADIUS is a constant. measureContactRadii's CONTACT_JOINTS carry no finger
 * entries — there is nothing to look up — and a finger is the one body part
 * whose thickness barely varies between characters.
 */
export const FINGER_RADIUS = 0.011;

const FINGER_NAMES = ["Thumb", "Index", "Middle", "Ring", "Pinky"];

for (const side of ["Left", "Right"]) {
	const lower = side === "Left" ? "left" : "right";
	for (const finger of FINGER_NAMES) {
		CAPSULE_DEFS.push({
			id: `${lower}Hand${finger}`,
			start: `mixamorig${side}Hand${finger}1`,
			// First spelling that resolves wins: the tip, else the last knuckle.
			ends: [`mixamorig${side}Hand${finger}4`, `mixamorig${side}Hand${finger}3`],
			optional: true,
			fixedRadius: FINGER_RADIUS,
			// The two ids a finger must never be tested against beyond its own
			// kind — see pairExcluded.
			handId: `${lower}Hand`,
			foreArmId: `${lower}ForeArm`,
			movable: { chain: `${lower}Hand`, joint: "effector" },
			priority: 2,
		});
	}
}

/**
 * A pair whose two capsules ride the SAME two-bone chain: the elbow folded shut,
 * the knee folded shut. Every push moves both ends together, so no solver run
 * can open the gap — the fixer must never act on one (it spends its passes
 * rearranging the limb, and on QA's yawed box it chased a fold the fix itself
 * had created and drove the hand 574 mm, 55 mm INTO the box). Detection still
 * REPORTS it, because a viewer can see a folded limb; what it must not do is
 * count as a frame the tool failed to clean.
 */
export function isHingeFold(pen) {
	const a = pen?.a?.def?.movable?.chain;
	const b = pen?.b?.def?.movable?.chain;
	return Boolean(a && b && a === b);
}

/** Fallback radius when no measurement exists (matches ik.js's floor). */
const RADIUS_FALLBACK = 0.01;

/** Soft-tissue compression allowance, as a fraction of the thinner capsule.
 * See detectPenetrations for why this is 0.25 and not something roomier. */
export const DEFAULT_SLACK_FACTOR = 0.25;

/** How much closer than its BIND pose a pair must come before the extra
 * closeness counts as a collision. See restPairOverlaps. 5 mm is under the
 * amplitude of the proxy error itself and far under any visible interpenetration. */
export const PAIR_TOLERANCE = 0.005;

/**
 * REPORTING FLOOR. A capsule proxy is a coarse stand-in for a specific mesh, and
 * its agreement with that mesh is worth a few millimetres at best; the pushes it
 * takes to resolve one are not small (a 0.2 mm thigh × thigh reading during a
 * normal walk stride moved the pose 16 mm and keyed the frame). So a pair under
 * this depth is not reported at all — not by detection, not to the fixer, not to
 * the readout — and the tool spends its passes on contact a viewer can actually
 * see.
 */
export const MIN_DEPTH = 0.004;

/** Clearance the pushed joint keeps above the floor. A separation normal has
 * no idea the ground exists, so an otherwise correct push can drive an ankle
 * or a knee underground; the fix trades a little residual for never solving one
 * artefact by creating a worse one. */
export const PUSH_FLOOR_CLEARANCE = 0.005;

/** Foot markers the accept gate keeps above the floor. The push guard clamps
 * the joint it DRIVES, which is the ankle; the toe hangs off the far side of
 * the foot and goes under the deck while the ankle sits happily at its
 * clearance. Judging the markers catches what the push guard structurally
 * cannot. */
const FLOOR_MARKERS = [
	"mixamorigLeftFoot", "mixamorigRightFoot", "mixamorigLeftToeBase", "mixamorigRightToeBase",
];

/**
 * TORSO/HEAD YIELD. Torso, chest and head are static blockers, which is right
 * for the geometry and wrong for the failure mode: when a limb is reach-limited
 * — a leg pinned by the floor guard, an arm at full stretch — the passes run
 * out with the penetration still there and the tool reports a residual it had no
 * way to spend. A body leans out of the way of its own knee; the rig should be
 * allowed to as well.
 *
 * So, only AFTER the limb passes have done what they can, the blocker gives a
 * little: a small FK swing on the spine (Spine1, the `chest` FK joint) or the
 * neck, away from the contact. Capped hard in both directions — per step and per
 * run — because a yield that could grow without bound would turn every hard case
 * into a bent-over character, and because the cap is what keeps the loop finite.
 * Every yielded joint id lands in `touched`, so the caller's bake keys the spine
 * exactly as it keys a limb.
 */
export const YIELD_STEP_RAD = (6 * Math.PI) / 180;
export const YIELD_TOTAL_RAD = (12 * Math.PI) / 180;

/**
 * Which FK joint carries each static blocker's yield — the joint whose rotation
 * actually MOVES that capsule. A capsule is drawn between two bone POSITIONS,
 * and rotating a bone never moves its own origin: swinging Spine1 turns the
 * chest (Spine1 → Spine2) but leaves the torso capsule (Hips → Spine1) exactly
 * where it was, so the torso's yield belongs one joint lower, at Spine, whose
 * swing carries Spine1 — and the chest with it.
 */
const YIELD_JOINTS = { torso: "spine", chest: "chest", head: "neck" };

/** The bone behind each of those ids, for a caller that has no FK joint map to
 * lend. Shaped exactly like resolveIkRig's entries — track id, bone, bind local
 * position — because solveSwingAngle and ikBakeKeyframe both read them that way,
 * and because the ids have to match the App's FK tracks for the bake to land. */
const YIELD_BONES = { spine: "mixamorigSpine", chest: "mixamorigSpine1", neck: "mixamorigNeck" };
function fallbackYieldJoints(rig) {
	const joints = new Map();
	for (const [id, name] of Object.entries(YIELD_BONES)) {
		const bone = findBone(rig, name);
		if (!bone) continue;
		const saved = rig.userData?.poseBind?.get(bone)?.position;
		joints.set(id, {
			track: { id },
			bone,
			bindPos: saved ? new THREE.Vector3(saved.x, saved.y, saved.z) : bone.position.clone(),
		});
	}
	return joints;
}

/**
 * True when the rig carries every bone the capsule table REQUIRES — the
 * cheap pre-flight the UI runs to decide whether to offer the tool at all.
 * Bone lookups only: no mesh measurement, so it is safe to call per render.
 * Optional ends (the finger bones) never count against a rig.
 */
export function supportsCollisionCleanup(rig) {
	if (!rig) return false;
	for (const def of CAPSULE_DEFS) {
		// An OPTIONAL capsule (the fingers) is an extra proxy, never a
		// requirement: a rig without them is described just as well without them.
		if (def.optional) continue;
		if (!findBone(rig, def.start)) return false;
		if (def.end && !def.endOptional && !findBone(rig, def.end)) return false;
	}
	return true;
}

/** The capsule table against an arbitrary source of bone positions — the
 * current pose for detection, the bind pose for calibration. Returns null when
 * a REQUIRED bone is missing. */
function buildCapsules(rig, radiiMap, positionOf) {
	const capsules = new Map();
	for (const def of CAPSULE_DEFS) {
		const start = findBone(rig, def.start);
		// An OPTIONAL capsule the rig has no bones for is left out, not fatal.
		if (!start) {
			if (def.optional) continue;
			return null;
		}
		let end = null;
		if (def.ends) {
			for (const name of def.ends) {
				end = findBone(rig, name);
				if (end) break;
			}
			// A finger with a base joint but no further joint has no segment worth
			// testing: skip it rather than park a knuckle-sized sphere on the hand.
			if (!end) continue;
		} else if (def.end) {
			end = findBone(rig, def.end);
			// A missing OPTIONAL end degrades to the wrist sphere; a missing
			// required end means this is not a rig we can build proxies for.
			if (!end && !def.endOptional) return null;
		}
		const a = positionOf(start);
		const b = end ? positionOf(end) : a.clone();
		const measured = Math.max(RADIUS_FALLBACK, radiiMap[def.radiusJoint] ?? RADIUS_FALLBACK);
		const radius = def.fixedRadius ?? (def.maxRadius ? Math.min(measured, def.maxRadius) : measured);
		capsules.set(def.id, {
			def,
			bones: end ? [start, end] : [start],
			a,
			b,
			radius,
		});
	}
	return capsules;
}

/**
 * Build world-space capsules for the rig's CURRENT pose. Cheap (a bone
 * lookup + two world positions per entry), so callers rebuild per frame.
 * `radii` overrides the measured map (tests, or rigs without skin weights).
 * Returns null when a REQUIRED bone is missing — a non-Mixamo rig the tool
 * cannot describe, same policy as resolveIkRig. Callers must tell that apart
 * from "found nothing to fix": see fixCollisions's `supported` flag.
 */
export function buildCollisionCapsules(rig, radii = null) {
	if (!rig) return null;
	rig.updateMatrixWorld(true);
	const radiiMap = radii ?? measureContactRadii(rig);
	const capsules = buildCapsules(rig, radiiMap, (bone) => bone.getWorldPosition(new THREE.Vector3()));
	// Ride the pair calibration along on the map so detectPenetrations gets it
	// for free — it is a property of the RIG, which detection alone cannot see.
	if (capsules) capsules.pairAllowances = restPairOverlaps(rig, radiiMap);
	return capsules;
}

/* --- rest-relative calibration ---------------------------------------------- */

/** Stable key for an unordered capsule pair. */
function pairKey(idA, idB) {
	return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

// rig → (radii object identity → pair overlap map). The reference poses never
// change, so this is measured once per character.
const restOverlapCache = new WeakMap();

/** Every testable pair's overlap in one reference pose, positive entries only,
 * merged into `into` by taking the larger of the two. Measured through the SAME
 * pairGeometry detection uses, so a trimmed (hinged) pair is calibrated on the
 * portions it will actually be judged on — the natural fold a character rests
 * in is a legitimate overlap there exactly as it is anywhere else. */
function collectPairOverlaps(rig, radiiMap, positionOf, into) {
	const capsules = buildCapsules(rig, radiiMap, positionOf);
	if (!capsules) return into;
	const list = [...capsules.values()];
	const pa = new THREE.Vector3();
	const pb = new THREE.Vector3();
	for (let i = 0; i < list.length; i += 1) {
		for (let j = i + 1; j < list.length; j += 1) {
			const geo = pairGeometry(list[i], list[j]);
			if (!geo) continue;
			closestPointsSegmentSegment(geo.a0, geo.a1, geo.b0, geo.b1, pa, pb);
			const overlap = list[i].radius + list[j].radius - pa.distanceTo(pb);
			if (overlap <= 0) continue;
			const key = pairKey(list[i].def.id, list[j].def.id);
			if (overlap > (into.get(key) ?? 0)) into.set(key, overlap);
		}
	}
	return into;
}

/**
 * How much each non-adjacent capsule pair ALREADY overlaps in a pose the
 * character legitimately holds, in metres (positive entries only; a pair that is
 * clear in every reference pose has no entry). Returns null on a rig with no
 * bind snapshot to compose from.
 *
 * Capsules are a coarse proxy for a specific mesh, and on real characters the
 * proxy error is not small: on the shipped default rig the REST pose reports
 * torso × upper arm at 9.2 mm of "penetration" (torso 0.17 + upper arm 0.05447
 * + offset 0.002 against a 0.19547 axis distance, minus a 21.8 mm slack
 * allowance). One press of Fix collisions on a brand-new project baked a phantom
 * key and moved the rig 13.7 mm. Slack cannot fix this: the rig would need
 * slackFactor ≥ 0.569 to read clean, and a global allowance that loose re-masks
 * every real contact on every other pair.
 *
 * So the pair's own reference overlap becomes its zero point — the same
 * clip-relative-ground move auto-physics made for the floor.
 *
 * TWO REFERENCE POSES, and the second is the one that matters. `poseBind` is a
 * T-POSE: arms straight out, nowhere near the torso (LeftForeArm at x = 0.4616).
 * The pose the app actually shows is DEFAULT_POSE — arms hanging at the sides,
 * the same forearm at x = 0.1876 — and that is where the arm capsules graze the
 * torso. Calibrating against bind alone therefore recorded only leftThigh ×
 * rightThigh and left torso × upper arm at zero allowance, which is exactly the
 * pair that false-positives. Both poses are measured and the LARGER allowance
 * wins, so a T-posed character and a standing one both read clean, while a pair
 * that overlaps in neither (a hand driven into a thigh) still fires at full
 * sensitivity. Both are composed virtually through ik.js, so measuring never
 * disturbs — or depends on — the pose currently on screen.
 *
 * The cost, stated plainly: contact that the rest pose already has is invisible
 * here. An arm pressed flat against the ribs cannot be distinguished from an arm
 * hanging beside them, because the capsule proxies genuinely cannot tell those
 * apart. Excluding those pairs outright (the alternative) would lose the deep
 * hits too; this keeps them.
 */
export function restPairOverlaps(rig, radii = null) {
	if (!rig || !hasBindPose(rig)) return null;
	const radiiMap = radii ?? measureContactRadii(rig);
	let perRadii = restOverlapCache.get(rig);
	if (!perRadii) restOverlapCache.set(rig, (perRadii = new Map()));
	const cached = perRadii.get(radiiMap);
	if (cached) return cached;
	rig.updateMatrixWorld(true);
	const overlaps = new Map();
	collectPairOverlaps(rig, radiiMap, (bone) => bindWorldPosition(rig, bone, new THREE.Vector3()), overlaps);
	collectPairOverlaps(rig, radiiMap, (bone) => restWorldPosition(rig, bone, new THREE.Vector3()), overlaps);
	perRadii.set(radiiMap, overlaps);
	return overlaps;
}

/* --- detection -------------------------------------------------------------- */

/** Closest points between two segments (Ericson, Real-Time Collision
 * Detection — the textbook segment/segment distance). Writes into outA/outB
 * and returns the squared distance. */
function closestPointsSegmentSegment(p1, q1, p2, q2, outA, outB) {
	const d1 = q1.clone().sub(p1);
	const d2 = q2.clone().sub(p2);
	const r = p1.clone().sub(p2);
	const a = d1.dot(d1);
	const e = d2.dot(d2);
	const f = d2.dot(r);
	let s;
	let t;
	if (a <= 1e-12 && e <= 1e-12) {
		outA.copy(p1); outB.copy(p2);
		return r.dot(r);
	}
	if (a <= 1e-12) {
		s = 0;
		t = Math.max(0, Math.min(1, f / e));
	} else {
		const c = d1.dot(r);
		if (e <= 1e-12) {
			t = 0;
			s = Math.max(0, Math.min(1, -c / a));
		} else {
			const b = d1.dot(d2);
			const denom = a * e - b * b;
			s = denom > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
			t = (b * s + f) / e;
			if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
			else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
		}
	}
	outA.copy(p1).addScaledVector(d1, s);
	outB.copy(p2).addScaledVector(d2, t);
	return outA.distanceToSquared(outB);
}

/** Ancestor hop count between two bones, or Infinity when neither is an
 * ancestor of the other within `limit` hops. */
const HOP_SEARCH = 8;
function boneHops(b0, b1, limit = HOP_SEARCH) {
	let hops = 0;
	for (let node = b0; node && hops <= limit; node = node.parent, hops += 1) {
		if (node === b1) return hops;
	}
	hops = 0;
	for (let node = b1; node && hops <= limit; node = node.parent, hops += 1) {
		if (node === b0) return hops;
	}
	return Infinity;
}

/** Capsules whose endpoints sit within HOP_LIMIT hops on the skeleton are
 * NEIGHBOURS (upper arm against chest at the shoulder, thigh against the
 * pelvis, forearm against upper arm at the elbow): they always overlap AT the
 * joint they share, so they get the trimmed test below rather than the plain
 * one. */
const HOP_LIMIT = 2;
function bonesRelated(b0, b1) {
	return boneHops(b0, b1, HOP_LIMIT) <= HOP_LIMIT;
}

function capsulesAdjacent(ca, cb) {
	return ca.bones.some((ba) => cb.bones.some((bb) => bonesRelated(ba, bb)));
}

/* --- hinged pairs ------------------------------------------------------------ */

/**
 * HINGED PAIRS. A blanket "skip everything within HOP_LIMIT" made whole classes
 * of real interpenetration invisible: a knee driven into the belly is
 * thigh × torso, an arm folded past its own elbow is forearm × upper arm, and
 * neither pair was ever tested. The skip existed for a good reason — the two
 * capsules MEET at the joint they share, so an untrimmed test reports a
 * permanent collision at every pose and pins the fixer forever — but that
 * reason only covers the part of each capsule NEXT TO the joint.
 *
 * So the pair is tested on the portions FAR from the shared joint: TRIM_FRACTION
 * of each segment is cut away from the joint side, and the segment-segment test
 * runs on what is left. A normally bent elbow keeps its far portions well apart;
 * a fully folded one lays them on top of each other, which is exactly the pose
 * that has to be caught.
 *
 * The joint side is the endpoint CLOSER to the other capsule in the hierarchy
 * (fewest ancestor hops), so the trim always eats the shared end and never the
 * free one.
 */
export const TRIM_FRACTION = 0.45;

/**
 * Compression allowance for a pair that SHARES a bone — the two segments of one
 * hinge (elbow, knee, ankle, wrist, waist). Flesh-to-flesh contact is the normal
 * state of a deep fold there, and the capsule proxies overlap by construction
 * long before the pose is wrong, so the thin-capsule slack rule is the wrong
 * ruler: this one is a fraction of the COMBINED radii, and only a fold that puts
 * the far end of one segment inside the body of the other clears it.
 */
export const HINGE_SLACK_FACTOR = 0.65;

/** Which end of `ca` faces `cb` on the skeleton: true = the START endpoint. */
function jointSideIsStart(ca, cb) {
	const hopsOf = (bone) => Math.min(...cb.bones.map((other) => boneHops(bone, other)));
	const first = hopsOf(ca.bones[0]);
	const last = ca.bones.length > 1 ? hopsOf(ca.bones[ca.bones.length - 1]) : first;
	return first <= last;
}

/** `ca` with the joint-side TRIM_FRACTION cut off, written into out0/out1. */
function trimTowardJoint(ca, cb, out0, out1) {
	if (jointSideIsStart(ca, cb)) {
		out0.copy(ca.a).lerp(ca.b, TRIM_FRACTION);
		out1.copy(ca.b);
	} else {
		out0.copy(ca.a);
		out1.copy(ca.b).lerp(ca.a, TRIM_FRACTION);
	}
}

/** How many bones the two capsules have in common (0, 1 or 2). */
function sharedBoneCount(ca, cb) {
	return ca.bones.filter((bone) => cb.bones.includes(bone)).length;
}

/**
 * Pairs that must never be tested, whatever the pose.
 *
 * Adjacency already covers most of the finger cases (a finger base is one hop
 * from the hand, two from the forearm), but the trimmed test above means
 * "adjacent" no longer means "skipped", so the finger rules are spelled out
 * rather than inherited: a finger against its own hand, its own forearm, or any
 * other finger is a pose the proxies cannot judge — fingers touch each other and
 * lie against the palm constantly — while a finger against a thigh, a shin, the
 * torso, the chest, the head or the opposite arm is exactly what the finger
 * capsules were added to catch.
 */
function pairExcluded(ca, cb) {
	const fa = ca.def.handId;
	const fb = cb.def.handId;
	if (fa && fb) return true; // finger × finger, either hand
	if (fa && (cb.def.id === fa || cb.def.id === ca.def.foreArmId)) return true;
	if (fb && (ca.def.id === fb || ca.def.id === cb.def.foreArmId)) return true;
	// SAME CHAIN, no shared joint: a hand against its own upper arm, a foot
	// against its own thigh, a finger against its own forearm. Two things are
	// true of every such pair and neither is true of a hinge: the pose is
	// legitimate (a hand rests on its own shoulder, a heel touches its own
	// thigh) and the fixer could not separate them anyway, because ONE solver
	// drives both sides and each push undoes the other — measured as a fold
	// that oscillated to maxIterations without converging. The fold that IS
	// impossible — the segments either side of the elbow or the knee — shares a
	// bone, and stays tested (trimmed) by the rule above.
	const chainA = ca.def.movable?.chain;
	const chainB = cb.def.movable?.chain;
	if (chainA && chainA === chainB && sharedBoneCount(ca, cb) === 0) return true;
	return false;
}

/** Scratch segments for the pair geometry below. One pair is measured at a time
 * (detection is a plain double loop), so these can be module-level. */
const geoA0 = new THREE.Vector3();
const geoA1 = new THREE.Vector3();
const geoB0 = new THREE.Vector3();
const geoB1 = new THREE.Vector3();
const geometry = { a0: geoA0, a1: geoA1, b0: geoB0, b1: geoB1, hinge: false };

/**
 * The segments to test for one capsule pair, or null when the pair is not
 * testable at all. Unrelated capsules are tested whole; neighbours are tested
 * on their trimmed portions (see HINGED PAIRS). The returned object is REUSED
 * between calls — read it before the next call.
 */
function pairGeometry(ca, cb) {
	if (pairExcluded(ca, cb)) return null;
	if (!capsulesAdjacent(ca, cb)) {
		geoA0.copy(ca.a); geoA1.copy(ca.b);
		geoB0.copy(cb.a); geoB1.copy(cb.b);
		geometry.hinge = false;
		return geometry;
	}
	// Same segment, or two capsules over the same two bones: there is no "far
	// portion" to compare and nothing a fixer could do about it either way.
	const shared = sharedBoneCount(ca, cb);
	if (shared >= 2 || ca.bones.length === 0 || cb.bones.length === 0) return null;
	// Two static blockers meeting at the spine (torso × chest, chest × head) are
	// permanent by construction and unfixable by anything: no limb chain drives
	// them. Reporting them would only burn passes — the same reason
	// fixCollisions filters static × static out of its own pass list.
	if (!ca.def.movable && !cb.def.movable) return null;
	trimTowardJoint(ca, cb, geoA0, geoA1);
	trimTowardJoint(cb, ca, geoB0, geoB1);
	geometry.hinge = shared === 1;
	return geometry;
}

/* --- external blockers ------------------------------------------------------- */

/**
 * EXTERNAL BLOCKERS. Everything above is the character against itself; a hand
 * swinging through a chair is the same problem against the SET. Callers pass
 * `blockers`: world-space static shapes, already posed for the frame being
 * solved (the caller owns their animation — this owns the push).
 *
 *   capsule: { id, kind: "capsule", a: Vector3, b: Vector3, radius }
 *   box:     { id, kind: "box", center: Vector3, halfExtents: Vector3, yaw }
 *
 * `yaw` is radians about world +Y, the only rotation a prop standing on a floor
 * normally needs and the only one the closest-point test below has to invert.
 *
 * They behave exactly like torso and head: never movable, never adjacent to
 * anything, and never rest-calibrated — a character's rest pose says nothing
 * about where the furniture is. The full slack rule applies, with one wrinkle: a
 * box has no radius to take the min against, so the movable capsule's own slack
 * is used (a box is a surface, not a soft body).
 *
 * A blocker's records carry its id VERBATIM, so the existing pair readouts
 * ("leftHand×obj:chair") identify which prop was hit without any caller change.
 * The id is the caller's to namespace — collision-blockers.js already ships
 * "obj:cube" and "char:char-2:torso" — and a prefix added here would only double
 * it up ("obj:obj:cube", as QA read out).
 */
function blockerEntry(shape) {
	if (!shape || typeof shape.id !== "string") return null;
	const point = (value) => (value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
		? new THREE.Vector3(value.x, value.y, value.z)
		: null);
	const def = { id: shape.id, movable: null, blocker: true };
	if (shape.kind === "capsule") {
		const a = point(shape.a);
		const b = point(shape.b);
		if (!a || !b || !Number.isFinite(shape.radius) || shape.radius < 0) return null;
		return { def, kind: "capsule", bones: [], a, b, radius: shape.radius };
	}
	if (shape.kind === "box") {
		const center = point(shape.center);
		const halfExtents = point(shape.halfExtents);
		if (!center || !halfExtents) return null;
		halfExtents.set(Math.abs(halfExtents.x), Math.abs(halfExtents.y), Math.abs(halfExtents.z));
		return {
			def,
			kind: "box",
			bones: [],
			center,
			halfExtents,
			yaw: Number.isFinite(shape.yaw) ? shape.yaw : 0,
			// The slack rule reads `radius`; a box surface has none.
			radius: 0,
		};
	}
	return null;
}

/** The capsule whose START is a chain's root joint (shoulder / hip) — the
 * anchor a box escape aims back toward. */
const CHAIN_ROOT_CAPSULE = {
	leftHand: "leftUpperArm",
	rightHand: "rightUpperArm",
	leftFoot: "leftThigh",
	rightFoot: "rightThigh",
};

function normalizeBlockers(blockers) {
	if (!Array.isArray(blockers) || blockers.length === 0) return [];
	const out = [];
	for (const shape of blockers) {
		const entry = blockerEntry(shape);
		if (entry) out.push(entry);
	}
	return out;
}

/**
 * Signed distance from `point` to an oriented box: positive outside, NEGATIVE
 * inside (the depth to the nearest face). Writes the closest SURFACE point into
 * `outSurface` and the outward surface normal there into `outNormal`.
 *
 * The box is axis-aligned once the yaw is undone, so the whole thing is a clamp
 * in box space plus a rotation back.
 */
const boxLocal = new THREE.Vector3();
const boxClamped = new THREE.Vector3();
const boxPrefer = new THREE.Vector3();
function boxSignedDistance(box, point, outSurface, outNormal, prefer = null) {
	const cos = Math.cos(box.yaw);
	const sin = Math.sin(box.yaw);
	const dx = point.x - box.center.x;
	const dy = point.y - box.center.y;
	const dz = point.z - box.center.z;
	// world → box: rotate by −yaw about Y.
	boxLocal.set(cos * dx - sin * dz, dy, sin * dx + cos * dz);
	const h = box.halfExtents;
	const outward = (local) => {
		// box → world.
		outSurface.set(cos * local.x + sin * local.z, local.y, -sin * local.x + cos * local.z).add(box.center);
	};
	const outsideX = Math.abs(boxLocal.x) - h.x;
	const outsideY = Math.abs(boxLocal.y) - h.y;
	const outsideZ = Math.abs(boxLocal.z) - h.z;
	if (outsideX > 0 || outsideY > 0 || outsideZ > 0) {
		boxClamped.set(
			Math.max(-h.x, Math.min(h.x, boxLocal.x)),
			Math.max(-h.y, Math.min(h.y, boxLocal.y)),
			Math.max(-h.z, Math.min(h.z, boxLocal.z)),
		);
		const distance = boxLocal.distanceTo(boxClamped);
		outward(boxClamped);
		if (distance > 1e-9) {
			const nx = (boxLocal.x - boxClamped.x) / distance;
			const ny = (boxLocal.y - boxClamped.y) / distance;
			const nz = (boxLocal.z - boxClamped.z) / distance;
			outNormal.set(cos * nx + sin * nz, ny, -sin * nx + cos * nz).normalize();
		} else {
			// Exactly ON the surface: fall through to the face normal.
			const gaps = [h.x - Math.abs(boxLocal.x), h.y - Math.abs(boxLocal.y), h.z - Math.abs(boxLocal.z)];
			const axis = gaps.indexOf(Math.min(...gaps));
			const sign = [boxLocal.x, boxLocal.y, boxLocal.z][axis] < 0 ? -1 : 1;
			const local = [0, 0, 0];
			local[axis] = sign;
			outNormal.set(cos * local[0] + sin * local[2], local[1], -sin * local[0] + cos * local[2]).normalize();
		}
		return distance;
	}
	// Inside: THE EXIT FACE, which is not always the nearest one.
	//
	// A limb buried in a crate is nearest to whichever face it happened to sink
	// past, and for a deep hit that is regularly the FAR one — a push out through
	// it drags the whole arm through the box (QA measured 16 bones inside after a
	// "fix"). So of the six faces the exit prefers one the limb's own ROOT is on:
	// the shallowest whose outward normal points back toward the shoulder or hip.
	// With no root hint — or with the root itself inside the box — the nearest
	// face is still the answer, which is the plain signed distance.
	//
	// `prefer` therefore changes the DIRECTION and the depth of the escape, never
	// the geometry: the plain nearest-face value is what the segment search below
	// minimises (a max of linear functions, so convex, which is what makes the
	// ternary search exact), and the preference is applied once, to the point that
	// search returns.
	const components = [boxLocal.x, boxLocal.y, boxLocal.z];
	const extents = [h.x, h.y, h.z];
	let bestAxis = 0;
	let bestSign = 1;
	let bestExit = Infinity;
	let bestAligned = false;
	for (let axis = 0; axis < 3; axis += 1) {
		for (const sign of [-1, 1]) {
			const exit = extents[axis] - sign * components[axis];
			let aligned = false;
			if (prefer) {
				boxPrefer.set(
					cos * (axis === 0 ? sign : 0) + sin * (axis === 2 ? sign : 0),
					axis === 1 ? sign : 0,
					-sin * (axis === 0 ? sign : 0) + cos * (axis === 2 ? sign : 0),
				);
				aligned = boxPrefer.dot(prefer) > 0;
			}
			// An aligned face beats an unaligned one outright; within a class the
			// shallower exit wins.
			if ((aligned && !bestAligned) || (aligned === bestAligned && exit < bestExit)) {
				bestAxis = axis;
				bestSign = sign;
				bestExit = exit;
				bestAligned = aligned;
			}
		}
	}
	boxClamped.copy(boxLocal);
	if (bestAxis === 0) boxClamped.x = bestSign * h.x;
	else if (bestAxis === 1) boxClamped.y = bestSign * h.y;
	else boxClamped.z = bestSign * h.z;
	outward(boxClamped);
	outNormal.set(
		cos * (bestAxis === 0 ? bestSign : 0) + sin * (bestAxis === 2 ? bestSign : 0),
		bestAxis === 1 ? bestSign : 0,
		-sin * (bestAxis === 0 ? bestSign : 0) + cos * (bestAxis === 2 ? bestSign : 0),
	).normalize();
	return -bestExit;
}

/** How many ternary-search steps the segment/box solve takes. Each step keeps
 * 2/3 of the interval, so 48 of them pin the parameter to ~1e-8 of the segment
 * — far under the millimetre the depths are reported in. */
const BOX_SEARCH_STEPS = 48;

/**
 * Closest approach between a segment and an oriented box. The distance from a
 * point to a convex set is convex along a line, and the SIGNED distance of a
 * convex set is convex too (which is what makes the inside case work), so a
 * ternary search on the parameter finds the minimum without any case analysis of
 * edges, faces and corners.
 *
 * Writes the segment point into `outA` and the box's surface point into `outB`,
 * with the outward surface normal in `outNormal`, and returns the SIGNED
 * distance (negative when the segment runs through the box).
 */
const boxProbe = new THREE.Vector3();
const boxSurface = new THREE.Vector3();
const boxNormal = new THREE.Vector3();
function closestSegmentBox(p, q, box, outA, outB, outNormal, prefer = null) {
	const at = (t) => {
		boxProbe.copy(p).lerp(q, t);
		return boxSignedDistance(box, boxProbe, boxSurface, boxNormal);
	};
	let lo = 0;
	let hi = 1;
	for (let step = 0; step < BOX_SEARCH_STEPS; step += 1) {
		const third = (hi - lo) / 3;
		const m1 = lo + third;
		const m2 = hi - third;
		if (at(m1) < at(m2)) hi = m2;
		else lo = m1;
	}
	const t = (lo + hi) / 2;
	let distance = at(t);
	if (distance < 0 && prefer) {
		// Deepest point found; now pick the face it leaves by.
		boxProbe.copy(p).lerp(q, t);
		distance = boxSignedDistance(box, boxProbe, boxSurface, boxNormal, prefer);
	}
	outA.copy(p).lerp(q, t);
	outB.copy(boxSurface);
	outNormal.copy(boxNormal);
	return distance;
}

/**
 * One capsule against one blocker. Returns { gap, normal, pointA, pointB } with
 * `gap` the signed distance from the capsule's AXIS to the blocker's SURFACE and
 * `normal` pointing from the blocker toward the capsule — the same b → a
 * convention detectPenetrations uses everywhere else.
 */
const blockNormal = new THREE.Vector3();
const blockPrefer = new THREE.Vector3();
function blockerContact(capsule, blocker, outA, outB, rootAnchor = null) {
	if (blocker.kind === "box") {
		// The way OUT of a box is the way the limb came in, and the limb's root is
		// the only anchor that knows which way that was.
		let prefer = null;
		if (rootAnchor) {
			blockPrefer.copy(rootAnchor).sub(capsule.a.clone().lerp(capsule.b, 0.5));
			if (blockPrefer.lengthSq() > 1e-12) prefer = blockPrefer.normalize();
		}
		const gap = closestSegmentBox(capsule.a, capsule.b, blocker, outA, outB, blockNormal, prefer);
		return { gap, normal: blockNormal.clone() };
	}
	closestPointsSegmentSegment(capsule.a, capsule.b, blocker.a, blocker.b, outA, outB);
	const axisGap = outA.distanceTo(outB);
	const normal = outA.clone().sub(outB);
	if (normal.lengthSq() < 1e-12) {
		normal.set(0, 0, 1).cross(capsule.b.clone().sub(capsule.a));
		if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
	}
	normal.normalize();
	// Report the contact ON the blocker's surface, not on its axis.
	outB.addScaledVector(normal, blocker.radius);
	return { gap: axisGap - blocker.radius, normal };
}

/**
 * How many capsule endpoints sit INSIDE a box blocker. The one measure of "made
 * it worse" a box escape cannot argue with: a limb pushed out through the far
 * face is off the surface and reports no contact while more of it than ever is
 * in the crate. Counted over endpoints because they are the extremities the
 * viewer sees poking through.
 */
export function blockerInsideCount(capsules, blockers) {
	const shapes = normalizeBlockers(blockers).filter((shape) => shape.kind === "box");
	if (!capsules || shapes.length === 0) return 0;
	let inside = 0;
	const surface = new THREE.Vector3();
	const normal = new THREE.Vector3();
	for (const capsule of capsules.values()) {
		if (!capsule.def.movable) continue;
		for (const point of [capsule.a, capsule.b]) {
			for (const box of shapes) {
				if (boxSignedDistance(box, point, surface, normal) < 0) inside += 1;
			}
		}
	}
	return inside;
}

/**
 * Find every penetrating capsule pair in the current pose. Returns records
 * { a, b, depth, normal, pointA, pointB } sorted deepest-first. `normal`
 * points from b toward a. `offset` inflates the contact distance HERE, in
 * the test itself — a pair counts as penetrating once it is closer than
 * rA + rB + offset — so the same gap the fixer pushes out to is the gap it
 * checks for. Honouring offset only in the push distance would make the
 * fixer chase a target detection never asked for, and the very gap it just
 * opened would read as clean at exactly the surface-grazing pose it exists
 * to avoid.
 *
 * SLACK: capsules are rigid proxies for soft tissue — an upper arm resting
 * against the torso, or thighs touching, legitimately overlaps the proxies.
 * A pair only counts once it penetrates past `slackFactor × min(radius)`,
 * the soft-tissue compression allowance; `depth` is the amount PAST that
 * allowance, which is also the distance the fixer pushes.
 *
 * The default is 0.25, and it used to be 0.4. The looser value was doing two
 * jobs: covering genuine soft-tissue compression AND covering the overlaps a
 * character legitimately holds at rest, which the proxies cannot tell from a
 * real hit. The rest/bind calibration below now does the second job precisely,
 * per pair, so the global allowance no longer has to be blunt enough for the
 * worst pair on the rig — and at 0.4 it hid a centimetre and a half of forearm
 * inside a thigh. (Loosening it further was never an option either: at 0.6 a
 * hand sunk most of the way into a thigh still fit inside the allowance and the
 * tool answered "no collisions".)
 *
 * HINGED PAIRS use their own, wider allowance instead — see HINGE_SLACK_FACTOR —
 * because two segments meeting at a joint are in flesh-to-flesh contact at any
 * deep fold. BLOCKERS use the plain rule, with a box's missing radius standing
 * in as the movable capsule's own.
 *
 * BIND CALIBRATION: on top of the global slack, a pair that already overlaps in
 * the rig's bind pose gets that overlap plus PAIR_TOLERANCE as its own
 * allowance (see restPairOverlaps), so a rest or bind pose can never report a
 * collision. `pairAllowances` overrides the map buildCollisionCapsules attached;
 * pass null to measure a pose against nothing but the slack rule.
 *
 * `blockers` adds the world-space static shapes described under EXTERNAL
 * BLOCKERS; they are tested against every MOVABLE capsule and named `obj:<id>`
 * in the records.
 */
export function detectPenetrations(capsules, {
	offset = 0.002,
	slackFactor = DEFAULT_SLACK_FACTOR,
	pairAllowances,
	blockers = null,
} = {}) {
	if (!capsules) return [];
	const calibration = pairAllowances === undefined ? (capsules.pairAllowances ?? null) : pairAllowances;
	const list = [...capsules.values()];
	const out = [];
	const pa = new THREE.Vector3();
	const pb = new THREE.Vector3();
	for (let i = 0; i < list.length; i += 1) {
		for (let j = i + 1; j < list.length; j += 1) {
			const ca = list[i];
			const cb = list[j];
			const geo = pairGeometry(ca, cb);
			if (!geo) continue;
			const hinge = geo.hinge;
			closestPointsSegmentSegment(geo.a0, geo.a1, geo.b0, geo.b1, pa, pb);
			const overlap = ca.radius + cb.radius + offset - pa.distanceTo(pb);
			const slack = hinge
				? HINGE_SLACK_FACTOR * (ca.radius + cb.radius)
				: slackFactor * Math.min(ca.radius, cb.radius);
			const bindOverlap = calibration?.get(pairKey(ca.def.id, cb.def.id)) ?? 0;
			const allowance = Math.max(slack, bindOverlap > 0 ? bindOverlap + PAIR_TOLERANCE : 0);
			const depth = overlap - allowance;
			// MIN_DEPTH, not epsilon: see the constant. A pair under it is not a
			// contact anyone can see and not one worth moving a limb for.
			if (depth < MIN_DEPTH) continue;
			const normal = pa.clone().sub(pb);
			if (normal.lengthSq() < 1e-12) {
				// Coincident axes: any perpendicular direction separates them.
				normal.set(0, 0, 1).cross(ca.b.clone().sub(ca.a));
				if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
			}
			normal.normalize();
			out.push({ a: ca, b: cb, depth, normal, pointA: pa.clone(), pointB: pb.clone() });
		}
	}
	// External blockers: only MOVABLE capsules are worth testing — a blocker
	// against the torso is two immovable things touching, which no pass can fix.
	const shapes = normalizeBlockers(blockers);
	for (const blocker of shapes) {
		for (const capsule of list) {
			if (!capsule.def.movable) continue;
			const rootId = CHAIN_ROOT_CAPSULE[capsule.def.movable.chain];
			const rootAnchor = rootId ? capsules.get(rootId)?.a ?? null : null;
			const contact = blockerContact(capsule, blocker, pa, pb, rootAnchor);
			const overlap = capsule.radius + offset - contact.gap;
			// A box has no radius to take the min against, so the limb's own
			// slack is the whole allowance. No rest calibration: the character's
			// reference poses say nothing about where the set dressing is.
			const slack = slackFactor * (blocker.kind === "box"
				? capsule.radius
				: Math.min(capsule.radius, blocker.radius));
			const depth = overlap - slack;
			if (depth < MIN_DEPTH) continue;
			out.push({
				a: capsule,
				b: blocker,
				depth,
				normal: contact.normal.clone(),
				pointA: pa.clone(),
				pointB: pb.clone(),
			});
		}
	}
	out.sort((x, y) => y.depth - x.depth);
	return out;
}

/**
 * The penetrations a fixer is allowed to ACT on, out of everything detection
 * reports: no static × static (two immovable things touching, which no pass can
 * separate), no same-chain hinge fold (see isHingeFold), and, with a filter,
 * only pairs naming a permitted chain. Shared so a caller — the range walker's
 * continuity pass — can read a frame with exactly the eyes fixCollisions uses,
 * rather than a second, subtly different filter.
 */
function fixablePenetrations(capsules, { offset, slackFactor, blockers, onlyChains } = {}) {
	if (!capsules) return [];
	return detectPenetrations(capsules, { offset, slackFactor, blockers }).filter((pen) => {
		if (!pen.a.def.movable && !pen.b.def.movable) return false;
		if (isHingeFold(pen)) return false;
		if (!onlyChains) return true;
		const chainsOf = [pen.a, pen.b].map((c) => c.def.movable?.chain).filter(Boolean);
		return chainsOf.some((id) => onlyChains.has(id));
	});
}

/** Every chain named by a penetration list — the cast a frame's own pose puts
 * in play, which is what the provenance gate is allowed to move. */
function chainsInPlay(pens) {
	const ids = new Set();
	for (const pen of pens) {
		for (const side of [pen.a, pen.b]) {
			if (side.def?.movable?.chain) ids.add(side.def.movable.chain);
		}
	}
	return ids;
}

/* --- escape direction ------------------------------------------------------- */

/**
 * REST-BIASED ESCAPE. The separation normal is the SHORTEST way out, which for
 * a deep hit is regularly the wrong side of the blocker: a forearm driven into
 * the chest is closest to the far side of the torso axis, so the shortest
 * escape carries the hand ACROSS the chest and parks it at the opposite
 * shoulder; a hand 10.8 cm inside the head exits forward, and "hand to face"
 * becomes "hand held out in front of the face".
 *
 * A limb has somewhere it belongs, and the rig already knows where: the REST
 * pose. So the push direction is the contact normal blended with a HOME
 * direction — contact point → the driven joint's rest-pose position — which
 * bends the escape back toward the limb's own side of the body without
 * abandoning the normal.
 *
 * The blend alone would under-separate: a direction at 60° to the normal that
 * travels (depth + offset) only clears 0.5 × that much, and the next pass would
 * find the pair still penetrating. So the push LENGTH is divided by the
 * alignment, `dot(biased, normal)`, which makes the component ALONG THE NORMAL
 * exactly the separation the unbiased push would have achieved — the bias
 * chooses the side, never the amount of clearance.
 *
 * MIN_ALIGN is the floor on that division: a home direction that opposes the
 * normal would demand an unbounded push, or (past 90°) push the limb DEEPER, so
 * below the floor the pass falls back to the plain normal. The rule is
 * therefore never worse than the old one — at worst it is exactly the old one.
 *
 * No bind snapshot means no rest pose to bias toward (restWorldPosition would
 * compose the CURRENT pose, i.e. the penetrating one), so those rigs keep the
 * unbiased normal.
 *
 * The home direction is a HINT, not a target, and it is deliberately the rest
 * pose's ABSOLUTE world position: a clip that has walked or lowered the hips a
 * long way from the rest pose points it less precisely (a crouch aims it a
 * little high). MIN_ALIGN is what makes that safe — a hint pointing the wrong
 * way is dropped rather than followed, so the worst case is the old rule.
 */
export const HOME_BIAS = 0.6;

/** Floor on dot(biasedDir, normal): below it the bias is dropped for that push.
 * 0.35 ≈ 70°, and caps the push at 1/0.35 ≈ 2.9 × the unbiased distance. */
export const MIN_ALIGN = 0.35;

/**
 * ESCAPE CONSISTENCY. A deep hit usually has more than one honest way out — a
 * hand buried in the head can leave up, forward or across — and which one a
 * frame picks turns on millimetres of contact geometry. Solved frame by frame
 * that is a coin toss per frame, and QA measured the result on the crouch clip:
 * frame 115 escaped with the arm straight up, 116 with the hands in front of the
 * face, 117 with the arm down across the body, on source poses that barely move
 * (22 mm of hand travel a frame became 520 mm).
 *
 * So a chain corrected on the PREVIOUS frame carries its push direction into
 * this one, as a third term in the same blend the rest bias uses: the normal
 * still owns the amount of clearance (see the alignment division above), the
 * biases only choose the side. Weighted like HOME_BIAS, because it is the same
 * kind of hint and answers the same question — where does this limb belong.
 */
export const CONTINUITY_BIAS = 0.6;

/** The weight the STEP CAP's retry uses when the plain one produced a jump: the
 * previous frame's direction outvotes the rest pose rather than tying with it. */
export const CONTINUITY_BIAS_STRONG = 1.6;

/**
 * THE STEP CAP, as a multiple of the clip's own worst adjacent step for the
 * effector being judged. The clip is the only honest ruler: 8 cm in a frame is
 * a flail on a crouch and unremarkable in a sprint, and a fixed millimetre
 * budget would have to be re-tuned per take. 2.5× leaves room for a correction
 * to lead or lag the clip's own motion by a good margin while a 20× jump — the
 * flail QA measured — cannot fit inside it.
 */
export const STEP_CAP_FACTOR = 2.5;

/** Ceiling on that cap, in metres. A clip whose hand already crosses the frame
 * in one step must not thereby license a half-metre correction jump; ~24 frames
 * a second, so 0.25 m is 6 m/s of hand — past any human hand speed a viewer
 * would read as continuous. */
export const STEP_CAP_ABS = 0.25;

/** Floor on that cap, in metres. A perfectly static clip has a zero worst step,
 * and a cap of zero would refuse every frame that follows a corrected one. 5 mm
 * is the millimetre noise of the proxies themselves. */
export const STEP_CAP_FLOOR = 0.005;

/** The bone a capsule's push actually drives: mid joint (elbow/knee) for an
 * upper segment, effector (wrist/ankle) for a lower segment or an end sphere. */
function drivenBone(capsule, chains) {
	const target = capsule.def.movable;
	if (!target) return null;
	const chain = chains?.get(target.chain);
	if (!chain) return null;
	return target.joint === "mid" ? chain.bones[1] : chain.bones[2];
}

/** Unit vector from the contact point toward where the driven joint sits in the
 * rig's REST pose (bind pose if the rest composition is unavailable), or null
 * when the rig carries no bind snapshot to compose either from. */
function homeDirection(rig, capsule, chains, contactPoint) {
	if (!hasBindPose(rig)) return null;
	const bone = drivenBone(capsule, chains);
	if (!bone) return null;
	const home = restWorldPosition(rig, bone, new THREE.Vector3())
		?? bindWorldPosition(rig, bone, new THREE.Vector3());
	if (!home) return null;
	const dir = home.sub(contactPoint);
	if (dir.lengthSq() < 1e-12) return null;
	return dir.normalize();
}

/**
 * The world push for one side of one penetration: `normal` already points the
 * way THIS capsule must go, `distance` is the separation it owes along that
 * normal, and `weight` scales the home bias (0 disables it).
 *
 * `continuity` is the ESCAPE CONSISTENCY hint — { dirs: Map(chainId → unit
 * Vector3), weight } — and rides in the same blend: a chain the previous frame
 * pushed somewhere leans that way again. Both hints are optional and either can
 * be absent; with neither, this is the plain separation normal it always was.
 */
function escapeVector(rig, capsule, chains, normal, contactPoint, distance, weight, continuity = null) {
	const straight = normal.clone().multiplyScalar(distance);
	const carry = continuity?.weight > 0
		? continuity.dirs?.get(capsule.def.movable?.chain) ?? null
		: null;
	if (!(weight > 0) && !carry) return straight;
	const home = weight > 0 ? homeDirection(rig, capsule, chains, contactPoint) : null;
	if (!home && !carry) return straight;
	const biased = normal.clone();
	if (home) biased.addScaledVector(home, weight);
	if (carry) biased.addScaledVector(carry, continuity.weight);
	if (biased.lengthSq() < 1e-12) return straight;
	biased.normalize();
	const align = biased.dot(normal);
	// Opposing (or near-perpendicular) home direction: keep the normal rather
	// than trade a sideways slide for a shallower — or negative — separation.
	if (align < MIN_ALIGN) return straight;
	return biased.multiplyScalar(distance / Math.max(MIN_ALIGN, align));
}

/* --- side preservation ------------------------------------------------------ */

/** Chains whose end joint must not change sides of the body because of a fix. */
const SIDE_CHAINS = ["leftHand", "rightHand"];

/** How far off the midline a wrist must be, both before and after, before a
 * sign change counts as a crossing. Hands legitimately work at the midline
 * (clasped, folded); 2 cm keeps that noise out of the guard. */
const SIDE_EPSILON = 0.02;

/**
 * Signed distance from the body's sagittal plane — positive on the character's
 * LEFT. The plane is the hips' own YZ plane: origin at the hips, normal = the
 * hips' local X axis in world space, which is the hips→spine frame's lateral
 * axis (ik.js's toe-derived facing helper is not exported, and the hips basis
 * agrees with it on any upright rig). Returns null on a rig with no hips.
 */
function sagittalSide(rig, point) {
	const hips = findBone(rig, "mixamorigHips");
	if (!hips) return null;
	const lateral = new THREE.Vector3();
	hips.matrixWorld.extractBasis(lateral, new THREE.Vector3(), new THREE.Vector3());
	if (lateral.lengthSq() < 1e-12) return null;
	const origin = new THREE.Vector3().setFromMatrixPosition(hips.matrixWorld);
	return point.clone().sub(origin).dot(lateral.normalize());
}

/* --- resolution ------------------------------------------------------------- */


const NO_PUSH = Object.freeze({ ran: false, moved: false });

/**
 * Push one movable capsule by `push` (world vector). Mid joint drives the
 * elbow/knee (upper segment), effector drives the wrist/ankle (lower segment
 * and end spheres). Returns { ran, moved }: `ran` means a solver was invoked on
 * this chain (so the chain's pose may have changed and must be keyed), `moved`
 * means the driven joint actually went somewhere.
 *
 * `onlyChains` is enforced HERE, not only at the detection filter. A pair is
 * kept when EITHER side names a permitted chain, so a movable×movable pair with
 * one side listed used to push the unlisted side too (3 cm of unrequested
 * motion in "filter only selected" mode) — a filter honoured by the query but
 * not by the write.
 *
 * DIRECTION is the caller's business: `push` arrives already blended toward the
 * limb's rest pose by escapeVector — see the REST-BIASED ESCAPE note there for
 * why the raw separation normal is not enough on a deep hit.
 */
function pushCapsule(capsule, chains, push, ikState, { onlyChains = null, floorY = 0 } = {}) {
	const target = capsule.def.movable;
	if (!target) return NO_PUSH;
	if (onlyChains && !onlyChains.has(target.chain)) return NO_PUSH;
	const chain = chains?.get(target.chain);
	if (!chain) return NO_PUSH;
	// Detection, target and solve all use the clip's current translations.
	// A bind reset here would reintroduce length compensation into the key.
	const rotations = chain.bones.map((bone) => bone.quaternion.clone());
	const driven = target.joint === "mid" ? chain.bones[1] : chain.bones[2];
	const before = driven.getWorldPosition(new THREE.Vector3());
	const goal = before.clone().add(push);
	goal.y = Math.max(goal.y, floorY + PUSH_FLOOR_CLEARANCE);
	if (target.joint === "mid") solveMidJoint(chain, goal);
	else solveIk(chain, goal);
	// `ran` is "this chain's pose is no longer the one it arrived in", measured
	// rather than assumed: a solver that put every bone back where it found it
	// has nothing to key, and a run of nothing but those must report itself as
	// the no-op it was.
	const ran = chain.bones.some((bone, index) => bone.quaternion.angleTo(rotations[index]) > 1e-9);
	if (ran && ikState) ikTouch(ikState, target.chain);
	// A push the solver clamped away (unreachable target, floor guard, a limb
	// already at full stretch) is NOT progress. Counting it as progress kept the
	// pass loop alive to maxIterations re-solving a pose that cannot move.
	return { ran, moved: driven.getWorldPosition(new THREE.Vector3()).distanceTo(before) > 1e-6 };
}

/**
 * Clean self-collisions out of the CURRENT pose. Iterates detect → push
 * until the deepest remaining penetration fits in `epsilon` or
 * maxIterations passes ran. A movable-vs-static pair pushes the limb by the
 * full depth + offset; two movable capsules split it, weighted toward the
 * higher-priority limb (arms yield before legs — leg moves read heavier).
 *
 * `onlyChains` (Set of chain ids) restricts which limbs may move — the
 * "filter only selected" mode. `ikState`, when given, marks every touched
 * chain as tracked so a following ikBakeKeyframe persists the fix.
 * `slackFactor` rides through to detectPenetrations for callers that want a
 * stricter or looser reading than the default. `blockers` rides through too:
 * world-space props the limbs are pushed out of exactly as they are pushed out
 * of the torso. `fkJoints` enables the capped TORSO/HEAD YIELD — without it the
 * blockers stay perfectly rigid, which is what every existing caller gets.
 *
 * `continuity` ({ dirs: Map(chainId → unit Vector3), weight }) is the ESCAPE
 * CONSISTENCY hint — the way each chain left its collision on the frame before
 * — and `provenanceChains` overrides the cast the provenance gate reads off the
 * entry pose. Both exist for the range walker's temporal pass and are null for
 * every single-frame caller, which therefore behaves exactly as it did.
 *
 * Returns { supported, changed, passes, residual, touched } — residual is the
 * deepest remaining penetration in metres, 0 when fully clean, and `touched` is
 * the chain ids THIS run actually drove, plus any FK joint id a yield leaned on
 * (both are keyable ids: ikBakeKeyframe reads a chain map first and the FK joint
 * map second, so a bake naming "spine" keys the spine). `supported` is false when the rig has
 * no capsule proxies to build at all (a non-Mixamo skeleton): the tool did not
 * run, which is a DIFFERENT answer from "ran and found nothing", and the UI
 * must say so rather than claim a clean pose.
 *
 * `touched` exists so the bake can name what moved. ikBakeKeyframe defaults to
 * the whole tracked set, which after any earlier drag or pass is far more than
 * this fix touched — keying a leg fix at frame 40 also re-keyed the hand
 * dragged at frame 2, at whatever blended value the layer happened to be
 * showing there.
 *
 * `baseQuats` is the other half of that: the rotations the key is a DELTA from.
 * The returned map (chain id → the three bone quaternions BEFORE the first
 * solver pass) is what a caller hands to ikBakeKeyframe so the blend window
 * carries the correction rather than the whole pose difference. Pass the option
 * in when you know the RAW CLIP rotations for this frame — the range walker
 * does, because it samples the clip with the layer switched off — otherwise the
 * pose on the rig at entry is used, which is exact whenever no earlier key is
 * already blending into this frame.
 *
 * CLIP TRANSLATIONS THROUGHOUT. The solvers measure each frame's segment
 * lengths without changing its locals. Detection, pushes and warm starts must
 * therefore leave those translations alone too; the bake records them so the
 * pose measured here is the one playback reproduces.
 */
export function fixCollisions(rig, chains, {
	radii = null,
	offset = 0.002,
	epsilon = 1e-4,
	maxIterations = 8,
	onlyChains = null,
	ikState = null,
	slackFactor = DEFAULT_SLACK_FACTOR,
	floorY = 0,
	baseQuats = null,
	blockers = null,
	fkJoints = null,
	continuity = null,
	provenanceChains = null,
} = {}) {
	if (!rig || !chains) {
		return { supported: false, changed: false, passes: 0, residual: 0, touched: [], baseQuats: new Map() };
	}
	const bases = baseQuats ?? new Map(
		[...chains].map(([id, chain]) => [id, chain.bones.map((bone) => bone.quaternion.clone())]),
	);
	const touched = new Set();
	let poseDirty = false;
	/**
	 * PROVENANCE. The chains this frame is allowed to move, named by the FIRST
	 * detection on the pose as handed over. Filled in below, before the first
	 * pass.
	 *
	 * A solve is iterative, so the pose it detects on after pass 0 is a pose it
	 * made. Contacts that appear there are the fix's own doing, and acting on
	 * them recruits limbs the source frame never had a problem with: on the
	 * crouch clip a head × hand escape flung the arm through the legs, the legs
	 * were then "fixed" for hitting it, and the right leg came away keyed, snapped
	 * to bind length and smeared 164.9 mm over a dozen frames on which no leg
	 * pair had ever existed. A new contact between two chains that were already
	 * in play is still fair game — that is the projection loop doing its job —
	 * but the cast is closed at the door.
	 */
	let allowedChains = null;
	const drive = (capsule, vector) => {
		const chainId = capsule.def.movable?.chain;
		if (allowedChains && chainId && !allowedChains.has(chainId)) return false;
		const outcome = pushCapsule(capsule, chains, vector, ikState, {
			onlyChains, floorY,
		});
		if (outcome.ran) {
			touched.add(capsule.def.movable.chain);
			// A solve that changed the pose without moving the driven joint is not
			// progress, but it IS a change, and a run that ends with one owes the
			// caller a `changed: true` and a key.
			poseDirty = true;
		}
		return outcome.moved;
	};

	/* --- one pass, at a given home-bias weight ----------------------------- */
	// Every push of a pass is computed from the pose the pass STARTED in, so the
	// same penetration list can be replayed at a different weight (the side
	// guard below) and produce a deterministic result either way.
	const applyPass = (pens, weight) => {
		let passChanged = false;
		for (const pen of pens) {
			const ma = pen.a.def.movable;
			const mb = pen.b.def.movable;
			const distance = pen.depth + offset;
			// `normal` points b → a: a escapes along +normal, b along −normal.
			const away = pen.normal;
			const back = pen.normal.clone().negate();
			const pushA = (share) => escapeVector(rig, pen.a, chains, away, pen.pointA, distance * share, weight, continuity);
			const pushB = (share) => escapeVector(rig, pen.b, chains, back, pen.pointB, distance * share, weight, continuity);
			if (ma && !mb) passChanged = drive(pen.a, pushA(1)) || passChanged;
			else if (mb && !ma) passChanged = drive(pen.b, pushB(1)) || passChanged;
			else if (ma && mb) {
				// Splitting the push is only right when BOTH sides are allowed to
				// move. With a filter naming one of them, the permitted side owes
				// the whole separation — half a push leaves half a penetration.
				const allowA = !onlyChains || onlyChains.has(ma.chain);
				const allowB = !onlyChains || onlyChains.has(mb.chain);
				if (allowA && allowB) {
					const pa = pen.a.def.priority ?? 1;
					const pb = pen.b.def.priority ?? 1;
					const shareA = pa / (pa + pb); // arms (2) yield before legs (1)
					const movedA = drive(pen.a, pushA(shareA));
					const movedB = drive(pen.b, pushB(1 - shareA));
					passChanged = movedA || movedB || passChanged;
				} else if (allowA) passChanged = drive(pen.a, pushA(1)) || passChanged;
				else if (allowB) passChanged = drive(pen.b, pushB(1)) || passChanged;
			}
		}
		return passChanged;
	};

	/* --- side-preservation guard ------------------------------------------- */
	/**
	 * A hand must not change sides of the body because of a fix. The heuristic,
	 * deliberately blunt: measure each arm chain's WRIST against the sagittal
	 * plane, and if a pass leaves a wrist that was clearly on one side
	 * (> SIDE_EPSILON) clearly on the other, the escape went ACROSS the torso
	 * rather than back out — so that pass is rewound and replayed with the home
	 * bias at DOUBLE weight, which pulls harder toward the limb's own side. One
	 * retry per pass, and the retry is accepted whatever it produces, so the
	 * pass count and the output stay deterministic.
	 *
	 * TWO REFERENCE SIDES, and the second is the one that fires. A single pass
	 * moves the wrist by (depth + offset), so a hand does not jump the midline
	 * in one pass — measured over 6000 random deep poses it never once did.
	 * Crossings are CUMULATIVE: a few passes of a few centimetres each, and the
	 * hand has walked to the far shoulder. So a pass is judged against the side
	 * the wrist had when the pass started AND against the side it had when the
	 * fix started, and the pass that completes a cumulative crossing is the one
	 * that gets replayed.
	 */
	const bias = hasBindPose(rig) ? HOME_BIAS : 0;
	const passBones = [];
	{
		const seen = new Set();
		for (const chain of chains.values()) {
			for (const bone of chain.bones) if (!seen.has(bone)) { seen.add(bone); passBones.push(bone); }
		}
	}
	const snapshotPass = () => passBones.map((bone) => bone.quaternion.clone());
	const restorePass = (snapshot) => {
		passBones.forEach((bone, index) => bone.quaternion.copy(snapshot[index]));
		rig.updateMatrixWorld(true);
	};
	const wristSides = () => {
		const sides = new Map();
		for (const id of SIDE_CHAINS) {
			const chain = chains.get(id);
			if (!chain) continue;
			const side = sagittalSide(rig, chain.bones[2].getWorldPosition(new THREE.Vector3()));
			if (side !== null) sides.set(id, side);
		}
		return sides;
	};
	const crossedMidline = (before, after) => [...before].some(([id, start]) => {
		const end = after.get(id);
		return end !== undefined
			&& Math.abs(start) > SIDE_EPSILON && Math.abs(end) > SIDE_EPSILON
			&& start * end < 0;
	});
	const entrySides = bias > 0 ? wristSides() : null;

	/** The penetrations THIS run is allowed to act on: no static × static (two
	 * immovable things touching, which no pass can fix), no SAME-CHAIN HINGE (a
	 * fold is a pose, not a collision — see isHingeFold), and only pairs naming a
	 * permitted chain when a filter is in force. */
	const fixablePens = (capsules) => fixablePenetrations(capsules, { offset, slackFactor, blockers, onlyChains });

	/* --- what this frame started as, so a bad fix can be refused whole ------ */
	/** Every bone a fix or a yield can write, with its full local transform. */
	const frameSnapshot = () => {
		const entries = [];
		const seen = new Set();
		const add = (bone) => {
			if (!bone || seen.has(bone)) return;
			seen.add(bone);
			entries.push([bone, bone.quaternion.clone(), bone.position.clone()]);
		};
		for (const chain of chains.values()) for (const bone of chain.bones) add(bone);
		const joints = fkJoints ?? fallbackYieldJoints(rig);
		if (joints) for (const joint of joints.values()) add(joint.bone);
		return entries;
	};
	const frameRestore = (entries) => {
		for (const [bone, quaternion, position] of entries) {
			bone.quaternion.copy(quaternion);
			bone.position.copy(position);
		}
		rig.updateMatrixWorld(true);
	};
	/** Lowest foot marker in the current pose, or +Infinity when the rig has
	 * none to judge. */
	const lowestFoot = () => {
		let lowest = Infinity;
		for (const name of FLOOR_MARKERS) {
			const bone = findBone(rig, name);
			if (!bone) continue;
			lowest = Math.min(lowest, bone.getWorldPosition(new THREE.Vector3()).y);
		}
		return lowest;
	};
	/** The deepest fixable penetration in the current pose, 0 when clean. */
	const currentWorst = () => {
		const capsules = buildCollisionCapsules(rig, radii);
		if (!capsules) return 0;
		const pens = fixablePens(capsules);
		return pens.length ? pens[0].depth : 0;
	};

	const entryPose = frameSnapshot();
	const entryFoot = lowestFoot();
	let entryWorst = 0;
	{
		const capsules = buildCollisionCapsules(rig, radii);
		const pens = capsules ? fixablePens(capsules) : [];
		entryWorst = pens.length ? pens[0].depth : 0;
		// The cast, closed at the door. A chain that is not named by a pair on the
		// pose as handed over cannot be recruited by a contact the fix invents.
		//
		// `provenanceChains` lets a caller name that cast itself, and exists for
		// exactly one caller: the range walker's WARM START hands over a pose it
		// has already nudged with the previous frame's correction, so the pose at
		// the door is no longer the frame's own. The list it passes is read off
		// the frame's UNTOUCHED pose, which keeps the gate saying what it always
		// said — only limbs this frame's own clip pose put in play may move.
		allowedChains = provenanceChains ? new Set(provenanceChains) : chainsInPlay(pens);
	}

	let changed = false;
	let residual = 0;
	let pass = 0;
	for (; pass < maxIterations; pass += 1) {
		const capsules = buildCollisionCapsules(rig, radii);
		if (!capsules) {
			return { supported: false, changed, passes: pass, residual, touched: [...touched], baseQuats: bases };
		}
		// `changed` is cumulative across passes, so it can never report what
		// THIS pass did. A pass that pushes nothing — every penetration
		// belongs to a chain the rig lacks, or to a filtered-out chain — would
		// otherwise keep looping to maxIterations re-solving an unmoving pose.
		let passChanged = false;
		const pens = fixablePens(capsules);
		if (pens.length === 0) { residual = 0; break; }
		residual = pens[0].depth;
		const sidesBefore = bias > 0 ? wristSides() : null;
		const insideBefore = blockerInsideCount(capsules, blockers);
		const rewind = snapshotPass();
		const dirtyBefore = poseDirty;
		const touchedBefore = [...touched];
		passChanged = applyPass(pens, bias);
		if (passChanged && sidesBefore) {
			const sidesAfter = wristSides();
			if (crossedMidline(sidesBefore, sidesAfter) || crossedMidline(entrySides, sidesAfter)) {
				restorePass(rewind);
				passChanged = applyPass(pens, bias * 2);
			}
		}
		// BOX GUARD. A box escape that ends with MORE of the limb inside the box
		// went out through the wrong face, and no residual number can see that —
		// the pose reports no contact precisely because it is buried. Such a pass
		// is rewound whole and the loop stops with the pose it had, which is the
		// worse-is-not-an-option rule the rest of this file already follows.
		if (passChanged && insideBefore >= 0) {
			const after = buildCollisionCapsules(rig, radii);
			if (after && blockerInsideCount(after, blockers) > insideBefore) {
				restorePass(rewind);
				poseDirty = dirtyBefore;
				touched.clear();
				for (const id of touchedBefore) touched.add(id);
				break;
			}
		}
		changed = changed || passChanged;
		if (!passChanged) break;
	}
	/* --- capped torso/head yield -------------------------------------------- */
	/**
	 * The last resort, and only ever a last one: the limb passes are over and a
	 * movable × static pair is still penetrating, so the STATIC side leans away
	 * by a few degrees.
	 *
	 * THE JOINTS ARE FOUND, NOT REQUIRED. The map is the caller's `fkJoints` when
	 * there is one and a minimal one built off the rig's own bones otherwise —
	 * because the caller that needs this most (the single-frame button) does not
	 * pass one, and QA measured exactly that: a head × upper-arm hit at the arm's
	 * reach limit, 88 mm left standing, spine and neck at 0.000°. The ids match
	 * the FK track ids either way, so `touched` stays bakeable.
	 *
	 * THE DIRECTION IS THE SUM OF WHAT PRESSES ON IT. Leaning away from the single
	 * deepest pair is no use when the blocker is caught between two of them — a
	 * head between both upper arms, the measured case — because every degree away
	 * from one is a degree into the other. The swing follows the depth-weighted
	 * sum of every pair pressing on that capsule, which for the symmetric case
	 * points backward, out of both.
	 *
	 * THE BUDGET IS SPENT IN STEPS, NOT BET ON ONE. A single 6° step cannot clear
	 * 88 mm, so a step that merely fails to improve is not a reason to stop:
	 * steps continue while the residual is NON-INCREASING, up to the cap. What is
	 * refused is the outcome — if the whole yield leaves the pose no better than
	 * it found it, every degree of it is rolled back and nothing is keyed.
	 */
	const yieldJoints = fkJoints ?? fallbackYieldJoints(rig);
	const yieldTargetOf = (pen) => {
		const staticSide = !pen.a.def.movable ? pen.a : (!pen.b.def.movable ? pen.b : null);
		if (!staticSide) return null;
		const id = YIELD_JOINTS[staticSide.def.id];
		const joint = id ? yieldJoints?.get(id) : null;
		if (!joint?.bone?.parent) return null;
		return { id, joint, staticSide };
	};
	/** Everything a yield can move, so a yield that does not pay for itself can
	 * be put back exactly. */
	const yieldSnapshot = () => {
		const entries = [];
		const seen = new Set();
		const add = (bone) => {
			if (!bone || seen.has(bone)) return;
			seen.add(bone);
			entries.push([bone, bone.quaternion.clone(), bone.position.clone()]);
		};
		for (const chain of chains.values()) for (const bone of chain.bones) add(bone);
		if (yieldJoints) for (const joint of yieldJoints.values()) add(joint.bone);
		return entries;
	};
	const yieldRestore = (entries) => {
		for (const [bone, quaternion, position] of entries) {
			bone.quaternion.copy(quaternion);
			bone.position.copy(position);
		}
		rig.updateMatrixWorld(true);
	};
	/** The depth-weighted direction `capsule` is being pressed FROM, with the
	 * contact it should pivot about and the deepest pair pressing on it. */
	const yieldLoad = (pens, capsule) => {
		const away = new THREE.Vector3();
		const contact = new THREE.Vector3();
		let weight = 0;
		let deepest = 0;
		for (const pen of pens) {
			const isA = pen.a === capsule;
			if (!isA && pen.b !== capsule) continue;
			// `normal` points b → a, so the static side escapes along +normal when
			// it is a and along −normal when it is b — the same rule applyPass uses.
			away.addScaledVector(isA ? pen.normal : pen.normal.clone().negate(), pen.depth);
			contact.addScaledVector(isA ? pen.pointA : pen.pointB, pen.depth);
			weight += pen.depth;
			deepest = Math.max(deepest, pen.depth);
		}
		if (weight <= 0 || away.lengthSq() < 1e-12) return null;
		return { away: away.normalize(), contact: contact.divideScalar(weight), deepest };
	};
	const yieldStatic = (pens, target, limit) => {
		const load = yieldLoad(pens, target.staticSide);
		if (!load) return 0;
		const pivot = target.joint.bone.getWorldPosition(new THREE.Vector3());
		const lever = load.contact.clone().sub(pivot);
		const radius = lever.length();
		if (radius < 1e-4) return 0;
		const axis = lever.clone().cross(load.away);
		if (axis.lengthSq() < 1e-12) return 0;
		const angle = Math.min(limit, (load.deepest + offset) / radius);
		if (!(angle > 1e-6)) return 0;
		axis.normalize();
		// WHICH WAY ROUND. `lever × away` names the plane the yield should turn
		// in, but not reliably its sign: `contact` is a depth-weighted mean of
		// several contact points, and when a blocker is pressed from both sides
		// that mean can land on the far side of the pivot from every individual
		// contact, which flips the cross product and leans INTO the deeper pair.
		// Both signs are cheap to try, so try both and keep the one that actually
		// reduces the worst depth; if neither does, spend nothing.
		const before = worstDepth();
		const start = target.joint.bone.quaternion.clone();
		const parentWorld = target.joint.bone.parent.getWorldQuaternion(new THREE.Quaternion());
		const startPosition = target.joint.bone.position.clone();
		let best = null;
		for (const sign of [1, -1]) {
			solveSwingAngle(target.joint, axis, sign * angle, start, parentWorld);
			rig.updateMatrixWorld(true);
			const now = worstDepth();
			if (best === null || now < best.depth) {
				best = { depth: now, quaternion: target.joint.bone.quaternion.clone() };
			}
		}
		if (!best || best.depth >= before - 1e-9) {
			target.joint.bone.quaternion.copy(start);
			target.joint.bone.position.copy(startPosition);
			rig.updateMatrixWorld(true);
			return 0;
		}
		target.joint.bone.quaternion.copy(best.quaternion);
		rig.updateMatrixWorld(true);
		return angle;
	};
	/** The deepest fixable penetration right now, 0 when there is none. */
	const worstDepth = () => {
		const capsules = buildCollisionCapsules(rig, radii);
		if (!capsules) return 0;
		const pens = fixablePens(capsules);
		return pens.length ? pens[0].depth : 0;
	};
	if (yieldJoints?.size && residual > epsilon) {
		const entrySnapshot = yieldSnapshot();
		const entryTouched = [...touched];
		const entryDirty = poseDirty;
		const startResidual = residual;
		let bestResidual = residual;
		let bestSnapshot = null;
		const yielded = new Set();
		let budget = YIELD_TOTAL_RAD;
		while (budget > 1e-6) {
			const capsules = buildCollisionCapsules(rig, radii);
			if (!capsules) break;
			const pens = fixablePens(capsules);
			const worst = pens.length ? pens[0].depth : 0;
			if (worst <= epsilon) break;
			let picked = null;
			for (const pen of pens) {
				const target = yieldTargetOf(pen);
				if (target) { picked = { pens, target }; break; }
			}
			if (!picked) break;
			const spent = yieldStatic(picked.pens, picked.target, Math.min(YIELD_STEP_RAD, budget));
			if (!(spent > 0)) break;
			// The room a yield opens is only worth anything if the limb takes it.
			const after = buildCollisionCapsules(rig, radii);
			const remaining = after ? fixablePens(after) : [];
			if (remaining.length) applyPass(remaining, bias);
			const now = worstDepth();
			// Non-increasing keeps the budget alive (one 6° step cannot clear an
			// 88 mm hit); a step that makes things worse ends it there.
			if (now > worst + 1e-6) break;
			budget -= spent;
			yielded.add(picked.target.id);
			if (now < bestResidual - 1e-9) {
				bestResidual = now;
				bestSnapshot = yieldSnapshot();
			}
		}
		if (bestResidual < startResidual - 1e-6) {
			if (bestSnapshot) yieldRestore(bestSnapshot);
			residual = bestResidual;
			changed = true;
			for (const id of yielded) {
				touched.add(id);
				if (ikState) ikTouch(ikState, id);
			}
		} else {
			// Bought nothing: no lean, no key, and the pose the limb passes reached
			// is what the caller gets.
			yieldRestore(entrySnapshot);
			touched.clear();
			for (const id of entryTouched) touched.add(id);
			poseDirty = entryDirty;
		}
	}

	// A solve that rearranged a chain without moving its driven joint still
	// changed the pose, and the caller must key it.
	changed = changed || poseDirty;

	/* --- the accept gate ---------------------------------------------------- */
	/**
	 * A frame's fix is kept only if it is BETTER than the pose it started from.
	 * Two ways it can fail to be, each measured against the entry pose:
	 *
	 *  - IT DID NOT HELP. The deepest fixable pair is no shallower than it was.
	 *    Keying that is how a whole-clip run stayed non-idempotent: 19 frames
	 *    re-keyed on every press with "13 still penetrate", because a frame the
	 *    passes could not clear was baked anyway and then baked again next time.
	 *    An unreducible frame is now reported, not written.
	 *  - IT BURIED A FOOT. The push guard clamps the joint it drives, which is
	 *    the ankle; the toe hangs off the far side and went 18.7 mm under the
	 *    deck on QA's crouch. Any marker lower than it started, and lower than
	 *    its clearance, is a fix that solved one artefact by making a worse one.
	 *
	 * Refusal is total: the pose goes back exactly as it arrived, nothing is
	 * touched, nothing is keyed, and `residual` reports the depth that defeated
	 * it so the caller can say so out loud.
	 */
	if (changed) {
		const afterWorst = currentWorst();
		const afterFoot = lowestFoot();
		const improved = afterWorst < entryWorst - epsilon;
		const buried = Number.isFinite(afterFoot)
			&& afterFoot < Math.min(entryFoot, floorY + PUSH_FLOOR_CLEARANCE) - 1e-6;
		if (!improved || buried) {
			frameRestore(entryPose);
			return {
				supported: true,
				changed: false,
				passes: pass,
				residual: entryWorst,
				touched: [],
				baseQuats: bases,
				refused: improved ? "foot-below-floor" : "no-improvement",
			};
		}
	}

	// Final measurement for an honest residual report.
	if (changed) {
		const capsules = buildCollisionCapsules(rig, radii);
		// Same-chain folds are reported by detection but never acted on, so
		// they must not count as residual either — otherwise a frame the fixer
		// has fully handled toasts "reduced (0.8 cm)" and the next press,
		// which finds nothing to do, toasts "no collisions" for the same pose.
		const pens = capsules ? detectPenetrations(capsules, { offset, slackFactor, blockers }).filter((pen) => !isHingeFold(pen)) : [];
		residual = pens.length ? pens[0].depth : 0;
	}
	return { supported: true, changed, passes: pass, residual, touched: [...touched], baseQuats: bases };
}

/** Every bone the IK layer can write, once each: the chain bones plus the FK
 * joints. These are exactly the bones a bake at one frame can change, so
 * snapshotting them captures everything this pass could contaminate. */
function layerBones(chains, fkJoints) {
	const bones = [];
	const seen = new Set();
	const add = (bone) => {
		if (!bone || seen.has(bone)) return;
		seen.add(bone);
		bones.push(bone);
	};
	for (const chain of chains.values()) for (const bone of chain.bones) add(bone);
	if (fkJoints) for (const joint of fkJoints.values()) add(joint.bone);
	return bones;
}

function snapshotBones(bones) {
	return bones.map((bone) => ({ position: bone.position.clone(), quaternion: bone.quaternion.clone() }));
}

function restoreBones(rig, bones, snapshot) {
	for (let index = 0; index < bones.length; index += 1) {
		bones[index].position.copy(snapshot[index].position);
		bones[index].quaternion.copy(snapshot[index].quaternion);
	}
	rig.updateMatrixWorld(true);
}

/**
 * Clean a frame RANGE, baking every touched frame into the IK key layer.
 * `applyFrame(frame)` must pose the rig (motion apply + ikEvaluate) before
 * the fix runs — App owns that plumbing, this owns the loop. Only frames
 * that actually changed get a key, so a clean clip stays keyless.
 *
 * External blockers come either as a static `blockers` array (the same shapes at
 * every frame) or as a `blockersAt(frame)` callback, called after applyFrame for
 * that frame so an ANIMATED prop can report its pose for the frame being solved.
 * Returns the list of keyed frames — empty on a rig the tool cannot
 * describe, which the caller should have screened with
 * supportsCollisionCleanup before offering the button at all.
 *
 * TWO SWEEPS, for the same reason auto-physics needs them. `applyFrame`
 * evaluates the IK layer, so once this loop starts writing keys it is no longer
 * looking at the clip: frame 40 gets posed as clip + the blend ramp of the key
 * written at frame 37, that blend introduces penetrations of its own, and those
 * get keyed too. On the QA clip 4 of 11 keys landed on frames that were CLEAN
 * in the source, and 58 frames finished flagged that started clean — the pass
 * chasing its own tail. Sweep 1 therefore records each frame's pose with
 * nothing of this run's written yet; sweep 2 restores that pose before
 * detecting, so every frame is judged and fixed against the clip.
 *
 * Sweep 1 records TWO poses per frame, and the difference matters:
 *
 *  - the LAYER pose (clip + whatever keys already existed) is what the fix is
 *    applied to, because the user's earlier corrections are part of the pose
 *    they are asking to clean;
 *  - the RAW CLIP pose — sampled with `ikState.tracked` emptied, which makes
 *    the caller's own ikEvaluate a no-op — is what each key's rotations are
 *    stored as a DELTA FROM. It has to be the raw one: ikEvaluate finds the raw
 *    clip on the bone when it comes to apply the key, so only a delta measured
 *    from there collapses back to the authored pose at the keyed frame.
 *
 * With no keys yet the two are identical and the second sample is skipped.
 */
export function fixCollisionsRange({
	rig,
	chains,
	ikState,
	fkJoints = null,
	startFrame,
	endFrame,
	applyFrame,
	blockersAt = null,
	blendWindow = 6,
	...options
} = {}) {
	if (!rig || !chains || !ikState || typeof applyFrame !== "function") return [];
	const start = Math.max(0, Math.round(startFrame));
	const end = Math.max(start, Math.round(endFrame));

	/* --- sweep 1: record the clip as it stands, writing nothing ------------ */
	const bones = layerBones(chains, fkJoints);
	const chainIds = [...chains.keys()];
	const readChainQuats = () => new Map(chainIds.map((id) => [id, chains.get(id).bones.map((b) => b.quaternion.clone())]));
	/** Every chain's EFFECTOR (wrist / ankle) in world space — the one point per
	 * limb whose frame-to-frame travel a viewer reads as speed, and the thing the
	 * step cap below is written in terms of. */
	const readEffectors = () => new Map(chainIds.map(
		(id) => [id, chains.get(id).bones[2].getWorldPosition(new THREE.Vector3())],
	));
	const layerActive = ikState.tracked.size > 0;
	const basePose = [];
	const clipQuats = [];
	const sourceEffectors = [];
	for (let frame = start; frame <= end; frame += 1) {
		if (layerActive) {
			// Silence the layer for one sample: ikEvaluate walks `tracked`, so an
			// empty set makes the caller's applyFrame pure clip. Restored on the
			// same iteration, and never observed by anyone else — this loop owns
			// the rig for its duration.
			const tracked = ikState.tracked;
			ikState.tracked = new Set();
			try {
				applyFrame(frame);
				clipQuats.push(readChainQuats());
			} finally {
				ikState.tracked = tracked;
			}
		}
		applyFrame(frame);
		basePose.push(snapshotBones(bones));
		sourceEffectors.push(readEffectors());
		if (!layerActive) clipQuats.push(readChainQuats());
	}

	/* --- what a frame-to-frame step is allowed to be ------------------------ */
	/**
	 * THE STEP CAP, per chain, measured on the clip the pass was handed. A
	 * correction is allowed to move a limb; what it is not allowed to do is move
	 * it FASTER THAN THE CLIP EVER DOES between two frames it both corrects. So
	 * the cap is the effector's own worst adjacent step over the range, times
	 * STEP_CAP_FACTOR — a limb that already travels 8 cm a frame gets a roomier
	 * allowance than one that barely moves, which is the only ruler that means
	 * the same thing on a crouch and on a sprint.
	 *
	 * Clamped at both ends. STEP_CAP_ABS is the ceiling: a fast clip must not
	 * license a half-metre teleport just because its own hand is quick. The floor
	 * is what keeps a perfectly static clip from setting a cap of zero and
	 * refusing every correction that follows another one.
	 *
	 * The cap governs the step between two CONSECUTIVE CORRECTED frames only.
	 * The first corrected frame of a run has no corrected predecessor and is
	 * uncapped — the correction itself is as big as the collision demands, and
	 * easing that in is the blend window's job, not this one's.
	 */
	const stepCap = new Map();
	for (const id of chainIds) {
		let worst = 0;
		for (let index = 1; index < sourceEffectors.length; index += 1) {
			const previous = sourceEffectors[index - 1].get(id);
			const current = sourceEffectors[index].get(id);
			if (previous && current) worst = Math.max(worst, current.distanceTo(previous));
		}
		stepCap.set(id, Math.min(STEP_CAP_ABS, Math.max(STEP_CAP_FLOOR, STEP_CAP_FACTOR * worst)));
	}

	/* --- sweep 2: fix each frame against that recorded pose ---------------- */
	const keyed = [];
	// Frame → deepest penetration left standing. A map, not a list: a frame the
	// blend-window round revisits reports its LAST word, and a frame that round
	// cleans drops off the list rather than being reported twice.
	const residuals = new Map();
	const unresolvedList = () => [...residuals.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([frame, residual]) => ({ frame, residual }));
	const blockersFor = (frame) => (typeof blockersAt === "function" ? blockersAt(frame) : options.blockers);
	const noteResidual = (frame, residual) => {
		if (residual > 0) residuals.set(frame, residual);
		else residuals.delete(frame);
	};
	/* --- temporal continuity ------------------------------------------------ */
	/**
	 * WHY THIS EXISTS. Every frame above is solved on its own, from the clip,
	 * which is what makes each one honest — and what made a RUN of them garbage.
	 * A deep hit has several ways out, the choice between them turns on
	 * millimetres, and QA measured the consequence on the crouch clip: frames
	 * 104..120 each had a 112 mm head × hand hit, each frame found its own escape,
	 * and the hand stepped 22 → 160 mm, 23 → 520 mm, 25 → 519 mm frame to frame
	 * on source poses that barely moved. Arm up, hands to face, arm down across
	 * the body: three frames of flail, every one of them collision-free.
	 *
	 * The cure is to make a run of corrected frames one correction rather than N
	 * unrelated ones, in three pieces that all keep the per-frame guarantees:
	 *
	 *  1. WARM START. When the frame before was corrected, this frame's solve
	 *     starts from the pose it would have if it inherited that correction —
	 *     the previous frame's delta (baseQ⁻¹ ∘ q, its correction relative to its
	 *     OWN clip pose) applied to this frame's pose. If that already reads
	 *     clean, it is accepted as it stands: the collision is gone and the
	 *     continuity comes for free. If not, the solve carries on from there, so
	 *     it starts in the neighbourhood of the answer its neighbour found.
	 *  2. ESCAPE CONSISTENCY. Whatever is solved gets the previous frame's push
	 *     direction as a bias (see CONTINUITY_BIAS), so two frames that must both
	 *     escape leave the same way.
	 *  3. THE STEP CAP. If the result still moves an effector further from its
	 *     previous corrected position than the clip's own motion justifies, the
	 *     frame is re-solved with the continuity bias turned up; failing that the
	 *     closest collision-free candidate is kept, and failing THAT the frame is
	 *     left alone and reported unresolved. A flail is never the answer.
	 *
	 * Everything is keyed exactly as before — this frame's own raw baseQuats,
	 * only the chains that moved — so the blend window, the pins and the delta
	 * bake are untouched.
	 */
	/** The frame before this one, when it was corrected: what it did, where it
	 * left each effector, and which way it pushed. Null the moment a frame is
	 * not keyed, so continuity never reaches across a gap. */
	let carried = null;
	/** `baseQ⁻¹ ∘ q` per bone — the correction a frame applied to its own clip
	 * pose, which is exactly the delta ikEvaluate replays for its key. */
	const correctionDeltas = (touched, baseQuats) => {
		const deltas = new Map();
		for (const id of touched) {
			const chain = chains.get(id);
			const bases = baseQuats?.get(id);
			if (!chain || !bases) continue;
			deltas.set(id, chain.bones.map((bone, index) => (bases[index]
				? bases[index].clone().invert().multiply(bone.quaternion)
				: new THREE.Quaternion())));
		}
		return deltas;
	};
	/** Seed `ids` with the previous frame's rotation correction on this frame's
	 * own translations, the same solve space used by the fresh attempts. */
	const applyWarmStart = (ids, deltas) => {
		for (const id of ids) {
			const chain = chains.get(id);
			const delta = deltas.get(id);
			if (!chain || !delta) continue;
			chain.bones.forEach((bone, index) => {
				if (delta[index]) bone.quaternion.multiply(delta[index]);
			});
		}
		rig.updateMatrixWorld(true);
	};
	const lowestFootMarker = () => {
		let lowest = Infinity;
		for (const name of FLOOR_MARKERS) {
			const bone = findBone(rig, name);
			if (bone) lowest = Math.min(lowest, bone.getWorldPosition(new THREE.Vector3()).y);
		}
		return lowest;
	};
	const epsilonOf = options.epsilon ?? 1e-4;
	const floorOf = options.floorY ?? 0;

	for (let frame = start; frame <= end; frame += 1) {
		const index = frame - start;
		const blockers = blockersFor(frame);
		const detectOptions = { offset: options.offset, slackFactor: options.slackFactor, blockers, onlyChains: options.onlyChains };
		// applyFrame still runs: it poses the bones outside the IK layer (fingers,
		// toes, spine tips) that the capsules also measure. The restore then
		// overwrites exactly the bones this pass could have moved.
		//
		// Blockers are WORLD-SPACE and posed for this frame: a static array is
		// the same set at every frame, while `blockersAt(frame)` is asked for
		// them AFTER applyFrame, so a caller animating a prop reports where it
		// is on the frame being solved rather than where it started.
		const restoreFrame = () => {
			applyFrame(frame);
			restoreBones(rig, bones, basePose[index]);
		};
		restoreFrame();

		// The frame's OWN reading, before anything is seeded into it: the cast the
		// provenance gate may move, the depth any candidate has to beat, and the
		// floor no candidate may go under.
		let warmChains = null;
		let provenance = null;
		let baseWorst = 0;
		const baseEffectors = readEffectors();
		const baseFoot = lowestFootMarker();
		if (carried?.frame === frame - 1) {
			const capsules = buildCollisionCapsules(rig, options.radii ?? null);
			const pens = fixablePenetrations(capsules, detectOptions);
			baseWorst = pens.length ? pens[0].depth : 0;
			provenance = chainsInPlay(pens);
			// Only a chain THIS frame's own pose puts in play may be warm started:
			// inheriting a correction onto a limb with nothing wrong with it would
			// smear the fix across frames that never needed one.
			warmChains = [...provenance].filter((id) => carried.deltas.has(id));
		}

		/** One attempt at this frame, from the pose as recorded, optionally warm
		 * started and with the continuity bias at `weight`. Returns everything the
		 * chooser needs and leaves nothing behind: the pose is snapshotted, and
		 * the next attempt restores the frame before it starts. */
		const attempt = ({ warm, weight }) => {
			restoreFrame();
			if (warm?.length) applyWarmStart(warm, carried.deltas);
			const continuity = weight > 0 && carried ? { dirs: carried.dirs, weight } : null;
			// A warm start that lands clean IS the answer: the collision is gone
			// and the pose is the neighbour's, which is the whole point. It still
			// has to clear the floor, the one guarantee a solve would have checked
			// and a straight inheritance would not.
			if (warm?.length) {
				const capsules = buildCollisionCapsules(rig, options.radii ?? null);
				if (!capsules) return { supported: false };
				if (fixablePenetrations(capsules, detectOptions).length === 0) {
					const foot = lowestFootMarker();
					if (!(Number.isFinite(foot) && foot < Math.min(baseFoot, floorOf + PUSH_FLOOR_CLEARANCE) - 1e-6)) {
						return {
							supported: true, keyed: true, warm: true,
							touched: [...warm], residual: 0,
							pose: snapshotBones(bones), effectors: readEffectors(),
						};
					}
				}
			}
			const result = fixCollisions(rig, chains, {
				...options,
				blockers,
				fkJoints,
				// The chains a DISCARDED attempt drove must not be left tracked, so
				// the bake below — which touches every id it keys — is what marks
				// the layer, not the attempts.
				ikState: null,
				baseQuats: clipQuats[index],
				continuity,
				provenanceChains: warm?.length ? provenance : null,
			});
			if (!result.supported) return { supported: false };
			// A warm attempt keys every chain it seeded, whether the solve moved it
			// again or not: the pose being measured is the seeded one, and a chain
			// left out of the key would be evaluated back on the clip.
			const touched = new Set(result.touched);
			if (result.changed && warm?.length) for (const id of warm) touched.add(id);
			return {
				supported: true,
				keyed: result.changed && touched.size > 0,
				warm: Boolean(warm?.length),
				touched: [...touched],
				residual: result.residual,
				pose: snapshotBones(bones),
				effectors: readEffectors(),
			};
		};

		/** How far this attempt moves an effector away from where the previous
		 * corrected frame left it, as a FRACTION of that chain's cap — counted
		 * only on chains BOTH frames correct, because a chain the previous frame
		 * corrected and this one does not is the blend window's business, not the
		 * cap's. Over 1 is a jump; below it the frames read as one motion. The
		 * ratio (not the raw millimetres) is also what ranks two candidates, so a
		 * hand and a foot are compared on the same scale. */
		const stepRatio = (candidate) => {
			let worst = 0;
			if (!carried) return worst;
			for (const id of candidate.touched) {
				const before = carried.effectors.get(id);
				const after = candidate.effectors?.get(id);
				if (!before || !after) continue;
				worst = Math.max(worst, after.distanceTo(before) / (stepCap.get(id) ?? STEP_CAP_ABS));
			}
			return worst;
		};
		const overCap = (candidate) => stepRatio(candidate) > 1;
		// A warm attempt may not come out WORSE than the frame's own pose: the
		// seeded pose is not this frame's, so fixCollisions's accept gate — which
		// judges against the pose it was handed — cannot see that comparison.
		const usable = (candidate) => candidate?.keyed
			&& (!candidate.warm || candidate.residual <= baseWorst + 1e-9);

		const tries = [];
		if (warmChains?.length) tries.push(attempt({ warm: warmChains, weight: CONTINUITY_BIAS }));
		if (tries[0]?.supported === false) { keyed.unresolved = unresolvedList(); return keyed; }
		const plain = attempt({ warm: null, weight: carried ? CONTINUITY_BIAS : 0 });
		// An unsupported rig is unsupported at every frame: bail on the first
		// one instead of re-posing the whole clip to learn the same thing.
		if (!plain.supported) { keyed.unresolved = unresolvedList(); return keyed; }
		tries.push(plain);

		// Warm first, then plain: the inherited answer wins ties, which is what
		// makes a run of frames one correction.
		let chosen = tries.find((candidate) => usable(candidate) && !overCap(candidate)) ?? null;
		if (!chosen && tries.some(usable)) {
			// Every candidate jumped. One more go with the previous frame's
			// direction outvoting the rest bias...
			const stronger = attempt({ warm: warmChains?.length ? warmChains : null, weight: CONTINUITY_BIAS_STRONG });
			if (stronger.supported === false) { keyed.unresolved = unresolvedList(); return keyed; }
			if (usable(stronger) && !overCap(stronger)) chosen = stronger;
			else {
				// ...and failing that, the closest of the candidates that actually
				// clears the collision. A frame with no collision-free candidate is
				// left as the clip had it and reported, because a flail that happens
				// to be collision-free is not a fix.
				const free = [...tries, stronger]
					.filter((candidate) => usable(candidate) && candidate.residual <= epsilonOf)
					.sort((a, b) => stepRatio(a) - stepRatio(b));
				chosen = free[0] ?? null;
			}
		}

		if (!chosen) {
			// Nothing to key: either the frame was clean (residual 0, and every
			// candidate reports it) or every candidate was refused. Report whichever
			// depth is left standing on the pose the viewer will see.
			restoreFrame();
			noteResidual(frame, Math.max(baseWorst, plain.keyed ? 0 : plain.residual));
			carried = null;
			continue;
		}
		restoreBones(rig, bones, chosen.pose);
		noteResidual(frame, chosen.residual);
		// Only the chains THIS frame moved — the pass must not re-key an
		// unrelated limb at the blended value it happens to be showing here —
		// and each one as a delta from the clip's own rotations at this frame.
		ikBakeKeyframe(chains, ikState, frame, fkJoints, chosen.touched, null, clipQuats[index]);
		keyed.push(frame);
		const dirs = new Map();
		for (const id of chosen.touched) {
			const before = baseEffectors.get(id);
			const after = chosen.effectors.get(id);
			if (!before || !after) continue;
			const dir = after.clone().sub(before);
			if (dir.lengthSq() > 1e-8) dirs.set(id, dir.normalize());
		}
		carried = {
			frame,
			deltas: correctionDeltas(chosen.touched, clipQuats[index]),
			effectors: new Map([...chosen.effectors].filter(([id]) => chosen.touched.includes(id))),
			dirs,
		};
	}

	/* --- sweep 3: the blend window's own frames, ONCE ----------------------- */
	/**
	 * Sweeps 1 and 2 judge every frame against the CLIP, which is what stops the
	 * pass chasing its own tail. The cost is that the ramp each new key runs out
	 * over is never looked at, and a big correction drags its neighbours into
	 * contact on the way: QA's crouch had frame 103 clean before the pass and
	 * 28.9 mm of forearm × thumb after it, deterministically, with no frame left
	 * to notice.
	 *
	 * So one bounded round, and only for frames a key can actually reach: pose
	 * the frame WITH the layer (the pose the viewer will see), and if that pose
	 * penetrates, fix and key it from there. The key is still stored as a delta
	 * from the RAW CLIP rotations sweep 1 recorded, so it composes with the ramp
	 * the same way every other key does.
	 *
	 * ONE ROUND. Keying these frames moves the ramp again, and chasing that would
	 * not terminate on a clip whose corrections overlap. A frame this round
	 * leaves dirty is reported in `unresolved` instead, which is the honest
	 * answer and one the caller can say out loud.
	 */
	if (keyed.length && blendWindow > 0) {
		const keyedSet = new Set(keyed);
		const candidates = [];
		for (const frame of keyed) {
			for (let offset = -blendWindow; offset <= blendWindow; offset += 1) {
				const near = frame + offset;
				if (near < start || near > end || keyedSet.has(near)) continue;
				if (!candidates.includes(near)) candidates.push(near);
			}
		}
		candidates.sort((a, b) => a - b);
		for (const frame of candidates) {
			applyFrame(frame); // the BLENDED pose, keys included — no restore here
			const result = fixCollisions(rig, chains, {
				...options,
				blockers: blockersFor(frame),
				fkJoints,
				ikState,
				baseQuats: clipQuats[frame - start],
			});
			if (!result.supported) break;
			noteResidual(frame, result.residual);
			if (!result.changed || !result.touched.length) continue;
			ikBakeKeyframe(chains, ikState, frame, fkJoints, result.touched, null, result.baseQuats);
			keyed.push(frame);
		}
		keyed.sort((a, b) => a - b);
	}

	/* --- final sweep: the truth on the pose the viewer will actually see ----- */
	/**
	 * Everything above judges a frame at the moment it is solved. What the viewer
	 * gets is the EVALUATED pose — clip plus every key's blend ramp — and the last
	 * key written can put a frame back into contact after that frame was already
	 * measured and passed. QA's crouch ended with frame 104 at 13.5 mm, created by
	 * a neighbouring key's ramp, and the toast said nothing at all.
	 *
	 * So one last read-only walk over every frame a key can reach: pose it with
	 * the layer, measure, and let that measurement be the final word. Nothing is
	 * written here — a frame this finds dirty is REPORTED, because writing would
	 * move the ramps again and there would be no frame left to check that.
	 */
	if (keyed.length) {
		const reach = new Set();
		for (const frame of keyed) {
			for (let offset = -blendWindow; offset <= blendWindow; offset += 1) {
				const near = frame + offset;
				if (near >= start && near <= end) reach.add(near);
			}
		}
		for (const frame of [...reach].sort((a, b) => a - b)) {
			applyFrame(frame);
			const capsules = buildCollisionCapsules(rig, options.radii ?? null);
			const pens = (capsules
				? detectPenetrations(capsules, {
					offset: options.offset,
					slackFactor: options.slackFactor,
					blockers: blockersFor(frame),
				})
				: []).filter((pen) => !isHingeFold(pen));
			// The final word replaces whatever the solve-time measurement said,
			// in both directions: a frame a later ramp dirtied is added, and one
			// a later key cleaned drops off.
			noteResidual(frame, pens.length ? pens[0].depth : 0);
		}
	}

	// Frames the passes could not clear, deepest remaining penetration and all,
	// so the caller can say "some frames still touch" instead of implying a clean
	// clip. Rides on the returned array so every existing caller keeps working.
	keyed.unresolved = unresolvedList();
	return keyed;
}
