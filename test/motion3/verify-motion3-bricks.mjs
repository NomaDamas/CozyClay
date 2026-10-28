#!/usr/bin/env node
// The MotionBricks converters (src/motion3/bricks) on synthetic poses: forward (SOMA joints -> spec channels) reads a hand-built
// skeleton's heading, root, targets and poles exactly; reverse (compiled X Bot frame -> SOMA pose) puts SOMA's wrists, ankles
// and hip sockets on the X Bot's and keeps every rotation proper, and the round trip gives back the keyed channels.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { apply, ry, add, mul, T } from "../../src/motion3/compiler/math.js";
import { frameChannels, XBOT_HIPMID } from "../../src/motion3/bricks/forward.js";
import { somaPose } from "../../src/motion3/bricks/reverse.js";
import { SOMA_JOINTS, SID, toSomaPoint, toCozyPoint } from "../../src/motion3/bricks/soma.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const near = (a, b, tol) => (Array.isArray(a) ? a.every((v, i) => Math.abs(v - b[i]) <= tol) : Math.abs(a - b) <= tol);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// 1. Forward: a straight standing figure (CozyClay space, facing +Z, left +X), knees bent slightly forward, elbows back,
// feet pointing along the body then turned 30 deg about Y and moved. Toes sit along the planted SOMA foot's angles.
const FLAT_PITCH = 20.8, TOE_OUT = 16.8, rad = d => d * Math.PI / 180;
const toe = (side, ankle) => { const yaw = rad(side * TOE_OUT), l = 0.14, p = rad(FLAT_PITCH); return add(ankle, [Math.sin(yaw) * l * Math.cos(p), -l * Math.sin(p), Math.cos(yaw) * l * Math.cos(p)]); };
const local = {
	Hips: [0, 1.0, 0], Spine1: [0, 1.05, 0], Spine2: [0, 1.12, 0], Chest: [0, 1.2, 0], Neck1: [0, 1.46, 0], Neck2: [0, 1.54, 0], Head: [0, 1.6, 0],
	Jaw: [0, 1.6, 0.03], LeftEye: [0.031, 1.6445, 0.0815], RightEye: [-0.031, 1.6445, 0.0815],
	LeftShoulder: [0.02, 1.43, 0], LeftArm: [0.17, 1.43, 0], LeftForeArm: [0.2, 1.15, -0.05], LeftHand: [0.22, 0.88, 0], LeftHandThumbEnd: [0.22, 0.8, 0.03], LeftHandMiddleEnd: [0.22, 0.75, 0],
	RightShoulder: [-0.02, 1.43, 0], RightArm: [-0.17, 1.43, 0], RightForeArm: [-0.2, 1.15, -0.05], RightHand: [-0.22, 0.88, 0], RightHandThumbEnd: [-0.22, 0.8, 0.03], RightHandMiddleEnd: [-0.22, 0.75, 0],
	LeftLeg: [0.09, 0.9325, -0.016], LeftShin: [0.09, 0.51, 0.03], LeftFoot: [0.09, 0.087, 0], RightLeg: [-0.09, 0.9325, -0.016], RightShin: [-0.09, 0.51, 0.03], RightFoot: [-0.09, 0.087, 0],
};
local.LeftToeBase = toe(1, local.LeftFoot);
local.RightToeBase = toe(-1, local.RightFoot);
const Y = ry(30), move = [0.4, 0, -0.2], place = p => add(apply(Y, p), move);
const P = SOMA_JOINTS.map(n => place(local[n]));
const ch = frameChannels(P);
expect("forward: heading, pitch and roll of the pelvis", near([ch.yaw, ch.pitch, ch.roll], [30, 0, 0], 1e-6), JSON.stringify([ch.yaw, ch.pitch, ch.roll]));
expect("forward: root puts the X Bot hip sockets on SOMA's", near(ch.root, place(add([0, 0.9325, -0.016], XBOT_HIPMID.map(v => -v))), 1e-9), JSON.stringify(ch.root));
expect("forward: a straight spine and head key 0", near([ch.spine_yaw, ch.spine_pitch, ch.spine_roll, ch.head_yaw, ch.head_pitch, ch.head_roll], [0, 0, 0, 0, 0, 0], 1e-6),
	JSON.stringify([ch.spine_yaw, ch.spine_pitch, ch.spine_roll, ch.head_yaw, ch.head_pitch, ch.head_roll]));
expect("forward: ankle and wrist targets are the joints", near(ch.foot_l, P[SID.LeftFoot], 1e-12) && near(ch.hand_r, P[SID.RightHand], 1e-12));
expect("forward: knee poles point forward in the body frame", ch.knee_l[2] > 0.9 && ch.knee_r[2] > 0.9, JSON.stringify([ch.knee_l, ch.knee_r]));
expect("forward: elbow poles point back in the body frame", ch.elbow_l[2] < -0.9 && ch.elbow_r[2] < -0.9, JSON.stringify([ch.elbow_l, ch.elbow_r]));
expect("forward: a flat foot along the body keys fpitch 0 and fyaw = yaw", near([ch.fpitch_l, ch.fpitch_r, ch.fyaw_l, ch.fyaw_r], [0, 0, 30, 30], 0.1),
	JSON.stringify([ch.fpitch_l, ch.fpitch_r, ch.fyaw_l, ch.fyaw_r]));

// 2. Reverse: one compiled X Bot frame (standing, turned 30 deg, hands on IK) as a SOMA pose.
const sk = skeletonFor("x-bot-tpose");
const set = {
	root: [0.4, 1.0, -0.2], yaw: 30, pitch: 5, roll: 0, spine_pitch: 10, head_pitch: -5,
	foot_l: place([0.1, 0.087, 0.05]), foot_r: place([-0.1, 0.087, -0.03]), fyaw_l: 30, fyaw_r: 30, fpitch_l: 0, fpitch_r: 0,
	knee_l: [0.1, 0, 1], knee_r: [-0.1, 0, 1], armw_l: 1, armw_r: 1,
	hand_l: place([0.25, 0.95, 0.12]), hand_r: place([-0.25, 0.9, 0.05]), elbow_l: [0.3, -0.2, -0.9], elbow_r: [-0.3, -0.2, -0.9],
};
const r = compileSpec({ schema: "cozyclay.motion-spec.v1", frames: 1, flow: false, keys: [{ f: 0, set }] }, { sk, scene: motionScene([]) });
const s = r.out.frames[0].s, soma = somaPose(sk, s), X = n => toSomaPoint(s.P[sk.index[n]]);
for (const [a, b] of [["LeftHand", "LeftHand"], ["RightHand", "RightHand"], ["LeftFoot", "LeftFoot"], ["RightFoot", "RightFoot"]])
	expect(`reverse: SOMA ${a} lands on the X Bot's`, dist(soma.P[SID[a]], X(b)) < 1e-3, `${(dist(soma.P[SID[a]], X(b)) * 100).toFixed(2)} cm`);
const hipmid = P => P[SID.LeftLeg].map((v, i) => (v + P[SID.RightLeg][i]) / 2);
expect("reverse: hip-socket midpoint matches", dist(hipmid(soma.P), X("LeftUpLeg").map((v, i) => (v + X("RightUpLeg")[i]) / 2)) < 1e-9);
const proper = soma.R.every(R => { const D = mul(T(R), R); return near(D.flat(), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-9) && near(R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]), 1, 1e-9); });
expect("reverse: every rotation is proper and orthonormal", proper);
const back = frameChannels(soma.P.map(toCozyPoint));
expect("round trip: root, yaw and pitch come back", dist(back.root, set.root) < 0.01 && near(back.yaw, 30, 2) && near(back.pitch, 5, 3),
	JSON.stringify([back.root, back.yaw, back.pitch]));
expect("round trip: ankle and wrist targets come back within 1 cm", ["foot_l", "foot_r", "hand_l", "hand_r"].every(k => dist(back[k], set[k]) < 0.01),
	JSON.stringify(["foot_l", "foot_r", "hand_l", "hand_r"].map(k => (dist(back[k], set[k]) * 100).toFixed(2))));
expect("round trip: feet stay flat and straight within 5 deg", near([back.fpitch_l, back.fpitch_r, back.fyaw_l, back.fyaw_r], [0, 0, 30, 30], 5),
	JSON.stringify([back.fpitch_l, back.fpitch_r, back.fyaw_l, back.fyaw_r]));

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("all passed");
