#!/usr/bin/env node
// #500 todo 4: the tracker gate's pure metrics on synthetic motions.
import assert from "node:assert/strict";
import { hiddenJointError, occlusionAgreement, pelvisStepsDeg, resampleMotion, splineResample, STANCE_FEET, truthStanceSlideCmPerS } from "../tools/track/metrics.mjs";

const J = 27;
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

// pelvisStepsDeg: root yaw 0,5,10,40,45 deg -> steps 5,5,30,5; other joints ignored.
{
	const yaws = [0, 5, 10, 40, 45];
	const rot = new Float32Array(yaws.length * J * 9);
	yaws.forEach((deg, t) => {
		for (let j = 0; j < J; j += 1) rot.set([1, 0, 0, 0, 1, 0, 0, 0, 1], (t * J + j) * 9);
		const a = (deg * Math.PI) / 180;
		rot.set([Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)], t * J * 9);
		if (t % 2) rot.set([0, -1, 0, 1, 0, 0, 0, 0, 1], (t * J + 5) * 9); // a non-root joint flipping 90 deg must not count
	});
	const steps = pelvisStepsDeg(rot, yaws.length);
	assert.equal(steps.length, 4);
	[5, 5, 30, 5].forEach((v, i) => close(steps[i], v, 1e-3, `pelvis step ${i}`));
	assert.equal([...steps].filter((v) => v > 20).length, 1);
	assert.throws(() => pelvisStepsDeg(new Float32Array(10), 3), /do not split/);
}

// splineResample: not-a-knot reproduces a cubic exactly; 3 knots fall back to linear.
{
	const f = (t) => t ** 3 - 2 * t ** 2 + t - 1;
	const times = Array.from({ length: 9 }, (_, i) => i * 0.25);
	const out = splineResample(times, times.map((t) => [f(t), 2 * t]), [0.1, 0.9, 1.33, 2, 3]);
	[0.1, 0.9, 1.33, 2, 2].forEach((q, i) => { close(out[i][0], f(q), 1e-9, `cubic at ${q}`); close(out[i][1], 2 * q, 1e-9, `line at ${q}`); });
	const lin = splineResample([0, 1, 2], [[0], [1], [4]], [0.5, 1.5]);
	close(lin[0][0], 0.5, 1e-12, "linear 0.5"); close(lin[1][0], 2.5, 1e-12, "linear 1.5");
	assert.throws(() => splineResample([0, 0, 1], [[0], [1], [2]], [0]), /increase/);
}

/** A motion whose four foot joints follow footX(t) (x only), other joints at the origin. */
function motion(fps, frames, footX) {
	const posedJoints = new Float64Array(frames * J * 3);
	for (let k = 0; k < frames; k += 1) for (const j of STANCE_FEET) posedJoints[(k * J + j) * 3] = footX(k / fps);
	return { fps, frames, posedJoints };
}

// truthStanceSlideCmPerS: truth feet still for t < 1 s then 1 m/s; prediction slides 3 cm/s
// while the truth stands and 50 cm/s after. Truth at 30 fps, prediction at 24 fps.
{
	const truth = motion(30, 60, (t) => (t < 1 ? 0 : t - 1));
	const pred = motion(24, 48, (t) => (t <= 1 ? 0.03 * t : 0.03 + 0.5 * (t - 1)));
	const r = truthStanceSlideCmPerS(pred, truth);
	close(r.meanCmPerS, 3, 0.5, "slide on truth stance");
	assert.ok(r.stanceSamples >= 4 * 20 && r.stanceSamples <= 4 * 25, `stance samples ${r.stanceSamples}`);
	// The truth measured as a prediction on the 24 fps timeline: still feet -> ~0.
	const self = truthStanceSlideCmPerS(resampleMotion(truth, 24, 48), truth);
	assert.ok(self.meanCmPerS < 0.5, `truth self slide ${self.meanCmPerS}`);
	// A truth that never stands gives no stance samples, reported as null (not 0).
	const moving = motion(30, 60, (t) => t);
	const none = truthStanceSlideCmPerS(pred, moving);
	assert.equal(none.meanCmPerS, null);
	assert.equal(none.stanceSamples, 0);
	// Rigid yaw/translation of the prediction does not change the slide.
	const shifted = { ...pred, posedJoints: pred.posedJoints.map((v, i) => (i % 3 === 2 ? v + 7 : v)) };
	close(truthStanceSlideCmPerS(shifted, truth).meanCmPerS, r.meanCmPerS, 1e-9, "translation invariance");
	assert.throws(() => truthStanceSlideCmPerS({ fps: 24, frames: 3, posedJoints: new Float64Array(7) }, truth), /do not split/);
}

// resampleMotion is the identity on the motion's own timeline.
{
	const m = motion(30, 10, (t) => Math.sin(t));
	const same = resampleMotion(m, 30, 10);
	same.posedJoints.forEach((v, i) => close(v, m.posedJoints[i], 1e-12, `resample identity ${i}`));
}

// occlusionAgreement: confusion counts and shape checks.
{
	const r = occlusionAgreement([[true, false], [false, false]], [[false, true], [true, false]]);
	assert.deepEqual(r, { agreement: 0.75, pairs: 4, truthHidden: 2, flagged: 1, hiddenRecall: 0.5, flaggedPrecision: 1 });
	assert.equal(occlusionAgreement([], []).agreement, null);
	assert.throws(() => occlusionAgreement([[true]], [[true], [true]]), /frames/);
	assert.throws(() => occlusionAgreement([[true, true]], [[true]]), /joints/);
}

// hiddenJointError: only flagged pairs, unaligned world metres.
{
	const truth = [[[0, 0, 0], [1, 1, 1]], [[0, 0, 0], [2, 2, 2]]];
	const pred = [[[3, 4, 0], [9, 9, 9]], [[0, 0, 0], [2, 2, 3]]];
	assert.deepEqual(hiddenJointError(pred, truth, [[true, false], [false, true]]), { meanM: 3, pairs: 2 });
	assert.deepEqual(hiddenJointError(pred, truth, [[false, false], [false, false]]), { meanM: null, pairs: 0 });
	assert.throws(() => hiddenJointError(pred, truth, [[true]]), /frames|joints/);
}

console.log("verify-track-metrics: ok");
