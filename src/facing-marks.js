import * as THREE from "three";

/**
 * Give the head a front.
 *
 * Both shipped rigs are smooth helmets with no facial geometry and no texture
 * of any kind — the FBX materials carry a flat colour and nothing else — and
 * the app then replaces every material with one clay tone. The result reads as
 * an ovoid with no direction, which matters most in an exported blocking
 * frame: the prompt claims a three-quarter front view and the picture has to
 * back it up.
 *
 * Sizes are in the head bone's own units. The rig is authored in Mixamo
 * centimetres and the whole clone is scaled by 0.01 afterwards, so a child of
 * the bone is written in centimetres too. Measured on both rigs (#407): the
 * skull's face surface is 15 units forward of the bone (z −13…+15) and the
 * crown is 20 up, so marks sit ON the face at z ≈ 14–15.
 *
 * Two eyes, not one band (#380). The eye band read to the video model as a
 * "dark horizontal eye slit" (its own expansion of the reference said so) and
 * it rendered exactly that: ViTPose then found the L/R eyes 5.6 px apart and
 * swapped them on 74 % of frames, which is the estimator's only heading cue
 * besides the shoulders. Two eyes 6 units apart are ~11 px at the fal
 * reference distance where the head is ~35 px — enough for the estimator to
 * key which side is which.
 *
 * Fixed near-black, NOT the body tint: pale tints washed the old marks into
 * the grey skull (#407). The extractor's neutral head mask swallows dark
 * pixels inside the skull silhouette (verified: 0 dark pixels escape), so
 * these cannot split segmentation. The COCO nose keypoint is the one the
 * estimator keys facing on; the wedge centres the face below the eyes.
 */
export const EYE_SEPARATION = 6;

export function facingMarkSpecs() {
	const eye = (x) => ({
		role: "eye",
		geometry: () => new THREE.SphereGeometry(1.7, 12, 10),
		position: [x, 8, 14.4],
		rotation: null,
	});
	return [
		eye(-EYE_SEPARATION / 2),
		eye(EYE_SEPARATION / 2),
		{
			role: "nose",
			geometry: () => new THREE.ConeGeometry(2.4, 4.6, 4),
			position: [0, 4.5, 14.6],
			rotation: [Math.PI / 2, Math.PI / 4, 0],
		},
	];
}

/** Hang the marks off the clone's head bone; posing, playback and pose
 * extraction are untouched — nothing here is skinned or animated. */
export function addFacingMarks(clone) {
	let head = null;
	clone.traverse((node) => {
		if (!head && node.isBone && /head$/i.test(node.name)) head = node;
	});
	if (!head) return;
	const material = new THREE.MeshStandardMaterial({ color: "#1C1C1C", roughness: 0.7, metalness: 0 });
	for (const spec of facingMarkSpecs()) {
		const mesh = new THREE.Mesh(spec.geometry(), material);
		mesh.position.set(...spec.position);
		if (spec.rotation) mesh.rotation.set(...spec.rotation);
		mesh.castShadow = true;
		mesh.frustumCulled = false;
		// The head bone's local +Z is the face direction on both rigs.
		head.add(mesh);
	}
}
