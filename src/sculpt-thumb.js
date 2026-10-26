// The sculpt card's picture (#740 S9): one 256 px frame of the recipe from the
// front three-quarter view, the turntable's look without the turntable. The
// camera fit is pure (sculptThumbCamera, node-tested); the render needs WebGL.
//
// Each render gets its own small WebGLRenderer and loses its context right
// after, so a save never holds a second context next to the viewport's. Renders
// are serialized: two quick saves never build two scatter-heavy groups at once.
import * as THREE from "three";
import { buildSculptGroup, disposeSculptGroup } from "./sculpt-geometry.js";

const SCULPT_THUMB_SIZE = 256;
// Target values: SCULPT_VIEWS (sculpt-mode.js) has front, side and back only.
const THUMB_YAW = 35;
const THUMB_ELEVATION = 15;
const THUMB_FOV = 30;

/**
 * Where the thumbnail camera stands for a bounding box { min: [x,y,z], max }.
 * Yaw turns toward the subject's own left (+x) from the front (+z), elevation
 * lifts it; the distance fits the box's bounding sphere inside the field of
 * view with a small margin, so any recipe size fills the same frame.
 */
export function sculptThumbCamera(box, { yaw = THUMB_YAW, elevation = THUMB_ELEVATION, fov = THUMB_FOV } = {}) {
	const min = box?.min ?? [0, 0, 0], max = box?.max ?? [0, 0, 0];
	const target = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2);
	const radius = Math.max(0.05, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
	const distance = (radius / Math.sin(THREE.MathUtils.degToRad(fov) / 2)) * 1.08;
	const y = THREE.MathUtils.degToRad(yaw), e = THREE.MathUtils.degToRad(elevation);
	const position = [target[0] + distance * Math.sin(y) * Math.cos(e), target[1] + distance * Math.sin(e), target[2] + distance * Math.cos(y) * Math.cos(e)];
	return { position, target, fov, near: Math.max(0.01, distance - radius * 2), far: distance + radius * 2 };
}

let queue = Promise.resolve();

function renderNow(recipe) {
	const canvas = document.createElement("canvas");
	canvas.width = SCULPT_THUMB_SIZE;
	canvas.height = SCULPT_THUMB_SIZE;
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
	const group = buildSculptGroup(recipe);
	try {
		renderer.setSize(SCULPT_THUMB_SIZE, SCULPT_THUMB_SIZE, false);
		renderer.setClearColor(0x000000, 0);
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		const scene = new THREE.Scene();
		scene.add(new THREE.HemisphereLight(0xfff6ea, 0x5a5048, 1.6));
		const key = new THREE.DirectionalLight(0xffffff, 2.2);
		key.position.set(2, 4, 3);
		scene.add(key, group);
		const box = new THREE.Box3().setFromObject(group);
		const fit = sculptThumbCamera(box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() });
		const camera = new THREE.PerspectiveCamera(fit.fov, 1, fit.near, fit.far);
		camera.position.fromArray(fit.position);
		camera.lookAt(...fit.target);
		renderer.render(scene, camera);
		return canvas.toDataURL("image/png");
	} finally {
		disposeSculptGroup(group);
		renderer.dispose();
		renderer.forceContextLoss();
	}
}

/** A PNG data URL of the recipe, or null when this browser cannot draw it. */
export function renderSculptThumb(recipe) {
	const run = queue.then(() => renderNow(recipe));
	queue = run.catch(() => {});
	return run.catch((error) => {
		console.warn("[cozyclay] could not draw the sculpt card thumbnail", error);
		return null;
	});
}
