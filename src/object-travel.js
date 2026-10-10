import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { objectTransformAt } from "./object-path.js";

/**
 * Travel through the grouping hierarchy.
 *
 * A route belongs to one record, but a group is one body: a car built from a
 * chassis with its cabin, fenders and wheels parented under it has to drive as
 * a whole when the chassis gets the route. Records stay flat and world-space
 * (a parent only carries its children while authoring), so the carry happens
 * here at sample time: every routed ancestor's motion — where its route puts
 * it, relative to where it was authored — is applied rigidly to everything
 * under it. Scale never rides along: the motion is the routed record's own
 * route sample against its own authored pose, both at its own scale.
 *
 * Carried props are left to the attach frame that already places them: a
 * record that rides a character is not walked, and neither is an ancestor
 * that does.
 */

const DEG = Math.PI / 180;

const scratchPos = new Vector3();
const scratchQuat = new Quaternion();
const scratchScale = new Vector3();
const scratchEuler = new Euler();
const scratchAuthored = new Matrix4();
const scratchOwn = new Matrix4();
const scratchMotion = new Matrix4();

function compose(out, x, y, z, rotX, rot, rotZ, object, order = "XYZ") {
	scratchPos.set(x, y, z);
	scratchQuat.setFromEuler(scratchEuler.set(rotX * DEG, rot * DEG, rotZ * DEG, order));
	scratchScale.set(object.scaleX ?? 1, object.scaleY ?? 1, object.scaleZ ?? 1);
	return out.compose(scratchPos, scratchQuat, scratchScale);
}

function authoredMatrix(object, out) {
	return compose(out, object.x ?? 0, object.y ?? 0, object.z ?? 0, object.rotX ?? 0, object.rot ?? 0, object.rotZ ?? 0, object);
}

/**
 * The pose a route sample gives a record, as the Euler triple of
 * R = Ry(yaw) · Rx(pitch) · Rz(bank), applied as three.js's "YXZ" order: the
 * yaw turns the body in the world, the pitch tilts it about its own lateral
 * axis, the bank rolls it about its own forward axis. An authored rotX/rotZ is
 * the body's own pitch and roll, so it stays about the body's axes however the
 * heading turns (in the plain XYZ order rotX stayed about world X, and a pitch
 * became a roll once the route turned). The route's lean rides on top:
 * `bank` positive = right side down, `pitch` positive = nose up, which is
 * the opposite sign to rotX (positive rotX tips the nose down).
 */
export function travelPose(object, at) {
	return {
		rotX: (object.rotX ?? 0) - (at.pitch ?? 0),
		rot: at.rot ?? object.rot ?? 0,
		rotZ: (object.rotZ ?? 0) + (at.bank ?? 0),
	};
}

/** The record's own route sample as a matrix, or null when it does not travel. */
function ownTravelMatrix(object, frame, take, out) {
	if (!object.path) return null;
	const at = objectTransformAt(object, frame, take);
	if (!at) return null;
	const pose = travelPose(object, at);
	return compose(out, at.x, at.y, at.z, pose.rotX, pose.rot, pose.rotZ, object, "YXZ");
}

const asLookup = (objects) => {
	if (objects instanceof Map) return objects;
	const lookup = new Map();
	for (const object of objects ?? []) if (object && typeof object.id === "string") lookup.set(object.id, object);
	return lookup;
};

/**
 * The world matrix a record is drawn with at `frame`, or null when neither it
 * nor any ancestor travels (its authored transform is then the answer).
 *
 * @param {Map<string, object>|object[]} objects authored records, by id or as the list
 */
/** Parent first, up to the root; stops at a cycle, a missing record or a carried one. */
function ancestorsOf(lookup, object) {
	const chain = [];
	const seen = new Set([object.id]);
	let parentId = typeof object.parent === "string" ? object.parent : null;
	while (parentId && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = lookup.get(parentId);
		if (!parent || parent.attach) break;
		chain.push(parent);
		parentId = typeof parent.parent === "string" ? parent.parent : null;
	}
	return chain;
}

export function sceneObjectTravelMatrixAt(objects, id, frame, take = {}, out = new Matrix4()) {
	const lookup = asLookup(objects);
	const object = lookup.get(id);
	if (!object || object.attach) return null;
	const chain = ancestorsOf(lookup, object);
	let moved = false;
	scratchMotion.identity();
	for (let index = chain.length - 1; index >= 0; index -= 1) {
		const ancestor = chain[index];
		if (!ownTravelMatrix(ancestor, frame, take, scratchOwn)) continue;
		scratchMotion.multiply(scratchOwn).multiply(authoredMatrix(ancestor, scratchAuthored).invert());
		moved = true;
	}
	const own = ownTravelMatrix(object, frame, take, scratchOwn);
	if (!moved && !own) return null;
	return out.multiplyMatrices(scratchMotion, own ?? authoredMatrix(object, scratchAuthored));
}

const scratchCarry = new Matrix4();

/**
 * The rigid motion a record's travel hands to whatever rides it at `frame`:
 * where it is drawn against where it was authored. Its own scale cancels out,
 * so a rider keeps its size under a scaled chassis. Null when the record does
 * not travel (nor anything above it), is missing, or is carried by a character.
 */
export function sceneObjectCarryMatrixAt(objects, id, frame, take = {}, out = new Matrix4()) {
	const lookup = asLookup(objects);
	const object = lookup.get(id);
	if (!object || object.attach) return null;
	if (!sceneObjectTravelMatrixAt(lookup, id, frame, take, out)) return null;
	return out.multiply(authoredMatrix(object, scratchCarry).invert());
}

const scratchCarried = new Matrix4();
const scratchPoint = new Vector3();

/**
 * Where a point riding `objectId` stands at `frame`: the point (a grouped
 * character's played root) through the object's carry. The point comes back
 * unchanged when there is no object or it does not travel; `y` is used for
 * the carry and returned only when the point had one.
 */
export function carriedPointAt(objects, objectId, point, frame, take = {}) {
	if (!point || !objectId) return point;
	const carry = sceneObjectCarryMatrixAt(objects, objectId, frame, take, scratchCarried);
	if (!carry) return point;
	scratchPoint.set(point.x, point.y ?? 0, point.z).applyMatrix4(carry);
	return point.y === undefined ? { x: scratchPoint.x, z: scratchPoint.z } : { x: scratchPoint.x, y: scratchPoint.y, z: scratchPoint.z };
}

const wrapDegrees = (value) => {
	const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
	return wrapped === -180 ? 180 : wrapped;
};

/**
 * The records as they stand at `frame`: x/y/z and rotation replaced for every
 * record that travels on its own route or under a routed ancestor. Untouched
 * records are returned as-is, and so is the list when nothing moves.
 */
export function sceneObjectsAt(objects, frame, take = {}) {
	if (!objects.some((object) => object.path)) return objects;
	const lookup = asLookup(objects);
	const matrix = new Matrix4();
	const position = new Vector3();
	const quaternion = new Quaternion();
	const scale = new Vector3();
	const euler = new Euler();
	/** The record for a pose given as a matrix: x/y/z plus the XYZ Euler the records speak. */
	const recordAt = (object, pose) => {
		pose.decompose(position, quaternion, scale);
		const next = { ...object, x: position.x, y: position.y, z: position.z };
		// A pure turn about the vertical keeps the authored zero pitch/roll and
		// reads back as one yaw, instead of the 180/x/180 Euler a decompose of a
		// large yaw gives.
		if (!(object.rotX ?? 0) && !(object.rotZ ?? 0) && Math.abs(quaternion.x) < 1e-9 && Math.abs(quaternion.z) < 1e-9) {
			next.rot = wrapDegrees((2 * Math.atan2(quaternion.y, quaternion.w)) / DEG);
		} else {
			euler.setFromQuaternion(quaternion, "XYZ");
			next.rotX = euler.x / DEG;
			next.rot = euler.y / DEG;
			next.rotZ = euler.z / DEG;
		}
		return next;
	};
	return objects.map((object) => {
		if (object.attach || !ancestorsOf(lookup, object).some((ancestor) => ancestor.path)) {
			// Nothing above it travels: the route sample alone, exactly as before
			// the hierarchy carry — for a carried prop, in the frame its numbers
			// already live in.
			const at = objectTransformAt(object, frame, take);
			if (!at) return object;
			// A level, upright route is a yaw and a place. One that leans, or a
			// body with its own pitch/roll, is an orientation (travelPose).
			if (!at.bank && !at.pitch && !(object.rotX ?? 0) && !(object.rotZ ?? 0)) return { ...object, x: at.x, y: at.y, z: at.z, rot: at.rot ?? object.rot };
			const pose = travelPose(object, at);
			return recordAt(object, compose(matrix, at.x, at.y, at.z, pose.rotX, pose.rot, pose.rotZ, object, "YXZ"));
		}
		if (!sceneObjectTravelMatrixAt(lookup, object.id, frame, take, matrix)) return object;
		return recordAt(object, matrix);
	});
}
