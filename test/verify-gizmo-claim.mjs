#!/usr/bin/env node
/**
 * Press-claim classification on GIZMO_LAYER (#81).
 *
 * The bug: ObjectGizmo's selection handler treated ANY GIZMO_LAYER raycast hit
 * as "another gizmo's handle" and swallowed the press. The layer also carries
 * pure furniture — the selected object's own cage, drawn arrows, rail lines —
 * so with a Cube selected, a click aimed at a Sphere behind the cage never
 * reached the object picker and the selection never changed.
 *
 * This rebuilds that exact geometry with real three.js raycasts and asserts
 * the split gizmo-claim.js draws: furniture never claims a press, explicitly
 * marked grab surfaces (handle proxies, key-light sun, path/crane dots) always
 * do, and the camera ghost — a selection target — falls through.
 */
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { HANDLE_PROXY_FLAG, claimsPress, isPressClaimer } from "../src/gizmo-claim.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

// The editor-furniture layer. dualview.jsx owns the constant but is JSX; the
// source assertion below keeps this literal honest.
const GIZMO_LAYER = 5;
const dualviewSource = readFileSync(new URL("../src/dualview.jsx", import.meta.url), "utf8");
expect("GIZMO_LAYER literal matches dualview.jsx", dualviewSource.includes("export const GIZMO_LAYER = 5"));

const onLayer = (node) => {
	node.layers.set(GIZMO_LAYER);
	return node;
};
const raycaster = new THREE.Raycaster();
raycaster.layers.set(GIZMO_LAYER);
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
camera.position.set(0, 1, 6);
camera.updateMatrixWorld();

/** GIZMO_LAYER hits for a ray from the camera through world `target`. */
const layerHits = (scene, target) => {
	scene.updateMatrixWorld(true);
	raycaster.set(camera.position, target.clone().sub(camera.position).normalize());
	return raycaster.intersectObjects(scene.children, true);
};

/* ------------------------- the reported scene ------------------------- */
// A selected 1 m Cube at the origin: its cage (EdgesGeometry LineSegments) and
// a drawn gizmo arrow ride GIZMO_LAYER unmarked, its pick proxy rides it
// MARKED. A Sphere sits behind on layer 0, visible past the cage.
const scene = new THREE.Scene();
const cage = onLayer(
	new THREE.LineSegments(
		new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04)),
		new THREE.LineBasicMaterial(),
	),
);
cage.position.set(0, 0.5, 0);
const arrow = onLayer(new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.62), new THREE.MeshBasicMaterial()));
arrow.position.set(0, 1.1, 0);
const proxy = onLayer(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.76), new THREE.MeshBasicMaterial()));
proxy.position.copy(arrow.position);
proxy.userData[HANDLE_PROXY_FLAG] = true;
const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), new THREE.MeshBasicMaterial());
sphere.position.set(1.6, 0.5, -1);
scene.add(cage, arrow, proxy, sphere);

// The regression itself: a press aimed at the Sphere's body crosses the cage's
// line raycast slop (the default Line threshold is 1 WORLD METRE), which used
// to veto the press before the object picker ran.
const towardSphere = layerHits(scene, sphere.position);
expect(
	"the cage line is actually under the sphere-bound ray (default 1 m Line slop)",
	towardSphere.some((hit) => hit.object === cage),
	JSON.stringify(towardSphere.map((hit) => hit.object.type)),
);
expect("a press aimed at another object's body is NOT claimed by furniture", !claimsPress(towardSphere));

// A press ON the gizmo's marked pick proxy still yields — twin-handle
// protection survives the fix.
expect("a press on a marked handle proxy IS claimed", claimsPress(layerHits(scene, proxy.position)));

// The drawn arrow alone (proxy removed) is furniture: it draws, it never owns
// a press.
scene.remove(proxy);
const towardArrow = layerHits(scene, arrow.position);
expect(
	"the drawn arrow is hit but claims nothing",
	towardArrow.some((hit) => hit.object === arrow) && !claimsPress(towardArrow),
	JSON.stringify(towardArrow.map((hit) => hit.object.type)),
);

/* --------------------- the other press-owning marks -------------------- */
// Markers ride meshes inside unmarked groups (KeyLightPuck's layout): the
// ancestor walk must find them either way, and index 0 is a valid dot.
const puck = new THREE.Group();
const sun = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), new THREE.MeshBasicMaterial());
sun.userData.keyLightPick = true;
puck.add(sun);
expect("the key-light sun claims through its group", isPressClaimer(sun));
const markedParent = new THREE.Group();
markedParent.userData.pathAxis = "y";
const plainChild = new THREE.Mesh();
markedParent.add(plainChild);
expect("a marked GROUP claims for its child mesh", isPressClaimer(plainChild));
for (const [key, value] of [["pathAxis", "y"], ["pathIndex", 0], ["craneAxis", "x"], ["craneIndex", 0]]) {
	const dot = new THREE.Mesh();
	dot.userData[key] = value;
	expect(`${key}=${JSON.stringify(value)} claims its press`, isPressClaimer(dot));
}

// The camera ghost is a selection target, not a claimer: its press must fall
// through to pickObject.
const ghost = new THREE.Mesh();
ghost.userData.shotCameraPick = true;
expect("the camera ghost never claims", !isPressClaimer(ghost));
expect("an unmarked mesh never claims", !isPressClaimer(new THREE.Mesh()));

/* ----------------------------- the wiring ------------------------------ */
// The classification only guards clicks if ObjectGizmo actually consults it
// and stamps its proxies. Source assertions keep the wiring from silently
// regressing to the blanket layer veto.
const gizmoSource = readFileSync(new URL("../src/object-gizmo.jsx", import.meta.url), "utf8");
expect(
	"every register* stamps the claim mark (axis, plane, corner proxies)",
	(gizmoSource.match(/mesh\.userData\[HANDLE_PROXY_FLAG\] = true/g) ?? []).length >= 3,
);
expect("the selection handler vetoes through claimsPress, not raw layer hits", /claimsPress\(tools\.raycaster\.intersectObjects/.test(gizmoSource));

if (failures) process.exit(1);
console.log("OK verify-gizmo-claim");
