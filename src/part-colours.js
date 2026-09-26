import * as THREE from "three";

// One table travels with the captured frame: the video inbetweener and a
// downstream colour segmenter must agree on which colour names each limb.
// The segmenter treats neutral grey as uncoloured and locates the head by its
// adjacency to the torso, so the head intentionally has no hue.
//
// Hue layout (#407): 28 degrees apart on a wheel starting at 44 degrees, so
// the extractor's ±12 degree HSV window around each centre cannot overlap a
// neighbour even after the AI pass shifts hues (p95 11 degrees measured),
// every left/right pair sits 168 degrees apart, and both ends keep clear of
// the 8-36 degree wood/skin band the extractor excludes. The previous table
// failed this: rightUpperArm 202 vs rightShin 175 and rightForeArm 256 vs
// rightHand 283 were 27 degrees apart, the windows bled into each other, and
// palette keypoints placed the right shoulder on the right shin (#380).
export const PART_COLOURS = Object.freeze([
	{ part: "torso", bones: ["Hips", "Spine", "Spine1", "Spine2", "Neck", "LeftShoulder", "RightShoulder"], hex: "#FFFFFF", hue: null },
	{ part: "head", bones: ["Head", "HeadTop_End"], hex: "#8C8C8C", hue: null },
	{ part: "leftUpperArm", bones: ["LeftArm"], hex: "#FFBB00", hue: 44 },
	{ part: "rightUpperArm", bones: ["RightArm"], hex: "#0077FF", hue: 212 },
	{ part: "leftForeArm", bones: ["LeftForeArm"], hex: "#CCFF00", hue: 72 },
	{ part: "rightForeArm", bones: ["RightForeArm"], hex: "#0000FF", hue: 240 },
	{ part: "leftHand", bones: ["LeftHand"], hex: "#55FF00", hue: 100 },
	{ part: "rightHand", bones: ["RightHand"], hex: "#7700FF", hue: 268 },
	{ part: "leftThigh", bones: ["LeftUpLeg"], hex: "#00FF22", hue: 128 },
	{ part: "rightThigh", bones: ["RightUpLeg"], hex: "#EE00FF", hue: 296 },
	{ part: "leftShin", bones: ["LeftLeg"], hex: "#00FF99", hue: 156 },
	{ part: "rightShin", bones: ["RightLeg"], hex: "#FF0099", hue: 324 },
	{ part: "leftFoot", bones: ["LeftFoot", "LeftToeBase", "LeftToe_End"], hex: "#00EEFF", hue: 184 },
	{ part: "rightFoot", bones: ["RightFoot", "RightToeBase", "RightToe_End"], hex: "#FF0022", hue: 352 },
]);

function hueDistance(a, b) {
	const difference = Math.abs(a - b) % 360;
	return Math.min(difference, 360 - difference);
}

// Return useful diagnostics instead of throwing, so tests and palette editors
// can report all three constraints together. Head and torso have no hue.
export function paletteViolations(palette) {
	const limbs = palette.filter((entry) => entry.hue !== null);
	const violations = [];
	for (const [index, limb] of limbs.entries()) {
		if (limb.hue >= 10 && limb.hue <= 35) {
			violations.push(`${limb.part}: hue is inside 10-35 degrees`);
		}
		for (const other of limbs.slice(index + 1)) {
			// The extractor windows each hue by ±12 degrees and the AI pass drifts
			// hues ~11 degrees, so a gap below 28 lets two parts claim one pixel.
			if (hueDistance(limb.hue, other.hue) < 28) {
				violations.push(`${limb.part}/${other.part}: hues are less than 28 degrees apart`);
			}
		}
		if (!limb.part.startsWith("left")) continue;
		const right = limbs.find((entry) => entry.part === limb.part.replace(/^left/, "right"));
		if (right && hueDistance(limb.hue, right.hue) < 60) {
			violations.push(`${limb.part}/${right.part}: pair is less than 60 degrees apart`);
		}
	}
	return violations;
}

function normalizeBone(name) {
	// FBXLoader removes the colon in Mixamo namespaces. Accept both the file's
	// spelling and the loaded rig's spelling, as well as unprefixed bone names.
	return String(name ?? "").replace(/^mixamorig:?/i, "").toLowerCase();
}

export function partForBone(name) {
	const bone = normalizeBone(name);
	return PART_COLOURS.find((entry) => entry.bones.some((candidate) => {
		const canonical = normalizeBone(candidate);
		return bone === canonical || bone.startsWith(canonical);
	}))?.part ?? null;
}

export function applyPartColours(root, mode = "shaded") {
	const palette = new Map(PART_COLOURS.map((entry) => [entry.part, new THREE.Color(entry.hex)]));
	const fallback = palette.get("torso");
	const unassigned = new Set();
	root.traverse((mesh) => {
		if (!mesh.isSkinnedMesh || !mesh.geometry?.attributes.skinIndex) return;
		// SkeletonUtils clones bones but shares geometry with the cached FBX.
		// Colour only this instance, so another character and the grey mode keep
		// their original attributes. The caller restores/disposes this copy.
		const geometry = mesh.geometry.clone();
		const indices = geometry.attributes.skinIndex;
		const weights = geometry.attributes.skinWeight;
		const colours = new Float32Array(indices.count * 3);
		for (let vertex = 0; vertex < indices.count; vertex += 1) {
			let dominantBone = 0;
			let largestWeight = -1;
			for (let component = 0; component < 4; component += 1) {
				const weight = weights?.getComponent(vertex, component) ?? 0;
				if (weight > largestWeight) {
					largestWeight = weight;
					dominantBone = indices.getComponent(vertex, component);
				}
			}
			const bone = mesh.skeleton?.bones[dominantBone]?.name;
			const part = partForBone(bone);
			if (!part) unassigned.add(bone);
			const colour = palette.get(part) ?? fallback;
			colour.toArray(colours, vertex * 3);
		}
		geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3));
		mesh.geometry = geometry;
		// Unlit colours bypass tone mapping as well as lights, so an interior
		// flat pixel encodes the palette hex exactly after sRGB output conversion.
		mesh.material = mode === "flat"
			? new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false })
			: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.66, metalness: 0, envMapIntensity: 0.35 });
	});
	return [...unassigned];
}
