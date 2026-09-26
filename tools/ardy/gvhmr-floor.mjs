/** Root-only floor safety for an accepted GVHMR descent correction.
 * Measures both shipped character skins with the same playback transforms
 * as Studio. It never runs AutoPhysics, writes IK keys or changes rotations.
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

export function guardTrajectoryFloor(motion, events = []) {
	if (!events.length) return { motion, diagnostics: { status: "not-needed", changedFrames: 0 } };
	const began = performance.now();
	// Export/retarget grounding uses skeletal foot points, not skin thickness.
	// Once this pass owns a corrected take, protect its whole surface timeline
	// (including the initial standing frames), not only the final descent.
	const start = 0;
	const descentStart = Math.max(0, Math.min(...events.map(e => e.start)));
	const lifts = new Float64Array(motion.frames);
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
			floor[f] = Math.min(...Object.values(sample()).map(p => p.floor));
			lifts[f] = Math.max(lifts[f], (0.002 - floor[f]) / scale, 0);
		}
		measurements.push({ model, scale, floor });
		// These are private measurement rigs, not cached live user characters.
		rig.traverse(o => { o.geometry?.dispose(); if (Array.isArray(o.material)) o.material.forEach(m => m.dispose()); else o.material?.dispose(); });
	}
	// A camera-scaled endpoint is not yet calibrated to the target skin.
	// Adjust its landing datum from measured contact clearance, distributing
	// that change over the observed descent instead of abruptly lifting the
	// body at impact. Only raise an endpoint that penetrates; never assume a
	// stationary landing on an elevated object must be lowered to the floor.
	const datum = new Float64Array(motion.frames);
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
	const desired = lifts.slice();
	for (const event of events) if (event.endpointSource === "observed-plateau") {
		for (let f = event.start; f < event.landing; f++) desired[f] = Math.max(desired[f], datum[f]);
	}
	const safe = desired.slice();
	for (let f = start; f < motion.frames; f++) for (let j = Math.max(start, f - radius); j <= Math.min(motion.frames - 1, f + radius); j++) {
		const t = Math.abs(f - j) / (radius + 1), fade = 1 - t * t * (3 - 2 * t);
		safe[f] = Math.max(safe[f], desired[j] * fade);
	}
	const corrected = { ...motion, rootPos: motion.rootPos.slice(), posedJoints: motion.posedJoints.slice() };
	for (let f = start; f < motion.frames; f++) if (safe[f]) shiftFrame(corrected, f, safe[f]);
	const diagnostics = { status: "verified", start, descentStart, changedFrames: [...safe].filter(v => v > 1e-6).length,
		maxLiftM: Math.max(...safe), endpointDatumLiftM: Math.max(...datum), seconds: (performance.now() - began) / 1000,
		models: measurements.map(({ model, scale, floor }) => ({ model,
			minimumBeforeM: Math.min(...floor.slice(start)),
			minimumAfterM: Math.min(...floor.slice(start).map((v, i) => v + safe[start + i] * scale)),
		})), };
	return { motion: corrected, diagnostics };
}
