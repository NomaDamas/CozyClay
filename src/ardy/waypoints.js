const cleanZero = (value) => (Object.is(value, -0) || Math.abs(value) < 1e-9 ? 0 : value);
import { isKo } from "../locale.js";
import { TIMELINE_FRAME_FPS } from "../timeline-fps.js";

const DEFAULT_WAYPOINT_SPACING_FRAMES = Math.round(0.4 * TIMELINE_FRAME_FPS);

/**
 * ARDY root constraints live in the actor's clip-local coordinates. CozyClay's
 * plan uses scene-world coordinates and rotates Subject 1 as a scene object, so
 * both translation and actor yaw must be removed before generation. Playback
 * applies the exact inverse transform when it places the generated root.
 */
export function toArdyWaypoints(waypoints, actorRotationDeg = 0) {
	if (!waypoints.length) return [];
	const origin = waypoints[0];
	const yaw = (actorRotationDeg * Math.PI) / 180;
	const cos = Math.cos(yaw);
	const sin = Math.sin(yaw);
	return waypoints.map((waypoint) => {
		const worldX = waypoint.x - origin.x;
		const worldZ = waypoint.z - origin.z;
		return {
			frame: waypoint.frame,
			x: cleanZero(cos * worldX - sin * worldZ),
			z: cleanZero(sin * worldX + cos * worldZ),
			heading: waypoint.heading ?? null,
		};
	});
}
/**
 * Densify an authored root path for ARDY motion generation: rebase to
 * clip-local coordinates exactly like toArdyWaypoints, interpolate on the
 * authored polyline, and emit one sample roughly every `spacing` frames
 * (capped at maxPoints). Authored frames are always kept, the first
 * sample is always frame 0, and frames are strictly ascending without
 * duplicates. The spacing is deliberately loose: a sample every 2-3
 * frames rails the root so hard the model gives up its gait cadence and
 * ice-skates; ~0.4 s between position pins leaves room for real steps
 * while the interpolated headings still steer the facing.
 * Each sample heading is the path tangent (central difference between
 * neighbors; adjacent-segment direction at the ends), carried forward
 * through stalls shorter than 1e-6 and 0 when the whole path is
 * stationary; headings are always finite numbers in [-2π, 2π].
 */
export function densifyArdyWaypoints(waypoints, actorRotationDeg = 0, maxPoints = 32, spacing = DEFAULT_WAYPOINT_SPACING_FRAMES) {
	if (waypoints.length < 2) return [];
	const local = toArdyWaypoints(waypoints, actorRotationDeg);

	// Authored frames and positions, deduplicated: these are the
	// interpolation endpoints every sample set must contain.
	const authored = [];
	for (const point of local) {
		if (authored.length === 0 || authored[authored.length - 1].frame !== point.frame) {
			authored.push({ frame: point.frame, x: point.x, z: point.z });
		}
	}
	if (authored.length === 1) {
		return [{ frame: authored[0].frame, x: authored[0].x, z: authored[0].z, heading: 0 }];
	}

	const denseCount = authored[authored.length - 1].frame - authored[0].frame + 1;
	const limit = Math.max(0, Math.floor(maxPoints));
	const gapSpacing = Math.max(1, Math.floor(spacing));
	// One filler per started `spacing` chunk beyond the first, per gap.
	let spacingExtra = 0;
	for (let i = 0; i < authored.length - 1; i += 1) {
		spacingExtra += Math.max(0, Math.ceil((authored[i + 1].frame - authored[i].frame) / gapSpacing) - 1);
	}
	const extra = Math.max(0, Math.min(limit, denseCount, authored.length + spacingExtra) - authored.length);

	// Distribute the extra samples across the gaps between authored frames
	// in proportion to gap length (largest remainder), so spacing stays
	// uniform while authored frames are always kept.
	const gaps = [];
	for (let i = 0; i < authored.length - 1; i += 1) {
		gaps.push(authored[i + 1].frame - authored[i].frame);
	}
	const gapSizes = gaps.map(() => 0);
	if (extra > 0) {
		const total = gaps.reduce((sum, size) => sum + size, 0);
		const raw = gaps.map((size) => (extra * size) / total);
		const base = raw.map((value) => Math.floor(value));
		const order = raw
			.map((value, i) => [value - base[i], i])
			.sort((a, b) => b[0] - a[0]);
		let used = base.reduce((sum, value) => sum + value, 0);
		for (const [, i] of order) {
			if (used >= extra) break;
			const add = Math.min(extra - used, gaps[i] - 1 - base[i]);
			base[i] += add;
			used += add;
		}
		for (let i = 0; i < gaps.length; i += 1) gapSizes[i] = base[i];
	}

	// Sample frames: authored frames plus evenly spaced integer fillers.
	const frames = [];
	for (let i = 0; i < authored.length; i += 1) {
		if (i > 0) {
			const count = gapSizes[i - 1];
			if (count > 0) {
				const step = gaps[i - 1] / (count + 1);
				for (let j = 0; j < count; j += 1) {
					frames.push(authored[i - 1].frame + Math.round((j + 1) * step));
				}
			}
		}
		frames.push(authored[i].frame);
	}

	// C1 resampling: cubic Hermite through the authored pins, with each pin's
	// velocity as the finite-difference average of its two segment velocities
	// (one-sided at the ends). A C0 polyline pins an instantaneous direction
	// flip at every interior waypoint — and, when authored frames imply
	// different paces, an instantaneous speed jump — which the generator can
	// only satisfy by braking and pivoting on the pin: the hitch you see as
	// the root crosses waypoint 2. Hermite keeps authored pins exact, keeps a
	// uniform straight path exactly linear, and turns corners into arcs where
	// both travel direction and speed ramp continuously. (A near-180° reversal
	// will swing wide of the pin — that wide swing is the C1 answer to an
	// about-face, not an error.)
	const segmentVelocity = (a, b) => ({
		x: (b.x - a.x) / (b.frame - a.frame),
		z: (b.z - a.z) / (b.frame - a.frame),
	});
	const stalledSegment = (a, b) => (b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z) < 1e-12;
	const velocity = authored.map((point, i) => {
		const prev = authored[i - 1];
		const next = authored[i + 1];
		// A knot beside a stall comes to a full stop: leaking a neighbour's
		// velocity into a hold would make the "stationary" span drift, and a
		// walker entering a hold decelerates to zero anyway.
		if (!prev) return stalledSegment(point, next) ? { x: 0, z: 0 } : segmentVelocity(point, next);
		if (!next) return stalledSegment(prev, point) ? { x: 0, z: 0 } : segmentVelocity(prev, point);
		if (stalledSegment(prev, point) || stalledSegment(point, next)) return { x: 0, z: 0 };
		const before = segmentVelocity(prev, point);
		const after = segmentVelocity(point, next);
		return { x: (before.x + after.x) / 2, z: (before.z + after.z) / 2 };
	});
	const samples = [];
	let seg = 0;
	for (const frame of frames) {
		while (frame > authored[seg + 1].frame) seg += 1;
		const start = authored[seg];
		const end = authored[seg + 1];
		const span = end.frame - start.frame;
		const t = (frame - start.frame) / span;
		const h00 = (1 + 2 * t) * (1 - t) * (1 - t);
		const h10 = t * (1 - t) * (1 - t);
		const h01 = t * t * (3 - 2 * t);
		const h11 = t * t * (t - 1);
		const v0 = velocity[seg];
		const v1 = velocity[seg + 1];
		samples.push({
			frame,
			x: cleanZero(h00 * start.x + h10 * span * v0.x + h01 * end.x + h11 * span * v1.x),
			z: cleanZero(h00 * start.z + h10 * span * v0.z + h01 * end.z + h11 * span * v1.z),
			heading: 0,
		});
	}

	// Path-tangent headings. Interior samples use the central difference
	// between neighbors, the ends use their adjacent segment; displacements
	// under 1e-6 (stalls) carry the previous heading, 0 when stationary.
	// Sign convention measured against the deployed generator, not assumed.
	// With the path aligned so heading[0] = 0 matches the model's forced
	// frame-0 facing, the generated hips reproduce the SENT angle exactly
	// (a probe sending mirrored headings walked the second segment facing
	// +77.7° while travelling at −77.7°). Earlier mirror-looking results
	// came from clips whose frame-0 facing conflicted with heading[0] and
	// corrupted the whole track. Model heading = atan2(dx, dz) of the
	// facing/travel direction; 0 faces +Z.
	let previousHeading = 0;
	for (let i = 0; i < samples.length; i += 1) {
		let dx = 0;
		let dz = 0;
		if (samples.length > 1) {
			if (i === 0) {
				dx = samples[1].x - samples[0].x;
				dz = samples[1].z - samples[0].z;
			} else if (i === samples.length - 1) {
				dx = samples[i].x - samples[i - 1].x;
				dz = samples[i].z - samples[i - 1].z;
			} else {
				dx = samples[i + 1].x - samples[i - 1].x;
				dz = samples[i + 1].z - samples[i - 1].z;
			}
		}
		if (dx * dx + dz * dz >= 1e-12) previousHeading = Math.atan2(dx, dz);
		samples[i].heading = cleanZero(previousHeading);
	}
	return samples;
}
/**
 * Align an authored root path for ARDY generation: compute the clip-local
 * first travel tangent (first non-zero authored displacement, squared
 * length >= 1e-12) and fold it into the total rotation so the densified
 * path starts with heading 0, the model's forced frame-0 +Z facing. The
 * returned rotationDeg is the scene->clip total rotation; handing it to
 * toSceneRootOffset at playback restores scene coordinates exactly.
 */
export function alignArdyPath(waypoints, actorRotationDeg = 0, maxPoints = 32) {
	if (waypoints.length < 2) return { waypoints: [], rotationDeg: actorRotationDeg };
	// Fold the first *sampled* travel direction into the rotation, not the
	// authored chord: the C1 resampler bends inside the first segment, so only
	// the dense samples know the true first step. Rotation is rigid, so
	// densifying again with the folded rotation rotates those samples exactly
	// and heading[0] lands on 0 by construction.
	const probe = densifyArdyWaypoints(waypoints, actorRotationDeg, maxPoints);
	let phi = 0;
	for (let i = 0; i < probe.length - 1; i += 1) {
		const dx = probe[i + 1].x - probe[i].x;
		const dz = probe[i + 1].z - probe[i].z;
		if (dx * dx + dz * dz >= 1e-12) {
			phi = Math.atan2(dx, dz);
			break;
		}
	}
	const rotationDeg = actorRotationDeg + (phi * 180) / Math.PI;
	return {
		waypoints: densifyArdyWaypoints(waypoints, rotationDeg, maxPoints),
		rotationDeg,
	};
}

/** Rotate an ARDY clip-local root offset back into CozyClay scene space. */
export function toSceneRootOffset(x, z, actorRotationDeg = 0) {
	const yaw = (actorRotationDeg * Math.PI) / 180;
	const cos = Math.cos(yaw);
	const sin = Math.sin(yaw);
	return {
		x: cleanZero(cos * x + sin * z),
		z: cleanZero(-sin * x + cos * z),
	};
}

/**
 * A full-body pose also constrains the root. On a root path it must share the
 * frame-zero origin; otherwise the two constraints can pull the clip apart.
 */
export function poseConstraintFrame(requestedFrame, clipFrames, hasRootPath) {
	if (hasRootPath) return 0;
	return Math.max(0, Math.min(Math.round(requestedFrame) || 0, clipFrames - 1));
}

/* ---------------------------------------------------- path limits ------ */

// What the generator can actually express, learned the hard way: waypoints
// are inpainting observations ARDY cannot refuse, so a request outside the
// training distribution collapses into foot-sliding instead of erroring.
// These limits keep authored paths inside that distribution.
export const PATH_LIMITS = Object.freeze({
	speedMinMps: 0.5, // below this, "walking" cannot cycle a gait — feet slide
	speedMaxMps: 3.0, // above this is out of the locomotion band entirely
	holdEpsM: 0.05, // a displacement this small is a deliberate hold, any duration
	minPinGapFrames: 8, // authored pins closer than this over-rail the root
	speedRatioWarn: 2, // adjacent legs differing more than 2x force a gait change
	turnRateWarnDegPerS: 120, // sharper turns need wider arcs than the path gives
	tailMaxS: 2, // unconstrained tail after the last pin inherits its history
	clipMaxS: 10, // ARDY's trained window; one-shot constrained calls cannot exceed it
});

const NATURAL_WALK_MPS = 1.4;

/**
 * Judge the segment a candidate pin would create after `last`. Returns
 * { ok, error?, warnings: [] } — `error` blocks the placement and always
 * names the fix (a workable frame or distance), `warnings` accompany a
 * placement that is legal but will read oddly.
 * @param {{frame:number,x:number,z:number}} last      the previous pin (or the frame-0 start)
 * @param {{frame:number,x:number,z:number}} candidate the pin being authored
 * @param {number} fps
 * @param {{frame:number,x:number,z:number}|null} prev the pin before `last`, for ratio/turn warnings
 */
export function judgeNextWaypoint(last, candidate, fps, prev = null) {
	const gap = candidate.frame - last.frame;
	if (gap < PATH_LIMITS.minPinGapFrames) {
		return {
			ok: false,
			error: isKo ? `핀 사이에는 최소 ${PATH_LIMITS.minPinGapFrames}프레임(${(PATH_LIMITS.minPinGapFrames / fps).toFixed(1)}초)이 필요해요 — ${last.frame + PATH_LIMITS.minPinGapFrames}프레임 이후로 이동해 주세요` : `pins need at least ${PATH_LIMITS.minPinGapFrames} frames between them (${(PATH_LIMITS.minPinGapFrames / fps).toFixed(1)} s) — scrub past frame ${last.frame + PATH_LIMITS.minPinGapFrames}`,
			warnings: [],
		};
	}
	const dist = Math.hypot(candidate.x - last.x, candidate.z - last.z);
	if (dist <= PATH_LIMITS.holdEpsM) return { ok: true, warnings: [] }; // a hold: legal at any length
	const dt = gap / fps;
	const speed = dist / dt;
	if (speed > PATH_LIMITS.speedMaxMps) {
		const neededFrames = Math.ceil((dist / PATH_LIMITS.speedMaxMps) * fps);
		return {
			ok: false,
			error: isKo ? `${speed.toFixed(1)} m/s는 사람이 움직이기엔 너무 빨라요(최대 ${PATH_LIMITS.speedMaxMps}) — ${last.frame + neededFrames}프레임 이후에 핀을 찍거나 더 가까운 곳을 눌러 주세요` : `${speed.toFixed(1)} m/s is faster than anyone moves (max ${PATH_LIMITS.speedMaxMps}) — pin frame ${last.frame + neededFrames} or later, or click closer`,
			warnings: [],
		};
	}
	if (speed < PATH_LIMITS.speedMinMps) {
		const walkFrame = last.frame + Math.max(PATH_LIMITS.minPinGapFrames, Math.round((dist / NATURAL_WALK_MPS) * fps));
		const neededDist = (PATH_LIMITS.speedMinMps * dt).toFixed(1);
		return {
			ok: false,
			error: isKo ? `${speed.toFixed(2)} m/s는 자연스럽게 걷기엔 너무 느려요(최소 ${PATH_LIMITS.speedMinMps}) — 대신 약 ${walkFrame}프레임에 핀을 찍거나 최소 ${neededDist} m 이상 떨어진 곳을 눌러 주세요` : `${speed.toFixed(2)} m/s is below a sustainable walk (min ${PATH_LIMITS.speedMinMps}) — pin frame ~${walkFrame} instead, or click at least ${neededDist} m away`,
			warnings: [],
		};
	}
	const warnings = [];
	if (prev) {
		const prevDist = Math.hypot(last.x - prev.x, last.z - prev.z);
		if (prevDist > PATH_LIMITS.holdEpsM) {
			const prevSpeed = prevDist / ((last.frame - prev.frame) / fps);
			const ratio = Math.max(speed, prevSpeed) / Math.max(Math.min(speed, prevSpeed), 1e-6);
			if (ratio > PATH_LIMITS.speedRatioWarn) {
				warnings.push(isKo ? `이전 구간보다 속도가 ${ratio.toFixed(1)}배 달라요 — 걸음 변화가 눈에 보일 수 있어요` : `${ratio.toFixed(1)}x speed change from the previous leg — expect a visible gait shift`);
			}
			const before = Math.atan2(last.x - prev.x, last.z - prev.z);
			const after = Math.atan2(candidate.x - last.x, candidate.z - last.z);
			let turn = Math.abs(after - before);
			if (turn > Math.PI) turn = 2 * Math.PI - turn;
			const turnRate = (turn * 180) / Math.PI / dt;
			if (turnRate > PATH_LIMITS.turnRateWarnDegPerS) {
				warnings.push(isKo ? `${dt.toFixed(1)}초 동안 ${Math.round((turn * 180) / Math.PI)}° 회전은 걷는 동선치고 너무 급해요 — 프레임이나 거리를 더 주세요` : `${Math.round((turn * 180) / Math.PI)}° turn in ${dt.toFixed(1)} s is sharper than a walking arc — give it more frames or distance`);
			}
		}
	}
	return { ok: true, warnings };
}

/**
 * Re-judge a whole authored path (frame-0 start included) before generation:
 * placement-time checks can be invalidated later by removing a middle pin.
 * @returns {{errors: string[], warnings: string[]}}
 */
export function judgeAuthoredPath(rootPath, fps, clipFrames, { chained = false } = {}) {
	const errors = [];
	const warnings = [];
	const ordered = [...rootPath].sort((a, b) => a.frame - b.frame);
	for (let i = 1; i < ordered.length; i += 1) {
		const verdict = judgeNextWaypoint(ordered[i - 1], ordered[i], fps, i >= 2 ? ordered[i - 2] : null);
		if (!verdict.ok) errors.push(isKo ? `구간 ${i} (${ordered[i - 1].frame}->${ordered[i].frame}프레임): ${verdict.error}` : `leg ${i} (frame ${ordered[i - 1].frame}->${ordered[i].frame}): ${verdict.error}`);
		else for (const warning of verdict.warnings) warnings.push(isKo ? `구간 ${i}: ${warning}` : `leg ${i}: ${warning}`);
	}
	// The trained window binds ONE model call. A chained rollout (a prompt
	// schedule) makes a call per block, so the whole clip may exceed it —
	// each block is capped separately by the bridge and the box generator.
	if (!chained && clipFrames / fps > PATH_LIMITS.clipMaxS) {
		errors.push(
			isKo
				? `이동 경로는 전체 클립을 한 번의 모델 호출로 만들어요. 모션 모델이 학습한 길이는 ${PATH_LIMITS.clipMaxS}초까지예요 — 클립을 ${PATH_LIMITS.clipMaxS}초로 줄이거나 프롬프트를 블록으로 나눠 이어 만들기를 사용해 주세요`
				: `a root path generates the whole clip in one model call, and the motion model's trained window is ${PATH_LIMITS.clipMaxS} s — shorten the clip to ${PATH_LIMITS.clipMaxS} s, or split the prompt into blocks so the path rides a chained rollout`,
		);
	}
	const tail = (clipFrames - 1 - (ordered[ordered.length - 1]?.frame ?? 0)) / fps;
	if (ordered.length > 1 && tail > PATH_LIMITS.tailMaxS) {
		warnings.push(
			isKo
				? `마지막 핀 뒤에 클립이 ${tail.toFixed(1)}초 남아 있어요 — 제약이 없는 끝부분은 경로가 끝난 상태를 그대로 이어가요`
				: `${tail.toFixed(1)} s of clip remain after the last pin — the unconstrained tail continues whatever the path ends in`,
		);
	}
	return { errors, warnings };
}

/** Place a newly-authored keyframe where it is immediately visible and draggable. */
export function defaultWaypointPosition(waypoints, subject) {
	if (!waypoints.length) return { x: subject.x, z: subject.z };
	const last = waypoints[waypoints.length - 1];
	if (waypoints.length > 1) {
		const previous = waypoints[waypoints.length - 2];
		return { x: last.x + (last.x - previous.x), z: last.z + (last.z - previous.z) };
	}
	const yaw = (subject.rot * Math.PI) / 180;
	return { x: last.x + Math.sin(yaw), z: last.z + Math.cos(yaw) };
}
