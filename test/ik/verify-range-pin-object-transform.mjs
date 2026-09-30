import * as THREE from "three";
import { rangePinObjectMatrixAt } from "../../src/range-pin-object-transform.js";
import { objectTransformAt } from "../../src/object-path.js";

let failures = 0;
function check(name, condition, detail = "") {
	if (condition) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const object = {
	id: "table",
	x: 2,
	y: 0.2,
	z: -1,
	rot: 10,
	rotX: 7,
	rotZ: -4,
	scaleX: 1.5,
	scaleY: 2,
	scaleZ: 0.75,
	path: {
		points: [{ x: 0, y: 0.2, z: 0 }, { x: 2, y: 0.6, z: 0 }],
		speed: 1,
		faceTravel: true,
	},
};
const take = { frameCount: 11, fps: 10 };
const expected = objectTransformAt(object, 5, take);
const matrix = rangePinObjectMatrixAt(object, 5, take);
const position = new THREE.Vector3().setFromMatrixPosition(matrix);
const scale = new THREE.Vector3();
const rotation = new THREE.Quaternion();
const ignore = new THREE.Vector3();
matrix.decompose(ignore, rotation, scale);
check("path prop matrix follows objectTransformAt translation", Math.abs(position.x - expected.x) < 1e-9 && Math.abs(position.y - expected.y) < 1e-9 && Math.abs(position.z - expected.z) < 1e-9, position.toArray().join(","));
check("path prop matrix keeps authored scale", scale.distanceTo(new THREE.Vector3(1.5, 2, 0.75)) < 1e-9, scale.toArray().join(","));
const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
check("path prop matrix follows travel yaw", forward.x > 0.99 && Math.abs(forward.z) < 0.02, forward.toArray().join(","));

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall range pin object transform checks passed");
