import * as THREE from "three";

// Left side runs cool (blue arm, teal leg), right side warm (red arm, magenta leg); the pelvis is
// its own amber so the body's root reads apart from the spine above it.
export const HANDLE_COLORS = Object.freeze({
	pelvis: "#ffb21e",
	torso: "#2fd66b",
	head: "#a37bff",
	leftArm: "#3d8bff",
	leftLeg: "#14c8e6",
	rightArm: "#ff4d6a",
	rightLeg: "#e44dff",
});
export const ROTATION_AXES = Object.freeze([
	{ axis: "x", dir: new THREE.Vector3(1, 0, 0), color: "#ff6b5e" },
	{ axis: "y", dir: new THREE.Vector3(0, 1, 0), color: "#7ee07a" },
	{ axis: "z", dir: new THREE.Vector3(0, 0, 1), color: "#5c9dff" },
]);

export const RING_BACK_OPACITY = 0.22;

// Fades the half of a ring that faces away from the camera (relative to the ring's centre), the way
// DCC rotate gizmos do, so the three rings stop crossing over the bone like a cage.
export function backFaceFade(material) {
	material.onBeforeCompile = (shader) => {
		shader.uniforms.ringBackOpacity = { value: RING_BACK_OPACITY };
		shader.vertexShader = shader.vertexShader
			.replace("#include <common>", "#include <common>\nvarying float vRingFront;")
			.replace("#include <project_vertex>", `#include <project_vertex>
				vec4 ringCentre = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
				vRingFront = smoothstep(-0.02, 0.02, mvPosition.z - ringCentre.z);`);
		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", "#include <common>\nvarying float vRingFront;\nuniform float ringBackOpacity;")
			.replace("#include <opaque_fragment>", "#include <opaque_fragment>\ngl_FragColor.a *= mix(ringBackOpacity, 1.0, vRingFront);");
	};
	material.customProgramCacheKey = () => "pose-ring-backfade";
	return material;
}

export function handlePart(id = "") {
	const match = /^(left|right)(.*)$/.exec(String(id));
	if (match) return `${match[1]}${/knee|foot|leg|toe|hip/i.test(match[2]) ? "Leg" : "Arm"}`;
	if (id === "hips") return "pelvis";
	return id === "head" ? "head" : "torso";
}

export function handleColor(id) {
	return HANDLE_COLORS[handlePart(id)];
}

const v0 = new THREE.Vector3();
const v1 = new THREE.Vector3();
const cross = new THREE.Vector3();

/** Signed angle (radians) that turns `start` into `current` about `axis`, both measured from `origin`. */
export function ringAngle(axis, origin, start, current) {
	v0.subVectors(start, origin);
	v1.subVectors(current, origin);
	if (v0.lengthSq() < 1e-12 || v1.lengthSq() < 1e-12) return 0;
	cross.crossVectors(v0, v1);
	return Math.atan2(cross.dot(axis), v0.dot(v1));
}

const relative = new THREE.Quaternion();
const euler = new THREE.Euler();

/** Local rotation away from the bind pose, as XYZ Euler degrees rounded to 0.1. */
export function rotationFromBindDeg(bindQuat, quat) {
	relative.copy(bindQuat ?? relative.identity()).invert().multiply(quat);
	euler.setFromQuaternion(relative, "XYZ");
	const round = (rad) => Math.round(THREE.MathUtils.radToDeg(rad) * 10) / 10 || 0;
	return { x: round(euler.x), y: round(euler.y), z: round(euler.z) };
}

export function rotationReadout(deg, drag = null) {
	const axes = ["x", "y", "z"].map((axis) => ({ axis, value: `${Math.round(deg[axis])}°`, active: drag?.axis === axis }));
	if (!drag) return { delta: null, axes };
	const value = THREE.MathUtils.radToDeg(drag.angle);
	return { delta: { axis: drag.axis, value: `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}°` }, axes };
}

const bindCache = new WeakMap();

export function bindQuaternionOf(bone) {
	if (bindCache.has(bone)) return bindCache.get(bone);
	let node = bone;
	while (node && !node.userData?.poseBind) node = node.parent;
	const saved = node?.userData.poseBind.get(bone);
	const quat = saved ? new THREE.Quaternion(saved.x, saved.y, saved.z, saved.w) : null;
	bindCache.set(bone, quat);
	return quat;
}
