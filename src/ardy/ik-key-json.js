import * as THREE from "three";

/**
 * One IK track key in the JSON form character.setIkKey takes
 * (src/studio-actions.js ikTrackKey) and back: quaternions as {x,y,z,w},
 * positions as {x,y,z}. Optional fields are written only when the key has
 * them, so a key without a stored `blend` stays one without it.
 */
export function ikTrackKeyJson(key) {
	const quaternion = (q) => ({ x: q.x, y: q.y, z: q.z, w: q.w });
	const vector = (p) => ({ x: p.x, y: p.y, z: p.z });
	return {
		...(key.q ? { q: key.q.map(quaternion) } : {}),
		...(key.p ? { p: vector(key.p) } : {}),
		...(key.baseQ ? { baseQ: key.baseQ.map(quaternion) } : {}),
		...(key.basePos ? { basePos: vector(key.basePos) } : {}),
		...(key.chainP ? { chainP: key.chainP.map(vector) } : {}),
		...(key.keepTranslations ? { keepTranslations: true } : {}),
		...(key.blend != null ? { blend: key.blend } : {}),
		...(key.pin != null ? { pin: key.pin } : {}),
	};
}

/** A baked key entry (Map trackId → key) as character.setIkKey's `tracks`. */
export function ikKeyJson(entry) {
	return Object.fromEntries([...entry].map(([track, key]) => [track, ikTrackKeyJson(key)]));
}

/** The IK state's key for one track of character.setIkKey's `tracks`. */
export function ikTrackKeyFromJson(key) {
	const quaternion = (q) => new THREE.Quaternion(q.x, q.y, q.z, q.w).normalize();
	const vector = (p) => new THREE.Vector3(p.x, p.y, p.z);
	return {
		q: key.q?.map(quaternion) ?? null,
		p: key.p ? vector(key.p) : null,
		...(key.baseQ ? { baseQ: key.baseQ.map(quaternion) } : {}),
		...(key.basePos ? { basePos: vector(key.basePos) } : {}),
		...(key.chainP ? { chainP: key.chainP.map(vector) } : {}),
		...(key.keepTranslations ? { keepTranslations: true } : {}),
		...(key.blend != null ? { blend: key.blend } : {}),
		...(key.pin != null ? { pin: key.pin } : {}),
	};
}
