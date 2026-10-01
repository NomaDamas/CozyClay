/** Root-only floor safety for every converted GVHMR take.
 * Measures both shipped character skins with the same playback transforms
 * as Studio. It never runs AutoPhysics, writes IK keys or changes rotations,
 * and it only ever raises frames: it never lowers a take, re-grounds an
 * elevated one, or touches scene placement.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { applyMotionFrame } from "../../src/ardy/playback.js";
import { createSurfaceSampler } from "../../src/ardy/physics-surface.js";

const SITES = [
	{ id: "leftFoot", bone: "LeftFoot", kind: "foot", match: /Left(Foot|Toe)/ },
	{ id: "rightFoot", bone: "RightFoot", kind: "foot", match: /Right(Foot|Toe)/ },
	{ id: "leftHand", bone: "LeftHand", kind: "hand", match: /LeftHand/ },
	{ id: "rightHand", bone: "RightHand", kind: "hand", match: /RightHand/ },
];
function shiftFrame(motion, f, delta) {
	motion.rootPos[f * 3 + 1] += delta;
	for (let j = 0; j < 27; j++) motion.posedJoints[(f * 27 + j) * 3 + 1] += delta;
}
function loadRig(model) {
	const path = ["public", "dist"].map(dir => fileURLToPath(new URL(`../../${dir}/models/${model}.fbx`, import.meta.url))).find(existsSync);
	if (!path) throw new Error(`extract-trajectory-floor-model-missing: ${model}`);
	const bytes = readFileSync(path);
	const rig = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
	rig.scale.setScalar(.01); rig.updateMatrixWorld(true);
	return rig;
}

const CLEARANCE = .002;
const FOOT_JOINTS = [21, 22, 25, 26];
const lowestFootJoint = (motion, f) => Math.min(...FOOT_JOINTS.map(j => motion.posedJoints[(f * 27 + j) * 3 + 1]));

export function guardTrajectoryFloor(motion, events = []) {
	const began = performance.now();
	// Export/retarget grounding uses skeletal foot points, not skin thickness,
	// so every take (ordinary or with an accepted descent) is checked over its
	// whole surface timeline, including the initial standing frames.
	const start = 0;
	const descentStart = events.length ? Math.max(0, Math.min(...events.map(e => e.start))) : null;
	// The skeletal floor is enforced here too, as the last pass before the
	// take ships: stabilization runs between the retarget's grounding and this
	// guard and may move joints.
	const lifts = Float64Array.from({ length: motion.frames }, (_, f) => Math.max(0, -lowestFootJoint(motion, f))), footLifts = lifts.slice();
	const models = ["x-bot-tpose", "y-bot-tpose"];
	const measurements = [];
	for (const model of models) {
		const rig = loadRig(model), sample = createSurfaceSampler(rig, SITES);
		applyMotionFrame(rig, motion, start);
		const y = sample().pelvis.position.y;
		const probe = { ...motion, rootPos: motion.rootPos.slice(), posedJoints: motion.posedJoints.slice() };
		shiftFrame(probe, start, 1); applyMotionFrame(rig, probe, start);
		const scale = sample().pelvis.position.y - y;
		if (!(scale > .5 && scale < 2)) throw new Error("extract-trajectory-floor-invalid-scale");
		const floor = new Float64Array(motion.frames);
		for (let f = start; f < motion.frames; f++) {
			applyMotionFrame(rig, motion, f);
			const sites = sample();
			floor[f] = Math.min(...Object.values(sites).map(p => p.floor));
			lifts[f] = Math.max(lifts[f], (CLEARANCE - floor[f]) / scale, 0);
			const foot = Math.min(...SITES.filter(s => s.kind === "foot").map(s => sites[s.id]?.floor ?? Infinity));
			footLifts[f] = Math.max(footLifts[f], (CLEARANCE - foot) / scale, 0);
		}
		measurements.push({ model, scale, floor });
		// These are private measurement rigs, not cached live user characters.
		rig.traverse(o => { o.geometry?.dispose(); if (Array.isArray(o.material)) o.material.forEach(m => m.dispose()); else o.material?.dispose(); });
	}
	const datum = new Float64Array(motion.frames);
	// An ordinary take is skeletally grounded by its lowest foot joint; the
	// shipped soles sit below those joints by an amount that is a property of
	// the skin, not of the frame. Ground the skins with the same minimum
	// semantics: one rigid lift that brings the lowest foot surface of the
	// take to the clearance on both bodies. A rigid shift keeps jumps and
	// elevated landings exactly; zero when the feet never penetrate, so a
	// hovering take is never pulled down. Hands and body use the residual
	// per-frame safety below.
	const groundingLift = events.length ? 0 : Math.max(0, ...footLifts);
	if (groundingLift > .25) throw new Error("extract-trajectory-floor-correction-too-large");
	datum.fill(groundingLift);
	// A camera-scaled endpoint is not yet calibrated to the target skin.
	// Adjust its landing datum from measured contact clearance, distributing
	// that change over the observed descent instead of abruptly lifting the
	// body at impact. Only raise an endpoint that penetrates; never assume a
	// stationary landing on an elevated object must be lowered to the floor.
	const median = values => { const a = [...values].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
	for (const event of events) {
		if (event.endpointSource !== "observed-plateau") continue;
		const { start: from, landing, anchor } = event;
		const lift = median(lifts.slice(landing, anchor + 1));
		if (lift > .5) throw new Error("extract-trajectory-endpoint-clearance-too-large");
		const firstY = motion.rootPos[from * 3 + 1];
		const lastY = median(Array.from({ length: anchor - landing + 1 }, (_, i) => motion.rootPos[(landing + i) * 3 + 1]));
		for (let f = from; f < motion.frames; f++) {
			const progress = f >= landing ? 1 : Math.max(0, Math.min(1, (firstY - motion.rootPos[f * 3 + 1]) / Math.max(.01, firstY - lastY)));
			datum[f] = Math.max(datum[f], lift * progress);
		}
	}
	const residual = lifts.map((v, f) => Math.max(0, v - datum[f]));
	if (Math.max(...residual) > .25) throw new Error("extract-trajectory-floor-correction-too-large");
	// A conservative smooth upper envelope cannot reintroduce penetration.
	const radius = Math.max(1, Math.round(motion.fps * .1));
	// Once landed, use each pose's actual clearance instead of keeping the
	// median datum as a permanent cushion (which can itself leave a hover).
	const desired = lifts.map((v, f) => Math.max(v, groundingLift));
	for (const event of events) if (event.endpointSource === "observed-plateau") {
		for (let f = event.start; f < event.landing; f++) desired[f] = Math.max(desired[f], datum[f]);
	}
	const safe = desired.slice();
	for (let f = start; f < motion.frames; f++) for (let j = Math.max(start, f - radius); j <= Math.min(motion.frames - 1, f + radius); j++) {
		const t = Math.abs(f - j) / (radius + 1), fade = 1 - t * t * (3 - 2 * t);
		safe[f] = Math.max(safe[f], desired[j] * fade);
	}
	const changed = safe.some(v => v > 0);
	const corrected = changed ? { ...motion, rootPos: motion.rootPos.slice(), posedJoints: motion.posedJoints.slice() } : motion;
	for (let f = start; f < motion.frames; f++) if (safe[f]) shiftFrame(corrected, f, safe[f]);
	const diagnostics = { status: "verified", mode: events.length ? "descent" : "ordinary", start, descentStart,
		changedFrames: [...safe].filter(v => v > 1e-6).length, maxLiftM: Math.max(...safe), groundingLiftM: groundingLift,
		skeletalMinimumAfterM: Math.min(...Array.from({ length: motion.frames }, (_, f) => lowestFootJoint(corrected, f))),
		endpointDatumLiftM: events.length ? Math.max(...datum) : 0, seconds: (performance.now() - began) / 1000,
		models: measurements.map(({ model, scale, floor }) => ({ model,
			minimumBeforeM: Math.min(...floor.slice(start)),
			minimumAfterM: Math.min(...floor.slice(start).map((v, i) => v + safe[start + i] * scale)),
		})), };
	return { motion: corrected, diagnostics };
}
