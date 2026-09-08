#!/usr/bin/env node
import { applySupportRise } from "../../src/ardy/root-drop.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const FRAMES = 20;
const JOINTS = 27;
function take({ rising = true } = {}) {
	const rootPos = new Float32Array(FRAMES * 3);
	const posedJoints = new Float32Array(FRAMES * JOINTS * 3);
	for (let frame = 0; frame < FRAMES; frame += 1) {
		rootPos[frame * 3] = (2 * frame) / (FRAMES - 1);
		rootPos[frame * 3 + 1] = rising && frame >= 8 ? 1 + Math.min((frame - 8) * 0.04, 0.3) : 1;
		for (let joint = 0; joint < JOINTS; joint += 1) {
			posedJoints[(frame * JOINTS + joint) * 3] = rootPos[frame * 3];
			posedJoints[(frame * JOINTS + joint) * 3 + 1] = [21, 22, 25, 26].includes(joint) ? 0.1 : 1;
		}
	}
	return { frames: FRAMES, fps: 10, rootPos, posedJoints };
}

const support = [{ x: 1.1, z: 0, rotDeg: 0, width: 0.8, depth: 1, supportY: 0.3 }];
const source = take();
const raised = applySupportRise(source, support, { subjectX: 0, subjectZ: 0, blendFrames: 3 });
expect("rising entry is detected", raised.surfaceRise?.applied === true, JSON.stringify(raised.surfaceRise));
expect("the source take is not mutated", Math.abs(source.rootPos[10 * 3 + 1] - 1.08) < 1e-5);
expect("frames before the support stay unchanged", raised.rootPos[5 * 3 + 1] === source.rootPos[5 * 3 + 1]);
expect("the body is lifted toward the authored surface", raised.rootPos[10 * 3 + 1] > source.rootPos[10 * 3 + 1]);
expect("lift is smooth at entry", raised.rootPos[8 * 3 + 1] < raised.rootPos[10 * 3 + 1]);
expect("lift releases smoothly after exit", raised.rootPos[13 * 3 + 1] > raised.rootPos[14 * 3 + 1] && raised.rootPos[14 * 3 + 1] > raised.rootPos[15 * 3 + 1]);
expect("all joints receive the same rigid offset", Math.abs((raised.posedJoints[(10 * JOINTS + 21) * 3 + 1] - source.posedJoints[(10 * JOINTS + 21) * 3 + 1]) - (raised.rootPos[10 * 3 + 1] - source.rootPos[10 * 3 + 1])) < 1e-6);

const flat = applySupportRise(take({ rising: false }), support);
expect("a flat walk crossing the footprint is not lifted", flat.surfaceRise === undefined && flat.rootPos[10 * 3 + 1] === 1);
const noDatum = applySupportRise(source, [{ ...support[0], supportY: undefined }]);
expect("a support without an explicit height is ignored", noDatum === source);

if (failures) process.exit(1);
console.log("all surface-rise checks PASS");
