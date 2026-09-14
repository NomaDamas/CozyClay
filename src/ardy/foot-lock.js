/* Pure-math foot locking, ported from Daniel Holden's article "Inverse
 * Kinematics and Foot Locking" (https://theorangeduck.com/page/inverse-kinematics-foot-locking).
 * Foot slide is a velocity error: instead of snapping a planted toe to the
 * floor, the locked contact target is blended in and out with cubic
 * inertialization so position and velocity stay continuous, the TOE (never
 * the heel) is the locked point, and IK stays a minimal modification of the
 * source pose. Everything here is a pure function over THREE.Vector3 data —
 * no rig, scene, or playback access — so callers decide how targets reach
 * the skeleton. */
import * as THREE from "three";

/* Shared read-only zero vector for "the contact point is stationary". Never
 * mutated; Vector3 methods that would mutate it are never called on it. */
const ZERO = new THREE.Vector3();

/* Cubic inertialization weights (Holden eq. for the cubic ease). w0/w1 blend
 * position, w2/w3 blend velocity; w1/w2 carry the blendTime units. blendTime
 * is guarded so a zero blend degrades to "snap now" instead of dividing by
 * zero. */
function cubicWeights(time, blendTime) {
	const bt = Math.max(blendTime, 1e-8);
	const t = Math.min(Math.max(time / bt, 0), 1);
	const t2 = t * t;
	const t3 = t2 * t;
	return {
		w0: 2 * t3 - 3 * t2 + 1,
		w1: (t3 - 2 * t2 + t) * bt,
		w2: (6 * t2 - 6 * t) / bt,
		w3: 3 * t2 - 4 * t + 1,
	};
}

/* Re-target the inertializer: fold the current offset state at `time` into a
 * fresh offset that reproduces the same output trajectory relative to the new
 * destination, then restart the blend clock. Source is where the motion is
 * coming from (the pre-switch target), destination where it goes next. */
export function inertializeCubicTransition(offsetPosition, offsetVelocity, time, sourcePosition, sourceVelocity, destinationPosition, destinationVelocity, blendTime) {
	const { w0, w1, w2, w3 } = cubicWeights(time.value, blendTime);
	return {
		offsetPosition: sourcePosition.clone().addScaledVector(offsetPosition, w0).addScaledVector(offsetVelocity, w1).sub(destinationPosition),
		offsetVelocity: sourceVelocity.clone().addScaledVector(offsetPosition, w2).addScaledVector(offsetVelocity, w3).sub(destinationVelocity),
		time: { value: 0 },
	};
}

/* Advance the inertialized output one step: the input stream plus the decaying
 * offset. `time` is a mutable { value } box so the offset state can be handed
 * around without wrapping it in a class. */
export function inertializeCubicUpdate(position, velocity, time, inputPosition, inputVelocity, offsetPosition, offsetVelocity, deltaTime, blendTime) {
	// Holden evaluates the weights at time+deltaTime so the step lands at the
	// end of the interval, not its start.
	const { w0, w1, w2, w3 } = cubicWeights(time.value + deltaTime, blendTime);
	position.copy(inputPosition).addScaledVector(offsetPosition, w0).addScaledVector(offsetVelocity, w1);
	velocity.copy(inputVelocity).addScaledVector(offsetPosition, w2).addScaledVector(offsetVelocity, w3);
	time.value += deltaTime;
	return position;
}

/* Fresh foot-lock state for one toe. `position` seeds both the filtered
 * output and the "previous input" so the first finite-difference velocity is
 * not polluted by an arbitrary origin. */
export function createFootLockState(position) {
	return {
		position: position.clone(),
		velocity: new THREE.Vector3(),
		inputPosition: position.clone(),
		inputVelocity: new THREE.Vector3(),
		offsetPosition: new THREE.Vector3(),
		offsetVelocity: new THREE.Vector3(),
		time: { value: 0 },
		contact: position.clone(),
		locked: false,
	};
}

/* Per-frame foot locking for one toe (Holden's UpdateFootLockingState).
 * contactHeight plants the lock at floor height; pass null to keep the input
 * y. options.contactPoint (used by footLockTrack for span anchors) overrides
 * the first-contact input position as the locked point. */
export function updateFootLockState(state, inputPosition, inputContact, contactHeight, deltaTime, { unlockDistance = 0.2, lockDistance = 0.1, blendTime = 0.2, contactPoint = null } = {}) {
	// Input velocity by finite difference: slide is a velocity error, so the
	// corrector needs to know how fast the raw toe was drifting.
	const dt = Math.max(deltaTime, 1e-8);
	state.inputVelocity.copy(inputPosition).sub(state.inputPosition).divideScalar(dt);

	if (!state.locked && inputContact && state.position.distanceTo(inputPosition) < lockDistance) {
		// Lock onto the TOE: capture the contact point (input, dropped to the
		// requested height) and hand the current motion error to the
		// inertializer as a transition from the input onto the stationary
		// contact.
		state.locked = true;
		if (contactPoint) {
			// An explicit anchor (e.g. a hand-placed ground mark) IS the contact
			// point — its y is authoritative, never re-derived from the input.
			state.contact.copy(contactPoint);
		} else {
			state.contact.copy(inputPosition);
			if (contactHeight === null || contactHeight === undefined) state.contact.y = inputPosition.y;
			else state.contact.y = contactHeight;
		}
		const next = inertializeCubicTransition(state.offsetPosition, state.offsetVelocity, state.time, inputPosition, state.inputVelocity, state.contact, ZERO, blendTime);
		state.offsetPosition.copy(next.offsetPosition);
		state.offsetVelocity.copy(next.offsetVelocity);
		state.time.value = next.time.value;
	} else if (state.locked && (!inputContact || state.position.distanceTo(inputPosition) > unlockDistance)) {
		// Release: transition from the stationary contact back onto the moving
		// input so the toe catches up instead of teleporting.
		state.locked = false;
		const next = inertializeCubicTransition(state.offsetPosition, state.offsetVelocity, state.time, state.contact, ZERO, inputPosition, state.inputVelocity, blendTime);
		state.offsetPosition.copy(next.offsetPosition);
		state.offsetVelocity.copy(next.offsetVelocity);
		state.time.value = next.time.value;
	}

	const target = state.locked ? state.contact : inputPosition;
	const targetVelocity = state.locked ? ZERO : state.inputVelocity;
	inertializeCubicUpdate(state.position, state.velocity, state.time, target, targetVelocity, state.offsetPosition, state.offsetVelocity, deltaTime, blendTime);
	state.inputPosition.copy(inputPosition);
	return state.position;
}

/* Offline driver: run the per-frame state over a whole clip. `inputs` is one
 * toe position per frame; `contacts` is booleans per frame, or — when
 * `anchors` is given — span objects { start, end, anchor? }. anchors[f] being
 * a Vector3 pins the locked contact to that exact point (e.g. a hand-placed
 * ground mark) instead of wherever the toe first touched; with contactHeight
 * null the input y is kept. Frame 0 just initialises the state. */
export function footLockTrack(inputs, contacts, { fps = 30, blendTime = 0.2, lockDistance = 0.1, unlockDistance = 0.2, contactHeight = null, anchors = null } = {}) {
	const count = inputs.length;
	const flags = new Array(count).fill(false);
	const points = new Array(count).fill(null);
	// Contacts arrive either as per-frame booleans or as {start,end,anchor?}
	// spans; expand spans so both shapes feed the same flags/points.
	for (let f = 0; f < count; f++) {
		const c = contacts[f];
		if (typeof c === "boolean") {
			flags[f] = c;
		} else if (c && Number.isFinite(c.start)) {
			for (let g = Math.max(0, c.start); g <= Math.min(count - 1, c.end); g++) {
				flags[g] = true;
				if (points[g] === null && c.anchor instanceof THREE.Vector3) points[g] = c.anchor;
			}
		}
	}
	if (anchors !== null) {
		// Per-frame anchors name a specific frame, so they outrank span anchors.
		for (let f = 0; f < count; f++) {
			if (anchors[f] instanceof THREE.Vector3) points[f] = anchors[f];
		}
	}

	const state = createFootLockState(inputs[0]);
	const out = [state.position.clone()];
	const deltaTime = 1 / Math.max(fps, 1e-6);
	for (let f = 1; f < count; f++) {
		updateFootLockState(state, inputs[f], flags[f], contactHeight, deltaTime, { lockDistance, unlockDistance, blendTime, contactPoint: points[f] });
		out.push(state.position.clone());
	}
	return out;
}

/* Holden's offline relaxation: given SOURCE toe/pelvis tracks and per-frame
 * contact flags, absorb contact-slide drift without inventing motion. Inputs
 * are never mutated; clones are relaxed and returned. Contact frames collapse
 * toward a shared ground point (hard); air frames chase their neighbour plus
 * the SOURCE relative displacement so the gait survives (soft); the in-frame
 * leg-length constraint keeps extension at what the source had instead of
 * pulling the hips down. */
export function relaxToePath(toes, pelvis, contacts, { iterations = 200, softFactor = 0.05, hardFactor = 0.9, toeMinHeight = 0, restLengths = null, relaxPelvis = false } = {}) {
	const count = toes.length;
	const sourceToes = toes.map((t) => t.clone());
	const outToes = toes.map((t) => t.clone());
	const outPelvis = pelvis.map((p) => p.clone());
	// Rest lengths default to the source pose: the point is to stop the leg
	// stretching further than the animation ever did.
	const rest = restLengths ?? sourceToes.map((t, i) => outPelvis[i].distanceTo(t));
	const tmp = new THREE.Vector3();
	const target = new THREE.Vector3();

	// Move `point` factor of the way to `target`, clamping y up to minY when
	// requested; returns the applied distance so the caller can early-exit.
	const relaxPoint = (point, to, factor, minY) => {
		const ox = point.x, oy = point.y, oz = point.z;
		point.lerp(to, factor);
		if (minY !== null && point.y < minY) point.y = minY;
		return Math.hypot(point.x - ox, point.y - oy, point.z - oz);
	};
	// Soft target for frame i: neighbour j plus the SOURCE i-j displacement,
	// so air frames preserve stride rather than smearing into each other.
	const chaseNeighbour = (out, source, i, j, factor, minY) => {
		target.copy(out[j]).add(source[i]).sub(source[j]);
		return relaxPoint(out[i], target, factor, minY);
	};

	for (let iter = 0; iter < iterations; iter++) {
		let largest = 0;
		for (let i = 1; i < count; i++) {
			if (contacts[i - 1] && contacts[i]) {
				// Both frames planted: they belong at ONE spot, so pull both
				// toward their midpoint dropped to the ground height.
				target.copy(outToes[i]).add(outToes[i - 1]).multiplyScalar(0.5);
				target.y = Math.max(target.y, Array.isArray(toeMinHeight) ? Math.max(toeMinHeight[i] ?? 0, toeMinHeight[i - 1] ?? 0) : toeMinHeight);
				largest = Math.max(largest, relaxPoint(outToes[i], target, hardFactor, null));
				largest = Math.max(largest, relaxPoint(outToes[i - 1], target, hardFactor, null));
			} else {
				largest = Math.max(largest, chaseNeighbour(outToes, sourceToes, i, i - 1, softFactor, Array.isArray(toeMinHeight) ? toeMinHeight[i] : toeMinHeight));
				largest = Math.max(largest, chaseNeighbour(outToes, sourceToes, i - 1, i, softFactor, Array.isArray(toeMinHeight) ? toeMinHeight[i - 1] : toeMinHeight));
				if (relaxPelvis) {
					largest = Math.max(largest, chaseNeighbour(outPelvis, pelvis, i, i - 1, softFactor, null));
					largest = Math.max(largest, chaseNeighbour(outPelvis, pelvis, i - 1, i, softFactor, null));
				}
			}
		}
		// In-frame constraint: hold |pelvis - toe| at the rest length by
		// moving the toe (splitting the correction with the pelvis only when
		// asked — moving the pelvis is the "pull the hips down" failure the
		// article warns about).
		for (let i = 0; i < count; i++) {
			tmp.copy(outToes[i]).sub(outPelvis[i]);
			const d = tmp.length();
			if (d < 1e-9) continue;
			const correction = ((d - rest[i]) * softFactor) / d;
			outToes[i].addScaledVector(tmp, -correction);
			if (relaxPelvis) outPelvis[i].addScaledVector(tmp, correction);
			largest = Math.max(largest, Math.abs(correction) * d);
		}
		if (largest < 1e-5) break;
	}
	return { toes: outToes, pelvis: outPelvis };
}
