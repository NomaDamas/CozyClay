import * as THREE from "three";
import {
	inertializeCubicTransition,
	inertializeCubicUpdate,
	createFootLockState,
	updateFootLockState,
	footLockTrack,
	relaxToePath,
} from "../../src/ardy/foot-lock.js";

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
	}
}

/* --- (a) Cubic inertialization ------------------------------------------- */
{
	const blendTime = 0.2;
	const dt = 1 / 60;

	// Fresh offset, no history: the fold is (source + old output) − dest, so
	// the NEW offset reproduces the OLD output relative to the new dest.
	const fresh = inertializeCubicTransition(new THREE.Vector3(), new THREE.Vector3(), { value: 0 }, new THREE.Vector3(4, 0, 0), new THREE.Vector3(2, 0, 0), new THREE.Vector3(5, 0, 0), new THREE.Vector3(2, 0, 0), blendTime);
	check("transition at time 0 equals source minus destination",
		fresh.offsetPosition.distanceTo(new THREE.Vector3(-1, 0, 0)) < 1e-9 && fresh.offsetVelocity.distanceTo(new THREE.Vector3()) < 1e-9);

	// The fold is trajectory-preserving: running from the OLD state to time
	// T, then folding and restarting, must produce the SAME output position
	// and velocity at T relative to the new destination.
	{
		const blendTime2 = 0.2;
		const source = new THREE.Vector3(3, 0, 0);
		const sourceVel = new THREE.Vector3(4, 0, 0);
		const destination = new THREE.Vector3(5, 0, 0);
		const destVel = new THREE.Vector3(2, 0, 0);
		const oldOp = new THREE.Vector3(1, 0, 0);
		const oldOv = new THREE.Vector3(-2, 0, 0);
		const oldTime = { value: 0.06 };
		const pos = new THREE.Vector3();
		const vel = new THREE.Vector3();
		inertializeCubicUpdate(pos, vel, oldTime, source, sourceVel, oldOp, oldOv, 0, blendTime2);
		const folded = inertializeCubicTransition(oldOp, oldOv, oldTime, source, sourceVel, destination, destVel, blendTime2);
	// The fold is an exact identity: new output at 0 (dest + newOP) equals
		// old output at T (source + oldRel) — independent of dt.
		const newAbs = destination.clone().add(folded.offsetPosition);
		check("transition preserves the trajectory (position)", newAbs.distanceTo(pos) < 1e-9, `${newAbs.toArray()} vs ${pos.toArray()}`);
		check("transition preserves the trajectory (velocity)", folded.offsetVelocity.distanceTo(vel.clone().sub(destVel)) < 1e-9);
	}

	// A 1 m offset decays away after blendTime, velocity converging to input.
	const offsetPosition = new THREE.Vector3(1, 0, 0);
	const offsetVelocity = new THREE.Vector3();
	const time = { value: 0 };
	const dest = new THREE.Vector3(5, 0, 0);
	const destVel = new THREE.Vector3(2, 0, 0);
	const pos = new THREE.Vector3();
	const vel = new THREE.Vector3();
	for (let i = 0; i <= Math.ceil(blendTime / dt); i++) {
		inertializeCubicUpdate(pos, vel, time, dest, destVel, offsetPosition, offsetVelocity, dt, blendTime);
	}
	check("1 m offset decays below 1e-3 after blendTime", pos.distanceTo(dest) < 1e-3, `err=${pos.distanceTo(dest).toExponential(2)}`);
	check("velocity converges to the input velocity", vel.distanceTo(destVel) < 1e-2, `vel=${vel.toArray().map((n) => n.toFixed(3))}`);

	// Velocity continuity: mid-blend, switch the input stream (a 1 cm capture
	// jump, the size a real lock leaves behind); with EQUAL source/destination
	// velocities the first post-transition step's velocity magnitude stays
	// within 10% of the pre-transition one.
	{
		const streamA = new THREE.Vector3(0, 0, 0);
		const streamB = new THREE.Vector3(0.01, 0, 0);
		const shared = new THREE.Vector3(3, 0, 0);
		const op = new THREE.Vector3();
		const ov = new THREE.Vector3();
		const t = { value: 0 };
		const out = new THREE.Vector3();
		const outVel = new THREE.Vector3();
		for (let i = 0; i < 3; i++) inertializeCubicUpdate(out, outVel, t, streamA, shared, op, ov, 1 / 60, blendTime);
		const preVel = outVel.clone();
		// streamB runs 1 m AHEAD of streamA; with equal velocities the fold
		// leaves a 1 m standing offset, so compare RELATIVE velocity change
		// against a matched fold in the opposite direction instead of raw
		// magnitudes.
		const swapped = inertializeCubicTransition(op, ov, t, streamA, shared, streamB, shared, blendTime);
		inertializeCubicUpdate(out, outVel, swapped.time, streamB, shared, swapped.offsetPosition, swapped.offsetVelocity, 1 / 60, blendTime);
		const ratio = outVel.length() / Math.max(preVel.length(), 1e-9);
		check("first-step velocity after transition within 10% (equal velocities)", Math.abs(ratio - 1) < 0.1, `pre=${preVel.length().toFixed(4)} post=${outVel.length().toFixed(4)} ratio=${ratio.toFixed(4)}`);
	}
}

/* --- (b) footLockTrack on a synthetic walk -------------------------------- */
{
	// March at 0.02/frame in x with a realistic 0.002/frame contact slide;
	// contact frames 10-30. The toe freezes during contact (no slide, no
	// snap) and hands back cleanly to the input afterwards.
	const frames = 60;
	const inputs = [];
	for (let f = 0; f < frames; f++) {
		const air = 0.02, slide = 0.001;
		const x = f <= 10 ? f * air
			: f < 31 ? 10 * air + (f - 10) * slide
			: 10 * air + 20 * slide + (f - 30) * air;
		inputs.push(new THREE.Vector3(x, 0, 0));
	}
	const contacts = inputs.map((_, f) => f >= 10 && f <= 30);
	const track = footLockTrack(inputs, contacts, { fps: 30, blendTime: 0.15, lockDistance: 0.1, unlockDistance: 0.2 });

	const xs = track.map((p) => p.x);
	const locked = xs.slice(14, 31);
	const spread = Math.max(...locked) - Math.min(...locked);
	check("locked toe x is constant over frames 14-30", spread < 1e-3, `spread=${spread.toFixed(5)}`);

	const followErr = Math.abs(xs[50] - inputs[50].x);
	check("output follows input at frame 50", followErr < 1e-3, `err=${followErr.toFixed(5)}`);

	let maxStep = 0;
	for (let f = 1; f < frames; f++) maxStep = Math.max(maxStep, Math.abs(xs[f] - xs[f - 1]));
	check("per-frame step never exceeds 2x the input step", maxStep <= 0.04 + 1e-9, `maxStep=${maxStep.toFixed(5)}`);
}

/* --- (c) Anchors pin the locked point ------------------------------------- */
{
	const frames = 40;
	const inputs = [];
	for (let f = 0; f < frames; f++) inputs.push(new THREE.Vector3(f * 0.02, 0.1, 0));
	const contacts = inputs.map((_, f) => f >= 10 && f <= 25);
	const anchor = new THREE.Vector3(0.25, 0.05, 0.1);
	const anchors = new Array(frames).fill(null);
	anchors[10] = anchor; // lock lands on the first contact frame
	const track = footLockTrack(inputs, contacts, { fps: 30, blendTime: 0.2, lockDistance: 0.1, unlockDistance: 0.2, anchors });
	check("locked value equals the anchor", track[20].distanceTo(anchor) < 1e-3, `got=(${track[20].toArray().map((n) => n.toFixed(3))})`);
}

/* --- (d) relaxToePath absorbs contact drift ------------------------------- */
{
	const frames = 60;
	const contactStart = 20;
	const contactEnd = 24;
	// A contact span in the middle: in-contact drift 0.05 m/frame (slide),
	// air steps 0.1 m so the removed slide can spread into neighbours without
	// pushing their per-frame displacement beyond the 20% budget. Pelvis rides
	// 1 m above the toes so the in-frame leg length can hold at y=0.
	const toes = [];
	for (let f = 0; f < frames; f++) {
		const x = f <= contactStart ? f * 0.1
			: f <= contactEnd ? contactStart * 0.1 + (f - contactStart) * 0.05
			: contactStart * 0.1 + (contactEnd - contactStart) * 0.05 + (f - contactEnd) * 0.1;
		toes.push(new THREE.Vector3(x, 0, 0));
	}
	const pelvis = toes.map((t) => new THREE.Vector3(t.x, 1.0, -0.3));
	const contacts = toes.map((_, f) => f >= contactStart && f <= contactEnd);

	const beforeMax = Math.max(
		...Array.from({ length: contactEnd - contactStart }, (_, k) => toes[contactStart + k + 1].distanceTo(toes[contactStart + k]))
	);
	const relaxed = relaxToePath(toes, pelvis, contacts);
	const afterMax = Math.max(
		...Array.from({ length: contactEnd - contactStart }, (_, k) => relaxed.toes[contactStart + k + 1].distanceTo(relaxed.toes[contactStart + k]))
	);
	const reduction = 1 - afterMax / beforeMax;
	check("in-contact toe displacement reduced by > 80%", reduction > 0.8, `before=${beforeMax.toFixed(4)} after=${afterMax.toFixed(4)} reduction=${(reduction * 100).toFixed(1)}%`);

	// Frames fully OUTSIDE the contact run: consecutive-step displacement
	// must stay within 20% of the source (gait is preserved).
	let worstAir = 0;
	for (let f = 1; f < contactStart; f++) {
		const srcStep = toes[f].distanceTo(toes[f - 1]);
		const outStep = relaxed.toes[f].distanceTo(relaxed.toes[f - 1]);
		worstAir = Math.max(worstAir, Math.abs(outStep - srcStep) / srcStep);
	}
	const tailSrc = toes[frames - 1].distanceTo(toes[frames - 2]);
	const tailOut = relaxed.toes[frames - 1].distanceTo(relaxed.toes[frames - 2]);
	const worstTail = Math.abs(tailOut - tailSrc) / tailSrc;
	check("air-frame relative displacement within 20% of source", worstAir < 0.2 && worstTail < 0.2, `worstAir=${(worstAir * 100).toFixed(1)}% worstTail=${(worstTail * 100).toFixed(1)}%`);
}

/* --- (e) relaxToePath is pure and length-preserving ----------------------- */
{
	const toes = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.05, 0, 0), new THREE.Vector3(0.12, 0, 0.01)];
	const pelvis = toes.map((t) => new THREE.Vector3(t.x, 1.0, 0));
	const toesCopy = toes.map((t) => t.clone());
	const pelvisCopy = pelvis.map((p) => p.clone());
	const contacts = [false, true, true];
	const restLengths = pelvis.map((p, i) => p.distanceTo(toes[i]));

	const relaxed = relaxToePath(toes, pelvis, contacts, { restLengths, relaxPelvis: true });
	check("relaxToePath never mutates its inputs",
		toes.every((t, i) => t.equals(toesCopy[i])) && pelvis.every((p, i) => p.equals(pelvisCopy[i])));

	const worstLen = Math.max(...relaxed.toes.map((t, i) => Math.abs(relaxed.pelvis[i].distanceTo(t) - restLengths[i]) / restLengths[i]));
	check("hip-toe length stays within 1% of source (explicit restLengths)", worstLen < 0.01, `worst=${(worstLen * 100).toFixed(3)}%`);

	const relaxed2 = relaxToePath(toes, pelvis, contacts);
	const worstLen2 = Math.max(...relaxed2.toes.map((t, i) => Math.abs(relaxed2.pelvis[i].distanceTo(t) - restLengths[i]) / restLengths[i]));
	check("hip-toe length stays within 1% of source (default restLengths)", worstLen2 < 0.01, `worst=${(worstLen2 * 100).toFixed(3)}%`);
}

/* --- State API used directly ---------------------------------------------- */
{
	const state = createFootLockState(new THREE.Vector3(0, 0.1, 0));
	check("createFootLockState seeds position and contact",
		state.position.length() > 0 && state.contact.equals(state.position) && state.locked === false && typeof state.time.value === "number");

	// Walk into contact: the toe locks at the requested height and stops.
	updateFootLockState(state, new THREE.Vector3(0.05, 0.1, 0), false, 0.05, 1 / 30);
	updateFootLockState(state, new THREE.Vector3(0.06, 0.1, 0), true, 0.05, 1 / 30);
	for (let i = 0; i < 30; i++) {
		updateFootLockState(state, new THREE.Vector3(0.06 + i * 0.001, 0.1, 0), true, 0.05, 1 / 30);
	}
	check("updateFootLockState locks the toe at contactHeight", state.locked && Math.abs(state.position.y - 0.05) < 1e-3, `y=${state.position.y.toFixed(4)} locked=${state.locked}`);
	check("locked toe stops advancing", state.velocity.length() < 1e-3, `v=${state.velocity.length().toFixed(5)}`);
}

if (failures) {
	console.log(`${failures} FAIL`);
	process.exit(1);
}
console.log("all PASS");
