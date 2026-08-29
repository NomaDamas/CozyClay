import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { applyPose, primeBindPose, POSE_BONES } from "./poses.js";

/**
 * Pose Studio thumbnails, rendered on demand. The studio's pose entries are
 * pure bone data (no image assets ship), so each tile's preview is generated
 * here: clone the character rig, apply the pose, render one 256px frame with
 * the same clay look as the viewport, and hand back a data URL. Results are
 * cached per model+pose for the session; the FBX itself is fetched once per
 * model (the browser HTTP cache dedupes the studio's own copy).
 */

const THUMB_SIZE = 256;
const BODY_CLAY = "#f2eee6";

const modelCache = new Map(); // model id -> Promise<Group>
const thumbCache = new Map(); // `${model}:${poseId}` -> Promise<dataURL>

// Thumbnail renders are SERIALIZED and yield to the browser between tiles:
// a burst of 16 skinned 165k-vert clones on the main thread freezes the
// studio open for half a second, so each tile waits for an idle slice.
let renderQueue = Promise.resolve();
const idle = () => new Promise((resolve) => {
	if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 120 });
	else setTimeout(resolve, 16);
});
function enqueueRender(work) {
	const run = renderQueue.then(async () => {
		await idle();
		return work();
	});
	renderQueue = run.catch(() => {});
	return run;
}

function loadModel(model) {
	if (!modelCache.has(model)) {
		modelCache.set(model, new Promise((resolve, reject) => {
			new FBXLoader().load(`/models/${model}.fbx`, resolve, undefined, reject);
		}));
	}
	return modelCache.get(model);
}

let renderer = null;
function thumbRenderer() {
	if (renderer) return renderer;
	const canvas = document.createElement("canvas");
	canvas.width = THUMB_SIZE;
	canvas.height = THUMB_SIZE;
	renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
	renderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
	return renderer;
}

// One rig per model, RE-POSED per tile: cloning + material traversal per
// pose was the bulk of the studio-open stall — one clone serves them all.
const thumbRigCache = new Map(); // model id -> Promise<Group (prepared clone)>
function thumbRig(model) {
	if (!thumbRigCache.has(model)) {
		thumbRigCache.set(model, loadModel(model).then((fbx) => {
			const rig = SkeletonUtils.clone(fbx);
			rig.scale.setScalar(0.01); // Mixamo exports centimetres
			const jointTint = new THREE.Color(BODY_CLAY).multiplyScalar(0.45);
			rig.traverse((child) => {
				if (child.isMesh) {
					child.material = new THREE.MeshStandardMaterial({
						color: /_Joints$/i.test(child.name) ? jointTint : BODY_CLAY,
						roughness: 0.82,
						metalness: 0,
					});
					child.frustumCulled = false;
				}
			});
			primeBindPose(rig);
			return rig;
		}));
	}
	return thumbRigCache.get(model);
}

function thumbScene() {
	const scene = new THREE.Scene();
	scene.background = new THREE.Color("#101014");
	const hemi = new THREE.HemisphereLight(0xffffff, 0x3a3a40, 1.25);
	const key = new THREE.DirectionalLight(0xffffff, 1.6);
	key.position.set(2.2, 4, 3);
	// A barely-lighter floor so floor poses (seated, kneel) read grounded and
	// air poses (jump) read airborne instead of everyone floating in a void.
	const floor = new THREE.Mesh(
		new THREE.CircleGeometry(6, 48),
		new THREE.MeshStandardMaterial({ color: "#17171d", roughness: 1 })
	);
	floor.rotation.x = -Math.PI / 2;
	scene.add(hemi, key, floor);
	return scene;
}

/** Frame the POSED rig, not a standing mannequin: hands-up, jump and floor
 * poses all leave the fixed framing of a standing figure, so the camera is
 * recomputed from the pose's own bone extents (plus a small margin). */
function frameCamera(rig) {
	rig.updateMatrixWorld(true);
	const box = new THREE.Box3();
	const point = new THREE.Vector3();
	rig.traverse((object) => {
		if (!object.isBone) return;
		object.getWorldPosition(point);
		box.expandByPoint(point);
	});
	if (box.isEmpty()) box.setFromObject(rig);
	const center = box.getCenter(new THREE.Vector3());
	const size = box.getSize(new THREE.Vector3());
	// Hands and feet sit slightly past their bones; heads a touch more.
	const padded = Math.max(size.x, size.y, size.z) * 0.5 + 0.22;
	const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 50);
	const distance = padded / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
	const direction = new THREE.Vector3(0.3, 0.42, 1).normalize();
	camera.position.copy(center).addScaledVector(direction, distance);
	camera.lookAt(center.x, center.y - size.y * 0.04, center.z);
	return camera;
}

/** Preload a rig model during browser idle so the first studio open does
 * not pay the FBX parse in one frame. Fire-and-forget by design. */
export function warmThumbnailModels(models) {
	for (const model of models) enqueueRender(() => thumbRig(model));
}

/** Render one pose of one rig model to a PNG data URL. */
export function poseThumbnail(model, pose) {
	const key = `${model}:${pose.id}`;
	if (!thumbCache.has(key)) {
		thumbCache.set(key, enqueueRender(() => thumbRig(model).then((rig) => {
			// Re-pose the shared rig: applyPose writes deltas over the stamped
			// bind pose, so a rest stamp per tile resets the previous pose.
			applyPose(rig, Object.fromEntries(POSE_BONES.map((bone) => [bone.id, [0, 0, 0]])));
			applyPose(rig, pose.bones);
			const scene = thumbScene();
			scene.add(rig);
			const camera = frameCamera(rig);
			const gl = thumbRenderer();
			gl.render(scene, camera);
			const url = gl.domElement.toDataURL("image/png");
			scene.remove(rig);
			return url;
		})));
	}
	return thumbCache.get(key);
}
