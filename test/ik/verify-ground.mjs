import { createGroundSampler, isCollidable } from "../../src/ardy/ground.js";

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// Plain scene-object records: a 1 m box (0.2 m tall) at the origin, a 0.4 m
// step further down +z, and a rotated plank.
const box = { id: "box", kind: "box", x: 0, z: 0, y: 0, height: 0.2, footprint: { width: 1, depth: 1 } };
const step = { id: "step", kind: "box", x: 0, z: 2, y: 0, height: 0.4, footprint: { width: 1, depth: 0.5 } };
const plank = { id: "plank", kind: "box", x: 3, z: 0, y: 0, rot: 45, height: 0.1, footprint: { width: 2, depth: 0.2 } };
const stacked = { id: "top", kind: "box", x: 0, z: 0, y: 0.2, height: 0.3, footprint: { width: 0.5, depth: 0.5 } };

const ground = createGroundSampler([box, step, plank]);
check("open floor is floorY", near(ground(5, 5), 0));
check("inside the box footprint the ground is the box top", near(ground(0.2, -0.3), 0.2));
check("footprint edge is inclusive", near(ground(0.5, 0.5), 0.2));
check("just outside the footprint falls back to the floor", near(ground(0.5001, 0), 0));
check("the step reports its own height", near(ground(0, 2.1), 0.4));
check("a yawed plank widens its AABB (approximation documented in objectFootprintBounds)", near(ground(3 + 0.7, 0), 0.1), `got ${ground(3.7, 0)}`);

const stack = createGroundSampler([box, stacked]);
check("stacked objects: the highest top under the point wins", near(stack(0.1, 0.1), 0.5));
check("stacked objects: outside the top box, the lower box is ground", near(stack(0.4, 0.4), 0.2));
check("maxY excludes surfaces above the foot (under a table, keep the lower ground)", near(stack(0.1, 0.1, 0.3), 0.2));

const raised = createGroundSampler([box], { floorY: -1 });
check("custom floorY is the fallback", near(raised(5, 5), -1));
check("custom floorY does not move object tops", near(raised(0, 0), 0.2));

check("cutouts are not ground", !isCollidable({ ...box, kind: "cutout" }));
check("attached/child objects are not ground", !isCollidable({ ...box, parentId: "x" }) && !isCollidable({ ...box, attach: { to: "hand" } }));
check("collide:false opts out", !isCollidable({ ...box, collide: false }));
check("a flat (zero-height) object is not ground", !isCollidable({ ...box, height: 0 }));
check("sampler exposes its surfaces for debugging", ground.surfaces.length === 3 && ground.floorY === 0);

if (failures) { console.log(`${failures} FAIL`); process.exit(1); }
console.log("all PASS");
