import * as THREE from "three";
import { findBone, solveIk, solveMidJoint, ikTouch, ikBakeKeyframe, measureContactRadii } from "./ik.js";

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
 *   for the upper segment, effector (wrist/ankle) for the lower — along the
 *   separation normal by (depth + offset). solveIk's bend continuity keeps
 *   the elbow/knee on its own side, so the fix never flips a hinge.
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
	{ id: "leftHand", start: "mixamorigLeftHand", end: null, radiusJoint: "LeftHand", maxRadius: 0.06, movable: { chain: "leftHand", joint: "effector" }, priority: 2 },
	{ id: "rightUpperArm", start: "mixamorigRightArm", end: "mixamorigRightForeArm", radiusJoint: "RightArm", movable: { chain: "rightHand", joint: "mid" }, priority: 2 },
	{ id: "rightForeArm", start: "mixamorigRightForeArm", end: "mixamorigRightHand", radiusJoint: "RightForeArm", movable: { chain: "rightHand", joint: "effector" }, priority: 2 },
	{ id: "rightHand", start: "mixamorigRightHand", end: null, radiusJoint: "RightHand", maxRadius: 0.06, movable: { chain: "rightHand", joint: "effector" }, priority: 2 },
	{ id: "leftThigh", start: "mixamorigLeftUpLeg", end: "mixamorigLeftLeg", radiusJoint: "LeftUpLeg", movable: { chain: "leftFoot", joint: "mid" }, priority: 1 },
	{ id: "leftShin", start: "mixamorigLeftLeg", end: "mixamorigLeftFoot", radiusJoint: "LeftLeg", movable: { chain: "leftFoot", joint: "effector" }, priority: 1 },
	{ id: "leftFoot", start: "mixamorigLeftFoot", end: "mixamorigLeftToeBase", radiusJoint: "LeftFoot", maxRadius: 0.07, movable: { chain: "leftFoot", joint: "effector" }, priority: 1 },
	{ id: "rightThigh", start: "mixamorigRightUpLeg", end: "mixamorigRightLeg", radiusJoint: "RightUpLeg", movable: { chain: "rightFoot", joint: "mid" }, priority: 1 },
	{ id: "rightShin", start: "mixamorigRightLeg", end: "mixamorigRightFoot", radiusJoint: "RightLeg", movable: { chain: "rightFoot", joint: "effector" }, priority: 1 },
	{ id: "rightFoot", start: "mixamorigRightFoot", end: "mixamorigRightToeBase", radiusJoint: "RightFoot", maxRadius: 0.07, movable: { chain: "rightFoot", joint: "effector" }, priority: 1 },
];

/** Fallback radius when no measurement exists (matches ik.js's floor). */
const RADIUS_FALLBACK = 0.01;

/**
 * Build world-space capsules for the rig's CURRENT pose. Cheap (a bone
 * lookup + two world positions per entry), so callers rebuild per frame.
 * `radii` overrides the measured map (tests, or rigs without skin weights).
 * Returns null when any defining bone is missing — the caller then hides
 * the tool, same policy as resolveIkRig.
 */
export function buildCollisionCapsules(rig, radii = null) {
	if (!rig) return null;
	rig.updateMatrixWorld(true);
	const radiiMap = radii ?? measureContactRadii(rig);
	const capsules = new Map();
	for (const def of CAPSULE_DEFS) {
		const start = findBone(rig, def.start);
		if (!start) return null;
		const end = def.end ? findBone(rig, def.end) : null;
		if (def.end && !end) return null;
		const a = start.getWorldPosition(new THREE.Vector3());
		const b = end ? end.getWorldPosition(new THREE.Vector3()) : a.clone();
		const measured = Math.max(RADIUS_FALLBACK, radiiMap[def.radiusJoint] ?? RADIUS_FALLBACK);
		capsules.set(def.id, {
			def,
			bones: end ? [start, end] : [start],
			a,
			b,
			radius: def.maxRadius ? Math.min(measured, def.maxRadius) : measured,
		});
	}
	return capsules;
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

/** Ancestor hop count between two bones, or Infinity when unrelated.
 * Capsules whose endpoints sit within HOP_LIMIT hops on the skeleton are
 * neighbours (upper arm against chest at the shoulder, thigh against the
 * pelvis) and ALWAYS overlap at the joint — checking them would pin the
 * fixer forever. */
const HOP_LIMIT = 2;
function bonesRelated(b0, b1) {
	for (let node = b0, hops = 0; node && hops <= HOP_LIMIT; node = node.parent, hops += 1) {
		if (node === b1) return true;
	}
	for (let node = b1, hops = 0; node && hops <= HOP_LIMIT; node = node.parent, hops += 1) {
		if (node === b0) return true;
	}
	return false;
}

function capsulesAdjacent(ca, cb) {
	return ca.bones.some((ba) => cb.bones.some((bb) => bonesRelated(ba, bb)));
}

/**
 * Find every penetrating capsule pair in the current pose. Returns records
 * { a, b, depth, normal, pointA, pointB } sorted deepest-first. `normal`
 * points from b toward a. `offset` inflates the contact distance, so the
 * fixer keeps a skin gap instead of surface-grazing.
 *
 * SLACK: capsules are rigid proxies for soft tissue — an upper arm resting
 * against the torso, or thighs touching, legitimately overlaps the proxies.
 * A pair only counts once it penetrates past `slackFactor × min(radius)`,
 * the soft-tissue compression allowance; `depth` is the amount PAST that
 * allowance, which is also the distance the fixer pushes.
 */
export function detectPenetrations(capsules, { offset = 0.002, slackFactor = 0.6 } = {}) {
	if (!capsules) return [];
	const list = [...capsules.values()];
	const out = [];
	const pa = new THREE.Vector3();
	const pb = new THREE.Vector3();
	for (let i = 0; i < list.length; i += 1) {
		for (let j = i + 1; j < list.length; j += 1) {
			const ca = list[i];
			const cb = list[j];
			if (capsulesAdjacent(ca, cb)) continue;
			closestPointsSegmentSegment(ca.a, ca.b, cb.a, cb.b, pa, pb);
			const overlap = ca.radius + cb.radius - pa.distanceTo(pb);
			const slack = slackFactor * Math.min(ca.radius, cb.radius);
			const depth = overlap - slack;
			if (depth <= 1e-7) continue;
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
	out.sort((x, y) => y.depth - x.depth);
	return out;
}

/* --- resolution ------------------------------------------------------------- */

/** Push one movable capsule by `push` (world vector). Mid joint drives the
 * elbow/knee (upper segment), effector drives the wrist/ankle (lower
 * segment and end spheres). Returns true when a solver ran. */
function pushCapsule(capsule, chains, push, ikState) {
	const target = capsule.def.movable;
	if (!target) return false;
	const chain = chains?.get(target.chain);
	if (!chain) return false;
	if (ikState) ikTouch(ikState, target.chain);
	if (target.joint === "mid") {
		const mid = chain.bones[1].getWorldPosition(new THREE.Vector3());
		solveMidJoint(chain, mid.add(push));
	} else {
		const eff = chain.bones[2].getWorldPosition(new THREE.Vector3());
		solveIk(chain, eff.add(push));
	}
	return true;
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
 *
 * Returns { changed, passes, residual } — residual is the deepest
 * remaining penetration in metres, 0 when fully clean.
 */
export function fixCollisions(rig, chains, {
	radii = null,
	offset = 0.002,
	epsilon = 1e-4,
	maxIterations = 8,
	onlyChains = null,
	ikState = null,
} = {}) {
	if (!rig || !chains) return { changed: false, passes: 0, residual: 0 };
	let changed = false;
	let residual = 0;
	let pass = 0;
	for (; pass < maxIterations; pass += 1) {
		const capsules = buildCollisionCapsules(rig, radii);
		if (!capsules) break;
		const pens = detectPenetrations(capsules, { offset }).filter((pen) => {
			// Two static blockers (e.g. head near torso in a crouch) can touch
			// but no limb chain can fix them — reporting them just burns passes.
			if (!pen.a.def.movable && !pen.b.def.movable) return false;
			if (!onlyChains) return true;
			const chainsOf = [pen.a, pen.b].map((c) => c.def.movable?.chain).filter(Boolean);
			return chainsOf.some((id) => onlyChains.has(id));
		});
		if (pens.length === 0) { residual = 0; break; }
		residual = pens[0].depth;
		for (const pen of pens) {
			const ma = pen.a.def.movable;
			const mb = pen.b.def.movable;
			const push = pen.normal.clone().multiplyScalar(pen.depth + offset);
			// `normal` points b → a: +push moves a away from b, -push the reverse.
			if (ma && !mb) changed = pushCapsule(pen.a, chains, push, ikState) || changed;
			else if (mb && !ma) changed = pushCapsule(pen.b, chains, push.negate(), ikState) || changed;
			else if (ma && mb) {
				const pa = pen.a.def.priority ?? 1;
				const pb = pen.b.def.priority ?? 1;
				const shareA = pa / (pa + pb); // arms (2) yield before legs (1)
				const movedA = pushCapsule(pen.a, chains, push.clone().multiplyScalar(shareA), ikState);
				const movedB = pushCapsule(pen.b, chains, push.negate().multiplyScalar(1 - shareA), ikState);
				changed = movedA || movedB || changed;
			}
		}
		if (!changed) break;
	}
	// Final measurement for an honest residual report.
	if (changed) {
		const capsules = buildCollisionCapsules(rig, radii);
		const pens = capsules ? detectPenetrations(capsules, { offset }) : [];
		residual = pens.length ? pens[0].depth : 0;
	}
	return { changed, passes: pass, residual };
}

/**
 * Clean a frame RANGE, baking every touched frame into the IK key layer.
 * `applyFrame(frame)` must pose the rig (motion apply + ikEvaluate) before
 * the fix runs — App owns that plumbing, this owns the loop. Only frames
 * that actually changed get a key, so a clean clip stays keyless.
 * Returns the list of keyed frames.
 */
export function fixCollisionsRange({
	rig,
	chains,
	ikState,
	fkJoints = null,
	startFrame,
	endFrame,
	applyFrame,
	...options
} = {}) {
	if (!rig || !chains || !ikState || typeof applyFrame !== "function") return [];
	const start = Math.max(0, Math.round(startFrame));
	const end = Math.max(start, Math.round(endFrame));
	const keyed = [];
	for (let frame = start; frame <= end; frame += 1) {
		applyFrame(frame);
		const result = fixCollisions(rig, chains, { ...options, ikState });
		if (!result.changed) continue;
		ikBakeKeyframe(chains, ikState, frame, fkJoints);
		keyed.push(frame);
	}
	return keyed;
}
