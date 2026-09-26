import assert from "node:assert/strict";
import * as THREE from "three";
import { inferSupportAlignment, supportDiagnostics, supportMotion, solveSupportForces } from "../../src/ardy/physics-support.js";

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
function rows({ frames = 48, fps = 24, height = () => .3, centerX = 0, site = "leftFoot" } = {}) {
	return Array.from({ length: frames }, (_, f) => {
		const y = height(f / fps), root = V(centerX, y + 1, 0);
		const patch = [V(-.2, y, -.15), V(.2, y, -.15), V(.2, y, .15), V(-.2, y, .15)];
		return { root, com: root.clone(), support: { [site]: { floor: y, point: patch[0].clone(), position: V(0, y + .05, 0), patch, vertices: 20 } },
			dynamics: [{ mass: 1, center: root.clone(), rotation: new THREE.Quaternion(), axis: V(0, 1, 0), length: .5, radius: .1 }] };
	});
}
function shiftRows(source, shifts) {
	return source.map((r, f) => {
		const d = V(0, shifts[f], 0);
		return { ...r, com: r.com.clone().add(d), root: r.root.clone().add(d),
			dynamics: r.dynamics.map((s) => ({ ...s, center: s.center.clone().add(d) })),
			support: Object.fromEntries(Object.entries(r.support).map(([id, s]) => [id, { ...s, floor: s.floor + d.y, position: s.position.clone().add(d), point: s.point.clone().add(d), patch: s.patch.map((p) => p.clone().add(d)) }])) };
	});
}
for (const site of ["leftFoot", "leftHand", "leftKnee", "chest", "pelvis"]) {
	const input = rows({ site }), before = supportDiagnostics(input, 24), inferred = inferSupportAlignment(input, 24);
	assert.equal(before.unsupportedFrames, 48, "no detected contact must not hide hovering");
	assert(inferred.shifts.every((v) => Math.abs(v + .298) < 1e-6), `${site} discovers a floor alignment without action labels`);
	const after = supportDiagnostics(shiftRows(input, inferred.shifts), 24);
	assert.equal(after.unsupportedFrames, 0); assert(after.forceResidual < .02); assert(after.momentResidual < .02);
}
console.log("PASS force-supported alignment works for feet, hands, knees, torso and pelvis; absent contacts never mean zero error");
{
	const input = rows({ height: (t) => 1 + 3 * t - .5 * 9.81 * t * t, frames: 20 });
	const motion = supportMotion(input, 24), result = inferSupportAlignment(input, 24);
	assert(motion.every((m) => m.force.length() < 1e-9));
	assert.equal(result.flight.size, 20); assert(result.shifts.every((v) => v === 0));
	assert.equal(supportDiagnostics(input, 24).unsupportedFrames, 0);
}
console.log("PASS quadratic free flight including apex is not snapped to floor");
{
	const input = rows({ centerX: 1 });
	assert(inferSupportAlignment(input, 24).shifts.every((v) => v === 0), "contact under the wrong side of the body cannot supply required moment");
	const demand = supportMotion(input, 24)[0];
	const fit = solveSupportForces(input[0], demand, Object.entries(input[0].support));
	assert(fit.momentResidual > .1 || fit.forceResidual > .22);
}
console.log("PASS force-only false support rejected by moment balance");
{
	const input = rows();
	const free = inferSupportAlignment(input, 24, { overrides: [{ site: "leftFoot", mode: "free", start: 0, end: 47 }] });
	assert(free.shifts.every((v) => v === 0));
	const protectedResult = inferSupportAlignment(input, 24, { protectedFrames: [24] });
	assert.equal(protectedResult.shifts[24], 0); assert(Math.abs(protectedResult.shifts[23]) < Math.abs(protectedResult.shifts[10]));
	assert(inferSupportAlignment(input, 24, { strength: 0 }).shifts.every((v) => v === 0));
	assert(inferSupportAlignment(rows({ frames: 3 }), 24).shifts.every((v) => v === 0));
	assert(inferSupportAlignment(rows({ height: () => 1 }), 24).shifts.every((v) => v === 0), "out of correction bounds stays unresolved");
}
console.log("PASS free/protected/zero strength and short/ambiguous spans stay safe");
console.log("all pass");
