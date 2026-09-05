/**
 * Line editing (ProjFlow, contract C6) — the pure half.
 *
 * The joint's EXISTING screen trajectory is drawn over the viewport and the
 * user grabs a point on it and pulls; the curve deforms under a Gaussian
 * falloff and the deformed curve is what the box is made to follow EXACTLY.
 * (This is the Disney scheduled-inpainting figure-1 interaction: drag the dots
 * on the motion curve.) Everything in this file is the part of that feature
 * that has no DOM, no React and no three.js in it: a projected curve in, a wire
 * payload out. It is kept separate from App.jsx for two reasons —
 *
 *   1. the camera maths below is the one place where a sign error produces a
 *      silently mirrored edit rather than a crash, so it has to be testable
 *      without a browser;
 *   2. App.jsx is 11k lines and the feature's diff there should be wiring,
 *      not arithmetic.
 *
 * NOTHING here imports three.js. Matrices arrive as plain 16-element arrays in
 * three's own column-major `elements` order, which is what `Matrix4.elements`
 * already is — the caller passes `[...m.elements]` and no adapter is needed.
 */

/**
 * The 15 track ids a line edit may name. Deliberately spelled out rather than
 * imported from ./ardy/ik.js: that module pulls in three.js for its contact
 * -radius measurement, and this one must stay loadable in a bare node test.
 *
 * The list IS the union of ik.js's three tables — IK_TRACKS (hands/feet),
 * MID_TRACKS (elbows/knees) and FK_TRACKS (hips/spine/chest/neck/head/
 * shoulders) — and it is also exactly the key set of TRACK_GROUPS in
 * tools/kimodo/preserve-mask.mjs, which is the bridge's own validation table.
 * App.jsx builds the picker's LABELS by looking each id up in those ik.js
 * tables, so a track added there without being added here shows up as a
 * missing option rather than as a silently wrong wire value.
 */
export const LINE_EDIT_TRACK_IDS = Object.freeze([
	// IK_TRACKS — effectors
	"leftHand",
	"rightHand",
	"leftFoot",
	"rightFoot",
	// MID_TRACKS — mid-chain handles
	"leftElbow",
	"rightElbow",
	"leftKnee",
	"rightKnee",
	// FK_TRACKS — torso and head
	"hips",
	"spine",
	"chest",
	"neck",
	"head",
	"leftShoulder",
	"rightShoulder",
]);

/** Upper bound on the polyline the app sends.
 *
 * The box builds TWO affine rows per constrained sample and then factorises an
 * m x m system (Cholesky, per the C7 amendment). 64 points is 128 rows, which
 * is comfortably inside what the sampler solves per ODE step, and it is far
 * more resolution than the deformed trajectory carries. A 200-frame range is
 * 200 curve points; sending them all would cost solve time for detail the
 * Gaussian falloff made smooth on purpose. */
export const MAX_LINE_POINTS = 64;

/** A polyline needs at least a start and an end (C6: `>= 2 points`). */
export const MIN_LINE_POINTS = 2;

/** How many curve points at EACH end are hard-pinned to the original
 * trajectory — never moved by a drag, never grabbable.
 *
 * This is the seam fix, and it is the reason this interaction replaced
 * freehand drawing. Gate GP2 measured it: an arbitrary drawn line pops the
 * take 3.9x/8.0x its own median frame delta at the range edges (the joint
 * teleports to wherever the stroke started), while a line whose ENDPOINTS sit
 * on the joint's own trajectory collapses that to 1.67x/1.09x. A Gaussian
 * never actually reaches zero — at 6 sigma it is still ~1e-8, and at the more
 * realistic "grab three frames from the end with radius 40" it is a very
 * visible fraction — so relying on the falloff alone would leave the endpoint
 * OFF the original trajectory by an amount that depends on where the user
 * happened to grab. Pinning makes the seam property structural instead of
 * probabilistic: points [0, 1] and [n-2, n-1] are returned byte-identical by
 * dragCurve, so the edit's first and last constrained frames are always
 * exactly where the take already put the joint. Two rather than one because a
 * single pinned frame still lets the SLOPE jump at the seam. */
export const PINNED_CURVE_ENDS = 2;

/** Influence-radius bounds, in FRAMES, for the panel's slider. 2 is a local
 * nudge (one gesture beat); 40 at 20 fps is two seconds, past which a drag
 * stops being an edit and becomes a different motion. */
export const DRAG_RADIUS_MIN = 2;
export const DRAG_RADIUS_MAX = 40;
export const DRAG_RADIUS_DEFAULT = 8;

/** Below this weight a point is not being dragged AT ALL: dragWeight returns
 * exactly 0 there, so dragCurve hands the point back by reference and the
 * overlay's influenced-span highlight, the identity-based curvesEqual test and
 * changedFrameRange (which names the frames a pull actually touched) all agree
 * on one boundary. Before the cutoff the Gaussian tail brushed every frame of
 * the clip with sub-5% weights, which made "the frames the pull touched" the
 * whole clip — and a whole-clip edit range leaves the box zero preserve rows. */
export const DRAG_WEIGHT_EPSILON = 0.05;

/** Grab tolerance for the hit test, in CSS pixels. */
export const CURVE_GRAB_RADIUS_PX = 14;

/** How far the camera may drift under a pulled curve before the curve stops
 * being DRAWABLE in the live view. The captured extrinsics and the authored uv
 * are a MATCHED PAIR: once the user orbits, the same uv names a different ray,
 * so the line can no longer be painted where it belongs and a second gesture
 * would author points through a lens the first ones never saw.
 *
 * What it does NOT invalidate is the edit: the committed curve carries its own
 * camera and that snapshot is what goes on the wire, so a pending edit survives
 * any amount of drift (App.jsx paints it detached and refuses new gestures
 * until the view comes back). 1e-4 is tighter than any deliberate nudge and
 * looser than float noise from re-deriving the same matrix. */
export const CAMERA_DRIFT_EPSILON = 1e-4;

/**
 * The rendering camera -> the C6 `camera` block: { fx, fy, cx, cy, R, t }.
 *
 * ============================ CONVENTION (read this) ======================
 * This is the contract the box-side driver builds its affine rows against
 *   [fx*R0 - (u - cx)*R2] X = -[fx*t0 - (u - cx)*t2]
 *   [fy*R1 - (v - cy)*R2] X = -[fy*t1 - (v - cy)*t2]
 * so every symbol below has to mean exactly one thing.
 *
 * UNITS. points2d are normalized 0..1 across the render viewport, so fx, fy,
 * cx, cy are in THOSE SAME uv units, not pixels. That is forced, not stylistic:
 * C6's camera block carries no width/height, so the only way (u - cx) can be
 * dimensionally consistent with fx is for both to live in uv. Multiply fx and
 * cx by the viewport width (fy, cy by its height) to recover pixel intrinsics.
 * cx and cy are therefore always exactly 0.5 for a three.js PerspectiveCamera,
 * which has no principal-point offset; they are still emitted so the box never
 * has to assume a centred principal point.
 *
 * AXES. u runs left->right and v runs TOP->BOTTOM, matching both the DOM
 * pointer coordinates the curve is grabbed in and the OpenCV image
 * convention. three.js NDC has y running bottom->top, so v is the flipped one:
 *   u = (x_ndc + 1) / 2
 *   v = (1 - y_ndc) / 2
 *
 * FRAME. R and t map WORLD -> an OPENCV camera frame: x right, y DOWN, z
 * FORWARD (into the screen, positive depth in front of the lens). three.js
 * cameras look down their own -Z with +Y up, so this function applies the
 * standard diag(1, -1, -1) flip to `matrixWorldInverse` — negating rows 1 and
 * 2 of the rotation and components 1 and 2 of the translation. With that flip
 * both fx and fy come out POSITIVE, which is why the flip is done here rather
 * than pushed onto the box as a sign convention it would have to remember.
 * The projection is then plain pinhole:
 *   Xc = R X + t ;  u = cx + fx * Xc0 / Xc2 ;  v = cy + fy * Xc1 / Xc2
 * with Xc2 > 0 for anything in front of the camera.
 *
 * R is 3x3 ROW-MAJOR as a flat 9-array of numbers (R[0..2] is the first row).
 * ==========================================================================
 *
 * @param {object} view
 * @param {number} view.fovDeg   three's VERTICAL field of view, in degrees.
 * @param {number} view.aspect   the camera's own `aspect` — the one baked into
 *   its projection matrix, which is not necessarily width/height (the shot
 *   camera is locked to the export aspect and letterboxed into its pane).
 * @param {number[]} view.matrixWorldInverse  16 numbers, three's column-major
 *   `elements` order, world -> three-camera.
 * @param {number} view.width    render viewport width in CSS px — the exact
 * @param {number} view.height   rectangle the curve's uv are normalized by.
 *   Only used to catch a caller that measured the curve against a different
 *   rectangle than the one the camera actually drew into.
 */
export function cameraToC6({ fovDeg, aspect, matrixWorldInverse, width, height }) {
	if (!Number.isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 180) {
		throw new Error(`cameraToC6: fovDeg must be a vertical FOV in (0, 180), got ${JSON.stringify(fovDeg)}`);
	}
	if (!Number.isFinite(aspect) || aspect <= 0) {
		throw new Error(`cameraToC6: aspect must be a positive number, got ${JSON.stringify(aspect)}`);
	}
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		throw new Error(`cameraToC6: width/height must be positive, got ${JSON.stringify([width, height])}`);
	}
	const e = matrixWorldInverse;
	if (!e || e.length !== 16 || !Array.prototype.every.call(e, Number.isFinite)) {
		throw new Error("cameraToC6: matrixWorldInverse must be 16 finite numbers (three's column-major elements)");
	}
	// The image rectangle the caller normalized against must match the aspect
	// the projection matrix was built with, or u and v are measured in a
	// different space than fx and fy describe and the whole edit lands skewed.
	// The callers fit the pane to the camera's aspect (dualview's fitAspect),
	// so a mismatch here is a wiring bug, not a user action.
	if (Math.abs(width / height - aspect) > 1e-3 * aspect) {
		throw new Error(
			`cameraToC6: viewport aspect ${(width / height).toFixed(4)} does not match camera aspect ${aspect.toFixed(4)} — ` +
			"the curve was measured against a rectangle the camera did not draw into",
		);
	}

	// Vertical FOV -> uv intrinsics. Derivation, from three's own perspective
	// projection: x_ndc = Xc_x / (aspect * tan(fov/2) * -Zc) and
	// y_ndc = Yc_y / (tan(fov/2) * -Zc). Substituting u = (x_ndc + 1)/2 and
	// v = (1 - y_ndc)/2 gives the halves below.
	const tanHalfFov = Math.tan((fovDeg * Math.PI) / 360);
	const fx = 0.5 / (aspect * tanHalfFov);
	const fy = 0.5 / tanHalfFov;

	// three's Matrix4.elements is COLUMN-major: element(row, col) = e[col*4+row].
	const m = (row, col) => e[col * 4 + row];
	// diag(1, -1, -1) * [R | t] — the three-camera (y up, -z forward) to
	// OpenCV-camera (y down, +z forward) change of basis described above.
	const R = [
		m(0, 0), m(0, 1), m(0, 2),
		-m(1, 0), -m(1, 1), -m(1, 2),
		-m(2, 0), -m(2, 1), -m(2, 2),
	];
	const t = [m(0, 3), -m(1, 3), -m(2, 3)];
	return { fx, fy, cx: 0.5, cy: 0.5, R, t };
}

/**
 * Project a world point through a C6 camera block into the uv the curve lives
 * in. It is what builds the editable trajectory below, and it is the direct
 * inverse-check of cameraToC6: if a projected joint does not land on the joint
 * the user sees, the convention above is wrong and the curve makes that visible
 * immediately.
 *
 * Returns null for points at or behind the lens (depth <= 0), which have no
 * image.
 */
export function projectPointC6(camera, x, y, z) {
	const { fx, fy, cx, cy, R, t } = camera;
	const xc = R[0] * x + R[1] * y + R[2] * z + t[0];
	const yc = R[3] * x + R[4] * y + R[5] * z + t[1];
	const zc = R[6] * x + R[7] * y + R[8] * z + t[2];
	if (!(zc > 1e-6)) return null;
	return [cx + (fx * xc) / zc, cy + (fy * yc) / zc];
}

/**
 * A uv drag -> a WORLD-space delta in the plane through `point` that faces the
 * camera. The pin gesture's whole 2D-to-3D step.
 *
 * A screen drag names two of three degrees of freedom and the third has to come
 * from somewhere. Every DCC answers the same way for an unconstrained effector
 * drag: keep the depth the point already had and move it in the image plane. So
 * the point's camera-space depth zc is measured once, a uv delta becomes a
 * camera-space delta (du*zc/fx, dv*zc/fy, 0) — the exact inverse of the pinhole
 * projection at that depth — and R transposed carries it back to world. The
 * consequence is worth saying out loud: the pin lands exactly under the pointer
 * in the view it was authored in, and its depth is the take's own. Nothing here
 * guesses at depth, which is precisely the guess that would make a pin
 * unpredictable.
 *
 * R is world->camera and orthonormal, so its transpose is its inverse; that is
 * the one property this function leans on and it is guaranteed by cameraToC6.
 *
 * Returns null for a point at or behind the lens, which has no image and
 * therefore no image-plane to slide in.
 */
export function unprojectDeltaC6(camera, point, du, dv) {
	if (!camera || !Array.isArray(point) || point.length !== 3) return null;
	if (!Number.isFinite(du) || !Number.isFinite(dv)) return null;
	const { fx, fy, R } = camera;
	const t = camera.t;
	const zc = R[6] * point[0] + R[7] * point[1] + R[8] * point[2] + t[2];
	if (!(zc > 1e-6)) return null;
	const dxc = (du * zc) / fx;
	const dyc = (dv * zc) / fy;
	// R^T @ [dxc, dyc, 0] — column j of R^T is row j of R.
	return [
		R[0] * dxc + R[3] * dyc,
		R[1] * dxc + R[4] * dyc,
		R[2] * dxc + R[5] * dyc,
	];
}

/* ===================== the editable trajectory curve =======================
 * A "curve" throughout this file is a DENSE, FRAME-INDEXED array: one entry per
 * frame of the edit range, in order, either `{ frame, u, v }` or `null` for a
 * frame whose joint is behind the lens and therefore has no image.
 *
 * Dense-and-frame-indexed is the load-bearing property. C6 spreads points2d
 * across frameRange, so index i of the curve IS frame startFrame + i; that is
 * what lets a drag mean "move the joint at THIS moment" instead of "move this
 * point of a shape", and it is why the falloff below is measured in frames.
 * Nothing in here compacts the array — nulls keep their slot.
 * ========================================================================== */

/** Is this curve point inside the drawable viewport?
 *
 * A point can leave 0..1 two ways: it was already offscreen when the trail was
 * projected (the joint is out of frame at that moment), or a drag pushed it
 * out. Both are the same fact for the UI — it cannot be grabbed and it cannot
 * be sent, because the bridge refuses points2d outside 0..1. */
export function isCurvePointOnScreen(point) {
	return !!point && point.u >= 0 && point.u <= 1 && point.v >= 0 && point.v <= 1;
}

/** Is this index one of the hard-pinned ends? See PINNED_CURVE_ENDS. */
export function isCurveEndPinned(index, length) {
	return index < PINNED_CURVE_ENDS || index >= length - PINNED_CURVE_ENDS;
}

/**
 * Gaussian falloff weight for a point `distanceFrames` away from the grab.
 *
 * sigma = radius/2, so `radiusFrames` reads as "the span I am pulling": the
 * weight is 1 at the grab, 0.61 at radius/2, 0.135 at the radius itself and
 * ~1e-4 at twice it. Exported (rather than inlined in dragCurve) because the
 * overlay paints the influenced span with the SAME formula — two independent
 * spellings of one falloff is how the drawn highlight drifts from the applied
 * deformation.
 *
 * NOT the smoothstep in motion-trail.js: that one is compact (exactly 0 at the
 * radius) because it edits 3D world positions where a hard boundary is fine.
 * Here a C1 tail is what keeps the deformed trajectory from developing a crease
 * the sampler would then have to follow exactly.
 */
export function dragWeight(distanceFrames, radiusFrames) {
	const radius = Number(radiusFrames);
	const distance = Number(distanceFrames);
	if (!Number.isFinite(distance)) return 0;
	if (!(radius > 0)) return distance === 0 ? 1 : 0;
	const sigma = radius / 2;
	const weight = Math.exp(-(distance * distance) / (2 * sigma * sigma));
	// Hard zero past the tail (see DRAG_WEIGHT_EPSILON): a pull must touch a
	// bounded window of frames, not brush the whole clip with 1% ghosts.
	return weight < DRAG_WEIGHT_EPSILON ? 0 : weight;
}

/**
 * The joint's world-space trail -> the on-screen curve the user grabs.
 *
 * `trail` is the flat Float32Array from motion-trail's jointTrailPoints (3
 * floats per frame of the WHOLE take); `frameRange` is C6's half-open app-clip
 * range; `camera` is the C6 block the range will be sent with. Frames past the
 * end of the trail and frames whose joint is behind the lens come back as
 * null. Points OUTSIDE 0..1 are kept as they are — the joint really is over
 * there, just not in shot, and the caller wants to say so rather than pretend
 * the trajectory stops at the frame edge.
 */
export function projectTrailCurve({ trail, frameRange, camera }) {
	if (!trail || !camera || !frameRange) return null;
	const start = Math.max(0, Math.trunc(frameRange.startFrame));
	const end = Math.trunc(frameRange.endFrame);
	if (!(end > start)) return null;
	const trailFrames = Math.floor(trail.length / 3);
	const curve = [];
	for (let frame = start; frame < end; frame += 1) {
		if (frame >= trailFrames) {
			curve.push(null);
			continue;
		}
		const uv = projectPointC6(camera, trail[frame * 3], trail[frame * 3 + 1], trail[frame * 3 + 2]);
		curve.push(uv ? { frame, u: uv[0], v: uv[1] } : null);
	}
	return curve;
}

/**
 * Re-anchor an authored curve in WORLD space and see it through another lens.
 *
 * A committed edit is uv through the camera it was authored in; painted
 * verbatim after the view moves, those uv land wherever the new lens happens
 * to point (the "line floats across the floor" bug). But the depth a naive
 * reprojection lacks is sitting in the take: each curve point names a frame,
 * and the joint's ORIGINAL world position at that frame is in `trail`. So per
 * point: measure the authored uv against the original point's image under
 * `fromCamera`, lift that uv offset into world with unprojectDeltaC6 (image-
 * plane at the joint's own depth — the same rule the pin gesture uses), and
 * project the resulting WORLD point through `toCamera`. An unedited point
 * therefore lands exactly on the trajectory under the new lens, and an edited
 * one shows its true world displacement from wherever the user now stands.
 *
 * Display only: the wire payload keeps the authored camera + uv untouched,
 * because a 2D constraint is a ray through ITS lens — rewriting it through
 * another lens would change what the sampler is asked to satisfy.
 *
 * `trail` is jointTrailPoints' flat Float32Array for the whole take. Points
 * that cannot make the trip — null in, frame off the trail's end, original or
 * edited point behind either lens — come back null, which the painter already
 * treats as "no image at this frame". Returns null (not a partial curve) when
 * the inputs themselves are unusable.
 */
export function reprojectCurveWorld(curve, trail, fromCamera, toCamera) {
	if (!Array.isArray(curve) || !trail || !fromCamera || !toCamera) return null;
	const trailFrames = Math.floor(trail.length / 3);
	const out = [];
	for (const point of curve) {
		if (!point || !Number.isInteger(point.frame) || point.frame < 0 || point.frame >= trailFrames) {
			out.push(null);
			continue;
		}
		const x = trail[point.frame * 3];
		const y = trail[point.frame * 3 + 1];
		const z = trail[point.frame * 3 + 2];
		const authored = projectPointC6(fromCamera, x, y, z);
		if (!authored) {
			out.push(null);
			continue;
		}
		const delta = unprojectDeltaC6(fromCamera, [x, y, z], point.u - authored[0], point.v - authored[1]);
		if (!delta) {
			out.push(null);
			continue;
		}
		const uv = projectPointC6(toCamera, x + delta[0], y + delta[1], z + delta[2]);
		out.push(uv ? { frame: point.frame, u: uv[0], v: uv[1] } : null);
	}
	return out;
}

/**
 * Pull one point of the curve and let the neighbours follow — a new curve out,
 * the input untouched.
 *
 * `du`/`dv` are the pointer's total travel since the grab, in normalized uv,
 * and they are applied to the curve AS IT WAS AT GRAB TIME (the caller keeps
 * that snapshot). That makes a single drag idempotent: moving the pointer back
 * to where it started restores the curve exactly, and re-running the function
 * with a different radius mid-drag re-derives the whole deformation instead of
 * compounding it. Successive drags stack because each new grab snapshots the
 * curve the previous one produced.
 *
 * Null points stay null (no image, nothing to move) and the outermost
 * PINNED_CURVE_ENDS points on each side are returned by reference, unmoved —
 * the seam guarantee, argued at that constant.
 */
export function dragCurve(curve, grabIndex, du, dv, radiusFrames) {
	if (!Array.isArray(curve)) return curve;
	const deltaU = Number(du);
	const deltaV = Number(dv);
	if (!Number.isFinite(deltaU) || !Number.isFinite(deltaV)) return curve;
	const length = curve.length;
	return curve.map((point, index) => {
		if (!point) return null;
		if (isCurveEndPinned(index, length)) return point;
		const weight = dragWeight(index - grabIndex, radiusFrames);
		// Not an approximation of zero — an untouched point must come back as
		// the SAME object so an unedited stretch of curve compares equal to the
		// original without a float epsilon.
		if (weight === 0) return point;
		return { frame: point.frame, u: point.u + deltaU * weight, v: point.v + deltaV * weight };
	});
}

/**
 * The half-open app-frame window a pull actually touched.
 *
 * dragCurve returns UNTOUCHED points by reference (weight 0 and the pinned
 * ends), so "touched" is object identity — no float epsilon, no threshold on a
 * Gaussian tail. This exists because a pull used to inherit the panel's range,
 * which defaults to the WHOLE CLIP: with no frames left outside the edit range
 * there were no preserve rows, and the sampler re-rolled the entire body of the
 * entire clip — a 25 px nudge moved frames four metres, eight seconds away. The
 * frames the falloff touched are the only frames the artist asked about; the
 * splice guards everything else.
 *
 * `pad` breathes a couple of frames so the seam ease has room; `minFrames`
 * keeps a one-frame flick from asking the sampler for a sub-perceptual window.
 * Returns null when nothing changed or the curve carries no frame numbers.
 */
export function changedFrameRange(before, after, { pad = 2, minFrames = 8, clipFrames } = {}) {
	if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return null;
	let first = -1;
	let last = -1;
	for (let index = 0; index < after.length; index += 1) {
		if (after[index] !== before[index]) {
			if (first < 0) first = index;
			last = index;
		}
	}
	if (first < 0) return null;
	const firstFrame = after[first]?.frame ?? before[first]?.frame;
	const lastFrame = after[last]?.frame ?? before[last]?.frame;
	if (!Number.isFinite(firstFrame) || !Number.isFinite(lastFrame)) return null;
	let start = Math.trunc(firstFrame) - pad;
	let end = Math.trunc(lastFrame) + 1 + pad;
	const grow = minFrames - (end - start);
	if (grow > 0) {
		start -= Math.ceil(grow / 2);
		end += Math.floor(grow / 2);
	}
	start = Math.max(0, start);
	if (Number.isFinite(clipFrames)) {
		end = Math.min(end, clipFrames);
		start = Math.max(0, Math.min(start, end - minFrames));
	}
	if (end - start < 2) return null;
	return { startFrame: start, endFrame: end };
}

/**
 * The curve's points whose frame lies inside the half-open range.
 *
 * The wire pairing is positional: driver.py spreads points2d across frameRange
 * by time, so the points MUST be exactly the range's own frames. A dragged
 * curve spans whatever window it was projected over (the whole clip by
 * default); once the committed range shrinks to the touched frames, sending the
 * unsliced curve would compress eight seconds of trail into a half-second
 * window. A curve that already spans the range comes back unchanged.
 */
export function sliceCurveToRange(curve, frameRange) {
	if (!Array.isArray(curve) || !frameRange) return curve;
	const { startFrame, endFrame } = frameRange;
	if (!Number.isFinite(startFrame) || !Number.isFinite(endFrame)) return curve;
	// Nulls (frames behind the lens) carry no frame number, but the curve is
	// dense and index-aligned, so any named point anchors the index -> frame map
	// and the nulls inherit their frame from position.
	const anchor = curve.findIndex((point) => point && Number.isFinite(point.frame));
	if (anchor < 0) return curve;
	const base = curve[anchor].frame - anchor;
	const sliced = curve.filter((point, index) => {
		const frame = point && Number.isFinite(point.frame) ? point.frame : base + index;
		return frame >= startFrame && frame < endFrame;
	});
	return sliced.length === curve.length ? curve : sliced;
}

/** How long a freehand stroke has to be before it is a STROKE rather than a
 * click, in CSS pixels. Measured by the caller, which is the only side that
 * knows how big the pane is; a press-and-release with a few pixels of hand
 * tremor is a click, and a click must never wipe an edit that is already there
 * (that exact regression is why the drag commit compares curvesEqual). */
export const DRAW_MIN_STROKE_PX = 8;

/** Fewest samples a stroke needs before it names a shape at all. One point is a
 * dot: it has no direction, no length and nothing to parameterize. */
export const DRAW_MIN_STROKE_POINTS = 2;

/* ==================== the drawn stroke's frame association ==================
 * THE PROBLEM THE PAPER DOES NOT HAVE. ProjFlow's 2D-to-3D lifting (paper 4.3.2)
 * constrains frame n of the motion to the 2D point y_{n,j}, and it "follows the
 * 2D heart trajectory exactly at every frame" — but that per-frame association
 * is FREE in their setup, because their 2D condition is the reprojection of a
 * real motion under a known camera: point n exists because frame n exists. A
 * human drawing on a viewport supplies a SHAPE and nothing else. Every one of
 * the three ways v1 was unusable comes from inventing that association badly:
 *
 *   1. the stroke was spread over the panel's frameRange, which defaults to the
 *      WHOLE CLIP, so a two-inch hook became an eight-second crawl;
 *   2. the ends were pinned to the trail 2 frames in, so a stroke drawn away
 *      from the trail teleported the joint there inside 2 frames;
 *   3. arc length was spread UNIFORMLY over those frames, erasing the take's own
 *      velocity profile (a fast fall + slow recovery became one constant glide).
 *
 * The fix for all three is to RECOVER the association the paper gets for free:
 * match the stroke back onto the joint's own projected trail. The trail is the
 * reprojection of the take under the live camera — exactly the object ProjFlow's
 * y is built from — so "where on the trail did this stroke start and end" is a
 * well-posed question with a screen-space answer, and answering it fixes the
 * range (matchStrokeWindow), the timing (baseArcFractions) and the seam
 * (seamEaseFrames) at once.
 * ========================================================================== */

/** Shortest window, in frames, a matched stroke may name.
 *
 * Below this the two matched frames are not naming a stretch of path at all —
 * they are the two ends of a stroke drawn ACROSS a bunched trail, where the
 * whole visible path is a few pixels wide and both endpoints land on nearly the
 * same frame. Rerouting 3 frames of a 24 fps take is a twitch, not an edit. */
export const DRAW_MIN_WINDOW_FRAMES = 8;

/** The window a bunched match falls back to: one second at the timeline's 24
 * fps, centred on the frame both endpoints matched. "I drew across the path
 * here" can only sanely mean "around this moment", and a second is the smallest
 * span an artist reads as a gesture rather than a pop. */
export const DRAW_BUNCHED_WINDOW_FRAMES = 24;

/** How far apart, in CSS pixels, the two matched trail points must be before
 * the match is believed.
 *
 * A frame-count test alone is not enough, and the take that motivated drawing
 * proves it: a hand that travels two pixels across the image over 120 frames
 * still has a strictly increasing trail, so a stroke drawn ACROSS it matches
 * its ends to frames 0 and 119 and "reroute this part" silently becomes
 * "reroute the whole clip" — the original complaint, reintroduced through the
 * back door. The honest question is whether the stroke's two ends picked out
 * two distinguishable PLACES on the path, and that is a screen-distance
 * question. Twice the grab radius is the app's own scale for "the same spot":
 * inside it a user could not have aimed at one end rather than the other. */
export const DRAW_MATCH_MIN_SEPARATION_PX = 2 * CURVE_GRAB_RADIUS_PX;

/** Seam easing, replacing the hard 2-frame pin on the DRAW path only.
 *
 * PINNED_CURVE_ENDS argues why a drag pins: a Gaussian never reaches zero, so
 * without a pin the drag's endpoint sits off the original trail by an amount
 * that depends on where the user grabbed. A DRAWN stroke has the opposite
 * problem — its endpoint is wherever the hand stopped, so a hard pin does not
 * remove the gap, it CONCENTRATES it into the two frames next to the pin. GP2
 * measured that: an arbitrary line pops the take 3.9x/8.0x its own median frame
 * delta at the range edges.
 *
 * So the draw path ramps instead. Over the outer `fraction` of the window the
 * curve is lerp(base, stroke, w) with w a smoothstep from 0 at the very edge to
 * 1 in the interior. Two properties matter and both are structural:
 *   - w(edge) = 0 EXACTLY, so the first and last constrained frames are still
 *     byte-identically on the original trail (the pin's guarantee, kept);
 *   - w'(edge) = 0 too (smoothstep is flat at both ends), so the curve leaves
 *     the seam along the ORIGINAL trail's own slope. That is strictly stronger
 *     than the 2-frame pin, whose second point was there precisely because one
 *     pinned frame still let the slope jump.
 * Because auto-ranging puts the stroke's ends near the trail to begin with, the
 * ramp usually has almost nothing to absorb; when it does, it converts a
 * teleport into a glide.
 *
 * 15% with a 12-frame cap is the documented GP2 follow-up ("free the first/last
 * ~15% of line frames") clipped to the paper's own temporal neighbourhood:
 * ProjFlow's dynamic masking uses l_max = 10 frames around a hard observation
 * (Table 5), so a dozen frames is the scale at which the sampler already thinks
 * about "near a constraint". The 2-frame floor keeps the shortest legal window
 * behaving exactly like the pin it replaces. */
export const SEAM_EASE_FRACTION = 0.15;
export const SEAM_EASE_MIN = 2;
export const SEAM_EASE_MAX = 12;

/** How many frames at EACH end of a window of `length` frames are eased.
 * Capped at a third of the window so the two ramps can never meet and leave the
 * stroke with no interior of its own. */
export function seamEaseFrames(length, { fraction = SEAM_EASE_FRACTION, min = SEAM_EASE_MIN, max = SEAM_EASE_MAX } = {}) {
	const n = Math.trunc(length);
	// A 2-frame window is nothing but its two edges: there is no interior for a
	// ramp to reach, and 0 hands the caller back to the pin path, which says the
	// same thing without pretending to ease anything.
	if (!(n >= 3)) return 0;
	const wanted = Math.round(n * fraction);
	const capped = Math.min(max, Math.max(min, wanted));
	return Math.max(1, Math.min(capped, Math.floor((n - 1) / 2)));
}

/** The ramp itself: 0 at either edge of the window, 1 once `easeFrames` in.
 *
 * Exported so the overlay and the tests read the SAME curve the blend applies —
 * a second spelling of a falloff is how a drawn highlight drifts from the
 * deformation it claims to describe (the lesson dragWeight already carries). */
export function seamEaseWeight(index, length, easeFrames) {
	const n = Math.trunc(length);
	const ease = Math.trunc(easeFrames);
	if (!(n >= 2)) return 1;
	if (!(ease > 0)) return index <= 0 || index >= n - 1 ? 0 : 1;
	const distance = Math.min(index, n - 1 - index);
	if (distance <= 0) return 0;
	if (distance >= ease) return 1;
	const t = distance / ease;
	// smoothstep: flat at both ends, which is the slope-continuity claim above.
	return t * t * (3 - 2 * t);
}

/**
 * The BASE trail's cumulative screen arc-length fraction at each frame of a
 * window — the timing a drawn stroke is replayed with.
 *
 * This is redesign point (B), and it is what keeps a re-routed motion looking
 * like the same performance. Uniform spacing along the stroke says "the joint
 * crosses the new path at a constant speed", which is true of no motion anybody
 * animates: the take's hand falls fast and recovers slowly, and spreading the
 * stroke evenly turns both into one glide. Sampling the stroke at the fraction
 * of arc length the ORIGINAL had already covered by frame f keeps the fast part
 * fast and the slow part slow — the path changes, the phrasing does not.
 *
 * Screen-space arc length, not world: the stroke is a screen object, the trail
 * it is replacing was measured on the same screen, and the two are only
 * comparable there. Null frames (joint behind the lens) contribute zero length
 * and inherit their neighbour's fraction, which keeps the sequence monotone
 * without inventing a position for them.
 *
 * Returns an array of `curve.length` fractions rising from 0 to 1, or null when
 * the base is degenerate (a stationary joint, total length ~0) — the caller
 * falls back to uniform, which is the only honest reading of "no velocity
 * profile to preserve".
 */
export function baseArcFractions(curve, { epsilon = 1e-9 } = {}) {
	if (!Array.isArray(curve) || curve.length < 2) return null;
	const cumulative = new Array(curve.length).fill(0);
	let previous = null;
	let total = 0;
	for (let i = 0; i < curve.length; i += 1) {
		const point = curve[i];
		if (point && previous) total += Math.hypot(point.u - previous.u, point.v - previous.v);
		if (point) previous = point;
		cumulative[i] = total;
	}
	if (!(total > epsilon)) return null;
	return cumulative.map((value) => value / total);
}

/**
 * Which stretch of the joint's own path did this stroke draw over?
 *
 * `fullCurve` is projectTrailCurve run over the WHOLE clip — the original trail,
 * never a previously drawn edit, so redrawing re-matches against the same
 * reference instead of chasing its own last answer. The stroke's first and last
 * samples are matched to their nearest trail frames in PIXELS (uv distance is
 * anisotropic; the same argument nearestCurvePoint makes), and the two matched
 * frames become the edit's range.
 *
 * A stroke drawn end-to-start is not an error and not a reversal of the take:
 * the artist traced the same stretch of path the other way round. The window is
 * ordered start < end regardless and `reversed` is reported, so the caller can
 * walk the stroke backwards and land a curve that runs forwards in time.
 *
 * Returns `{ startFrame, endFrame, reversed }` (endFrame EXCLUSIVE, like every
 * range on this wire) or null when nothing on the trail is on screen to match
 * against — the caller then keeps whatever range the panel already shows, which
 * is the only remaining meaning available.
 */
export function matchStrokeWindow(stroke, fullCurve, {
	paneW,
	paneH,
	clipFrames,
	minWindowFrames = DRAW_MIN_WINDOW_FRAMES,
	bunchedWindowFrames = DRAW_BUNCHED_WINDOW_FRAMES,
	minSeparationPx = DRAW_MATCH_MIN_SEPARATION_PX,
} = {}) {
	if (!Array.isArray(stroke) || !Array.isArray(fullCurve) || fullCurve.length < MIN_LINE_POINTS) return null;
	if (!(paneW > 0) || !(paneH > 0)) return null;
	const samples = stroke.filter((s) => Array.isArray(s) && s.length >= 2 && Number.isFinite(Number(s[0])) && Number.isFinite(Number(s[1])));
	if (samples.length < DRAW_MIN_STROKE_POINTS) return null;

	// Unlike nearestCurvePoint this accepts EVERY on-screen point, ends included:
	// matching is not grabbing, and the frame a stroke starts over is a perfectly
	// good answer even when that frame would be undraggable.
	const nearestFrame = (u, v) => {
		let best = null;
		for (const point of fullCurve) {
			if (!isCurvePointOnScreen(point)) continue;
			const dist = Math.hypot((point.u - u) * paneW, (point.v - v) * paneH);
			if (!best || dist < best.dist) best = { frame: point.frame, u: point.u, v: point.v, dist };
		}
		return best;
	};
	const head = samples[0];
	const tail = samples[samples.length - 1];
	const a = nearestFrame(Number(head[0]), Number(head[1]));
	const b = nearestFrame(Number(tail[0]), Number(tail[1]));
	if (!a || !b) return null;

	const reversed = b.frame < a.frame;
	let start = Math.min(a.frame, b.frame);
	let end = Math.max(a.frame, b.frame) + 1;

	// The clip is the only hard wall; without one, the trail's own extent is.
	const firstFrame = fullCurve[0]?.frame ?? 0;
	const limit = Number.isFinite(clipFrames)
		? Math.trunc(clipFrames)
		: firstFrame + fullCurve.length;
	const floor = Math.max(0, firstFrame);

	const separationPx = Math.hypot((a.u - b.u) * paneW, (a.v - b.v) * paneH);
	const bunched = end - start < Math.max(MIN_LINE_POINTS, Math.trunc(minWindowFrames))
		|| separationPx < minSeparationPx;
	if (bunched) {
		// BUNCHED TRAIL. The two ends landed on the same PLACE on the path — one
		// frame apart, or a couple of pixels apart on a trail that projects into
		// a dot — so the stroke crosses the path rather than running along it and
		// the frames it named are noise. Take a second around the moment it
		// crossed: sliding the window to keep its length when it hits a clip
		// edge, then clipping if the clip is shorter than a second.
		const want = Math.max(MIN_LINE_POINTS, Math.trunc(bunchedWindowFrames));
		const centre = (start + end) / 2;
		start = Math.round(centre - want / 2);
		end = start + want;
		if (start < floor) { start = floor; end = start + want; }
		if (end > limit) { end = limit; start = Math.max(floor, end - want); }
	}
	if (!(end - start >= MIN_LINE_POINTS)) return null;
	return { startFrame: start, endFrame: end, reversed };
}

/** The slice of a whole-clip curve a frame range names, with the frame numbers
 * respected rather than assumed equal to the index. Returns null when the range
 * is not fully covered — a half-covered window would silently shorten the edit
 * and the caller would never know which frames it actually sent. */
export function curveWindow(curve, { startFrame, endFrame } = {}) {
	if (!Array.isArray(curve) || curve.length === 0) return null;
	const first = curve[0]?.frame;
	// Nulls carry no frame, so anchor on the first point that has one and count
	// from there — the array is dense in FRAMES by construction.
	let offset = null;
	for (let i = 0; i < curve.length; i += 1) {
		if (curve[i]) { offset = curve[i].frame - i; break; }
	}
	if (offset === null) offset = Number.isFinite(first) ? first : 0;
	const from = Math.trunc(startFrame) - offset;
	const to = Math.trunc(endFrame) - offset;
	if (!(from >= 0 && to <= curve.length && to - from >= MIN_LINE_POINTS)) return null;
	return curve.slice(from, to);
}

/**
 * A freehand stroke -> the same dense frame-indexed curve a drag produces.
 *
 * This is the OTHER half of the interaction: on takes whose projected trail
 * bunches into a handful of screen pixels there is nothing to grab, so a press
 * on empty space draws a new path instead of doing nothing. The result has to
 * be indistinguishable from a dragged curve — same shape, same nulls, same
 * pinned ends — because everything downstream (preview, undo, curveToPoints2d,
 * the drift watcher) is written against that one type.
 *
 * ARC LENGTH, NOT SAMPLE INDEX. Frame at position `index` of the range samples
 * the stroke at the point `index / (length - 1)` of the way along its TOTAL
 * LENGTH, walking the polyline and interpolating inside the segment it lands
 * in. That is what makes drawing SPEED irrelevant: a stroke drawn slowly at the
 * start and flicked at the end carries a crowd of samples near its beginning,
 * and sampling by sample index would hand the crowded part most of the frames
 * and re-time the take. Arc length reads the stroke as a SHAPE, which is the
 * only thing a hand-drawn line honestly carries. (Note the deliberate contrast
 * with curveToPoints2d, which downsamples by index precisely because the curve
 * it is given DOES carry timing — index i is frame startFrame + i.)
 *
 * The parameterization is endpoint-inclusive: index 0 sits at the stroke's
 * start and index length-1 at its end, so the whole drawn shape is used.
 *
 * PINNED ENDS ARE THE SEAM GUARANTEE — or `easeFrames` is, which is the same
 * guarantee said in a way a drawn line can keep. With `pinnedEnds` (the default,
 * and what a DRAG uses) the first and last entries come back BY REFERENCE from
 * `baseCurve`, exactly as dragCurve returns them. With `easeFrames` the outer
 * frames are BLENDED toward the stroke instead, w = 0 at the very edge rising by
 * smoothstep to 1 in the interior; see SEAM_EASE_FRACTION for why a drawn stroke
 * needs the ramp and a drag does not. The two are mutually exclusive: an eased
 * blend that also pinned would just move the discontinuity inward.
 *
 * TIMING. `arcFractions` (from baseArcFractions) replaces the uniform
 * index/(n-1) parameterization with the base trail's own cumulative arc-length
 * fraction, so the take's velocity profile survives the reroute. Absent, the
 * mapping is uniform — the honest reading when there is no profile to preserve.
 *
 * `reversed` walks the stroke from its last sample to its first, for a stroke
 * the artist traced end-to-start over the path.
 *
 * Nulls in `baseCurve` stay null, again like dragCurve: a frame whose joint is
 * behind the lens has no image, and a stroke cannot invent one.
 *
 * @param {Array<[number, number]>} stroke  pointer samples in the SAME
 *   viewport-normalized uv the curve lives in, in the order they were drawn.
 * @param {Array<{frame:number,u:number,v:number}|null>} baseCurve  the dense
 *   frame-indexed curve whose interior this stroke replaces (the curve as it is
 *   right now, so drawing twice means the second drawing wins and a drag after
 *   a draw refines the drawn curve).
 * @param {object} [options]
 * @param {number} [options.pinnedEnds]  how many entries at each end stay put.
 * @param {number} [options.easeFrames]  ramp width in frames at each end;
 *   non-zero REPLACES pinnedEnds with a blend.
 * @param {number[]} [options.arcFractions]  per-index position along the stroke
 *   in 0..1; defaults to uniform.
 * @param {boolean} [options.reversed]  walk the stroke backwards.
 * @param {number} [options.minLength]  refuse strokes shorter than this in uv
 *   units. 0 (the default) still refuses a stroke of zero length — the callers
 *   measure their own threshold in PIXELS, where the user drew it.
 * @returns a new curve, or null when the stroke is a no-op click.
 */
export function strokeToCurve(stroke, baseCurve, {
	pinnedEnds = PINNED_CURVE_ENDS,
	minLength = 0,
	easeFrames = 0,
	arcFractions = null,
	reversed = false,
} = {}) {
	if (!Array.isArray(baseCurve) || baseCurve.length < MIN_LINE_POINTS) return null;
	if (!Array.isArray(stroke)) return null;
	// Non-finite samples are dropped rather than poisoning the arc length: a
	// pointer event outside a settled pane can produce one, and a single NaN
	// would otherwise turn the whole curve into NaN and be refused much later
	// with a message about the wire format.
	const points = [];
	for (const sample of stroke) {
		if (!Array.isArray(sample) || sample.length < 2) continue;
		const x = Number(sample[0]);
		const y = Number(sample[1]);
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		points.push([x, y]);
	}
	if (points.length < DRAW_MIN_STROKE_POINTS) return null;
	// Reversing here rather than at the sampler keeps ONE monotone walk below:
	// a backwards stroke is just a forwards stroke over the flipped polyline,
	// and arc length is direction-agnostic so the cumulative table is unchanged
	// in meaning.
	if (reversed) points.reverse();
	const cumulative = [0];
	for (let i = 1; i < points.length; i += 1) {
		cumulative.push(cumulative[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
	}
	const total = cumulative[cumulative.length - 1];
	// A stroke that never moved is a click, and a click changes nothing.
	if (!(total > 0) || total < minLength) return null;

	const length = baseCurve.length;
	// Never pin away the whole curve: a range shorter than 2 x pinnedEnds would
	// otherwise come back byte-identical and read as "the user drew nothing".
	const ease = Math.max(0, Math.trunc(easeFrames) || 0);
	const pinned = ease > 0 ? 0 : Math.max(0, Math.min(Math.trunc(pinnedEnds) || 0, Math.floor(length / 2)));
	const timing = Array.isArray(arcFractions) && arcFractions.length === length ? arcFractions : null;
	// One monotone walk along the stroke for the whole curve: the targets only
	// ever increase with index, so the cursor never rewinds and a 200-frame
	// range costs one pass over the samples rather than 200 searches. Velocity
	// timing keeps that property — arc-length fractions are non-decreasing.
	let cursor = 1;
	const out = new Array(length);
	for (let index = 0; index < length; index += 1) {
		const base = baseCurve[index];
		if (pinned > 0 && (index < pinned || index >= length - pinned)) {
			// BY REFERENCE, like dragCurve — an untouched point must compare
			// equal with no epsilon to choose.
			out[index] = base;
			continue;
		}
		if (!base) {
			out[index] = null;
			continue;
		}
		const along = timing ? timing[index] : index / (length - 1);
		const target = along * total;
		while (cursor < cumulative.length - 1 && cumulative[cursor] < target) cursor += 1;
		const span = cumulative[cursor] - cumulative[cursor - 1];
		const fraction = span > 0 ? Math.min(1, Math.max(0, (target - cumulative[cursor - 1]) / span)) : 0;
		const a = points[cursor - 1];
		const b = points[cursor];
		const u = a[0] + (b[0] - a[0]) * fraction;
		const v = a[1] + (b[1] - a[1]) * fraction;
		if (ease > 0) {
			const weight = seamEaseWeight(index, length, ease);
			// w === 0 returns the base point BY REFERENCE, so the outermost frame
			// of an eased window keeps the pin's exact-equality property and
			// curvesEqual still reads an untouched edge as untouched.
			if (weight === 0) { out[index] = base; continue; }
			out[index] = weight === 1
				? { frame: base.frame, u, v }
				: { frame: base.frame, u: base.u + (u - base.u) * weight, v: base.v + (v - base.v) * weight };
			continue;
		}
		out[index] = { frame: base.frame, u, v };
	}
	return out;
}

/**
 * THE DRAW GESTURE, end to end: a raw stroke in, a committed edit out.
 *
 * One function because the three redesign decisions are one decision — the
 * matched window IS the range, the range's base trail IS the timing, and the
 * window's edges ARE the seam. Splitting them across the caller is how they
 * drift apart. App.jsx therefore hands over the stroke and the geometry it was
 * drawn on, and gets back everything a commit needs:
 *
 *   { frameRange, base, curve, reversed, matched, easeFrames }
 *
 * `frameRange` is the panel's new range (redesign A) — drawing over a stretch of
 * the visible path means "reroute THIS part", with no numbers typed. `base` is
 * that window's slice of the original projected trail, i.e. the `original` half
 * of the committed `{ camera, original, edited }`; `curve` is the `edited` half.
 *
 * FALLBACKS, in the order the brief fixes them:
 *   - nothing on the trail is on screen to match against -> keep the panel's
 *     range (`fallbackCurve` / `fallbackRange`) and draw into it, so the gesture
 *     still does something on a take framed out of shot;
 *   - the matched window is not fully covered by `fullCurve` (a trail shorter
 *     than the clip) -> same fallback, for the same reason;
 *   - the base window has no measurable arc length (a stationary joint) ->
 *     uniform timing, which is what baseArcFractions returning null means.
 *
 * Returns null for a no-op click, exactly as strokeToCurve does, so the caller's
 * "a stray click must never wipe an existing edit" rule is unchanged.
 */
export function drawStrokeEdit(stroke, {
	fullCurve = null,
	fallbackCurve = null,
	fallbackRange = null,
	paneW,
	paneH,
	clipFrames,
	minLength = 0,
	minWindowFrames = DRAW_MIN_WINDOW_FRAMES,
	bunchedWindowFrames = DRAW_BUNCHED_WINDOW_FRAMES,
	minSeparationPx = DRAW_MATCH_MIN_SEPARATION_PX,
} = {}) {
	const match = matchStrokeWindow(stroke, fullCurve, { paneW, paneH, clipFrames, minWindowFrames, bunchedWindowFrames, minSeparationPx });
	const window = match ? curveWindow(fullCurve, match) : null;
	const base = window ?? fallbackCurve;
	if (!Array.isArray(base) || base.length < MIN_LINE_POINTS) return null;
	const matched = !!window;
	const frameRange = matched
		? { startFrame: match.startFrame, endFrame: match.endFrame }
		: (fallbackRange ?? null);
	const easeFrames = seamEaseFrames(base.length);
	const curve = strokeToCurve(stroke, base, {
		minLength,
		easeFrames,
		arcFractions: baseArcFractions(base),
		reversed: matched ? match.reversed : false,
	});
	if (!curve) return null;
	return { frameRange, base, curve, reversed: matched ? match.reversed : false, matched, easeFrames };
}

/* ========================= the third gesture: 3D pins =======================
 * "순간 찍기" — scrub to a moment, grab the joint, put it where it should be.
 *
 * WHY IT BELONGS BESIDE THE OTHER TWO, in the paper's own terms. ProjFlow's
 * entire spatial-control evaluation is SPARSE KEYFRAMES — 1, 2, 5, 49 and 196 of
 * them — with 0.0000 trajectory/location/average error at every density, and the
 * flow prior filling everything between. A drawn line is the dense end of that
 * axis (one constraint per frame); a pin is the sparse end, and the sparse end
 * is the one the method was measured on. Everything a stroke needs and a pin
 * does not — a camera, a frame association, a timing rule, a seam ease — exists
 * because a 2D stroke is an impoverished signal. A pin carries its own frame, is
 * already in 3D, and needs no lens — which is why a camera move leaves a pin
 * fully drawable (it is re-projected through the new lens and lands where the
 * artist put it) while a drawn curve can only be shown detached until the view
 * comes back. Both edits survive the move; only one of them can still be drawn.
 *
 * The exchange: a pin says nothing about the frames between pins, and the model
 * answers for them. That is the deal the paper's numbers are about.
 * ========================================================================== */

/** How many pins one edit may carry. ONE is legal (a line needs two points to
 * have a direction; a pin needs none); EIGHT is where keyframing by hand stops
 * being a refinement and starts being the pose studio's job. Mirrored in
 * tools/projflow/replay.mjs, which is the wire's own gate. */
export const LINE_EDIT_PINS_MIN = 1;
export const LINE_EDIT_PINS_MAX = 8;

/** Frames of CONTEXT either side of the pinned span, at the app's 24 fps.
 *
 * A pin is a point, but an edit is a passage: the model needs room to get the
 * limb into the pinned pose and back out of it, and pinning frame 100 with a
 * range of exactly [100, 101) would ask for an instantaneous arrival. Half a
 * second each way is the smallest span that reads as a movement rather than a
 * snap, and it is also comfortably wider than the driver's seam pin (2
 * generation frames), so the two never fight. */
export const PIN_CONTEXT_FRAMES = 12;

/** A SINGLE pin has no span of its own, so it gets a window instead: 1.5 s
 * centred on it. Wider than 2 x PIN_CONTEXT_FRAMES on purpose — with two pins
 * the span between them already carries the edit, and with one there is nothing
 * but context. */
export const PIN_SOLO_WINDOW_FRAMES = 36;

/**
 * The frames a pins-only edit owns, from the pins themselves.
 *
 * The pins ARE the edit, so the range is derived, never typed — the same
 * "nobody sets the numeric range first" lesson matchStrokeWindow learned for
 * strokes. Half-open and clamped to the clip, like every range on this wire.
 *
 * Returns null when there are no pins or no clip to place them in.
 */
export function pinsFrameRange(pins, clipFrames, {
	context = PIN_CONTEXT_FRAMES,
	soloWindow = PIN_SOLO_WINDOW_FRAMES,
} = {}) {
	if (!Array.isArray(pins) || pins.length === 0) return null;
	const frames = pins.map((pin) => Math.trunc(pin?.frame)).filter(Number.isFinite);
	if (frames.length === 0) return null;
	const limit = Number.isFinite(clipFrames) ? Math.trunc(clipFrames) : 0;
	if (!(limit >= MIN_LINE_POINTS)) return null;
	const first = Math.min(...frames);
	const last = Math.max(...frames);
	let start;
	let end;
	if (first === last) {
		const want = Math.max(MIN_LINE_POINTS, Math.trunc(soloWindow));
		start = Math.round(first - want / 2);
		end = start + want;
	} else {
		start = first - Math.trunc(context);
		end = last + 1 + Math.trunc(context);
	}
	// Slide to keep the length when one edge hits the clip, then clip.
	const span = end - start;
	if (start < 0) { start = 0; end = Math.min(limit, span); }
	if (end > limit) { end = limit; start = Math.max(0, end - span); }
	// Every pin must stay INSIDE the half-open range the wire validates against.
	start = Math.min(start, first);
	end = Math.max(end, last + 1);
	start = Math.max(0, start);
	end = Math.min(limit, end);
	if (end - start < MIN_LINE_POINTS) return null;
	return { startFrame: start, endFrame: end };
}

/**
 * Add or replace a pin, keeping the list ascending and capped.
 *
 * PINNING THE SAME FRAME TWICE REPLACES, it does not stack — a frame has one
 * answer to "where is the hand", and the second gesture is the artist changing
 * their mind, exactly as drawing twice replaces a stroke. Over the cap the
 * OLDEST pin is dropped rather than the new one refused: a gesture the artist
 * just made must do something visible, and silently ignoring the ninth pin is
 * the kind of nothing that made drawing feel broken.
 *
 * Returns a NEW array; the input is untouched.
 */
export function upsertPin(pins, pin, { max = LINE_EDIT_PINS_MAX } = {}) {
	if (!pin || !Number.isInteger(pin.frame) || !Array.isArray(pin.position) || pin.position.length !== 3) return pins;
	if (!pin.position.every(Number.isFinite)) return pins;
	const entry = { frame: pin.frame, position: [pin.position[0], pin.position[1], pin.position[2]] };
	const kept = (Array.isArray(pins) ? pins : []).filter((existing) => existing.frame !== entry.frame);
	kept.push(entry);
	kept.sort((a, b) => a.frame - b.frame);
	// Dropping from the FRONT keeps the pin just placed and the ones nearest it
	// in time, which is what "I am working on this passage" looks like.
	return kept.length > max ? kept.slice(kept.length - max) : kept;
}

/**
 * The edited curve -> the `points2d` C6 sends, or a refusal.
 *
 * Returns `{ points2d }` or `{ error }` where error is one of:
 *   "empty"     — fewer than 2 points have an image at all
 *   "offscreen" — some point sits outside 0..1, which the bridge refuses
 *
 * DOWNSAMPLING IS EVEN BY INDEX, i.e. even IN TIME, and that is the opposite
 * of what the old freehand path did (even by arc length). The reason is that
 * the two inputs mean different things. A freehand stroke carries no timing —
 * the only sane reading is "constant speed along the shape", so arc-length
 * spacing was right there. This curve is the joint's own trajectory: index i is
 * frame startFrame + i, and the box spreads the points evenly across
 * frameRange. Arc-length resampling would therefore RE-TIME the take — it
 * would hand the slow parts of the motion fewer samples and the box would
 * stretch them back out to equal duration, turning a pause into a glide. Even
 * index sampling keeps every sent point on the frame it was projected from.
 *
 * The first and last kept points are always included, so the pinned endpoints
 * from dragCurve survive into the payload rather than being resampled away.
 */
export function curveToPoints2d(curve) {
	const visible = Array.isArray(curve) ? curve.filter(Boolean) : [];
	if (visible.length < MIN_LINE_POINTS) return { error: "empty" };
	for (const point of visible) {
		if (!isCurvePointOnScreen(point)) return { error: "offscreen" };
	}
	const count = Math.min(MAX_LINE_POINTS, visible.length);
	const last = visible.length - 1;
	const points2d = [];
	for (let i = 0; i < count; i += 1) {
		// Rounded rather than floored so the sampling is symmetric about the
		// middle; i = count-1 lands exactly on `last`, i = 0 exactly on 0.
		const source = count === 1 ? 0 : Math.round((i * last) / (count - 1));
		const point = visible[source];
		points2d.push([point.u, point.v]);
	}
	return { points2d };
}

/**
 * Which curve point is under the pointer? `{ index, dist }` or null.
 *
 * The hit test is in PIXELS, not uv, because uv distance is anisotropic: on a
 * 16:9 pane one unit of u is nearly twice one unit of v, so a uv-radius grab
 * zone is a visible ellipse and the curve is hardest to grab exactly where it
 * runs vertically. paneW/paneH convert once, here.
 *
 * Points with no image, points outside the viewport and the pinned ends are
 * all skipped — a marker the user can grab but that cannot move is worse than
 * no marker, so the overlay does not draw those as draggable either.
 */
export function nearestCurvePoint(curve, u, v, maxDistPx, paneW, paneH) {
	if (!Array.isArray(curve) || !(paneW > 0) || !(paneH > 0)) return null;
	let best = null;
	for (let index = 0; index < curve.length; index += 1) {
		const point = curve[index];
		if (!isCurvePointOnScreen(point)) continue;
		if (isCurveEndPinned(index, curve.length)) continue;
		const dx = (point.u - u) * paneW;
		const dy = (point.v - v) * paneH;
		const dist = Math.hypot(dx, dy);
		if (dist > maxDistPx) continue;
		if (!best || dist < best.dist) best = { index, dist };
	}
	return best;
}

/** Are these two curves the same curve? The "has the user actually pulled
 * anything yet?" test, and the reason dragCurve returns untouched points by
 * reference: an unmoved curve compares equal exactly, with no tolerance to
 * choose. Compared on value anyway so a rebuilt-but-identical curve (a camera
 * re-projection that landed in the same place) also reads as unedited. */
export function curvesEqual(a, b) {
	if (a === b) return true;
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		const pa = a[i];
		const pb = b[i];
		if (pa === pb) continue;
		if (!pa || !pb) return false;
		if (pa.frame !== pb.frame || pa.u !== pb.u || pa.v !== pb.v) return false;
	}
	return true;
}

/**
 * Has the camera moved out from under the curve?
 *
 * Compared on the C6 block itself rather than on three's camera object, so the
 * test is on exactly the numbers that were sent — a re-derived but identical
 * pose reads as "not moved" even after a matrix rebuild.
 *
 * A true means the 2D offsets on this curve CANNOT BE RE-INTERPRETED through the
 * new camera: there is no correct way to read offsets authored through one lens
 * as offsets through another, and no depth to reproject them with. It does not
 * mean the edit is void. An UNEDITED curve is simply re-projected from the new
 * camera and follows the view; a COMMITTED one keeps the lens it was authored
 * with (the caller stores `{ camera, original, edited }` and sends that camera),
 * so drift makes it undrawable and un-extendable in the live view, not invalid.
 */
export function cameraDrifted(a, b, epsilon = CAMERA_DRIFT_EPSILON) {
	if (!a || !b) return true;
	if (Math.abs(a.fx - b.fx) > epsilon || Math.abs(a.fy - b.fy) > epsilon) return true;
	if (Math.abs(a.cx - b.cx) > epsilon || Math.abs(a.cy - b.cy) > epsilon) return true;
	for (let i = 0; i < 9; i += 1) if (Math.abs(a.R[i] - b.R[i]) > epsilon) return true;
	for (let i = 0; i < 3; i += 1) if (Math.abs(a.t[i] - b.t[i]) > epsilon) return true;
	return false;
}

/**
 * Last gate before a line edit goes on the wire (contract C6).
 *
 * Returns `null` when the payload is good, otherwise
 * `{ code, message }` — `code` is a stable token the UI maps to localized copy
 * and `message` is the English detail worth putting in a log or a test name.
 * Structured the same way as the bridge's own validateGenerate: one specific
 * reason, named field first, and the first failure wins.
 *
 * `clipFrames` is the loaded take's frame count on the APP timeline clock —
 * C6's frameRange is in app clip frames, and unlike waypoints/motionEdit it is
 * NOT converted to the bridge clock here.
 */
export function validateLineEdit(lineEdit, { clipFrames } = {}) {
	const fail = (code, message) => ({ code, message });
	if (!lineEdit || typeof lineEdit !== "object" || Array.isArray(lineEdit)) {
		return fail("shape", "lineEdit must be an object");
	}
	if (typeof lineEdit.sourceMotion !== "string" || !lineEdit.sourceMotion) {
		// A line edit REWRITES a take; without the bridge-side source npz there
		// is nothing to rewrite and the box would silently generate from scratch.
		return fail("sourceMotion", "field 'lineEdit.sourceMotion' must be a non-empty motion url");
	}
	if (!LINE_EDIT_TRACK_IDS.includes(lineEdit.track)) {
		return fail("track", `field 'lineEdit.track' must be one of the ${LINE_EDIT_TRACK_IDS.length} ik track ids, got ${JSON.stringify(lineEdit.track)}`);
	}
	const range = lineEdit.frameRange;
	if (!range || typeof range !== "object" || !Number.isInteger(range.startFrame) || !Number.isInteger(range.endFrame)) {
		return fail("frameRange", "field 'lineEdit.frameRange' must be { startFrame, endFrame } integers");
	}
	if (range.startFrame < 0 || range.endFrame <= range.startFrame) {
		return fail("frameRange", `field 'lineEdit.frameRange' must satisfy 0 <= startFrame < endFrame, got ${range.startFrame}..${range.endFrame}`);
	}
	// endFrame is EXCLUSIVE, like every other half-open range crossing this
	// boundary (preserve.editRanges, the prompt schedule), so it may equal the
	// clip length but never exceed it.
	if (Number.isFinite(clipFrames) && range.endFrame > clipFrames) {
		return fail("frameRange", `field 'lineEdit.frameRange.endFrame' must be <= the clip's ${clipFrames} frames, got ${range.endFrame}`);
	}
	// One constrained frame cannot follow a LINE; two points need two frames.
	if (Number.isFinite(clipFrames) && range.endFrame - range.startFrame < MIN_LINE_POINTS) {
		return fail("frameRange", "field 'lineEdit.frameRange' must span at least 2 frames");
	}
	// PINS — the camera-free gesture. Checked before points2d so a pins payload
	// is never told it needs two points of a field it deliberately omitted; the
	// wire's own gate (tools/projflow/replay.mjs validateLineEditFields) applies
	// the identical rules, and this one exists so the panel can refuse in the
	// artist's language before anything is sent.
	if (lineEdit.pins3d !== undefined) {
		if (lineEdit.points2d !== undefined) {
			return fail("pins", "a line edit is one gesture: send either points2d or pins3d, not both");
		}
		if (lineEdit.camera !== undefined) {
			return fail("pins", "field 'lineEdit.camera' must be omitted for a pins edit — pins are world-space");
		}
		const pins = lineEdit.pins3d;
		if (!Array.isArray(pins) || pins.length < LINE_EDIT_PINS_MIN) {
			return fail("pins", `field 'lineEdit.pins3d' needs at least ${LINE_EDIT_PINS_MIN} pin`);
		}
		if (pins.length > LINE_EDIT_PINS_MAX) {
			return fail("pins", `field 'lineEdit.pins3d' is capped at ${LINE_EDIT_PINS_MAX} pins, got ${pins.length}`);
		}
		let previous = -1;
		for (let i = 0; i < pins.length; i += 1) {
			const pin = pins[i];
			if (!pin || typeof pin !== "object" || Array.isArray(pin) || !Number.isInteger(pin.frame)) {
				return fail("pins", `field 'lineEdit.pins3d[${i}]' must be { frame: integer, position: [x, y, z] }`);
			}
			if (pin.frame < range.startFrame || pin.frame >= range.endFrame) {
				return fail("pins", `field 'lineEdit.pins3d[${i}].frame' ${pin.frame} is outside frameRange ${range.startFrame}..${range.endFrame}`);
			}
			if (pin.frame <= previous) {
				return fail("pins", `field 'lineEdit.pins3d' frames must be strictly ascending, got ${pin.frame} after ${previous}`);
			}
			previous = pin.frame;
			if (!Array.isArray(pin.position) || pin.position.length !== 3 || !pin.position.every(Number.isFinite)) {
				return fail("pins", `field 'lineEdit.pins3d[${i}].position' must be [x, y, z] finite numbers`);
			}
		}
		if (lineEdit.prompt !== undefined && typeof lineEdit.prompt !== "string") {
			return fail("prompt", "field 'lineEdit.prompt' must be a string when present");
		}
		return null;
	}

	const points = lineEdit.points2d;
	if (!Array.isArray(points) || points.length < MIN_LINE_POINTS) {
		return fail("points", `field 'lineEdit.points2d' needs at least ${MIN_LINE_POINTS} points`);
	}
	if (points.length > MAX_LINE_POINTS) {
		return fail("points", `field 'lineEdit.points2d' is capped at ${MAX_LINE_POINTS} points, got ${points.length}`);
	}
	for (let i = 0; i < points.length; i += 1) {
		const point = points[i];
		if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
			return fail("points", `field 'lineEdit.points2d[${i}]' must be [u, v] finite numbers`);
		}
		if (point[0] < 0 || point[0] > 1 || point[1] < 0 || point[1] > 1) {
			return fail("points", `field 'lineEdit.points2d[${i}]' must be viewport-normalized into 0..1, got ${JSON.stringify(point)}`);
		}
	}
	const camera = lineEdit.camera;
	if (!camera || typeof camera !== "object") return fail("camera", "field 'lineEdit.camera' is required");
	for (const key of ["fx", "fy", "cx", "cy"]) {
		if (!Number.isFinite(camera[key])) return fail("camera", `field 'lineEdit.camera.${key}' must be a finite number`);
	}
	// A non-positive focal length means the uv/NDC flip was applied twice (or
	// not at all) and every solved position would be mirrored.
	if (camera.fx <= 0 || camera.fy <= 0) {
		return fail("camera", "field 'lineEdit.camera' has a non-positive focal length — the uv convention is inverted");
	}
	if (!Array.isArray(camera.R) || camera.R.length !== 9 || !camera.R.every(Number.isFinite)) {
		return fail("camera", "field 'lineEdit.camera.R' must be 9 finite numbers (3x3 row-major)");
	}
	if (!Array.isArray(camera.t) || camera.t.length !== 3 || !camera.t.every(Number.isFinite)) {
		return fail("camera", "field 'lineEdit.camera.t' must be 3 finite numbers");
	}
	if (lineEdit.prompt !== undefined && typeof lineEdit.prompt !== "string") {
		return fail("prompt", "field 'lineEdit.prompt' must be a string when present");
	}
	return null;
}

/**
 * Does this generate failure mean "the bridge does not know about lineEdit
 * yet"? Wave 2 lands the routing; until then a request either 400s on the
 * unknown field or is refused by the capability preflight. Both deserve the
 * same calm "not connected yet" answer rather than a red error card, so the
 * classification lives here where it can be tested against real reason
 * strings.
 */
export function isLineEditUnsupported(message) {
	if (typeof message !== "string" || !message) return false;
	if (/HTTP\s*400/i.test(message)) return true;
	return /line\s*edit/i.test(message) && /unknown|unsupported|not supported|unrecognis|unrecogniz|must not|invalid field/i.test(message);
}
