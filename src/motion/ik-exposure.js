import { Raycaster, Vector3 } from "three";
import { ikControlIsExposed } from "./ik.js";

/**
 * Distance from the camera to the first opaque surface on the way to a control
 * `targetDistance` away along `direction`, or undefined when nothing is in front.
 * Static blockers are raycast; a skinned mesh is read off its cached cloud of
 * skin-surface spheres ({ points, radius }), which keeps the animated silhouette
 * without skinning every triangle once per control ray.
 */
export function blockerDistanceTo(ray, cameraPos, direction, targetDistance, staticBlockers, skinnedProxies) {
	ray.set(cameraPos, direction);
	ray.near = 0.001;
	ray.far = Math.max(0.001, targetDistance - 0.001);
	let blockerDistance = ray.intersectObjects(staticBlockers, false)[0]?.distance;
	for (const proxy of skinnedProxies) {
		const radiusSq = proxy.radius * proxy.radius;
		for (const point of proxy.points) {
			const dx = point.x - cameraPos.x, dy = point.y - cameraPos.y, dz = point.z - cameraPos.z;
			const along = dx * direction.x + dy * direction.y + dz * direction.z;
			if (along < 0 || along > targetDistance + proxy.radius) continue;
			const perpendicularSq = dx * dx + dy * dy + dz * dz - along * along;
			if (perpendicularSq > radiusSq) continue;
			const distance = Math.max(0, along - Math.sqrt(radiusSq - perpendicularSq));
			if (distance < (blockerDistance ?? Infinity)) blockerDistance = distance;
		}
	}
	return blockerDistance;
}

/**
 * An exposure probe over the blockers of the last IkHandles exposure pass:
 * `(worldPoint, visibilityDepth) => boolean`, the same rule the IK controls use.
 * A fingertip is smaller than the 4 cm skin-proxy spheres (neighbouring fingers
 * read as blockers), so the probe raycasts the skinned meshes themselves; it runs
 * once per press, not per frame. Before any pass nothing is in front: exposed.
 */
export function exposureProbe(camera, occluders) {
	const ray = new Raycaster(), cameraPos = new Vector3(), direction = new Vector3();
	ray.layers.set(0);
	return (point, visibilityDepth) => {
		camera.getWorldPosition(cameraPos);
		const targetDistance = cameraPos.distanceTo(point);
		direction.copy(point).sub(cameraPos).normalize();
		const blockerDistance = blockerDistanceTo(ray, cameraPos, direction, targetDistance, occluders.current?.blockers ?? [], []);
		return ikControlIsExposed(targetDistance, blockerDistance, visibilityDepth);
	};
}
