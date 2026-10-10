// Object travel paths: schema repair, arc-length sampling and the frame →
// transform answer that playback, export and MCP all share.
import { readFileSync } from "node:fs";
import { createObjectPath, nearestPathFraction, pathCurve, pathCurvePointBetween, pathMarkFractions, pathMetrics, pathPointAtFraction, objectTransformAt, strokeToPathPoints, translateObjectPath, MAX_PATH_MARKS, MAX_PATH_POINTS, STROKE_MAX_POINTS } from "../src/object-path.js";
import { simplifyStroke } from "../src/camera-follow.js";
import { claimsPress } from "../src/gizmo-claim.js";
import { updateSceneObject } from "../src/scene-objects.js";

let failures = 0;
const ok = (name, pass, detail = "") => {
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : ` — ${detail}`}`);
	if (!pass) failures += 1;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/* --- schema ---------------------------------------------------------------- */

ok("a path needs two points", createObjectPath({ points: [{ x: 0, z: 0 }] }) === null);
ok("junk is not a path", createObjectPath(null) === null && createObjectPath({}) === null);
ok("a stroke that never moves is not a path", createObjectPath({ points: [{ x: 1, z: 1 }, { x: 1, z: 1 }] }) === null);
ok("repeated drag samples collapse", (() => {
	const path = createObjectPath({ points: [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 4, z: 0 }] });
	return path?.points.length === 2;
})());
ok("points are clamped into the room and above the floor", (() => {
	const path = createObjectPath({ points: [{ x: -9999, y: -5, z: 0 }, { x: 9999, y: 9999, z: 0 }] });
	return path.points[0].x === -240 && path.points[0].y === 0 && path.points[1].x === 240 && path.points[1].y === 60;
})());
ok("point count is capped", (() => {
	const many = Array.from({ length: 200 }, (_, i) => ({ x: i, z: 0 }));
	return createObjectPath({ points: many }).points.length === MAX_PATH_POINTS;
})());
ok("faceTravel defaults on, loop and extend default off", (() => {
	const path = createObjectPath({ points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] });
	return path.faceTravel === true && path.loop === false && path.extend === false;
})());
ok("a negative or absurd speed falls back to fill-the-timeline", (() => {
	const slow = createObjectPath({ points: [{ x: 0, z: 0 }, { x: 1, z: 0 }], speed: -3 });
	const fast = createObjectPath({ points: [{ x: 0, z: 0 }, { x: 1, z: 0 }], speed: 999 });
	return slow.speed === 0 && fast.speed === 50;
})());

/* --- arc length ------------------------------------------------------------ */

{
	const path = createObjectPath({ points: [{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 4 }] });
	const metrics = pathMetrics(path);
	// The route rounds the corner: a little off the 7 m of chords, never the
	// 5 m shortcut, and arc length only ever grows.
	ok("the travelled length is the curve through the stroke", metrics.length > 6.5 && metrics.length < 7.6 && metrics.cumulative.every((value, i) => i === 0 || value >= metrics.cumulative[i - 1]), String(metrics.length));
	const curve = pathCurve(path);
	ok("the curve passes through every authored point", path.points.every((point) => curve.points.some((sample) => near(sample.x, point.x, 1e-9) && near(sample.z, point.z, 1e-9))));
	ok("the curve starts and ends on the stroke's ends", near(curve.points[0].x, 0) && near(curve.points.at(-1).x, 3) && near(curve.points.at(-1).z, 4));
}

{
	// A corner is turned, not snapped: across a right-angle route the heading
	// never jumps more than a few degrees between frames, and still ends up
	// facing the last leg.
	const object = { path: { points: [{ x: 0, z: 0 }, { x: 0, z: 6 }, { x: 6, z: 6 }] } };
	const turnTake = { frameCount: 241, fps: 24 };
	let worst = 0;
	let previous = objectTransformAt(object, 0, turnTake).rot;
	for (let frame = 1; frame < 241; frame += 1) {
		const rot = objectTransformAt(object, frame, turnTake).rot;
		worst = Math.max(worst, Math.abs(((((rot - previous) % 360) + 540) % 360) - 180));
		previous = rot;
	}
	ok("a corner turns the heading smoothly", worst < 4, `largest per-frame turn ${worst.toFixed(2)}°`);
	ok("the heading starts down the first leg and ends down the last", near(objectTransformAt(object, 0, turnTake).rot, 0, 1) && near(objectTransformAt(object, 240, turnTake).rot, 90, 1));
	const corner = objectTransformAt(object, 120, turnTake);
	ok("the route cuts inside the corner instead of touching it twice", Math.hypot(corner.x - 0, corner.z - 6) < 1.5, JSON.stringify(corner));
}

{
	const points = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 6 }, { x: 6, y: 1, z: 6 }];
	const start = pathCurvePointBetween(points, 1, 0);
	const end = pathCurvePointBetween(points, 1, 1);
	const mid = pathCurvePointBetween(points, 1, 0.5);
	const curve = pathCurve({ points });
	const closest = Math.min(...curve.points.map((sample) => Math.hypot(sample.x - mid.x, sample.y - mid.y, sample.z - mid.z)));
	ok("a point between two handles sits on the curve", near(start.x, 0) && near(start.z, 6) && near(end.x, 6) && near(end.y, 1) && closest < 0.05, JSON.stringify({ mid, closest }));
	ok("a point between handles is refused off the ends", pathCurvePointBetween(points, 2, 0.5) === null && pathCurvePointBetween(points, -1, 0.5) === null);
}

/* --- sampling -------------------------------------------------------------- */

const take = { frameCount: 25, fps: 24 }; // exactly one second of travel

{
	// 24 m across 1 s with no speed set: the path fills the timeline
	const object = { path: { points: [{ x: 0, z: 0 }, { x: 24, z: 0 }] } };
	const start = objectTransformAt(object, 0, take);
	const mid = objectTransformAt(object, 12, take);
	const end = objectTransformAt(object, 24, take);
	ok("frame 0 sits at the stroke's start", near(start.x, 0) && near(start.z, 0));
	ok("the middle frame is halfway along", near(mid.x, 12, 1e-3), JSON.stringify(mid));
	ok("the last frame lands on the end", near(end.x, 24, 1e-3), JSON.stringify(end));
}
{
	// an explicit speed overrides the fill
	const object = { path: { points: [{ x: 0, z: 0 }, { x: 24, z: 0 }], speed: 1 } };
	const end = objectTransformAt(object, 24, take);
	ok("an explicit speed travels metres per second", near(end.x, 1, 1e-3), JSON.stringify(end));
}
{
	// without extend the object parks at the end
	const object = { path: { points: [{ x: 0, z: 0 }, { x: 2, z: 0 }], speed: 10 } };
	const parked = objectTransformAt(object, 24, take);
	ok("travel stops at the last point by default", near(parked.x, 2, 1e-3), JSON.stringify(parked));
}
{
	// extend keeps going in the final direction — the "just keep moving" case
	const object = { path: { points: [{ x: 0, z: 0 }, { x: 2, z: 0 }], speed: 10, extend: true } };
	const past = objectTransformAt(object, 24, take);
	ok("extend keeps travelling past the end", past.x > 9, JSON.stringify(past));
}
{
	// loop wraps instead of parking
	const object = { path: { points: [{ x: 0, z: 0 }, { x: 4, z: 0 }], speed: 8, loop: true } };
	const wrapped = objectTransformAt(object, 24, take);
	ok("loop wraps back onto the stroke", wrapped.x >= 0 && wrapped.x <= 4, JSON.stringify(wrapped));
}
{
	// heading: travelling +x faces +x (yaw 90°), travelling +z faces +z (yaw 0)
	const east = objectTransformAt({ path: { points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] } }, 5, take);
	const north = objectTransformAt({ path: { points: [{ x: 0, z: 0 }, { x: 0, z: 10 }] } }, 5, take);
	ok("faceTravel yaws toward the direction of travel", near(east.rot, 90, 1e-6) && near(north.rot, 0, 1e-6), `${east.rot} / ${north.rot}`);
	const free = objectTransformAt({ path: { points: [{ x: 0, z: 0 }, { x: 10, z: 0 }], faceTravel: false } }, 5, take);
	ok("faceTravel off leaves rotation to the author", free.rot === null);
}
{
	// height rides along: a plane can climb as it travels
	const object = { path: { points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 5, z: 0 }] } };
	const mid = objectTransformAt(object, 12, take);
	ok("a lifted path carries the object's height", mid.y > 2 && mid.y < 3, JSON.stringify(mid));
}
{
	ok("an object without a path samples to nothing", objectTransformAt({ x: 1, z: 2 }, 5, take) === null);
	ok("a frame beyond the take clamps", (() => {
		const object = { path: { points: [{ x: 0, z: 0 }, { x: 24, z: 0 }] } };
		const beyond = objectTransformAt(object, 9999, take);
		return near(beyond.x, 24, 1e-3);
	})());
}

/* --- a stroke keeps its shape, like the camera rail's ---------------------- */

// The camera rail simplifies at 0.12 m and keeps what that asks for; the route
// takes the same treatment. What a hand grabs are the MARKS, not these points.
const straightDrag = Array.from({ length: 60 }, (_, i) => ({ x: i * 0.1, z: 0 }));
const dogLeg = [
	...Array.from({ length: 30 }, (_, i) => ({ x: i * 0.2, z: 0 })),
	...Array.from({ length: 30 }, (_, i) => ({ x: 6, z: i * 0.2 })),
];
const circle = Array.from({ length: 120 }, (_, i) => ({ x: Math.cos((i / 120) * Math.PI * 2) * 5, z: Math.sin((i / 120) * Math.PI * 2) * 5 }));
const noisy = Array.from({ length: 200 }, (_, i) => ({ x: i * 0.05, z: Math.sin(i) * 0.4 }));

ok("a straight drag is two points (nothing to keep)", strokeToPathPoints(straightDrag, simplifyStroke).length === 2);
ok("a dog-leg keeps its corner", strokeToPathPoints(dogLeg, simplifyStroke).length === 3);
ok(
	"no stroke exceeds the ceiling",
	[straightDrag, dogLeg, circle, noisy].every((stroke) => strokeToPathPoints(stroke, simplifyStroke).length <= STROKE_MAX_POINTS),
);
ok(
	"the stroke's ends survive simplification",
	(() => {
		const points = strokeToPathPoints(dogLeg, simplifyStroke);
		const first = points[0];
		const last = points[points.length - 1];
		return Math.abs(first.x - dogLeg[0].x) < 1e-9 && Math.abs(last.z - dogLeg[dogLeg.length - 1].z) < 1e-9;
	})(),
);
ok("a stroke that is not a stroke yields nothing", strokeToPathPoints([{ x: 0, z: 0 }], simplifyStroke).length === 0);
ok("stroke points come in floor form, height authored later", strokeToPathPoints(dogLeg, simplifyStroke).every((point) => point.y === 0));

ok(
	"a drawn stroke keeps the camera rail's point count (same 0.12 m pass), not a caricature",
	(() => {
		const stroke = Array.from({ length: 100 }, (_, i) => ({ x: i * 0.1, z: Math.sin(i * 0.12) * 2 }));
		const rail = simplifyStroke(stroke, 0.12);
		const route = strokeToPathPoints(stroke, simplifyStroke);
		return rail.length > 5 && route.length === rail.length;
	})(),
);
ok("a very busy stroke still fits the schema's point ceiling", strokeToPathPoints(noisy, simplifyStroke).length <= MAX_PATH_POINTS);
ok("a stroke is not capped at the old five points", STROKE_MAX_POINTS === MAX_PATH_POINTS);

/* --- marks: the dots a hand takes hold of ---------------------------------- */

{
	const flat = createObjectPath({ points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] });
	ok("a route has its two ends as marks and no more by default", pathMarkFractions(flat).join() === "0,1");
	const marked = createObjectPath({ points: [{ x: 0, z: 0 }, { x: 10, z: 0 }], marks: [0.7, 0.3, 0.31, 0.001, 0.999, "x", 0.3] });
	ok("marks are sorted, deduplicated and kept off the ends", pathMarkFractions(marked).join() === "0,0.3,0.7,1");
	const many = createObjectPath({ points: [{ x: 0, z: 0 }, { x: 10, z: 0 }], marks: Array.from({ length: 30 }, (_, i) => 0.04 + i * 0.03) });
	ok("marks stop at the camera rail's ceiling", pathMarkFractions(many).length === MAX_PATH_MARKS);
	ok("marks survive a translated route", pathMarkFractions(translateObjectPath(marked, { x: 3, y: 0, z: 1 })).join() === "0,0.3,0.7,1");
	const at = pathPointAtFraction(flat, 0.25);
	ok("a mark rides the curve at its arc fraction", near(at.x, 2.5, 1e-6) && near(at.z, 0, 1e-6));
	const hit = nearestPathFraction(flat, (point) => ({ x: point.x * 10, y: point.z * 10 }), 40, 3);
	ok("the nearest spot on the route is found by arc fraction", near(hit.t, 0.4, 1e-6) && near(hit.d, 3, 1e-6));
}

/* --- the strip loads the selected subject -------------------------------- */

const timelineSource = readFileSync(new URL("../src/ardy/timeline.jsx", import.meta.url), "utf8");
// The studio source spans App.jsx and app-stage.jsx (module-level extraction); pin against both.
const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/app-stage.jsx", import.meta.url), "utf8");

const travelTrackSource = timelineSource.slice(
	timelineSource.indexOf("function ObjectTravelTrack("),
	timelineSource.indexOf("function CameraBlockEditor("),
);

ok("the strip has a travel track for a selected prop", timelineSource.includes("function ObjectTravelTrack("));
ok(
	"selecting a prop swaps the performer's lanes instead of joining them",
	timelineSource.includes("{pathObject ? (") && timelineSource.includes(") : tracks.map((name) => ("),
);
ok(
	"the prop's track carries the route controls",
	["Draw path", "Speed", "Keep going", "Loop", "Delete path"].every((label) => travelTrackSource.includes(label)),
);
ok("the prop's track names its subject", travelTrackSource.includes('ko("PROP", "소품")'));
ok("the prop's track folds duration into the graph header", travelTrackSource.includes("metrics.length.toFixed(1)") && travelTrackSource.includes("seconds.toFixed(1)"));
ok("prop motion did not become a separate bottom tab", !appSource.includes('bottomTab === "object"'));
ok("the inspector still does not host the path controls", !appSource.includes('ko("Travel path", "이동 경로")'));

/* --- mid-path points ------------------------------------------------------- */

const handlesSource = appSource.slice(
	appSource.indexOf("function ObjectPathHandles("),
	appSource.indexOf("function CraneHandles("),
);

ok("the route takes a mark on double-click", handlesSource.includes('addEventListener("dblclick", onDouble'));
ok(
	"a mark lands on the travelled curve, so adding one never reshapes the route",
	handlesSource.includes("nearestPathFraction(s.path, paneScreen, event.clientX, event.clientY)"),
);
ok("a mark cannot be dropped on top of another", handlesSource.includes("PATH_MARK_CLEARANCE"));
ok("the route refuses to grow past the camera rail's mark ceiling", handlesSource.includes("fractions.length >= MAX_PATH_MARKS"));
ok("dragging a mark bends the route with the camera rail's own preparation", handlesSource.includes("prepareRailBend(s.path.points"));
ok("Shift slides a mark along the route, as a crane mark slides", handlesSource.includes("event.shiftKey"));
ok("a press on the route is claimed, so the object stays selected for the double-click", handlesSource.includes("userData.pathLine") && claimsPress([{ object: { userData: { pathLine: true }, parent: null } }]));
ok("only an interior mark can be deleted", handlesSource.includes("s.selectedIndex <= 0 || s.selectedIndex >= fractions.length - 1"));
ok(
	"a selected point owns Delete, so the prop survives the press",
	appSource.includes("if (pathPointIndex != null) return;"),
);


/* --- the same gesture on the board it was drawn on -------------------------- */

const planSource = readFileSync(new URL("../src/planview.jsx", import.meta.url), "utf8");

ok("the Top-View takes a mark on double-click", planSource.includes('addEventListener("dblclick", onDouble)'));
ok("the board draws the camera rail's own line for the route", planSource.includes("<CameraRailLine points={curve.points} color={OBJECT_PATH_COLOR} />"));
ok("route points outrank pucks when picking on the board", planSource.includes('mode: "pathPoint"'));
ok("dragging a board point is one undo entry", planSource.includes("onObjectPathGestureStart") && planSource.includes("onObjectPathGestureEnd"));
ok(
	"the board bends the floor route and leaves height to the scene",
	planSource.includes("prepareRailBend(route.points") && !planSource.includes("entry.y +"),
);
ok(
	"the strip teaches both gestures instead of leaving them to be found",
	travelTrackSource.includes("선을 더블클릭하면 점 추가") && travelTrackSource.includes("Delete로 삭제"),
);

/* --- the strip's own layout ----------------------------------------------- */

const cssSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// A range input on a dark lane draws nothing but its thumb unless the track is
// styled, which reads as a broken control rather than a slider.
ok(
	"the speed slider paints a track and a thumb",
	cssSource.includes("::-webkit-slider-runnable-track") && cssSource.includes("::-webkit-slider-thumb"),
);
ok("the slider has a real width", /\.objmo-speed input\[type="range"\][^}]*width: 96px/s.test(cssSource));
ok(
	"speed reads as one unit rather than drifting apart",
	cssSource.includes(".objmo-speed {") && travelTrackSource.includes('className="objmo-speed"'),
);
ok("a long prop name is clipped, not spilled", cssSource.includes(".tl-track.objmo .tl-track-label .objmo-name") && cssSource.includes("text-overflow: ellipsis"));
ok(
	"the hint shares the controls row instead of owning an empty one",
	travelTrackSource.includes('<span className="tl-path-hint">') &&
	(travelTrackSource.match(/tl-track objmo/g) ?? []).length === 2 &&
	!travelTrackSource.includes('ko("Travel"'),
);
ok("the strip keeps the default height — no growth hack for the graph", !cssSource.includes("has(.tl-track.sg-row)"));
ok("the speed editor is a real instrument: header, graph body, axes",
	cssSource.includes(".sg-head") && cssSource.includes(".sg-body svg") &&
	cssSource.includes(".sg-axis") && cssSource.includes(".sg-average"));
ok("cuts are visible affordances, not hidden gestures",
	timelineSource.includes('ko("Cut at playhead", "재생 위치에 컷")') &&
	cssSource.includes(".sg-cut-diamond"));
ok("the travel bar row is gone, folded into the graph", !travelTrackSource.includes('ko("Travel", "이동")') && !cssSource.includes(".objmo-travel {"));


ok("the speed graph never display-clamps: the axis follows the data",
	timelineSource.includes("GRAPH_MIN_SCALE") &&
	!timelineSource.includes("Math.min(value, GRAPH_MAX_SCALE)") &&
	timelineSource.includes("envelopePeak"));
ok("the axis never shrinks under the pointer mid-drag",
	timelineSource.includes("setDragPeak((peak) => Math.max(peak, at.value))") &&
	timelineSource.includes("setDragPeak(0)"));

ok("the dolly graph lives inside its shot card, not a floating row",
	timelineSource.includes("sg-shot") &&
	timelineSource.includes("railLengthByShot") &&
	!timelineSource.includes("sg-cam .sg-lane"));

/* --- moving a prop that owns a route -------------------------------------- */

// The route is the prop's own geometry, so a prop and its route are one body:
// the frame-by-frame placement comes from the path alone, and a route that
// stayed behind would pin the prop to its old ground while the inspector
// claimed it had moved.
const routed = (over = {}) => ({
	id: "card",
	name: "Card",
	renderer: "cube",
	x: 0,
	y: 0,
	z: 0,
	rot: 0,
	rotX: 0,
	rotZ: 0,
	scaleX: 1,
	scaleY: 1,
	scaleZ: 1,
	parent: null,
	color: "#c8c8c8",
	footprint: { width: 1, depth: 1 },
	height: 1,
	path: { points: [{ x: -2, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }], speed: 0, faceTravel: true, loop: false, extend: false, timing: null },
	...over,
});

ok("dragging a routed prop carries its route with it", (() => {
	const [moved] = updateSceneObject([routed()], "card", { x: 3, z: 1.5 });
	return moved.path.points[0].x === 1 && moved.path.points[0].z === 1.5 &&
		moved.path.points[1].x === 5 && moved.path.points[1].z === 1.5;
})());
ok("a lifted prop lifts its route by the same metres", (() => {
	const [moved] = updateSceneObject([routed()], "card", { y: 2 });
	return moved.path.points.every((point) => point.y === 2);
})());
ok("the route keeps its shape, so the prop still travels the same distance", (() => {
	const before = pathMetrics(createObjectPath(routed().path)).length;
	const [moved] = updateSceneObject([routed()], "card", { x: 7, z: -4 });
	return near(pathMetrics(moved.path).length, before, 1e-6);
})());
ok("an authored route edit wins over the drag it arrives with", (() => {
	const [moved] = updateSceneObject([routed()], "card", { x: 3, path: { points: [{ x: 0, z: 0 }, { x: 1, z: 0 }] } });
	return moved.path.points[0].x === 0 && moved.path.points[1].x === 1;
})());
ok("a routed child is carried by its parent, route and all", (() => {
	const parent = routed({ id: "parent", path: null });
	const child = routed({ id: "child", parent: "parent" });
	const next = updateSceneObject([parent, child], "parent", { x: 2 });
	const moved = next.find((object) => object.id === "child");
	return moved.path.points[0].x === 0 && moved.path.points[1].x === 4;
})());
ok("a standing prop is untouched by the carry", (() => {
	const standing = routed({ id: "standing", path: null });
	const [moved] = updateSceneObject([standing], "standing", { x: 2 });
	return moved.path === null && moved.x === 2;
})());

console.log(failures === 0 ? "all object-path checks PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
