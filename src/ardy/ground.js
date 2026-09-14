import { objectFootprintBounds } from "../scene-objects.js";

/**
 * Ground height under a point, from the scene's objects (issue #250).
 *
 * AutoPhysics review measures every contact against ONE flat floor
 * (`floorY`). When a character stands on a box or a step its feet get pulled
 * down to the floor plane. This module answers "what is the ground here?" so
 * contact detection, span anchors, and toe minimum heights can use the
 * surface actually under the foot.
 *
 * DRAFT - the sampler exists and is tested; physics-review.js does not call
 * it yet. Wiring plan:
 *   1. supportIntervals(): compare the sole to groundAt(toe.x, toe.z), not
 *      floorY, in the "low enough to be a contact" test.
 *   2. Span anchors carry y = groundAt(anchor.x, anchor.z); footLockTrack
 *      anchors and relaxToePath's toeMinHeight take that value per frame.
 *   3. Penetration / float metrics and the root lift measure against the
 *      local ground under each support site.
 *
 * Surface model: each scene object is an axis-aligned box from
 * objectFootprintBounds (yaw-exact XZ footprint, flat top at topY). The
 * highest top whose footprint contains the point, and that is not higher than
 * `maxY` (so a foot below a table does not snap up onto it), wins; otherwise
 * the floor. Sloped tops are out of scope - the height is flat per object and
 * the foot keeps its source rotation.
 */
export function createGroundSampler(objects = [], { floorY = 0, collidable = isCollidable } = {}) {
	const surfaces = objects.filter(collidable).map((object) => objectFootprintBounds(object));
	const groundAt = (x, z, maxY = Infinity) => {
		let best = floorY;
		for (const b of surfaces) {
			if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
			if (b.topY > maxY || b.topY <= best) continue;
			best = b.topY;
		}
		return best;
	};
	groundAt.surfaces = surfaces;
	groundAt.floorY = floorY;
	return groundAt;
}

/** Objects a foot can stand on: solid props with a real footprint. Cutouts,
 * cameras, lights, and attached/child objects are not ground. */
export function isCollidable(object) {
	if (!object || object.kind === "cutout") return false;
	if (object.parentId || object.attach) return false;
	if (object.collide === false) return false;
	const b = objectFootprintBounds(object);
	return b.maxX - b.minX > 1e-6 && b.maxZ - b.minZ > 1e-6 && b.topY > b.baseY + 1e-6;
}
