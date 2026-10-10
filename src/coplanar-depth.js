import * as THREE from "three";

/**
 * Depth ranks for coplanar faces of scene-object primitives.
 *
 * Agent-built assemblies stack parts whose same-facing faces lie in exactly
 * one plane (a hood and a grille sharing a top at y=1.05). The depth test
 * cannot order them, so as the camera moves the winner flips every frame and
 * the strip sparkles. The ranks computed here let the renderer pull the
 * later-created part toward the camera by a polygon offset, which holds
 * whatever the camera does. The records are never edited.
 */

const DEG = Math.PI / 180;
/** Planes closer than this are one plane. */
const PLANE_EPS = 1e-3;
/** Normals this aligned (cosine) face the same way. */
const NORMAL_DOT = 0.9999;
/** Overlap shallower than this is two faces touching along an edge. */
const OVERLAP_EPS = 1e-4;
/** Bounds the offset: a deeper chain shares the top rank. */
export const MAX_DEPTH_RANK = 6;

// Planar faces per kind, in the primitive's local frame BEFORE scale: the axis
// the face is perpendicular to, which side, and where along that axis it sits
// (cube/cylinder/cone sit on y in [0, 1] — see Primitive in props.jsx).
const BOX_FACES = [
	{ axis: 0, side: 1, at: 0.5 }, { axis: 0, side: -1, at: -0.5 },
	{ axis: 1, side: 1, at: 1 }, { axis: 1, side: -1, at: 0 },
	{ axis: 2, side: 1, at: 0.5 }, { axis: 2, side: -1, at: -0.5 },
];
const CAP_TOP = { axis: 1, side: 1, at: 1 };
const CAP_BASE = { axis: 1, side: -1, at: 0 };
const FACES_BY_KIND = {
	cube: BOX_FACES,
	cylinder: [CAP_TOP, CAP_BASE],
	cone: [CAP_BASE],
	// 2x2, a hair above the floor, drawn double-sided
	plane: [{ axis: 1, side: 1, at: 0.004, flat: true }, { axis: 1, side: -1, at: 0.004, flat: true }],
};
// Local centre of the box the faces live on, per axis (x/z centred, y from 0).
const MID = [0, 0.5, 0];
const HALF = [0.5, 0.5, 0.5];
const PLANE_HALF = [1, 0, 1];

const rot = new THREE.Matrix4();
const euler = new THREE.Euler();

/** World-space rectangular faces of one object, or null when it has none. */
function facesOf(object) {
	const kind = object.renderer ?? object.kind;
	const table = FACES_BY_KIND[kind];
	if (!table || object.attach || object.hidden === true) return null;
	euler.set((object.rotX ?? 0) * DEG, (object.rot ?? 0) * DEG, (object.rotZ ?? 0) * DEG);
	rot.makeRotationFromEuler(euler);
	const e = rot.elements;
	// column a of the rotation = where local axis a points in the world
	const axes = [[e[0], e[1], e[2]], [e[4], e[5], e[6]], [e[8], e[9], e[10]]];
	const scale = [object.scaleX ?? 1, object.scaleY ?? 1, object.scaleZ ?? 1];
	const pos = [object.x ?? 0, object.y ?? 0, object.z ?? 0];
	if (![...scale, ...pos, ...axes[0]].every(Number.isFinite)) return null;
	const faces = [];
	for (const face of table) {
		const a = face.axis;
		const u = (a + 1) % 3;
		const v = (a + 2) % 3;
		// a mirrored scale turns the outward normal around with it
		const flip = face.side * (scale[a] < 0 ? -1 : 1);
		const half = face.flat ? PLANE_HALF : HALF;
		const centre = [0, 0, 0];
		for (let i = 0; i < 3; i += 1) {
			const local = i === a ? face.at : face.flat ? 0 : MID[i];
			for (let k = 0; k < 3; k += 1) centre[k] += axes[i][k] * local * scale[i];
		}
		faces.push({
			n: [axes[a][0] * flip, axes[a][1] * flip, axes[a][2] * flip],
			c: [centre[0] + pos[0], centre[1] + pos[1], centre[2] + pos[2]],
			u: axes[u],
			v: axes[v],
			hu: half[u] * Math.abs(scale[u]),
			hv: half[v] * Math.abs(scale[v]),
		});
	}
	// world box of the faces, for the pair prefilter
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const f of faces) {
		for (let k = 0; k < 3; k += 1) {
			const reach = Math.abs(f.u[k]) * f.hu + Math.abs(f.v[k]) * f.hv;
			min[k] = Math.min(min[k], f.c[k] - reach);
			max[k] = Math.max(max[k], f.c[k] + reach);
		}
	}
	return { faces, min, max };
}

const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];

// Overlap of two rectangles lying in one plane, by separating axes in the
// plane: the rectangles' own edge directions are the only candidates.
function overlaps(a, b) {
	const rel = [b.c[0] - a.c[0], b.c[1] - a.c[1], b.c[2] - a.c[2]];
	for (const axis of [a.u, a.v, b.u, b.v]) {
		const reachA = Math.abs(dot(axis, a.u)) * a.hu + Math.abs(dot(axis, a.v)) * a.hv;
		const reachB = Math.abs(dot(axis, b.u)) * b.hu + Math.abs(dot(axis, b.v)) * b.hv;
		if (Math.abs(dot(axis, rel)) >= reachA + reachB - OVERLAP_EPS) return false;
	}
	return true;
}

function conflict(a, b) {
	for (const fa of a.faces) {
		for (const fb of b.faces) {
			if (dot(fa.n, fb.n) <= NORMAL_DOT) continue;
			const gap = dot(fa.n, [fb.c[0] - fa.c[0], fb.c[1] - fa.c[1], fb.c[2] - fa.c[2]]);
			if (Math.abs(gap) > PLANE_EPS) continue;
			if (overlaps(fa, fb)) return true;
		}
	}
	return false;
}

/**
 * Which objects need to win the depth test over an earlier one.
 *
 * Two planar faces conflict when they face the same way, share a plane to
 * within a millimetre and overlap with real area; touching boxes (opposite
 * facing) never do. The later object in `objects` is the later-made detail, so
 * each conflict is an edge earlier -> later, and an object's rank is the length
 * of the longest chain ending at it (capped). Only ranked objects (> 0) get an
 * entry. Run it on the AUTHORED records: a routed group moves rigidly, so
 * relative geometry inside it does not change with the frame.
 *
 * Skipped: spheres, capsules, models, cutouts, props carried by a character
 * and hidden props. Cylinder and cone caps are approximated by their bounding
 * rectangle, which can over-report a conflict near a rim; that costs a
 * sub-pixel pull on a prop and nothing else.
 *
 * @param {Array<object>} objects scene-object records, in creation order
 * @returns {Map<string, number>} id -> rank
 */
export function coplanarDepthRanks(objects) {
	const ranks = new Map();
	if (!Array.isArray(objects) || objects.length < 2) return ranks;
	const shapes = objects.map((object) => (object && typeof object === "object" ? facesOf(object) : null));
	const rank = new Array(objects.length).fill(0);
	for (let j = 1; j < objects.length; j += 1) {
		const b = shapes[j];
		if (!b) continue;
		for (let i = 0; i < j; i += 1) {
			const a = shapes[i];
			if (!a || rank[i] + 1 <= rank[j]) continue;
			if (
				a.min[0] > b.max[0] + PLANE_EPS || b.min[0] > a.max[0] + PLANE_EPS ||
				a.min[1] > b.max[1] + PLANE_EPS || b.min[1] > a.max[1] + PLANE_EPS ||
				a.min[2] > b.max[2] + PLANE_EPS || b.min[2] > a.max[2] + PLANE_EPS
			) continue;
			if (conflict(a, b)) rank[j] = Math.min(MAX_DEPTH_RANK, rank[i] + 1);
		}
		if (rank[j] > 0) ranks.set(objects[j].id, rank[j]);
	}
	return ranks;
}
