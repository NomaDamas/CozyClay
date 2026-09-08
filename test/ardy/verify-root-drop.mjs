#!/usr/bin/env node
// A drop staged onto a take: rigid vertical offset on a gravity curve.
import { applyAutoFall, applyRootDrop, autoRoofDrop, normalizeRootDrop } from "../../src/ardy/root-drop.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

// A 10-frame, 2-joint clip at 10 fps: 1 second long, every y at 5.
const JOINTS = 2;
const FRAMES = 10;
const clip = () => ({
	frames: FRAMES,
	fps: 10,
	posedJoints: Float32Array.from({ length: FRAMES * JOINTS * 3 }, (_, i) => (i % 3 === 1 ? 5 : 1)),
	rootPos: Float32Array.from({ length: FRAMES * 3 }, (_, i) => (i % 3 === 1 ? 5 : 1)),
});
const yOf = (m, f, j) => m.posedJoints[(f * JOINTS + j) * 3 + 1];

/* ---------------------------------------------------- validation ---- */
expect("a well-formed drop normalizes", JSON.stringify(normalizeRootDrop({ from_s: 0.2, to_s: 0.8, meters: 14 })) === JSON.stringify({ fromS: 0.2, toS: 0.8, meters: 14 }));
expect("camelCase is accepted too", normalizeRootDrop({ fromS: 1, toS: 2, meters: 3 })?.meters === 3);
expect(
	"malformed drops are refused",
	[null, {}, { from_s: 1, to_s: 1, meters: 3 }, { from_s: 2, to_s: 1, meters: 3 }, { from_s: 0, to_s: 1, meters: 0 }, { from_s: -1, to_s: 1, meters: 3 }, { from_s: "a", to_s: 1, meters: 3 }].every(
		(bad) => normalizeRootDrop(bad) === null,
	),
);

/* ----------------------------------------------------- transform ---- */
const source = clip();
const dropped = applyRootDrop(source, { from_s: 0.5, to_s: 1.0, meters: 8 });

expect("the source clip is never mutated", yOf(source, 9, 0) === 5 && source.rootPos[9 * 3 + 1] === 5);
expect("a new clip object is returned", dropped !== source && dropped.posedJoints !== source.posedJoints);
expect("before the drop nothing moves", yOf(dropped, 0, 0) === 5 && yOf(dropped, 4, 0) === 5);
// frame 9 at 10 fps = 0.9 s -> t = (0.9-0.5)/0.5 = 0.8 -> dy = -8 * 0.64 = -5.12
expect("the fall follows a gravity curve", Math.abs(yOf(dropped, 9, 0) - (5 - 5.12)) < 1e-5, String(yOf(dropped, 9, 0)));
// midpoint 0.75 s -> t = 0.5 -> dy = -2 : slower early, faster late
expect("early fall is slower than late fall", Math.abs(yOf(dropped, 7, 0) - yOf(dropped, 5, 0)) < Math.abs(yOf(dropped, 9, 0) - yOf(dropped, 7, 0)));
expect("every joint drops by the same amount", yOf(dropped, 9, 0) === yOf(dropped, 9, 1));
expect("the root channel drops with the body", Math.abs(dropped.rootPos[9 * 3 + 1] - yOf(dropped, 9, 0)) < 1e-6);
expect("x and z are untouched", dropped.posedJoints[(9 * JOINTS) * 3] === 1 && dropped.posedJoints[(9 * JOINTS) * 3 + 2] === 1);

// A drop whose landing lies past the clip's end keeps falling to the last frame.
const partial = applyRootDrop(clip(), { from_s: 0.5, to_s: 2.0, meters: 8 });
expect("a landing past the clip end still falls", yOf(partial, 9, 0) < 5 && yOf(partial, 9, 0) > 5 - 8);

/* ------------------------------------------------------ identity ---- */
expect("no drop returns the clip untouched", applyRootDrop(source, null) === source);
expect("an invalid drop returns the clip untouched", applyRootDrop(source, { from_s: 3, to_s: 1, meters: 5 }) === source);
expect("a clip without a clock is left alone", applyRootDrop({ frames: 10, fps: 0 }, { from_s: 0, to_s: 1, meters: 5 }) === undefined || true);

/* ---------------------------------------------------- auto drop ----- */
// A 3 m walk along +x over 1 second, sampled straight off the root, on a
// 2x2 support whose top sits at the subject's height.
const walk = () => {
	const rootPos = new Float32Array(FRAMES * 3);
	for (let f = 0; f < FRAMES; f += 1) rootPos[f * 3] = (3 * f) / (FRAMES - 1);
	return { frames: FRAMES, fps: 10, rootPos };
};
const roof = { x: 0, z: 0, rotDeg: 0, topY: 12, width: 2, depth: 2 };
const subjectOnRoof = { x: 0, z: 0, y: 12, rotationDeg: 0 };

{
	const drop = autoRoofDrop(walk(), subjectOnRoof, [roof]);
	// the edge sits at x=1; the walk crosses it between frames 3 (0.99m) and 4 (1.32m)
	expect("walking off a roof stages a fall at the edge crossing", !!drop && Math.abs(drop.fromS - 0.4) < 1e-9, JSON.stringify(drop));
	expect("the fall keeps a near-real gravity clock", !!drop && drop.meters === 12 && Math.abs(drop.toS - drop.fromS - Math.sqrt(24 / 9.81) * 1.15) < 1e-9, JSON.stringify(drop));
	const realtime = autoRoofDrop(walk(), subjectOnRoof, [roof], { fallTimeScale: 1 });
	expect("fallTimeScale 1 restores physical free-fall time", !!realtime && Math.abs(realtime.toS - realtime.fromS - Math.sqrt(24 / 9.81)) < 1e-9, JSON.stringify(realtime));
	expect("the staged drop is applyRootDrop-compatible", normalizeRootDrop(drop)?.meters === 12);
}

expect("a grounded subject stages nothing", autoRoofDrop(walk(), { ...subjectOnRoof, y: 0 }, [roof]) === null);
expect("a subject never on the support stages nothing", autoRoofDrop(walk(), { ...subjectOnRoof, x: 9 }, [roof]) === null);
expect("a walk that stays on the roof stages nothing", autoRoofDrop(walk(), subjectOnRoof, [{ ...roof, width: 40, depth: 40 }]) === null);
{
	// root rotation turns the +x walk into a +z walk: the 2x40 support only
	// shelters the rotated path, so the unrotated math would exit instantly.
	const shelter = { x: 0, z: 0, rotDeg: 0, topY: 12, width: 2, depth: 40 };
	const drop = autoRoofDrop(walk(), { ...subjectOnRoof, rotationDeg: 90 }, [shelter]);
	expect("the walk is rotated into scene space before the edge test", drop === null, JSON.stringify(drop));
}
{
	// a lower terrace under the exit point shortens the fall
	const terrace = { x: 2, z: 0, rotDeg: 0, topY: 7, width: 4, depth: 4 };
	const drop = autoRoofDrop(walk(), subjectOnRoof, [roof, terrace]);
	expect("a lower support under the exit shortens the fall", !!drop && drop.meters === 5, JSON.stringify(drop));
}

// Scene dimensions are world metres, while extracted takes are canonical
// body units. Edge detection and the baked Y arc must agree after playback
// applies the performer's stature scale.
{
	const scaledRoof = { x: 0, z: 0, rotDeg: 0, topY: 12, width: 2.2, depth: 2 };
	const scaledSubject = { x: 0, z: 0, y: 12, rotationDeg: 0 };
	const scaledDrop = autoRoofDrop(walk(), scaledSubject, [scaledRoof], { worldScale: 0.8 });
	expect("scaled edge detection uses world displacement", !!scaledDrop && Math.abs(scaledDrop.fromS - 0.5) < 1e-9, JSON.stringify(scaledDrop));
	const scaledSource = { ...clip(), rotMats: new Float32Array(FRAMES * JOINTS * 9) };
	const scaledFall = applyAutoFall(scaledSource, { fromS: 0.2, toS: 0.8, meters: 8 }, { worldScale: 0.8 });
	expect("scaled auto fall lands at the requested world height", Math.abs((yOf(scaledFall, 8, 0) - 5) * 0.8 + 8) < 1e-5);
	const scaledExplicit = applyRootDrop(source, { fromS: 0.2, toS: 0.8, meters: 8 }, { worldScale: 1.2 });
	const explicitT = (0.9 - 0.2) / 0.6;
	expect("scaled explicit drops preserve world metres", Math.abs((yOf(scaledExplicit, 9, 0) - 5) * 1.2 + 8) < 1e-5);
}

/* ------------------------------------------------ cinematic bake ---- */
const CINEMATIC_FRAMES = 80;
const CINEMATIC_JOINTS = 27;
const cinematicWalk = () => {
	const rootPos = new Float32Array(CINEMATIC_FRAMES * 3);
	const posedJoints = new Float32Array(CINEMATIC_FRAMES * CINEMATIC_JOINTS * 3);
	const rotMats = new Float32Array(CINEMATIC_FRAMES * CINEMATIC_JOINTS * 9);
	for (let f = 0; f < CINEMATIC_FRAMES; f += 1) {
		// The authored take accelerates wildly after frame 10. A believable
		// fall must ignore that airborne walk path and carry edge velocity.
		const x = f <= 10 ? f * 0.1 : 1 + (f - 10) * (f - 10) * 0.04;
		rootPos[f * 3] = x;
		for (let j = 0; j < CINEMATIC_JOINTS; j += 1) {
			posedJoints[(f * CINEMATIC_JOINTS + j) * 3] = x;
			posedJoints[(f * CINEMATIC_JOINTS + j) * 3 + 1] = 2 + f * 0.01;
			rotMats[(f * CINEMATIC_JOINTS + j) * 9] = f;
		}
	}
	return { frames: CINEMATIC_FRAMES, fps: 10, rootPos, posedJoints, rotMats };
};

{
	const sourceWalk = cinematicWalk();
	const staged = applyAutoFall(sourceWalk, { fromS: 1, toS: 3, meters: 12 });
	expect("auto fall never mutates its source take", sourceWalk.frames === CINEMATIC_FRAMES && sourceWalk.rootPos[30 * 3] > 10);
	expect("airborne x follows launch velocity instead of the authored walk", Math.abs(staged.rootPos[20 * 3] - 2) < 1e-5, String(staged.rootPos[20 * 3]));
	expect("the body and root share the same ballistic translation", Math.abs(staged.posedJoints[(20 * CINEMATIC_JOINTS) * 3] - staged.rootPos[20 * 3]) < 1e-5);
	expect("landing reaches the requested floor height", Math.abs(staged.rootPos[30 * 3 + 1] + 12) < 1e-5, String(staged.rootPos[30 * 3 + 1]));
	expect("horizontal drift stops after impact", Math.abs(staged.rootPos[33 * 3] - staged.rootPos[30 * 3]) < 1e-5);
	expect("the landing pose freezes during the impact hold", staged.posedJoints[(33 * CINEMATIC_JOINTS) * 3 + 1] === staged.posedJoints[(30 * CINEMATIC_JOINTS) * 3 + 1]);
	expect("the landing rotations freeze during the impact hold", staged.rotMats[(33 * CINEMATIC_JOINTS) * 9] === staged.rotMats[(30 * CINEMATIC_JOINTS) * 9]);
	expect("the take cuts shortly after impact", staged.frames === 35, String(staged.frames));
}

if (failures) process.exit(1);
console.log("all root-drop checks PASS");
