import { sliceMotion } from "./trim.js";

// A vertical drop authored ONTO a take. ARDY generates motion on flat
// ground — nothing in a generated clip can carry a body off a 14 m roof.
// The plunge is previs staging, not motion synthesis, so it is applied to
// the decoded clip as a rigid vertical offset: every joint of a frame moves
// down by the same amount, and the amount follows a gravity curve.
//
// Seconds, not frames: a take crosses two clocks on its way in (ARDY's
// 20 fps, the 24 fps production timeline), and a boundary in seconds means
// the caller never has to know which side of the retime it is speaking to.

/** Validated {fromS, toS, meters} or null — malformed input is no drop. */
export function normalizeRootDrop(drop) {
	if (!drop || typeof drop !== "object" || Array.isArray(drop)) return null;
	const fromS = Number(drop.fromS ?? drop.from_s);
	const toS = Number(drop.toS ?? drop.to_s);
	const meters = Number(drop.meters);
	if (!Number.isFinite(fromS) || !Number.isFinite(toS) || !Number.isFinite(meters)) return null;
	if (fromS < 0 || toS <= fromS || meters <= 0) return null;
	return { fromS, toS, meters };
}

/** Point-in-footprint on the floor plane, honouring the support's yaw. */
function insideSupport(support, px, pz) {
	const yaw = ((support.rotDeg ?? 0) * Math.PI) / 180;
	const cos = Math.cos(yaw);
	const sin = Math.sin(yaw);
	const dx = px - support.x;
	const dz = pz - support.z;
	const lx = cos * dx - sin * dz;
	const lz = sin * dx + cos * dz;
	return Math.abs(lx) <= support.width / 2 && Math.abs(lz) <= support.depth / 2;
}

const SUPPORT_FEET = [21, 22, 25, 26];
const smoothstep = (value) => {
	const t = Math.max(0, Math.min(1, value));
	return t * t * (3 - 2 * t);
};

/**
 * Lift a take onto an explicitly authored scene surface.  ARDY clips are
 * normally rooted on the deck, so a performer climbing onto a prop needs a
 * small, time-continuous offset while their root is inside that prop's
 * footprint.  We require a real upward root trend before applying anything;
 * a flat walk through a prop therefore stays untouched.
 *
 * `supports` are world-space rectangles with an explicit `supportY` (the top
 * of the surface). `subjectX/Y/Z` supply the character's scene anchor and
 * `worldScale` converts canonical clip units to scene metres, matching the
 * transform used by `autoRoofDrop`. The input motion is never mutated. The
 * returned object carries `surfaceRise` diagnostics.
 */
export function applySupportRise(
	motion,
	supports,
	{ subjectX = 0, subjectY = 0, subjectZ = 0, rotationDeg = 0, minRise = 0.08, minSlope = 0.04, lookbackFrames = 6, blendFrames = 6, maxOffset = 1.5, worldScale = 1 } = {},
) {
	if (!motion || !Number.isFinite(motion.fps) || motion.fps <= 0 || !motion.rootPos || !motion.posedJoints) return motion;
	const frames = Number(motion.frames);
	if (!Number.isInteger(frames) || frames < 2 || motion.rootPos.length < frames * 3) return motion;
	const joints = motion.posedJoints.length / (frames * 3);
	if (!Number.isInteger(joints) || joints <= 0) return motion;
	const scale = Number.isFinite(Number(worldScale)) && Number(worldScale) > 0 ? Number(worldScale) : 1;
	if (!Array.isArray(supports) || !supports.length) return motion;
	const candidates = supports.filter((support) =>
		support && Number.isFinite(Number(support.supportY)) && Number(support.width) > 0 && Number(support.depth) > 0,
	);
	if (!candidates.length) return motion;
	const radians = (Number(rotationDeg) || 0) * Math.PI / 180;
	const cos = Math.cos(radians), sin = Math.sin(radians);
	const worldAt = (frame) => {
		const dx = motion.rootPos[frame * 3] - motion.rootPos[0];
		const dz = motion.rootPos[frame * 3 + 2] - motion.rootPos[2];
		return { x: Number(subjectX) + (dx * cos + dz * sin) * scale, z: Number(subjectZ) + (-dx * sin + dz * cos) * scale };
	};
	const points = Array.from({ length: frames }, (_, frame) => worldAt(frame));
	const feet = SUPPORT_FEET.filter((joint) => joint < joints);
	const footWorldAt = (frame, joint) => {
		const p = (frame * joints + joint) * 3;
		const dx = motion.posedJoints[p] - motion.rootPos[0];
		const dz = motion.posedJoints[p + 2] - motion.rootPos[2];
		return { x: Number(subjectX) + (dx * cos + dz * sin) * scale, z: Number(subjectZ) + (-dx * sin + dz * cos) * scale };
	};
	const inside = candidates.map((support) => points.map((point, frame) => insideSupport({
		x: Number(support.x) || 0, z: Number(support.z) || 0,
		rotDeg: Number(support.rotDeg) || 0, width: Number(support.width), depth: Number(support.depth),
	}, point.x, point.z) || feet.some((joint) => {
		const foot = footWorldAt(frame, joint);
		return insideSupport({
			x: Number(support.x) || 0, z: Number(support.z) || 0,
			rotDeg: Number(support.rotDeg) || 0, width: Number(support.width), depth: Number(support.depth),
		}, foot.x, foot.z);
	})));
	let selected = null;
	for (let si = 0; si < candidates.length; si += 1) {
		const support = candidates[si];
		// A performer often enters a prop's footprint before lifting a foot
		// (approach, brace, then climb). Search the first second of continuous
		// support occupancy instead of requiring the rise on the boundary frame.
		let entry = -1;
		for (let frame = 0; frame < frames; frame += 1) {
			if (!inside[si][frame]) { entry = -1; continue; }
			// A take can begin already standing on a platform. Treat frame 0 as
			// an entry so the same evidence search handles both approaches and
			// starts-on-support clips.
			if (entry < 0 && (frame === 0 || !inside[si][frame - 1])) entry = frame;
			if (entry < 0 || frame - entry > Math.round(motion.fps)) continue;
			const from = Math.max(0, frame - Math.max(1, Math.round(lookbackFrames)));
			// A foot can enter the footprint one or two frames before the body
			// commits to the climb. Look a short distance ahead, while retaining
			// the entry frame as the point where the blend begins.
			const evidenceFrame = Math.min(frames - 1, frame + Math.max(1, Math.round(lookbackFrames)));
			const rise = (motion.rootPos[evidenceFrame * 3 + 1] - motion.rootPos[from * 3 + 1]) * scale;
			const slope = rise / ((evidenceFrame - from) / motion.fps);
			if (rise < Number(minRise) || slope < Number(minSlope)) continue;
			const feet = SUPPORT_FEET.filter((joint) => joint < joints);
			if (!feet.length) continue;
			const occupiedYs = [];
			for (let probe = evidenceFrame; probe < frames && inside[si][probe] && probe <= evidenceFrame + Math.round(motion.fps * 0.75); probe += 1) {
				const ys = feet.map((joint) => motion.posedJoints[(probe * joints + joint) * 3 + 1] * scale).filter(Number.isFinite);
				if (ys.length) occupiedYs.push(Math.min(...ys));
			}
			occupiedYs.sort((a, b) => a - b);
			const observedFootY = occupiedYs[Math.floor(occupiedYs.length * 0.7)];
			const footYs = feet.map((joint) => motion.posedJoints[(evidenceFrame * joints + joint) * 3 + 1] * scale).filter(Number.isFinite);
			if (!footYs.length) continue;
			const baseY = Number(subjectY) || 0;
			const offsetWorld = Number(support.supportY) - (baseY + (Number.isFinite(observedFootY) ? observedFootY : Math.min(...footYs)));
			if (!(offsetWorld > 0.01) || offsetWorld > Number(maxOffset)) continue;
			selected = {
				si,
				frame,
				support,
				offset: offsetWorld / scale,
				offsetWorld,
				rise,
				slope,
				baseRootY: motion.rootPos[from * 3 + 1],
			};
			break;
		}
		if (selected) break;
	}
	if (!selected) return motion;
	const { si, frame: enter, offset, offsetWorld, support, rise, slope, baseRootY } = selected;
	let exit = frames - 1;
	for (let frame = enter + 1; frame < frames; frame += 1) {
		if (!inside[si][frame]) { exit = frame; break; }
	}
	// Some shots climb and then step down while the root remains inside a
	// generous footprint (a chair turn, a platform landing, or a jump in
	// place). Release the lift when the root has come back near its pre-climb
	// level; otherwise the rigid support offset would leave the performer
	// floating even though the take has visibly descended.
	let release = exit;
	const descendThreshold = Math.max(Number(minRise), 0.08);
	let peakRootY = motion.rootPos[enter * 3 + 1];
	for (let frame = enter + 1; frame <= exit; frame += 1) {
		peakRootY = Math.max(peakRootY, motion.rootPos[frame * 3 + 1]);
		const current = motion.rootPos[frame * 3 + 1];
		if (peakRootY - current >= descendThreshold && current <= baseRootY + descendThreshold * 0.5) {
			release = frame;
			break;
		}
	}
	const blend = Math.max(1, Math.round(blendFrames));
	const offsets = new Float32Array(frames);
	for (let frame = enter; frame < frames; frame += 1) {
		const up = smoothstep((frame - enter + 1) / blend);
		const down = release < frames - 1 ? smoothstep((release - frame) / blend) : 1;
		offsets[frame] = offset * Math.min(up, down);
	}
	const rootPos = Float32Array.from(motion.rootPos);
	const posedJoints = Float32Array.from(motion.posedJoints);
	const jointCount = Math.round(posedJoints.length / frames / 3);
	for (let frame = 0; frame < frames; frame += 1) {
		const dy = offsets[frame];
		if (!dy) continue;
		rootPos[frame * 3 + 1] += dy;
		for (let joint = 0; joint < jointCount; joint += 1) posedJoints[(frame * jointCount + joint) * 3 + 1] += dy;
	}
	return {
		...motion,
		rootPos,
		posedJoints,
		surfaceRise: { applied: true, supportY: Number(support.supportY), offset, offsetWorld, worldScale: scale, enterFrame: enter, exitFrame: exit, releaseFrame: release, rise, slope },
	};
}

/**
 * Stage a fall the author did not have to ask for: a character standing on a
 * raised support (a roof — place_character's y) whose take walks past the
 * support's edge should drop, because ARDY only generates flat-ground motion.
 *
 * `subject` is { x, z, y, rotationDeg } — the character's blocking, with the
 * take's root rotation. `supports` are world-space tops: { x, z, rotDeg,
 * topY, width, depth }. The walk is sampled with the same root convention
 * playback uses (frame-zero anchored, yaw-rotated into scene space).
 *
 * Returns a { fromS, toS, meters } drop, or null when the character is on
 * the ground, never stood on a support, or never leaves it — null means
 * "stage nothing", so this is safe to leave on the load path.
 */
export function autoRoofDrop(motion, subject, supports, { gravity = 9.81, topTolerance = 0.3, fallTimeScale = 1.15, worldScale = 1 } = {}) {
	if (!motion || !Number.isFinite(motion.fps) || motion.fps <= 0 || !motion.rootPos) return null;
	const frames = motion.frames;
	if (!Number.isFinite(frames) || frames < 2) return null;
	const y = Number(subject?.y) || 0;
	if (y <= 0.05 || !Array.isArray(supports) || supports.length === 0) return null;
	const scale = Number.isFinite(Number(worldScale)) && Number(worldScale) > 0 ? Number(worldScale) : 1;

	const radians = ((Number.isFinite(subject.rotationDeg) ? subject.rotationDeg : 0) * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const worldAt = (frame) => {
		const dx = motion.rootPos[frame * 3] - motion.rootPos[0];
		const dz = motion.rootPos[frame * 3 + 2] - motion.rootPos[2];
		return {
			x: subject.x + (dx * cos + dz * sin) * scale,
			z: subject.z + (-dx * sin + dz * cos) * scale,
		};
	};

	const start = worldAt(0);
	const carriers = supports.filter((support) =>
		support.width > 0 && support.depth > 0 &&
		Math.abs(support.topY - y) <= topTolerance &&
		insideSupport(support, start.x, start.z));
	if (carriers.length === 0) return null;

	for (let frame = 1; frame < frames; frame += 1) {
		const point = worldAt(frame);
		if (carriers.some((support) => insideSupport(support, point.x, point.z))) continue;
		// Land on the tallest lower support under the exit point, else the street.
		const landing = supports.reduce((top, support) =>
			support.topY < y - topTolerance && support.topY > top && insideSupport(support, point.x, point.z)
				? support.topY
				: top, 0);
		const meters = y - landing;
		if (meters <= 0) return null;
		const fromS = frame / motion.fps;
		// Near-real gravity: a lightly stretched clock keeps weight without
		// drifting into moon-fall. The readability comes from applyAutoFall's
		// ballistic arc and impact cut, not from slowing the clock down.
		return { fromS, toS: fromS + Math.sqrt((2 * meters) / gravity) * fallTimeScale, meters };
	}
	return null;
}

/**
 * Bake an auto-staged fall so it reads like a stunt, not a glitch:
 * - past the edge the root leaves the authored walk path and flies a true
 *   ballistic arc — the exit velocity carries, gravity owns the vertical;
 * - the horizontal drift stops at impact (bodies do not keep strolling);
 * - the take is cut just after the landing, because whatever the flat-ground
 *   clip does next (walking away twelve metres underground-level) is comedy.
 * Explicit MCP drops keep the rigid applyRootDrop bake below.
 */
export function applyAutoFall(motion, spec, { landHoldS = 0.35, launchLookbackS = 0.15, worldScale = 1 } = {}) {
	if (!spec || !motion || !Number.isFinite(motion.fps) || motion.fps <= 0) return motion;
	const fps = motion.fps;
	const scale = Number.isFinite(Number(worldScale)) && Number(worldScale) > 0 ? Number(worldScale) : 1;
	const fExit = Math.max(0, Math.round(spec.fromS * fps));
	if (fExit >= motion.frames - 1) return motion;
	const fallS = Math.max(spec.toS - spec.fromS, 1 / fps);
	const joints = Math.round(motion.posedJoints.length / motion.frames / 3);
	const rootPos = Float32Array.from(motion.rootPos);
	const posedJoints = Float32Array.from(motion.posedJoints);
	const lookback = Math.max(1, Math.round(launchLookbackS * fps));
	const f0 = Math.max(0, fExit - lookback);
	const span = Math.max(1, fExit - f0);
	const vx = ((rootPos[fExit * 3] - rootPos[f0 * 3]) / span) * fps;
	const vz = ((rootPos[fExit * 3 + 2] - rootPos[f0 * 3 + 2]) / span) * fps;
	const exitX = rootPos[fExit * 3];
	const exitZ = rootPos[fExit * 3 + 2];
	const fLand = Math.min(motion.frames - 1, Math.ceil(spec.toS * fps));
	for (let f = fExit + 1; f < motion.frames; f += 1) {
		const t = (f - fExit) / fps;
		const progress = Math.min(t / fallS, 1);
		const air = Math.min(t, fallS);
		const dy = -(spec.meters / scale) * progress * progress;
		const dx = exitX + vx * air - rootPos[f * 3];
		const dz = exitZ + vz * air - rootPos[f * 3 + 2];
		rootPos[f * 3] += dx;
		rootPos[f * 3 + 1] += dy;
		rootPos[f * 3 + 2] += dz;
		for (let j = 0; j < joints; j += 1) {
			const base = (f * joints + j) * 3;
			posedJoints[base] += dx;
			posedJoints[base + 1] += dy;
			posedJoints[base + 2] += dz;
		}
	}
	const rotMats = Float32Array.from(motion.rotMats);
	for (let f = fLand + 1; f < motion.frames; f += 1) {
		rootPos.set(rootPos.subarray(fLand * 3, fLand * 3 + 3), f * 3);
		posedJoints.set(
			posedJoints.subarray(fLand * joints * 3, (fLand + 1) * joints * 3),
			f * joints * 3,
		);
		rotMats.set(
			rotMats.subarray(fLand * joints * 9, (fLand + 1) * joints * 9),
			f * joints * 9,
		);
	}
	const baked = { ...motion, rootPos, posedJoints, rotMats };
	const fEnd = Math.min(motion.frames - 1, Math.ceil((spec.toS + landHoldS) * fps));
	return fEnd < motion.frames - 1 ? sliceMotion(baked, 0, fEnd) : baked;
}

/**
 * The clip with the drop applied. The input clip is never mutated — the
 * caller may hold it as a trim source — and an invalid drop returns the
 * clip untouched, so this is safe to leave on the load path unconditionally.
 *
 * The curve is t² (uniform acceleration): a body leaving a roof gathers
 * speed, and an eased-both-ends fall reads as a elevator, not gravity.
 */
export function applyRootDrop(motion, drop, { worldScale = 1 } = {}) {
	const spec = normalizeRootDrop(drop);
	if (!spec || !motion || !Number.isFinite(motion.fps) || motion.fps <= 0) return motion;
	const scale = Number.isFinite(Number(worldScale)) && Number(worldScale) > 0 ? Number(worldScale) : 1;
	const frames = motion.frames;
	if (!Number.isFinite(frames) || frames <= 0) return motion;

	const posedJoints = Float32Array.from(motion.posedJoints);
	const rootPos = Float32Array.from(motion.rootPos);
	const joints = Math.round(posedJoints.length / frames / 3);
	for (let f = 0; f < frames; f += 1) {
		const t = Math.min(Math.max((f / motion.fps - spec.fromS) / (spec.toS - spec.fromS), 0), 1);
		if (t === 0) continue;
		const dy = -(spec.meters / scale) * t * t;
		for (let j = 0; j < joints; j += 1) posedJoints[(f * joints + j) * 3 + 1] += dy;
		rootPos[f * 3 + 1] += dy;
	}
	return { ...motion, posedJoints, rootPos };
}
