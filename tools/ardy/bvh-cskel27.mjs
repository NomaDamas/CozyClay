/**
 * bvh-cskel27.mjs — SAM-3D-Body's Mixamo BVH → the exact motion arrays the
 * npz decoder consumes ({ frames, fps, rotMats, rootPos, posedJoints }).
 *
 * Both skeletons rest in the same T-pose convention (Y-up, spine +Y, left
 * arm +X — verified against CSKEL27_NEUTRAL and the BVH template generator),
 * so a BVH world rotation IS the cskel27 global rotation for the matching
 * joint, and each cskel27 local is recovered as parentGlobalᵀ · global.
 * Joints cskel27 has and the BVH does not (Spine3, the Hand ends) borrow the
 * nearest BVH ancestor's world rotation, which makes their local rotation
 * identity — the same "not authored" rule poseToCskel27 applies.
 *
 * Joint positions are re-grown with FK over the CANONICAL cskel27 skeleton:
 * the take must move CozyClay's body, not drag SAM's per-clip bone lengths
 * into the scene. The root trajectory is scaled by the leg-length ratio and
 * floor-shifted so the clip's lowest foot sample touches Y=0.
 */

import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "../../src/ardy/cskel27.js";
import { deriveBoneOffsets, forwardKinematics, globalRotations, matMul, matToQuat, matTranspose, quatToMat } from "../../src/ardy/convert.js";
import { canonicalCskel27Reference } from "../../src/ardy/to-cskel27.js";
import { slerpQuat } from "../../src/ardy/retime.js";

const CM_TO_M = 0.01;

// ---------------------------------------------------------------------------
// EVERY temporal constant in this file is a DURATION, resolved to frames
// against the clip's own fps at runtime. It used to be a mix, and the frame
// counts were a measured bug: SAM extractions arrive at whatever rate the
// footage ran at — the two fixtures are 30 fps, the user's real capture is
// 60 — and a constant written as N FRAMES covers half the time at 60 fps, so
// it filters half as hard exactly where the per-frame input noise is twice as
// dense (foot wobble measured 3.4 cm on the 60 fps take against 0.6 cm on the
// 30 fps fixtures). Before the conversion, feeding this module a 60 fps
// rendering of the SAME motion produced 1.8x the time-normalized ankle jitter
// and 1.7x the knee jerk of the 30 fps one, and dropped grounding 86.6 → 81.4 %.
// Every duration below is written as <30 fps frames>/30 so that 30 fps
// reproduces exactly the numbers each comment was measured at.
// ---------------------------------------------------------------------------

// Stabilization, ported from the proven Blender retarget script the old
// ingest pipeline used (sam3d-retarget-shadow.py):
//  - SPIN: SAM's BVH occasionally winds the root nearly 360° in a few frames
//    when yaw crosses ±180; detected by root angular SPEED (deg/s — as a
//    per-frame threshold the same physical spin reads half as fast at 60 fps
//    and the repair silently stops firing) and bridged with one shortest-path
//    slerp, corrected on EVERY joint so local articulation survives.
//  - TORSO: mild zero-lag three-frame slerp on the trunk only.
//  - LEGS: the same slerp, harder, on both leg chains — see LEG_BLEND.
//  - ARMS: a One-Euro filter instead (#84) — speed-adaptive, so guard-band
//    tremor is cut while punch speed survives; see the ARM_* block.
const SPIN_DEG_PER_S = 25 * 30; // = 25°/frame at 30 fps
const TORSO_BLEND = 0.2;
const TORSO_JOINTS = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"].map((n) => `mixamorig:${n}`);
// The leg chains get the SAME zero-lag 3-frame slerp, at double strength. This
// is the single largest measured lever on foot tremble: SAM estimates the legs
// frame-independently and they are the joints a fixed camera sees worst
// (self-occlusion behind the torso on every guard-up stance), so their
// per-frame rotation noise is what the ankle — and then the whole grounding
// stack downstream — has to fight. On its own it takes ankle accel RMS
// 2.32 → 1.71 cm and toe 2.53 → 1.83 on boxing-offline (2.29 → 1.65 / 2.50 →
// 1.78 on shadow17); take it back out of the finished stack and the ankle
// returns to 2.35. It costs almost nothing in motion: the 95th percentile
// ankle speed falls 318 → 303 cm/s, so the footwork is smoothed, not killed.
// Arms deliberately do NOT get this slerp: a punch is a two-frame
// acceleration into an impact, and blending it with its neighbours is exactly
// what softens the landing the animation exists to show — measured, this
// slerp on the arm chains cuts peak hand speed 802 -> 724 cm/s while leaving
// the guard-band wrist tremor it was meant to fix untouched (1.36 -> 1.36).
// A foot has no such event — it plants and it swings — so the same filter
// costs it nothing. The arms get the speed-adaptive filter below instead.
const LEG_BLEND = 0.4;
const LEG_JOINTS = ["LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"]
	.map((n) => `mixamorig:${n}`);
// ARMS (#84): a One-Euro filter on the arm chains only — an adaptive low-pass
// whose cutoff RISES with angular speed. The neighbour slerp above is the
// wrong tool here: it attenuates by frequency regardless of amplitude, and a
// punch is a two-frame acceleration into contact that shares its band with
// the tremor. One-Euro separates them by SPEED instead: near rest the chain
// is filtered at ARM_MIN_CUTOFF_HZ (SAM's per-frame shoulder/elbow noise is
// what reads as wrist tremble in a guard), while a strike drives the cutoff
// up by ARM_BETA per °/s until the filter passes it essentially untouched.
// Constants are durations/rates (Hz, °/s), so 30 and 60 fps clips filter the
// same amount of TIME — dt enters only through the alpha formula (measured:
// wrist accel per second² lands within 1.20x across a rate doubling, inside
// the legs' 1.35x bar).
// Measured on the fixtures (boxing / shadow17): wrist accel RMS 2.76 -> 2.56
// / 2.69 -> 2.49 cm, the guard-band wrist accel (hands under 1.2 m/s, the
// tremble the complaint is about) 1.36 -> 1.24 / 1.28 -> 1.19, while PEAK
// hand speed keeps 799 of 802 cm/s — against the rejected leg-style slerp's
// 724 with the guard band untouched. Swept: a lower ARM_MIN_CUTOFF_HZ buys
// nothing (a boxer's arms are never still enough for the floor term to bind)
// and a higher ARM_BETA_PER_DEG_S under-filters the guard band; the speed
// cutoff at 5 Hz is what lets the filter snap OPEN on punch onset instead of
// shaving its first frame (1 Hz there cost 25 cm/s of peak).
const ARM_JOINTS = ["LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "RightShoulder", "RightArm", "RightForeArm", "RightHand"]
	.map((n) => `mixamorig:${n}`);
const ARM_MIN_CUTOFF_HZ = 1.5; // rest-tremor low-pass on the arm chain
const ARM_BETA_PER_DEG_S = 0.02; // cutoff gain: +1 Hz per 20 °/s of joint speed
const ARM_SPEED_CUTOFF_HZ = 5.0; // smoothing on the speed estimate the cutoff reads
// Neighbour span of that slerp: ±1 frame at 30 fps. Widening the span instead
// of repeating the pass would be wrong — a stride-2 three-tap filter has unity
// gain at Nyquist, so at 60 fps it would leave the every-other-frame noise
// (the dominant term) completely untouched. Repeating a ±1-frame pass keeps
// the stopband and matches the 30 fps kernel in TIME (see smoothingPasses).
const TORSO_SMOOTH_HALF_S = 1 / 30;
const ROOT_XZ_SMOOTH_HALF_S = 2 / 30; // root translation jitter is camera noise, not gait (5-frame window at 30 fps)
// Grounding: the ground line PINS the SUPPORT sole to zero (the fixed-camera
// scope makes "wherever the planted sole lands" the floor by definition),
// with a jump permit so fast+tall+brief excursions of BOTH feet keep their
// measured air (see 4c). The version this replaces read the floor off the
// merely LOWEST foot, which is the SWING leg most of the time — measured on
// both fixtures that foot is horizontally still on 6–13 % of frames and runs
// 0.7 m/s median — so its per-frame estimation error went straight into body
// height and the hip popped at each of the ~3 support changes per second.
// On top of the line: per-foot contact RUNS with hysteresis, then a 2-bone
// leg IK that pins each planted ankle in XZ. Occlusion errors (a forward bend
// hides the legs and SAM floats or sinks them by ±25 cm) are bridged by XZ
// consistency: a foot that leaves "contact" but reappears at the same spot
// never actually moved, so the gap is pinned too — while a real jump either
// travels or lifts past the bridge ceiling and keeps its air. Whatever still
// ends up under the floor is corrected in the LEG rather than in the body
// (4f), because that is where the error is.
// SUPPORT — is this foot on the floor at all? Deliberately generous: a foot
// that pivots, drags or rocks while it carries weight is still the floor
// witness, and the boxer's slower ankle never drops below 0.43 m/s anyway.
// The three together put at least one foot in support on 82 % of frames; a
// strict reading leaves the ground line nothing to stand on for half the clip.
const SUPPORT_BAND_M = 0.16; // ankle within this of its own rolling low...
const SUPPORT_RISE_MPS = 1.0; // ...not climbing or dropping like a swing leg...
const SUPPORT_MIN_RUN_S = 4 / 30; // ...and holding for at least this long (0.13 s)
// Baseline of the vertical-speed central difference the two gates above read.
// A ±2-FRAME difference measures 0.13 s at 30 fps but 0.07 s at 60, where
// SAM's per-frame estimation noise (ankle accel RMS ~2.4 cm) has not yet
// averaged out — the gate would then be reading noise rather than movement and
// reject planted feet. Per-frame deltas are mostly that noise; this baseline is
// long enough to read the actual movement underneath it.
const SPEED_DIFF_HALF_S = 2 / 30;
// The hand-over. REF_MARGIN_M is what makes the reference sticky: it takes a
// real weight shift to move the floor onto the other foot, not the 3.6 cm
// median disagreement between the two feet's soles. Reference changes fall
// from 3.0/s (reading whichever foot is lowest) to 1.2/s.
const REF_MARGIN_M = 0.05; // the other foot must be in support AND this much lower to take over
const TRANSFER_BLEND_HALF_S = 3 / 30; // hand-over cross-fade (7-frame window at 30 fps), box-smoothed twice → an S-ramp with no corner
const FLOOR_SAG_M = 0.02; // how far the stance line may sit above the lowest sole
// CONTACT — is this foot ALSO nailed to one spot? This gate feeds the XZ foot
// LOCK, which teleports the ankle onto a single point, so it must stay strict:
// widening it to cover footwork (a 14 cm band / 12 cm wander patch) made the
// lock fire on 41 % of frames and drag ankles up to 18 cm — legs visibly
// flying. The ground line does NOT depend on this track (it reads `support`
// above), so strictness here costs nothing but a little residual foot slide.
// Stillness is still judged over the RUN rather than per frame: 1 cm of SAM's
// per-frame XZ noise already reads as 0.3 m/s.
const CONTACT_BAND_M = 0.06; // ankle within this of its own rolling low (two-sided: a below-floor dip is an ERROR, not a contact)
const CONTACT_SETTLE_MPS = 0.6; // ...not dropping or rising like a swing leg...
const CONTACT_WANDER_M = 0.03; // ...and never leaving one patch of floor for the whole run
const CONTACT_MIN_RUN_S = 3 / 30; // shortest accepted contact / bridged flicker gap (0.1 s)
const BRIDGE_MAX_GAP_S = 0.8; // occlusion gaps longer than this are believed instead
const BRIDGE_MAX_XZ_M = 0.12; // the foot must reappear this close to where it left
const BRIDGE_MAX_LIFT_M = 0.25; // ankle lift above this reads as a real jump, never bridged
const LOCK_BLEND_S = 4 / 30; // IK ramp at each contact-run edge (0.13 s)
// A plant that would have to be dragged further than this was never a plant —
// the run passed the wander gate but the lock point still lands far from where
// this frame's ankle actually is (occlusion bridging can extend a run across
// exactly such a stretch). Snapping the leg there is worse than the slide the
// lock exists to remove, so the correction is skipped instead of ramped.
const LOCK_MAX_PULL_M = 0.04;
// Jump permit — the only measured air the foot-pinned ground line believes.
// SAM's depth-drift floats are SLOW (the worst on the boxing clip climb
// ~20 cm over a second-plus); a real hop is FAST and BRIEF. An excursion of
// the lowest sole must clear all three gates to keep its air.
const AIR_EPS_M = 0.05; // candidate air: lowest sole this far above its local floor
const JUMP_MIN_PEAK_M = 0.15; // must peak at least this high...
const JUMP_MIN_RISE_MPS = 0.7; // ...climbing at least this fast...
const JUMP_MAX_AIR_S = 0.9; // ...and land within ballistic time, or it is drift
// Ground-line smoothing: sole jitter must not shake the root. Short on
// purpose — every centimetre the smoothed line drifts off the measured sole is
// a centimetre 4f has to take back out of a leg, and past a few frames that
// correction costs more than the smoothing saves (hip jerk RMS 0.58 cm at a
// 5-frame window, 0.90 at 13). Re-swept: 5 frames was still too long. Roughly
// HALF the floor penetration the 4f guard has to repair was manufactured here
// — on exactly the frames the guard fires, the smoothed line sat +0.61 cm
// above the measured sole — and a 3-frame window beats a 5-frame one on knee
// jerk (3.44 vs 3.68°), grounding (87.2 vs 86.6 %) and hover (1.64 vs 1.86 cm)
// while the hip cost the longer window was bought for is 0.01 cm. In the
// finished stack it matters more than that: with the shaped guard in front of
// it, putting the window back to 5 frames costs 2.1 points of grounding
// (86.2 → 84.1 %) for 0.004 cm of hip.
const PIN_SMOOTH_HALF_S = 1 / 30; // 3-frame window at 30 fps
// The 4f penetration guard's correction is SHAPED over this half-window before
// it is applied. Raw, the guard fired on 228/514 frames (44 %), switching on
// and off 6.8 times a second in bursts of median length 3 frames, and the
// correction's own second difference was 1.10 cm RMS — it fixed the sole and
// injected a per-frame tremble into the leg doing it. ±2 frames at 30 fps is
// the shortest window that spans that median burst.
const GUARD_SHAPE_HALF_S = 2 / 30;
// "Near the floor" is always measured against a LOCAL low, never a global
// constant, because SAM's vertical drift moves the apparent ground by tens of
// cm across a clip. Half a second is long enough to contain a whole step and
// short enough that the drift inside it is small. Already a duration before
// this file's constants were converted; named here so the block is complete.
const LOCAL_LOW_HALF_S = 0.5;

/** Frames covering `seconds` at `fps`, never fewer than `min` — a run length,
 *  a blend ramp or a central-difference baseline of zero frames is not an
 *  algorithm, so a slow clip degrades to the tightest meaningful setting
 *  rather than to a no-op. */
function framesFor(seconds, fps, min = 1) {
	return Math.max(min, Math.round(seconds * fps));
}

/** Odd, centred moving-average window covering ±`halfSeconds` — the smoothers
 *  below all read `Math.floor(window / 2)` on each side, so the window has to
 *  be built from the half-width to stay symmetric at any rate. */
function windowFor(halfSeconds, fps) {
	return 2 * framesFor(halfSeconds, fps) + 1;
}

/** How many passes of the three-frame slerp reproduce ONE pass at 30 fps.
 *  A three-tap smoother's spread grows as sqrt(passes) FRAMES, i.e.
 *  sqrt(passes)/fps seconds, so holding the duration fixed costs
 *  (halfSeconds * fps)² passes — 1 at 30 fps, 4 at 60. */
function smoothingPasses(halfSeconds, fps) {
	return Math.max(1, Math.round((halfSeconds * fps) ** 2));
}

// cskel27 joint -> BVH joint (mixamorig: prefix added at lookup). Identity
// mapping except the joints the BVH does not carry.
const BVH_SOURCE = Object.fromEntries(CSKEL27_JOINTS.map((name) => [name, name]));
BVH_SOURCE.Spine3 = "Spine2";
BVH_SOURCE.LeftHandEnd = "LeftHand";
BVH_SOURCE.RightHandEnd = "RightHand";

/** Minimal BVH reader: hierarchy (names, parents, offsets, channels) and the
 *  motion table. Throws with a named reason on anything malformed. */
export function parseBvh(text) {
	if (typeof text !== "string" || !text.includes("HIERARCHY")) throw new Error("bvh-malformed");
	const tokens = text.slice(text.indexOf("HIERARCHY")).split(/\s+/);
	let cursor = 0;
	const next = () => tokens[cursor++];
	const peek = () => tokens[cursor];
	const joints = [];
	const stack = [];

	if (next() !== "HIERARCHY") throw new Error("bvh-malformed");
	while (cursor < tokens.length) {
		const token = next();
		if (token === "ROOT" || token === "JOINT") {
			const name = next();
			const joint = { name, parent: stack.length ? stack[stack.length - 1] : -1, offset: [0, 0, 0], channels: [] };
			joints.push(joint);
			if (next() !== "{") throw new Error("bvh-malformed");
			stack.push(joints.length - 1);
		} else if (token === "OFFSET") {
			const target = stack[stack.length - 1];
			const offset = [Number(next()), Number(next()), Number(next())];
			if (!offset.every(Number.isFinite)) throw new Error("bvh-malformed");
			if (target !== undefined && joints[target].endPending) joints[target].end = offset;
			else if (target !== undefined) joints[target].offset = offset;
		} else if (token === "CHANNELS") {
			const count = Number(next());
			const channels = [];
			for (let i = 0; i < count; i += 1) channels.push(next());
			joints[stack[stack.length - 1]].channels = channels;
		} else if (token === "End") {
			next(); // "Site"
			if (next() !== "{") throw new Error("bvh-malformed");
			joints[stack[stack.length - 1]].endPending = true;
		} else if (token === "}") {
			const top = stack[stack.length - 1];
			if (top !== undefined && joints[top].endPending) joints[top].endPending = false;
			else stack.pop();
			if (stack.length === 0 && peek() === "MOTION") break;
		} else if (token === "MOTION") {
			break;
		}
	}
	if (next() !== "MOTION" && tokens[cursor - 1] !== "MOTION") {
		// the while-loop may have consumed MOTION already via peek/break
	}
	// Align cursor to just after "MOTION".
	while (tokens[cursor - 1] !== "MOTION") {
		if (cursor >= tokens.length) throw new Error("bvh-malformed");
		cursor += 1;
	}
	if (next() !== "Frames:") throw new Error("bvh-malformed");
	const frames = Number(next());
	if (next() !== "Frame" || next() !== "Time:") throw new Error("bvh-malformed");
	const frameTimeS = Number(next());
	if (!Number.isInteger(frames) || frames < 1 || !(frameTimeS > 0)) throw new Error("bvh-malformed");
	const channelTotal = joints.reduce((sum, joint) => sum + joint.channels.length, 0);
	const values = new Float64Array(frames * channelTotal);
	for (let i = 0; i < values.length; i += 1) {
		const value = Number(next());
		if (!Number.isFinite(value)) throw new Error("bvh-motion-truncated");
		values[i] = value;
	}
	return { joints, frames, frameTimeS, channelTotal, values };
}

function rotX(deg) {
	const r = (deg * Math.PI) / 180;
	const c = Math.cos(r);
	const s = Math.sin(r);
	return [[1, 0, 0], [0, c, -s], [0, s, c]];
}
function rotY(deg) {
	const r = (deg * Math.PI) / 180;
	const c = Math.cos(r);
	const s = Math.sin(r);
	return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}
function rotZ(deg) {
	const r = (deg * Math.PI) / 180;
	const c = Math.cos(r);
	const s = Math.sin(r);
	return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
const ROTATORS = { Xrotation: rotX, Yrotation: rotY, Zrotation: rotZ };

/** Convert a parsed Mixamo BVH into cskel27 motion arrays. */
export function bvhToCskel27Motion(bvh) {
	const { joints, frames, frameTimeS, channelTotal, values } = bvh;
	const bvhIndex = new Map(joints.map((joint, index) => [joint.name, index]));
	const sourceIndex = CSKEL27_JOINTS.map((name) => {
		const source = `mixamorig:${BVH_SOURCE[name]}`;
		if (!bvhIndex.has(source)) throw new Error(`bvh-missing-joint:${source}`);
		return bvhIndex.get(source);
	});
	const channelStart = [];
	let running = 0;
	for (const joint of joints) {
		channelStart.push(running);
		running += joint.channels.length;
	}

	const jointCount = CSKEL27_JOINTS.length;
	const fps = Math.round(1 / frameTimeS);
	// Every duration in the constants block, resolved against THIS clip's rate.
	// Nothing below this line may be written as a frame count.
	const spinDegPerFrame = SPIN_DEG_PER_S / fps;
	const torsoPasses = smoothingPasses(TORSO_SMOOTH_HALF_S, fps);
	const rootXzWindow = windowFor(ROOT_XZ_SMOOTH_HALF_S, fps);
	const supportMinRun = framesFor(SUPPORT_MIN_RUN_S, fps);
	const contactMinRun = framesFor(CONTACT_MIN_RUN_S, fps);
	const speedDiffHalf = framesFor(SPEED_DIFF_HALF_S, fps);
	const transferBlendWindow = windowFor(TRANSFER_BLEND_HALF_S, fps);
	const pinSmoothWindow = windowFor(PIN_SMOOTH_HALF_S, fps);
	const lockBlendFrames = framesFor(LOCK_BLEND_S, fps);
	const guardShapeHalf = framesFor(GUARD_SHAPE_HALF_S, fps);
	const localLowHalf = framesFor(LOCAL_LOW_HALF_S, fps);
	const rotMats = new Float32Array(frames * jointCount * 9);
	const rootPos = new Float32Array(frames * 3);
	const posedJoints = new Float32Array(frames * jointCount * 3);

	const skeleton = canonicalCskel27Reference();
	const offsets = deriveBoneOffsets(skeleton.posed_joints, skeleton.local_rot_mats);

	// Scale the root trajectory to CozyClay's body: SAM writes per-clip bone
	// lengths, and a 92 cm-legged skeleton's hip path on a 88 cm-legged body
	// floats or sinks. Ratio of hip-to-ankle chain lengths, both skeletons.
	const canonicalLeg = chainLength(skeleton.posed_joints, ["LeftUpLeg", "LeftLeg", "LeftFoot"]);
	const bvhLeg =
		(magnitude(joints[bvhIndex.get("mixamorig:LeftLeg")].offset) +
			magnitude(joints[bvhIndex.get("mixamorig:LeftFoot")].offset)) * CM_TO_M;
	const rootScale = bvhLeg > 1e-6 ? canonicalLeg / bvhLeg : 1;

	const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
	const rootChannels = joints[0].channels;

	// Pass 1 — BVH world rotations for every joint on every frame: local
	// eulers composed in listed channel order, chained down the hierarchy.
	const worldsByFrame = new Array(frames);
	for (let f = 0; f < frames; f += 1) {
		const base = f * channelTotal;
		const worlds = new Array(joints.length);
		for (let j = 0; j < joints.length; j += 1) {
			const joint = joints[j];
			let local = IDENTITY;
			const start = base + channelStart[j];
			for (let c = 0; c < joint.channels.length; c += 1) {
				const rotate = ROTATORS[joint.channels[c]];
				if (!rotate) continue; // position channels are read separately
				local = matMul(local, rotate(values[start + c]));
			}
			worlds[j] = joint.parent < 0 ? local : matMul(worlds[joint.parent], local);
		}
		worldsByFrame[f] = worlds;
		// Root position: the position channels, cm → m, scaled.
		const start = base + channelStart[0];
		for (let c = 0; c < rootChannels.length; c += 1) {
			if (rootChannels[c] === "Xposition") rootPos[f * 3] = values[start + c] * CM_TO_M * rootScale;
			else if (rootChannels[c] === "Yposition") rootPos[f * 3 + 1] = values[start + c] * CM_TO_M * rootScale;
			else if (rootChannels[c] === "Zposition") rootPos[f * 3 + 2] = values[start + c] * CM_TO_M * rootScale;
		}
	}
	// Frame-0 root in RAW metres (unscaled, untouched by any later pass):
	// every person extracted from the same clip shares this camera space, so
	// the difference between two takes' rawRootStart is their real-world
	// relative placement in the scene.
	const rawRootStart = [rootPos[0] / rootScale, rootPos[1] / rootScale, rootPos[2] / rootScale];

	// Pass 2 — repair root spins, then stabilize the torso and the legs (see
	// header). The two joint sets are disjoint and each pass snapshots its own
	// input, so the order between them does not change the result.
	repairRootSpins(worldsByFrame, bvhIndex.get("mixamorig:Hips"), spinDegPerFrame);
	const bvhIndices = (names) => names.map((name) => bvhIndex.get(name)).filter((i) => i !== undefined);
	stabilizeChain(worldsByFrame, bvhIndices(TORSO_JOINTS), TORSO_BLEND, torsoPasses);
	stabilizeChain(worldsByFrame, bvhIndices(LEG_JOINTS), LEG_BLEND, torsoPasses);
	oneEuroChain(worldsByFrame, bvhIndices(ARM_JOINTS), fps);

	// The BVH's own sole heights, via FK over ITS skeleton. SAM's offline
	// foot-contact pass already leveled the ground relationship in that
	// space (median lowest sole ≈ 2 cm); re-growing the pose on CozyClay's
	// canonical proportions would shift it (a crouched leg of different
	// thigh/shin ratio lands its foot at a different height), so the raw
	// sole track is carried over as the reference to restore.
	const rawSoleScaled = new Float64Array(frames);
	{
		const soleJoints = ["LeftFoot", "RightFoot", "LeftToeBase", "RightToeBase"]
			.map((name) => bvhIndex.get(`mixamorig:${name}`))
			.filter((index) => index !== undefined);
		const positions = new Array(joints.length);
		for (let f = 0; f < frames; f += 1) {
			const worlds = worldsByFrame[f];
			positions[0] = [rootPos[f * 3] / (CM_TO_M * rootScale), rootPos[f * 3 + 1] / (CM_TO_M * rootScale), rootPos[f * 3 + 2] / (CM_TO_M * rootScale)];
			for (let j = 1; j < joints.length; j += 1) {
				const parent = joints[j].parent;
				const rotated = matVec3(worlds[parent], joints[j].offset);
				positions[j] = [
					positions[parent][0] + rotated[0],
					positions[parent][1] + rotated[1],
					positions[parent][2] + rotated[2],
				];
			}
			let low = Infinity;
			for (const j of soleJoints) low = Math.min(low, positions[j][1]);
			rawSoleScaled[f] = low * CM_TO_M * rootScale;
		}
	}

	// Root translation: camera-space jitter is noise, not gait — X/Z ride a
	// short centred average.
	smoothTrack(rootPos, frames, 0, rootXzWindow);
	smoothTrack(rootPos, frames, 2, rootXzWindow);

	// Pass 3 — cskel27 locals: parentGlobalᵀ · global along the cskel27 chain.
	for (let f = 0; f < frames; f += 1) {
		const worlds = worldsByFrame[f];
		for (let j = 0; j < jointCount; j += 1) {
			const global = worlds[sourceIndex[j]];
			const parent = CSKEL27_PARENTS[j];
			const local = parent === null ? global : matMul(matTranspose(worlds[sourceIndex[parent]]), global);
			const o = (f * jointCount + j) * 9;
			rotMats[o] = local[0][0]; rotMats[o + 1] = local[0][1]; rotMats[o + 2] = local[0][2];
			rotMats[o + 3] = local[1][0]; rotMats[o + 4] = local[1][1]; rotMats[o + 5] = local[1][2];
			rotMats[o + 6] = local[2][0]; rotMats[o + 7] = local[2][1]; rotMats[o + 8] = local[2][2];
		}
	}

	// Pass 4 — grounding and foot lock (see the constants block), then one
	// global shift so the lowest contact sits exactly on Y=0.
	const readLocals = (f) => {
		const frameLocals = new Array(jointCount);
		for (let j = 0; j < jointCount; j += 1) {
			const o = (f * jointCount + j) * 9;
			frameLocals[j] = [
				[rotMats[o], rotMats[o + 1], rotMats[o + 2]],
				[rotMats[o + 3], rotMats[o + 4], rotMats[o + 5]],
				[rotMats[o + 6], rotMats[o + 7], rotMats[o + 8]],
			];
		}
		return frameLocals;
	};
	const rootAt = (f) => [rootPos[f * 3], rootPos[f * 3 + 1], rootPos[f * 3 + 2]];
	const writeLocal = (f, j, m) => {
		const o = (f * jointCount + j) * 9;
		rotMats[o] = m[0][0]; rotMats[o + 1] = m[0][1]; rotMats[o + 2] = m[0][2];
		rotMats[o + 3] = m[1][0]; rotMats[o + 4] = m[1][1]; rotMats[o + 5] = m[1][2];
		rotMats[o + 6] = m[2][0]; rotMats[o + 7] = m[2][1]; rotMats[o + 8] = m[2][2];
	};
	const J = (name) => CSKEL27_JOINTS.indexOf(name);
	const feet = ["LeftToeBase", "RightToeBase", "LeftFoot", "RightFoot"].map(J);
	const legs = [
		{ hip: J("LeftUpLeg"), knee: J("LeftLeg"), ankle: J("LeftFoot") },
		{ hip: J("RightUpLeg"), knee: J("RightLeg"), ankle: J("RightFoot") },
	];
	const hipsIdx = J("Hips");

	// 4a) ankle and sole tracks from a first FK sweep — and the proportion
	// correction: with the SAME joint angles, a crouched leg of different
	// thigh/shin ratio lands its sole at a different height, which reads as
	// a constant hover on a fighter who never fully straightens. The root is
	// re-seated per frame so the canonical body's lowest sole reproduces the
	// (scaled) sole height SAM's own leveled skeleton had.
	const toes = [J("LeftToeBase"), J("RightToeBase")];
	const ankle = [new Float64Array(frames * 3), new Float64Array(frames * 3)];
	const kneeY = [new Float64Array(frames), new Float64Array(frames)];
	const lowestSole = new Float64Array(frames * 2);
	for (let f = 0; f < frames; f += 1) {
		let positions = forwardKinematics(readLocals(f), offsets, rootAt(f));
		const canonSole = Math.min(
			positions[legs[0].ankle][1], positions[toes[0]][1],
			positions[legs[1].ankle][1], positions[toes[1]][1]
		);
		const reseat = rawSoleScaled[f] - canonSole;
		if (Math.abs(reseat) > 1e-9) {
			rootPos[f * 3 + 1] += reseat;
			positions = forwardKinematics(readLocals(f), offsets, rootAt(f));
		}
		for (let s = 0; s < 2; s += 1) {
			ankle[s][f * 3] = positions[legs[s].ankle][0];
			ankle[s][f * 3 + 1] = positions[legs[s].ankle][1];
			ankle[s][f * 3 + 2] = positions[legs[s].ankle][2];
			kneeY[s][f] = positions[legs[s].knee][1];
			lowestSole[f * 2 + s] = Math.min(positions[legs[s].ankle][1], positions[toes[s]][1]);
		}
	}

	// 4b) per-foot stance evidence, in two nested strengths, because the two
	// consumers want different things. Both are measured against that foot's
	// LOCAL low, not a global constant: SAM's vertical drift moves the apparent
	// ground by tens of cm across a clip, so "near the floor" can only mean
	// "near where this foot bottoms out around now".
	//  - SUPPORT (4c, the ground line) only has to know which foot is ON the
	//    floor. A boxer's lead foot pivots and drags while it carries his
	//    weight; it is still the floor witness, so support does NOT gate on
	//    horizontal speed — only on being low and vertically settled.
	//  - CONTACT (4e, the XZ foot lock) additionally needs the foot to STAY in
	//    one place, since the lock nails it there. That is judged over the RUN
	//    (see splitByXzWander), not per frame: 1 cm of SAM's per-frame XZ noise
	//    already reads as 0.3 m/s over a ±2-frame baseline, so an instantaneous
	//    speed gate tight enough to reject a real step also rejects every
	//    jittery-but-planted foot — which is exactly how the old single
	//    detector ended up firing on 4 % of foot-frames, leaving both the
	//    ground line and the lock with nothing to hold on to.
	const support = [new Array(frames).fill(false), new Array(frames).fill(false)];
	const realContact = [new Array(frames).fill(false), new Array(frames).fill(false)];
	const lockContact = [new Array(frames).fill(false), new Array(frames).fill(false)];
	const settleLimit = CONTACT_SETTLE_MPS / fps;
	const riseLimit = SUPPORT_RISE_MPS / fps;
	const lowHalf = localLowHalf;
	for (let s = 0; s < 2; s += 1) {
		for (let f = 0; f < frames; f += 1) {
			// Central difference over SPEED_DIFF_HALF_S (±2 frames at 30 fps):
			// per-frame deltas are mostly estimation noise (ankle accel RMS
			// ~2.4 cm), a 0.13 s baseline reads the actual movement underneath
			// it. The result is a per-FRAME delta, which is what riseLimit and
			// settleLimit are (m/s ÷ fps), so both sides scale together.
			const before = Math.max(0, f - speedDiffHalf);
			const after = Math.min(frames - 1, f + speedDiffHalf);
			const span = Math.max(1, after - before);
			const dy = (ankle[s][after * 3 + 1] - ankle[s][before * 3 + 1]) / span;
			let localLow = Infinity;
			for (let k = Math.max(0, f - lowHalf); k <= Math.min(frames - 1, f + lowHalf); k += 1) {
				localLow = Math.min(localLow, ankle[s][k * 3 + 1]);
			}
			const above = ankle[s][f * 3 + 1] - localLow;
			const belowKnee = ankle[s][f * 3 + 1] < kneeY[s][f] - 0.05;
			support[s][f] = above < SUPPORT_BAND_M && Math.abs(dy) < riseLimit && belowKnee;
			realContact[s][f] = above < CONTACT_BAND_M && Math.abs(dy) < settleLimit && belowKnee;
		}
		// Run cleaning IS the hysteresis: below supportMinRun neither a
		// flicker of evidence starts a stance nor a flicker of noise ends one,
		// so the ground reference cannot chatter between feet frame by frame.
		cleanRuns(support[s], supportMinRun);
		cleanRuns(realContact[s], contactMinRun);
		// ...then the lockable half of the evidence: keep only the stretches
		// the ankle spends inside one CONTACT_WANDER_M patch of floor. This is
		// what separates "planted, estimated noisily" from "stepping".
		splitByXzWander(realContact[s], ankle[s], CONTACT_WANDER_M, contactMinRun);
	}

	// 4c) the measured ground line: STANCE PINNING with a jump permit. The
	// scope is fixed-camera footage, so wherever a planted sole lands IS the
	// ground — pinning it to zero kills SAM's vertical drift outright. (The
	// rolling-quantile line two revisions back still floated up to 23 cm
	// whenever a window went majority-dip.) What the floor is read FROM is the
	// SUPPORT foot, not whichever foot is lowest: measured on both fixtures
	// the lowest foot is horizontally still on 6–13 % of frames and runs
	// 0.7 m/s median — it is usually the SWING leg, so every swing-leg
	// estimation error went straight into body height and the hip popped ~1 cm
	// (5.5 cm worst) at each of the ~3 support changes per second.
	// The only measured air that survives is a PERMITTED jump: a fast, tall,
	// brief excursion of the lowest sole above its local floor — the three
	// gates that separate a real hop from a slow depth-drift float or a
	// bend-occlusion lift. Over permitted air the ground interpolates takeoff
	// level → landing level, so the arc keeps its measured height.
	const soleAt = new Float64Array(frames); // physical lowest sole: jump gates and the sag clamp
	const soleSide = [new Float64Array(frames), new Float64Array(frames)];
	for (let f = 0; f < frames; f += 1) {
		soleSide[0][f] = lowestSole[f * 2];
		soleSide[1][f] = lowestSole[f * 2 + 1];
		soleAt[f] = Math.min(soleSide[0][f], soleSide[1][f]);
	}
	const airHalf = localLowHalf;
	const localFloor = new Float64Array(frames);
	for (let f = 0; f < frames; f += 1) {
		let low = Infinity;
		for (let k = Math.max(0, f - airHalf); k <= Math.min(frames - 1, f + airHalf); k += 1) low = Math.min(low, soleAt[k]);
		localFloor[f] = low;
	}
	const airborne = new Array(frames).fill(false);
	const candidate = new Array(frames).fill(false);
	for (let f = 0; f < frames; f += 1) candidate[f] = soleAt[f] - localFloor[f] > AIR_EPS_M;
	const maxAirFrames = Math.round(JUMP_MAX_AIR_S * fps);
	const airRuns = [];
	for (const run of contactRuns(candidate)) {
		let peak = 0;
		let rise = 0;
		for (let f = run.start; f <= run.end; f += 1) {
			peak = Math.max(peak, soleAt[f] - localFloor[f]);
			// The takeoff-speed gate reads the same SPEED_DIFF_HALF_S baseline
			// as the stance gates: over ±1 frame at 60 fps a real hop and a
			// noisy plant are indistinguishable.
			const before = Math.max(0, f - speedDiffHalf);
			const after = Math.min(frames - 1, f + speedDiffHalf);
			rise = Math.max(rise, ((soleAt[after] - soleAt[before]) / Math.max(1, after - before)) * fps);
		}
		if (peak >= JUMP_MIN_PEAK_M && rise >= JUMP_MIN_RISE_MPS && run.end - run.start + 1 <= maxAirFrames) {
			for (let f = run.start; f <= run.end; f += 1) airborne[f] = true;
			airRuns.push({ ...run, peak });
		}
	}
	// Which foot the floor is read from, frame by frame — a STICKY choice, so
	// that a stance the detector reports on both feet (double support runs 53 %
	// of this footage) does not hand the reference back and forth on whichever
	// sole the estimator happened to place a millimetre lower this frame. The
	// reference moves only when the foot holding it loses support outright, or
	// when the other foot is both in support and REF_MARGIN_M lower — a real
	// weight shift. With no evidence on either foot (flight, or footwork the
	// detector missed) the last reference is simply held; the jump permit below
	// owns those stretches.
	const refSide = new Int8Array(frames);
	{
		let side = soleSide[0][0] <= soleSide[1][0] ? 0 : 1;
		for (let f = 0; f < frames; f += 1) {
			const other = 1 - side;
			if (support[other][f] && (!support[side][f] || soleSide[other][f] < soleSide[side][f] - REF_MARGIN_M)) side = other;
			refSide[f] = side;
		}
	}
	// A support TRANSFER must never step. The two soles disagree by 3.6 cm
	// median — estimation error, not a floor that moved — so switching source
	// instantly dumps that whole gap into one frame of body height. Cross-fade
	// the two sole tracks instead: the 0/1 side track box-smoothed TWICE, so
	// the hand-over is an S-ramp with no corner at either end of it.
	const rightShare = new Float64Array(frames);
	for (let f = 0; f < frames; f += 1) rightShare[f] = refSide[f];
	smoothArray(rightShare, transferBlendWindow);
	smoothArray(rightShare, transferBlendWindow);
	const ground = new Float64Array(frames);
	for (let f = 0; f < frames; f += 1) {
		ground[f] = soleSide[0][f] * (1 - rightShare[f]) + soleSide[1][f] * rightShare[f];
	}
	// Permitted air: the floor does not move while nobody is standing on it,
	// so the line interpolates takeoff → landing and the hop keeps its arc.
	for (const run of contactRuns(airborne)) {
		const i0 = run.start - 1;
		const i1 = run.end + 1;
		const y0 = i0 >= 0 ? ground[i0] : i1 < frames ? ground[i1] : localFloor[run.start];
		const y1 = i1 < frames ? ground[i1] : y0;
		for (let f = run.start; f <= run.end; f += 1) {
			ground[f] = y0 + ((y1 - y0) * (f - i0)) / (i1 - i0);
		}
	}
	// Sag clamp: the stance line may sit at most FLOOR_SAG_M above the lowest
	// sole. Without it a foot the detector calls "swinging" while it is in
	// fact a few cm below the support foot would be driven under Y=0, and 4f's
	// per-frame penetration guard would hoist that single frame — trading the
	// pop we are removing for an identical one. Above permitted air the clamp
	// is inert (the soles are far above the line by construction).
	for (let f = 0; f < frames; f += 1) ground[f] = Math.min(ground[f], soleAt[f] + FLOOR_SAG_M);
	smoothArray(ground, pinSmoothWindow);

	if (process.env.BVH_GROUND_DEBUG) {
		const pctOf = (n) => `${((n / frames) * 100).toFixed(0)}%`;
		const trueCount = (track) => track.filter(Boolean).length;
		let either = 0;
		let switches = 0;
		for (let f = 0; f < frames; f += 1) {
			if (support[0][f] || support[1][f]) either += 1;
			if (f > 0 && refSide[f] !== refSide[f - 1]) switches += 1;
		}
		const contacts = trueCount(realContact[0]) + trueCount(realContact[1]);
		const jumps = airRuns.map((r) => `f${r.start}..${r.end}@${(r.peak * 100).toFixed(0)}cm`).join(" ") || "none";
		console.error(`[stance] support L=${pctOf(trueCount(support[0]))} R=${pctOf(trueCount(support[1]))} either=${pctOf(either)}; lockable contact ${contacts}/${frames * 2} (${((contacts / (frames * 2)) * 100).toFixed(0)}%); reference hand-overs ${switches} (${(switches / (frames / fps)).toFixed(1)}/s)`);
		console.error(`[ground] range=[${Math.min(...ground).toFixed(2)}..${Math.max(...ground).toFixed(2)}] jumps: ${jumps}`);
	}

	// 4d) level the root by subtracting the ground line.
	for (let f = 0; f < frames; f += 1) {
		rootPos[f * 3 + 1] -= ground[f];
		ankle[0][f * 3 + 1] -= ground[f];
		ankle[1][f * 3 + 1] -= ground[f];
	}
	const anchors = realContact[0].filter(Boolean).length + realContact[1].filter(Boolean).length;

	// XZ bridging runs in LEVELED space, where the planted-ankle level is a
	// constant again (the median over real contacts).
	const leveledPlant = [];
	for (let s = 0; s < 2; s += 1) {
		for (let f = 0; f < frames; f += 1) if (realContact[s][f]) leveledPlant.push(ankle[s][f * 3 + 1]);
	}
	leveledPlant.sort((a, b) => a - b);
	const plantY = leveledPlant[Math.floor(leveledPlant.length / 2)] ?? 0;
	for (let s = 0; s < 2; s += 1) {
		for (let f = 0; f < frames; f += 1) lockContact[s][f] = realContact[s][f];
		bridgeOcclusionGaps(lockContact[s], ankle[s], plantY, fps);
	}

	// How far the lock actually dragged an ankle sideways, the metric that
	// separates "removed a slide" from "threw the leg across the floor".
	let lockPullMax = 0;
	// 4e) foot lock: hold each contact run's ankle at its median planted spot
	// via 2-bone leg IK, ramped over the run edges. Positions are re-read
	// after leveling so the lock lives in the leveled space.
	if (anchors > 0) {
		for (let f = 0; f < frames; f += 1) {
			const positions = forwardKinematics(readLocals(f), offsets, rootAt(f));
			for (let s = 0; s < 2; s += 1) {
				ankle[s][f * 3] = positions[legs[s].ankle][0];
				ankle[s][f * 3 + 1] = positions[legs[s].ankle][1];
				ankle[s][f * 3 + 2] = positions[legs[s].ankle][2];
			}
		}
		for (let s = 0; s < 2; s += 1) {
			for (const run of contactRuns(lockContact[s])) {
				const lock = runLockPoint(run, realContact[s], ankle[s]);
				if (!lock) continue;
				for (let f = run.start; f <= run.end; f += 1) {
					const edge = Math.min(f - run.start + 1, run.end - f + 1);
					const weight = Math.min(1, edge / (lockBlendFrames + 1));
					const locals = readLocals(f);
					const worlds = globalRotations(locals);
					const positions = forwardKinematics(locals, offsets, rootAt(f));
					const current = positions[legs[s].ankle];
					const pull = Math.hypot(lock[0] - current[0], lock[2] - current[2]);
					if (pull > LOCK_MAX_PULL_M) continue;
					lockPullMax = Math.max(lockPullMax, pull * weight);
					const target = [
						current[0] + (lock[0] - current[0]) * weight,
						current[1] + (lock[1] - current[1]) * weight,
						current[2] + (lock[2] - current[2]) * weight,
					];
					const solved = solveLegIk(positions, worlds, legs[s], hipsIdx, target);
					if (!solved) continue;
					writeLocal(f, legs[s].hip, solved.hipLocal);
					writeLocal(f, legs[s].knee, solved.kneeLocal);
					writeLocal(f, legs[s].ankle, solved.ankleLocal);
				}
			}
		}
	}

	// 4f) final FK, then the vertical placement. The reference is a robust
	// touch level (the 10th percentile of per-frame lowest soles) — NOT the
	// clip's global minimum: one residual estimation dip below the floor
	// would otherwise hoist the entire clip by its depth. What still pokes
	// through afterwards is caught by a one-sided guard (lifting a sunken
	// frame never squashes a jump; only chasing feet upward does).
	const lowestAt = new Float64Array(frames);
	for (let f = 0; f < frames; f += 1) {
		const positions = forwardKinematics(readLocals(f), offsets, rootAt(f));
		for (let j = 0; j < jointCount; j += 1) {
			const p = (f * jointCount + j) * 3;
			posedJoints[p] = positions[j][0];
			posedJoints[p + 1] = positions[j][1];
			posedJoints[p + 2] = positions[j][2];
		}
		let low = Infinity;
		for (const j of feet) low = Math.min(low, posedJoints[(f * jointCount + j) * 3 + 1]);
		lowestAt[f] = low;
	}
	// The ground line already brought touch-downs to ≈0; the last shift only
	// centres the touch CLUSTER on zero. A low percentile would land just
	// above the residual error dips instead and hoist the clip by their
	// depth — the exact 7 cm hover this replaced.
	const touchValues = [...lowestAt].filter((value) => value < 0.05).sort((a, b) => a - b);
	const sortedLowest = [...lowestAt].sort((a, b) => a - b);
	const shift = touchValues.length > frames * 0.05
		? touchValues[Math.floor(touchValues.length / 2)]
		: sortedLowest[Math.floor(sortedLowest.length * 0.1)] ?? 0;
	if (Number.isFinite(shift) && Math.abs(shift) > 1e-6) {
		for (let f = 0; f < frames; f += 1) {
			rootPos[f * 3 + 1] -= shift;
			lowestAt[f] -= shift;
			for (let j = 0; j < jointCount; j += 1) posedJoints[(f * jointCount + j) * 3 + 1] -= shift;
		}
	}
	// A sole under the floor is a LEG error, not a body error: the ground line
	// stands on the SUPPORT foot, so what pokes through is the other leg's
	// per-frame estimate. Hoisting the whole body for it — the only thing this
	// guard used to do — wrote every one of those errors into hip height, on
	// 44 % of frames, 1.8 cm mean and 6 cm worst, and that rectified track was
	// measurably the largest single source of hip jitter in the take (hip jerk
	// RMS fell from 1.17 to 0.80 cm with the guard simply switched off).
	// So: lift the offending FOOT with the same 2-bone leg IK, where the error
	// actually is, and the hips never feel it. The body lift stays underneath
	// as the backstop for whatever the leg cannot reach — a leg already
	// straight has nowhere left to go — so nothing ever ends up below Y=0.
	//
	// The correction is SHAPED in time before it is applied, per leg. Raw, it
	// is a per-frame quantity computed from a per-frame estimate: it fired on
	// 44 % of frames in bursts of median length 3, switching on and off 6.8
	// times a second, and its own second difference was 1.10 cm RMS — so while
	// it fixed the sole it wrote that tremble straight into the knee. Shaping:
	//   deficit → running MAX over ±guardShapeHalf → moving average over the
	//   same half-window.
	// The DILATION BEFORE THE BLUR is what makes this safe: after the max,
	// every sample the average sees within ±guardShapeHalf of frame f is
	// already ≥ the raw deficit at f, so their mean is too — the smoothed
	// correction is pointwise ≥ the raw deficit everywhere and no floor
	// penetration can be reintroduced by the smoothing, which is the only
	// reason it is allowed to touch this correction at all. (Blurring the raw
	// deficit alone would halve the correction at the tip of every spike,
	// which is exactly where the sole is deepest under the floor.)
	// What this buys is measured in the leg's ANGLES, which is where the raw
	// guard's damage was: knee angle jerk 3.04 → 2.63°/frame² and the worst
	// single-frame knee change 16.2 → 14.5° on boxing-offline. The ankle's own
	// accel barely moves (1.70 → 1.72 cm) — the guard was never displacing the
	// foot much, it was chattering the joints that carry it. The cost is that
	// frames NEAR a penetration are lifted slightly above the floor: grounding
	// 87.2 → 86.2 %, which is most of why PIN_SMOOTH_HALF_S was re-swept.
	const legLift = { frames: 0, sum: 0, max: 0 };
	const bodyLift = { frames: 0, sum: 0, max: 0 };
	const soleOfLeg = (f, s) => Math.min(
		posedJoints[(f * jointCount + legs[s].ankle) * 3 + 1],
		posedJoints[(f * jointCount + toes[s]) * 3 + 1]
	);
	const correction = [0, 1].map((s) => {
		const deficit = new Float64Array(frames);
		for (let f = 0; f < frames; f += 1) deficit[f] = Math.max(0, -soleOfLeg(f, s));
		return shapeFloorCorrection(deficit, guardShapeHalf);
	});
	for (let f = 0; f < frames; f += 1) {
		let lifted = false;
		for (let s = 0; s < 2; s += 1) {
			const lift = correction[s][f];
			if (lift <= 1e-6) continue;
			const locals = readLocals(f);
			const positions = forwardKinematics(locals, offsets, rootAt(f));
			const current = positions[legs[s].ankle];
			const solved = solveLegIk(positions, globalRotations(locals), legs[s], hipsIdx, [current[0], current[1] + lift, current[2]]);
			if (!solved) continue;
			writeLocal(f, legs[s].hip, solved.hipLocal);
			writeLocal(f, legs[s].knee, solved.kneeLocal);
			writeLocal(f, legs[s].ankle, solved.ankleLocal);
			lifted = true;
			legLift.sum += lift;
			legLift.max = Math.max(legLift.max, lift);
		}
		if (lifted) {
			legLift.frames += 1;
			const positions = forwardKinematics(readLocals(f), offsets, rootAt(f));
			let low = Infinity;
			for (let j = 0; j < jointCount; j += 1) {
				const p = (f * jointCount + j) * 3;
				posedJoints[p] = positions[j][0];
				posedJoints[p + 1] = positions[j][1];
				posedJoints[p + 2] = positions[j][2];
			}
			for (const j of feet) low = Math.min(low, posedJoints[(f * jointCount + j) * 3 + 1]);
			lowestAt[f] = low;
		}
		const residual = -lowestAt[f];
		if (residual <= 1e-6) continue;
		bodyLift.frames += 1;
		bodyLift.sum += residual;
		bodyLift.max = Math.max(bodyLift.max, residual);
		rootPos[f * 3 + 1] += residual;
		lowestAt[f] += residual;
		for (let j = 0; j < jointCount; j += 1) posedJoints[(f * jointCount + j) * 3 + 1] += residual;
	}
	if (process.env.BVH_GROUND_DEBUG) {
		const report = (label, lift) =>
			`${label} ${lift.frames}/${frames} (${((lift.frames / frames) * 100).toFixed(0)}%) mean ${((lift.sum / Math.max(1, lift.frames)) * 100).toFixed(2)}cm max ${(lift.max * 100).toFixed(2)}cm`;
		console.error(`[guard] ${report("leg lifts", legLift)}; ${report("body lifts", bodyLift)}`);
	}

	// How large the FILMED person is relative to CozyClay's canonical body
	// (leg-chain ratio). The take itself stays canonical; the app may scale
	// the rendered character by this so the performer's real stature reads.
	const personScale = rootScale > 1e-6 ? 1 / rootScale : 1;

	return { frames, fps, rotMats, rootPos, posedJoints, personScale, rawRootStart, lockPullMax };
}

/** Angle in degrees between two rotation matrices, via the quat dot. */
function angleBetweenDeg(a, b) {
	const qa = matToQuat(a);
	const qb = matToQuat(b);
	const dot = Math.min(1, Math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]));
	return (2 * Math.acos(dot) * 180) / Math.PI;
}

/** Bridge intervals where the root spins impossibly fast with one shortest
 *  path between the sound frames on either side, applying the correction to
 *  EVERY joint so local articulation is preserved (the old retarget script's
 *  repair, generalized from its hand-measured frame range). */
function repairRootSpins(worldsByFrame, hipsIndex, degPerFrame) {
	const frames = worldsByFrame.length;
	if (hipsIndex === undefined || frames < 3) return;
	const fast = new Array(frames).fill(false);
	for (let f = 1; f < frames; f += 1) {
		fast[f] = angleBetweenDeg(worldsByFrame[f - 1][hipsIndex], worldsByFrame[f][hipsIndex]) > degPerFrame;
	}
	let f = 1;
	while (f < frames) {
		if (!fast[f]) {
			f += 1;
			continue;
		}
		let end = f;
		while (end + 1 < frames && fast[end + 1]) end += 1;
		const before = f - 1;
		const after = end + 1;
		if (before >= 0 && after < frames) {
			const qa = matToQuat(worldsByFrame[before][hipsIndex]);
			const qb = matToQuat(worldsByFrame[after][hipsIndex]);
			for (let inner = f; inner <= end; inner += 1) {
				const repaired = quatToMat(slerpQuat(qa, qb, (inner - before) / (after - before)));
				const correction = matMul(repaired, matTranspose(worldsByFrame[inner][hipsIndex]));
				const worlds = worldsByFrame[inner];
				for (let j = 0; j < worlds.length; j += 1) worlds[j] = matMul(correction, worlds[j]);
			}
		}
		f = end + 1;
	}
}

/** Zero-lag three-frame stabilization: each world rotation on the chain slides
 *  `blend` of the way toward its immediate neighbours' midpoint, `passes`
 *  times. Used on the torso (0.2) and both legs (0.4); the ARMS are never
 *  passed in — see LEG_BLEND for why the same filter that costs a foot nothing
 *  would blunt a punch. The neighbour span stays ±1 frame at every rate and
 *  the DURATION is carried by the pass count, because a stride-N three-tap
 *  filter passes Nyquist untouched (LEG/TORSO_SMOOTH_HALF_S). */
function stabilizeChain(worldsByFrame, chainIndices, blend, passes) {
	const frames = worldsByFrame.length;
	if (frames < 3 || chainIndices.length === 0) return;
	for (let pass = 0; pass < passes; pass += 1) {
		for (const j of chainIndices) {
			const original = worldsByFrame.map((worlds) => matToQuat(worlds[j]));
			for (let f = 1; f < frames - 1; f += 1) {
				const mid = slerpQuat(original[f - 1], original[f + 1], 0.5);
				worldsByFrame[f][j] = quatToMat(slerpQuat(original[f], mid, blend));
			}
		}
	}
}

/** One-Euro on world rotations (#84): sequential per joint, the filtered
 *  quaternion slides toward each frame's raw one by an alpha derived from a
 *  cutoff that RISES with the (smoothed) angular speed — slow tremor is cut,
 *  a fast strike passes. See the ARM_* constants for why the arms get this
 *  instead of the neighbour slerp above. Causal (a first frame of lag at
 *  rest, none at speed) where the slerp is zero-lag — acceptable on arms,
 *  wrong on legs, whose planted-foot metrics read absolute position. */
function oneEuroChain(worldsByFrame, chainIndices, fps) {
	const frames = worldsByFrame.length;
	if (frames < 2 || chainIndices.length === 0) return;
	const dt = 1 / fps;
	const alphaFor = (cutoffHz) => 1 / (1 + 1 / (2 * Math.PI * cutoffHz * dt));
	const speedAlpha = alphaFor(ARM_SPEED_CUTOFF_HZ);
	for (const j of chainIndices) {
		let filtered = matToQuat(worldsByFrame[0][j]);
		let speedFiltered = 0;
		for (let f = 1; f < frames; f += 1) {
			const raw = matToQuat(worldsByFrame[f][j]);
			const dot = Math.min(1, Math.abs(raw[0] * filtered[0] + raw[1] * filtered[1] + raw[2] * filtered[2] + raw[3] * filtered[3]));
			const speedDegPerS = ((2 * Math.acos(dot) * 180) / Math.PI) / dt;
			speedFiltered += speedAlpha * (speedDegPerS - speedFiltered);
			filtered = slerpQuat(filtered, raw, alphaFor(ARM_MIN_CUTOFF_HZ + ARM_BETA_PER_DEG_S * speedFiltered));
			worldsByFrame[f][j] = quatToMat(filtered);
		}
	}
}

/**
 * Shape a per-frame floor-penetration correction so that applying it does not
 * itself shake the leg: running MAX over ±half (dilation), then a centred
 * moving average over the same ±half. Returns a new track.
 *
 * SAFETY INVARIANT — the result is pointwise >= the input, so a correction
 * shaped this way can never reintroduce penetration the raw one removed. Every
 * sample the average sees at frame f is dilated[k] for some |k - f| <= half,
 * and dilated[k] >= source[f] because f is inside k's own ±half window; a mean
 * of values all >= source[f] is >= source[f]. (Blurring the raw deficit
 * without the dilation would instead halve the correction at the tip of every
 * spike, which is exactly where the sole is deepest under the floor.)
 * Exported so the invariant is tested directly rather than inferred.
 */
export function shapeFloorCorrection(source, half) {
	const frames = source.length;
	const dilated = new Float64Array(frames);
	for (let f = 0; f < frames; f += 1) {
		let peak = 0;
		for (let k = Math.max(0, f - half); k <= Math.min(frames - 1, f + half); k += 1) peak = Math.max(peak, source[k]);
		dilated[f] = peak;
	}
	const blurred = new Float64Array(frames);
	for (let f = 0; f < frames; f += 1) {
		let sum = 0;
		let count = 0;
		for (let k = Math.max(0, f - half); k <= Math.min(frames - 1, f + half); k += 1) {
			sum += dilated[k];
			count += 1;
		}
		blurred[f] = sum / count;
	}
	return blurred;
}

/** In-place centred moving average of a plain array, boundary-clamped. */
function smoothArray(values, window) {
	const half = Math.floor(window / 2);
	const source = Float64Array.from(values);
	for (let f = 0; f < values.length; f += 1) {
		let sum = 0;
		let count = 0;
		for (let k = Math.max(0, f - half); k <= Math.min(values.length - 1, f + half); k += 1) {
			sum += source[k];
			count += 1;
		}
		values[f] = sum / count;
	}
}

/** Erode contact runs shorter than minRun, then bridge gaps shorter than
 *  minRun — single-frame flicker neither starts nor breaks a plant. */
function cleanRuns(track, minRun) {
	const frames = track.length;
	for (let f = 0; f < frames; ) {
		if (!track[f]) { f += 1; continue; }
		let g = f;
		while (g < frames && track[g]) g += 1;
		if (g - f < minRun) for (let k = f; k < g; k += 1) track[k] = false;
		f = g;
	}
	for (let f = 0; f < frames; ) {
		if (track[f]) { f += 1; continue; }
		let g = f;
		while (g < frames && !track[g]) g += 1;
		if (f > 0 && g < frames && g - f < minRun) for (let k = f; k < g; k += 1) track[k] = true;
		f = g;
	}
}

/** Cut a candidate contact track down to the stretches during which the ankle
 *  never leaves a `maxWander`-wide patch of floor, dropping what is then
 *  shorter than minRun. Net wander over a run is immune to the per-frame XZ
 *  noise that defeats an instantaneous speed gate, and still rejects a foot
 *  that is actually travelling — a step's bounding box blows past the patch
 *  within a few frames, so the run is closed exactly where the foot left. */
function splitByXzWander(track, anklePositions, maxWander, minRun) {
	const kept = new Array(track.length).fill(false);
	for (const run of contactRuns(track)) {
		let start = run.start;
		let minX = Infinity;
		let maxX = -Infinity;
		let minZ = Infinity;
		let maxZ = -Infinity;
		for (let f = run.start; f <= run.end; f += 1) {
			const x = anklePositions[f * 3];
			const z = anklePositions[f * 3 + 2];
			const spanX = Math.max(maxX, x) - Math.min(minX, x);
			const spanZ = Math.max(maxZ, z) - Math.min(minZ, z);
			if (f > start && Math.hypot(spanX, spanZ) > maxWander) {
				if (f - start >= minRun) for (let k = start; k < f; k += 1) kept[k] = true;
				start = f;
				minX = maxX = x;
				minZ = maxZ = z;
				continue;
			}
			minX = Math.min(minX, x); maxX = Math.max(maxX, x);
			minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
		}
		if (run.end - start + 1 >= minRun) for (let k = start; k <= run.end; k += 1) kept[k] = true;
	}
	for (let f = 0; f < track.length; f += 1) track[f] = kept[f];
}

/** Contiguous true runs of a boolean track as { start, end } (inclusive). */
function contactRuns(track) {
	const runs = [];
	for (let f = 0; f < track.length; ) {
		if (!track[f]) { f += 1; continue; }
		let g = f;
		while (g < track.length && track[g]) g += 1;
		runs.push({ start: f, end: g - 1 });
		f = g;
	}
	return runs;
}

/** Merge contact runs across short occlusion gaps: the foot left "contact"
 *  but reappears at (nearly) the same spot without ever lifting past the
 *  jump ceiling — so it never actually moved, and the gap is an estimation
 *  error to be pinned, not air to be preserved. */
export function bridgeOcclusionGaps(track, anklePositions, floorY, fps) {
	const maxGap = Math.round(BRIDGE_MAX_GAP_S * fps);
	const runs = contactRuns(track);
	for (let i = 0; i + 1 < runs.length; i += 1) {
		const a = runs[i];
		const b = runs[i + 1];
		const gap = b.start - a.end - 1;
		if (gap <= 0 || gap > maxGap) continue;
		const dx = anklePositions[b.start * 3] - anklePositions[a.end * 3];
		const dz = anklePositions[b.start * 3 + 2] - anklePositions[a.end * 3 + 2];
		if (Math.hypot(dx, dz) > BRIDGE_MAX_XZ_M) continue;
		let maxLift = -Infinity;
		for (let f = a.end + 1; f < b.start; f += 1) maxLift = Math.max(maxLift, anklePositions[f * 3 + 1] - floorY);
		if (maxLift > BRIDGE_MAX_LIFT_M) continue; // a real jump keeps its air
		for (let f = a.end + 1; f < b.start; f += 1) track[f] = true;
	}
}

/** Where a contact run pins its ankle: the median planted position over the
 *  run's REAL contact frames (bridged frames are the error being repaired). */
function runLockPoint(run, realTrack, anklePositions) {
	const xs = [];
	const ys = [];
	const zs = [];
	for (let f = run.start; f <= run.end; f += 1) {
		if (!realTrack[f]) continue;
		xs.push(anklePositions[f * 3]);
		ys.push(anklePositions[f * 3 + 1]);
		zs.push(anklePositions[f * 3 + 2]);
	}
	if (xs.length === 0) return null;
	const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
	return [median(xs), median(ys), median(zs)];
}

function v3sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function v3add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function v3scale(v, k) { return [v[0] * k, v[1] * k, v[2] * k]; }
function v3dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function v3cross(a, b) {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function v3len(v) { return Math.hypot(v[0], v[1], v[2]); }
function matVec3(m, v) {
	return [
		m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
		m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
		m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
	];
}

/** Shortest rotation matrix taking direction u onto direction v (Rodrigues). */
function rotationBetween(u, v) {
	const lu = v3len(u);
	const lv = v3len(v);
	if (lu < 1e-9 || lv < 1e-9) return null;
	const a = v3scale(u, 1 / lu);
	const b = v3scale(v, 1 / lv);
	const c = v3cross(a, b);
	const d = v3dot(a, b);
	const s2 = v3dot(c, c);
	if (s2 < 1e-14) {
		if (d > 0) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
		// opposite: 180 deg about any axis perpendicular to a
		let axis = v3cross(a, [1, 0, 0]);
		if (v3len(axis) < 1e-6) axis = v3cross(a, [0, 1, 0]);
		const n = v3scale(axis, 1 / v3len(axis));
		return [
			[2 * n[0] * n[0] - 1, 2 * n[0] * n[1], 2 * n[0] * n[2]],
			[2 * n[0] * n[1], 2 * n[1] * n[1] - 1, 2 * n[1] * n[2]],
			[2 * n[0] * n[2], 2 * n[1] * n[2], 2 * n[2] * n[2] - 1],
		];
	}
	const K = [
		[0, -c[2], c[1]],
		[c[2], 0, -c[0]],
		[-c[1], c[0], 0],
	];
	const k = (1 - d) / s2;
	const KK = matMul(K, K);
	return [
		[1 + K[0][0] + KK[0][0] * k, K[0][1] + KK[0][1] * k, K[0][2] + KK[0][2] * k],
		[K[1][0] + KK[1][0] * k, 1 + K[1][1] + KK[1][1] * k, K[1][2] + KK[1][2] * k],
		[K[2][0] + KK[2][0] * k, K[2][1] + KK[2][1] * k, 1 + K[2][2] + KK[2][2] * k],
	];
}

/**
 * Analytic 2-bone leg IK (research 11 §2: "hold the ankle world position and
 * re-solve the two-bone leg chain"). Re-aims hip and knee so the ankle
 * reaches `target`, keeps the knee's current bend plane, and leaves the
 * foot's WORLD orientation untouched — a planted foot must not roll because
 * the leg above it moved. Returns the new cskel27 LOCAL matrices, or null
 * when the chain is degenerate.
 */
function solveLegIk(positions, worlds, leg, hipsIdx, target) {
	const H = positions[leg.hip];
	const K = positions[leg.knee];
	const A = positions[leg.ankle];
	const L1 = v3len(v3sub(K, H));
	const L2 = v3len(v3sub(A, K));
	if (L1 < 1e-4 || L2 < 1e-4) return null;
	let d = v3len(v3sub(target, H));
	const eps = 1e-3;
	d = Math.max(Math.abs(L1 - L2) + eps, Math.min(L1 + L2 - eps, d));
	if (d < 1e-4) return null;
	const dir = v3scale(v3sub(target, H), 1 / v3len(v3sub(target, H)));
	// Preserve the current bend plane: the knee keeps pointing the way it
	// already points, projected off the new hip→ankle axis.
	const hk = v3sub(K, H);
	let bend = v3sub(hk, v3scale(dir, v3dot(hk, dir)));
	if (v3len(bend) < 1e-6) {
		bend = v3sub(matVec3(worlds[leg.hip], [0, 0, 1]), v3scale(dir, v3dot(matVec3(worlds[leg.hip], [0, 0, 1]), dir)));
		if (v3len(bend) < 1e-6) return null;
	}
	bend = v3scale(bend, 1 / v3len(bend));
	const a1 = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
	const h = Math.sqrt(Math.max(0, L1 * L1 - a1 * a1));
	const newKnee = v3add(H, v3add(v3scale(dir, a1), v3scale(bend, h)));
	const clampedTarget = v3add(H, v3scale(dir, d));

	const hipDelta = rotationBetween(v3sub(K, H), v3sub(newKnee, H));
	if (!hipDelta) return null;
	const ankleAfterHip = v3add(newKnee, matVec3(hipDelta, v3sub(A, K)));
	const kneeDelta = rotationBetween(v3sub(ankleAfterHip, newKnee), v3sub(clampedTarget, newKnee));
	if (!kneeDelta) return null;

	const hipGlobal = matMul(hipDelta, worlds[leg.hip]);
	const kneeGlobal = matMul(kneeDelta, matMul(hipDelta, worlds[leg.knee]));
	return {
		hipLocal: matMul(matTranspose(worlds[hipsIdx]), hipGlobal),
		kneeLocal: matMul(matTranspose(hipGlobal), kneeGlobal),
		// the foot keeps its ORIGINAL world orientation under the new knee
		ankleLocal: matMul(matTranspose(kneeGlobal), worlds[leg.ankle]),
	};
}

/** Centred moving average over one interleaved component of a stride-3 track. */
function smoothTrack(track, frames, component, window) {
	const half = Math.floor(window / 2);
	const source = new Float64Array(frames);
	for (let f = 0; f < frames; f += 1) source[f] = track[f * 3 + component];
	for (let f = 0; f < frames; f += 1) {
		let sum = 0;
		let count = 0;
		for (let k = Math.max(0, f - half); k <= Math.min(frames - 1, f + half); k += 1) {
			sum += source[k];
			count += 1;
		}
		track[f * 3 + component] = sum / count;
	}
}


function magnitude(v) {
	return Math.hypot(v[0], v[1], v[2]);
}

function chainLength(positions, names) {
	let total = 0;
	for (let i = 1; i < names.length; i += 1) {
		const a = positions[CSKEL27_JOINTS.indexOf(names[i - 1])];
		const b = positions[CSKEL27_JOINTS.indexOf(names[i])];
		total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
	}
	return total;
}
