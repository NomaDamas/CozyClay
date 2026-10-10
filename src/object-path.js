/**
 * Object travel paths — the same authoring grammar the camera rail uses.
 *
 * A path is a stroke drawn on the Top-View floor, refined in the scene by
 * dragging its points (including their height, the way a crane point lifts a
 * camera). This module is the pure half: it owns the schema, the arc-length
 * table and the frame → transform answer, so playback, the offscreen export
 * and the MCP surface all read one truth and stay importable without three.js.
 *
 * Timing follows the character root path's rule: a path spans the whole
 * timeline. `speed` is metres per second when set; otherwise the path's own
 * length divided by the take's duration fills the timeline exactly.
 */

import { createTiming, timingIsFlat, timingProgress } from "./speed-envelope.js";

const MAX_PATH_POINTS = 64;
const ROOM_LIMIT = 240;
const MAX_HEIGHT = 60;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** One authored path point: a floor position plus the height it travels at. */
function createPathPoint(value) {
	const source = value && typeof value === "object" ? value : {};
	return {
		x: clamp(finite(source.x), -ROOM_LIMIT, ROOM_LIMIT),
		y: clamp(finite(source.y), 0, MAX_HEIGHT),
		z: clamp(finite(source.z), -ROOM_LIMIT, ROOM_LIMIT),
	};
}

/**
 * Normalize a stored or drawn path. Returns null for anything that cannot
 * describe travel — fewer than two points, or a stroke that never moves.
 */
export function createObjectPath(value) {
	if (!value || typeof value !== "object") return null;
	const rawPoints = Array.isArray(value.points) ? value.points : [];
	const points = [];
	for (const raw of rawPoints) {
		const point = createPathPoint(raw);
		// Drop the duplicate samples a drag emits while the pointer rests: they
		// add length-zero segments that would divide by zero downstream.
		const previous = points[points.length - 1];
		if (previous && Math.hypot(point.x - previous.x, point.z - previous.z, point.y - previous.y) < 1e-4) continue;
		points.push(point);
		if (points.length >= MAX_PATH_POINTS) break;
	}
	if (points.length < 2) return null;
	const speed = finite(value.speed, 0);
	// A flat timing changes nothing; storing null keeps saves clean and makes
	// "has a custom speed curve" a simple null check.
	const timing = createTiming(value.timing);
	return {
		points,
		timing: timingIsFlat(timing) ? null : timing,
		// 0 means "fill the timeline": the length/duration answer is computed at
		// sample time, where the take's duration is known.
		speed: speed > 0 ? clamp(speed, 0.01, 50) : 0,
		faceTravel: value.faceTravel !== false,
		loop: value.loop === true,
		// Keep going in the final direction after the last point — the "just
		// keep moving that way" case, expressed as an option on a real path.
		extend: value.extend === true,
	};
}

/**
 * The same route, moved bodily by a translation. A prop and its route are one
 * body: playback reads the prop's position from the route alone, so a route
 * left behind would pin the prop to its old ground while every readout claimed
 * it had moved. Shape is preserved — only the room walls can bend it.
 */
export function translateObjectPath(path, delta) {
	const source = createObjectPath(path);
	if (!source) return null;
	const dx = finite(delta?.x);
	const dy = finite(delta?.y);
	const dz = finite(delta?.z);
	if (!dx && !dy && !dz) return source;
	return createObjectPath({
		...source,
		points: source.points.map((point) => ({ x: point.x + dx, y: point.y + dy, z: point.z + dz })),
	});
}

/**
 * The same route, turned bodily about a pivot: a rotating group carries every
 * child's route around with it, the way translateObjectPath carries it along.
 * `matrix` is a row-major 3x3 rotation (kept as plain numbers so this module
 * stays importable without three.js); every point goes to
 * `to + matrix · (point − from)`, so one call also covers a pivot that moved
 * in the same edit. Values are tidied at 1e-9 so float dust never accumulates
 * over a drag's many small steps. Shape is preserved; only the room walls and
 * the floor can bend it.
 */
export function rotateObjectPath(path, matrix, from, to) {
	const source = createObjectPath(path);
	if (!source) return null;
	if (!Array.isArray(matrix) || matrix.length !== 9 || !matrix.every((value) => Number.isFinite(value))) return source;
	const tidy = (value) => {
		const rounded = Math.round(value * 1e9) / 1e9;
		return rounded === 0 ? 0 : rounded;
	};
	const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = matrix;
	return createObjectPath({
		...source,
		points: source.points.map((point) => {
			const dx = point.x - finite(from?.x);
			const dy = point.y - finite(from?.y);
			const dz = point.z - finite(from?.z);
			return {
				x: tidy(finite(to?.x) + m0 * dx + m1 * dy + m2 * dz),
				y: tidy(finite(to?.y) + m3 * dx + m4 * dy + m5 * dz),
				z: tidy(finite(to?.z) + m6 * dx + m7 * dy + m8 * dz),
			};
		}),
	});
}

/*
 * The route as travelled is a curve, not the polyline of its points: a
 * centripetal Catmull-Rom through every authored point (the camera rail's
 * curve, in 3D so lifted points stay lifted), sampled every few centimetres.
 * A car rounds a corner instead of snapping to the next leg, and its heading
 * turns with the curve instead of jumping at each point. The ends are
 * extended by mirroring their neighbour, so a two-point route is still a
 * straight line and the curve still starts and ends on the authored points.
 */
const CURVE_SPACING = 0.05;
const CURVE_MAX_STEPS = 400;
const CURVE_ALPHA = 0.5; // centripetal: no loops or overshoot at tight corners
const curveCache = new Map();
const CURVE_CACHE_SIZE = 64;

const mirror = (point, neighbour) => ({ x: 2 * point.x - neighbour.x, y: 2 * point.y - neighbour.y, z: 2 * point.z - neighbour.z });
const span = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

function catmullRom(p0, p1, p2, p3, t) {
	const t0 = 0;
	const t1 = t0 + Math.max(span(p0, p1) ** CURVE_ALPHA, 1e-6);
	const t2 = t1 + Math.max(span(p1, p2) ** CURVE_ALPHA, 1e-6);
	const t3 = t2 + Math.max(span(p2, p3) ** CURVE_ALPHA, 1e-6);
	const at = t1 + (t2 - t1) * t;
	const lerp = (a, b, ta, tb) => {
		const w = tb - ta < 1e-12 ? 0 : (at - ta) / (tb - ta);
		return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w, z: a.z + (b.z - a.z) * w };
	};
	const a1 = lerp(p0, p1, t0, t1);
	const a2 = lerp(p1, p2, t1, t2);
	const a3 = lerp(p2, p3, t2, t3);
	return lerp(lerp(a1, a2, t0, t2), lerp(a2, a3, t1, t3), t1, t2);
}

function segmentControls(points, index) {
	const p1 = points[index];
	const p2 = points[index + 1];
	const p0 = index > 0 ? points[index - 1] : mirror(p1, p2);
	const p3 = index + 2 < points.length ? points[index + 2] : mirror(p2, p1);
	return [p0, p1, p2, p3];
}

const asPoint = (point) => ({ x: finite(point?.x), y: finite(point?.y), z: finite(point?.z) });

/** The point a fraction `t` along the curve between authored points
 * `index` and `index + 1` — where a point inserted on the drawn line goes. */
export function pathCurvePointBetween(points, index, t) {
	const list = (points ?? []).map(asPoint);
	if (index < 0 || index + 1 >= list.length) return null;
	const at = catmullRom(...segmentControls(list, index), clamp(finite(t), 0, 1));
	return { x: at.x, y: Math.max(0, at.y), z: at.z };
}

/**
 * The travelled curve: dense points, cumulative arc length, the total, and
 * a heading (yaw degrees, or null when the curve does not move on the floor)
 * at every dense point.
 */
export function pathCurve(path) {
	const points = (path?.points ?? []).map(asPoint);
	const key = points.map((point) => `${point.x},${point.y},${point.z}`).join(";");
	const cached = curveCache.get(key);
	if (cached) return cached;
	const dense = points.length ? [{ ...points[0] }] : [];
	for (let index = 0; index + 1 < points.length; index += 1) {
		const controls = segmentControls(points, index);
		const steps = clamp(Math.ceil(span(points[index], points[index + 1]) / CURVE_SPACING), 2, CURVE_MAX_STEPS);
		for (let step = 1; step <= steps; step += 1) {
			const at = step === steps ? { ...points[index + 1] } : catmullRom(...controls, step / steps);
			dense.push({ x: at.x, y: Math.max(0, at.y), z: at.z });
		}
	}
	const cumulative = dense.length ? [0] : [];
	for (let i = 1; i < dense.length; i += 1) cumulative.push(cumulative[i - 1] + span(dense[i - 1], dense[i]));
	// The tangent at each sample, from its neighbours: headings blend between
	// samples instead of stepping with every 5 cm segment.
	const headings = dense.map((_, i) => headingBetween(dense[Math.max(0, i - 1)], dense[Math.min(dense.length - 1, i + 1)]));
	const curve = { points: dense, cumulative, length: cumulative[cumulative.length - 1] ?? 0, headings };
	if (curveCache.size >= CURVE_CACHE_SIZE) curveCache.delete(curveCache.keys().next().value);
	curveCache.set(key, curve);
	return curve;
}

/** Arc length along the travelled curve, plus the total. */
export function pathMetrics(path) {
	const { cumulative, length } = pathCurve(path);
	return { cumulative, length };
}

/** Shortest-way blend between two yaws in degrees; null-safe. */
function blendHeading(a, b, weight) {
	if (a === null) return b;
	if (b === null) return a;
	const delta = ((((b - a) % 360) + 540) % 360) - 180;
	return a + delta * weight;
}

/** The point at `distance` along the curve, extrapolating past the end. */
function pointAtDistance(path, curve, distance) {
	const { points, cumulative, length, headings } = curve;
	if (distance <= 0) return { ...points[0], heading: headings[0] };
	const lastIndex = points.length - 1;
	if (distance >= length) {
		const last = points[lastIndex];
		const heading = headings[lastIndex];
		if (!path.extend) return { ...last, heading };
		// Past the end the object keeps its final direction and speed.
		const overshoot = distance - length;
		const previous = points[lastIndex - 1];
		const step = span(previous, last) || 1;
		return {
			x: last.x + ((last.x - previous.x) / step) * overshoot,
			y: Math.max(0, last.y + ((last.y - previous.y) / step) * overshoot),
			z: last.z + ((last.z - previous.z) / step) * overshoot,
			heading,
		};
	}
	let lo = 0;
	let hi = lastIndex;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (cumulative[mid] <= distance) lo = mid;
		else hi = mid;
	}
	const a = points[lo];
	const b = points[hi];
	const segment = cumulative[hi] - cumulative[lo];
	const weight = segment > 1e-9 ? (distance - cumulative[lo]) / segment : 0;
	return {
		x: a.x + (b.x - a.x) * weight,
		y: a.y + (b.y - a.y) * weight,
		z: a.z + (b.z - a.z) * weight,
		heading: blendHeading(headings[lo], headings[hi], weight),
	};
}

/** Yaw in degrees for travel from `a` to `b`, in the object's rotation frame. */
function headingBetween(a, b) {
	if (!a || !b) return null;
	const dx = b.x - a.x;
	const dz = b.z - a.z;
	if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return null;
	return (Math.atan2(dx, dz) * 180) / Math.PI;
}

/**
 * Where an object stands at `frame`. Returns null when the object has no
 * usable path, so callers fall back to its authored transform untouched.
 *
 * @param {object} object a scene object record
 * @param {number} frame absolute timeline frame
 * @param {{ frameCount: number, fps: number }} take timeline geometry
 */
export function objectTransformAt(object, frame, take = {}) {
	const path = createObjectPath(object?.path);
	if (!path) return null;
	const curve = pathCurve(path);
	if (curve.length <= 1e-9) return null;
	const frameCount = Math.max(1, Math.round(finite(take.frameCount, 1)));
	const fps = Math.max(1, finite(take.fps, 24));
	const sampled = clamp(finite(frame), 0, Math.max(0, frameCount - 1));
	const seconds = sampled / fps;
	// speed 0 = fill the timeline: cover the whole path across the take.
	const duration = Math.max(1e-6, (frameCount - 1) / fps);
	const speed = path.speed > 0 ? path.speed : curve.length / duration;
	// The travel window: the stretch of the take the route is walked in. The
	// timing envelope shapes progress INSIDE this window; the window's length
	// (and so the arrival frame) never moves — the area is the distance.
	const window = curve.length / speed;
	const u = seconds / Math.max(1e-6, window);
	let distance;
	if (path.loop && curve.length > 1e-9) {
		distance = curve.length * timingProgress(path.timing, u - Math.floor(u));
	} else if (u >= 1) {
		// Past the window: arrived. Extend keeps walking the final heading at
		// the plain average speed, exactly as it did before envelopes existed.
		distance = curve.length + (path.extend ? speed * (seconds - window) : 0);
	} else {
		distance = curve.length * timingProgress(path.timing, u);
	}
	const at = pointAtDistance(path, curve, distance);
	return {
		x: at.x,
		y: at.y,
		z: at.z,
		rot: path.faceTravel && at.heading !== null ? at.heading : null,
	};
}

/**
 * A drawn stroke becomes the FEWEST points that still carry its shape.
 *
 * The rail wants fidelity to the drawn curve; a travel route does not. A route
 * is a plan the operator then adjusts point by point, and a stroke that lands
 * twenty dots on the floor is a route nobody can grab. So this simplifies
 * coarsely and, if the shape is still busy, keeps coarsening until the count
 * fits under the ceiling: a straight drag gives two points, a dog-leg three,
 * and anything more elaborate stays inside a handful the hand can manage.
 * Points are added deliberately afterwards, by double-clicking the line.
 */
const STROKE_MAX_POINTS = 5;

export function strokeToPathPoints(stroke, simplify, { maxPoints = STROKE_MAX_POINTS, epsilon = 0.55 } = {}) {
	if (!stroke || stroke.length < 2) return [];
	let points = simplify(stroke, epsilon);
	// Escalate rather than pick a single magic epsilon: the right coarseness
	// depends on how big the drawn route is, which only the stroke knows.
	for (let step = 0; step < 12 && points.length > maxPoints; step += 1) {
		epsilon *= 1.8;
		points = simplify(stroke, epsilon);
	}
	if (points.length > maxPoints) {
		// A pathological stroke (every sample a corner) still ends bounded:
		// keep the ends and spread the rest evenly along the drawn order.
		const picked = [points[0]];
		for (let i = 1; i < maxPoints - 1; i += 1) picked.push(points[Math.round((i * (points.length - 1)) / (maxPoints - 1))]);
		picked.push(points[points.length - 1]);
		points = picked;
	}
	return points.map((point) => ({ x: point.x, y: 0, z: point.z }));
}

export { MAX_PATH_POINTS, MAX_HEIGHT as MAX_PATH_HEIGHT, STROKE_MAX_POINTS };
