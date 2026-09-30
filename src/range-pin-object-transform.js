import * as THREE from "three";
import { objectTransformAt } from "./object-path.js";

/** The local matrix SetProps composes before an optional attachment frame.
 * Travel-path samples replace x/y/z/rot for the requested frame while the
 * authored pitch/roll and per-axis scale remain part of the prop transform. */
export function rangePinObjectMatrixAt(object, frame, take = {}, out = new THREE.Matrix4()) {
	const at = objectTransformAt(object, frame, take);
	const source = at ? { ...object, ...at } : object;
	return out.compose(
		new THREE.Vector3(source.x ?? 0, source.y ?? 0, source.z ?? 0),
		new THREE.Quaternion().setFromEuler(new THREE.Euler(
			(source.rotX ?? 0) * THREE.MathUtils.DEG2RAD,
			(source.rot ?? 0) * THREE.MathUtils.DEG2RAD,
			(source.rotZ ?? 0) * THREE.MathUtils.DEG2RAD,
		)),
		new THREE.Vector3(source.scaleX ?? 1, source.scaleY ?? 1, source.scaleZ ?? 1),
	);
}
