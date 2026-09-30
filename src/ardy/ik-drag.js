import { createIkState, ikBakeKeyframe, ikTouch } from "./ik.js";

/**
 * Per-drag bookkeeping for manual IK drags over a loaded motion.
 *
 * A drag keys ONLY the parts it wrote, as DELTA keys over the raw clip pose at
 * the drag frame. Keying every part ever tracked (the old behaviour) planted an
 * absolute key for untouched parts too, which spiked them off the clip on the
 * drag frame (bind-translation reset + absolute slerp on the ramp).
 */

/** The record for the drag in progress. IkHandles has no drag-start callback,
 * so a record opens on the first solve and closes on drag end; a record left
 * on another frame (a click-sized drag that never ended) is stale and resets. */
export function ikDragRecord(current, frame) {
	return current && current.frame === frame ? current : { frame, ids: new Set() };
}

/** Mark `id` as written by this drag and touch it into the live layer. */
export function ikDragTouch(ikState, record, id) {
	ikTouch(ikState, id);
	record?.ids.add(id);
}

/** Run `write` and return the chain ids whose bone locals it changed — for
 * solvers like applyBodyContact that only report "something moved". */
export function chainsChangedBy(chains, write) {
	const before = new Map();
	for (const [id, chain] of chains) {
		before.set(id, chain.bones.map((bone) => [bone.quaternion.clone(), bone.position.clone()]));
	}
	write();
	const changed = [];
	for (const [id, chain] of chains) {
		const saved = before.get(id);
		if (chain.bones.some((bone, index) => !bone.quaternion.equals(saved[index][0]) || !bone.position.equals(saved[index][1]))) changed.push(id);
	}
	return changed;
}

/**
 * Read the RAW clip locals of `ids` at the current frame without disturbing the
 * live pose: snapshot every node under `rig`, let `applyRaw(rig)` pose the clip
 * alone (no correction layer), read chain b0..b2 quaternions and FK joint
 * quaternion + position, then put every node back.
 */
export function captureRawBase(rig, chains, fkJoints, ids, applyRaw) {
	const saved = [];
	rig.traverse((node) => saved.push([node, node.position.clone(), node.quaternion.clone(), node.scale.clone()]));
	const baseQuats = new Map();
	const basePositions = new Map();
	try {
		applyRaw(rig);
		for (const id of ids) {
			const chain = chains?.get(id);
			const joint = fkJoints?.get(id);
			if (chain) baseQuats.set(id, chain.bones.map((bone) => bone.quaternion.clone()));
			else if (joint) {
				baseQuats.set(id, [joint.bone.quaternion.clone()]);
				basePositions.set(id, joint.bone.position.clone());
			}
		}
	} finally {
		for (const [node, position, quaternion, scale] of saved) {
			node.position.copy(position);
			node.quaternion.copy(quaternion);
			node.scale.copy(scale);
		}
		rig.updateMatrixWorld(true);
	}
	return { baseQuats, basePositions };
}

/**
 * Bake the key entry (Map trackId → key) a drag leaves at `frame`, for exactly
 * `ids`. With `applyRaw` (a motion is loaded) every entry is a delta key over
 * the raw clip: chains carry baseQ; FK joints carry baseQ + basePos, and a
 * joint whose rotation matches the clip is stored translation-only, the same
 * shape ikBakeKeyframe gives based hips keys. Without `applyRaw` the entry is
 * the plain absolute key. Returns null when nothing was keyed.
 */
export function bakeIkDragKey(chains, fkJoints, frame, ids, applyRaw = null) {
	const list = [...ids];
	if (!list.length) return null;
	const rig = chains?.values().next().value?.rig;
	const base = applyRaw && rig ? captureRawBase(rig, chains, fkJoints, list, applyRaw) : null;
	const scratch = createIkState();
	ikBakeKeyframe(chains, scratch, frame, fkJoints, list, null, base?.baseQuats ?? null);
	const entry = scratch.keys.get(frame);
	if (!entry || !base) return entry ?? null;
	for (const [id, key] of entry) {
		if (chains.has(id) || !fkJoints?.has(id)) continue;
		const baseQ = base.baseQuats.get(id)?.[0];
		const basePos = base.basePositions.get(id);
		if (!baseQ || !basePos || !key.p) continue;
		key.basePos = basePos;
		if (key.q?.[0] && key.q[0].angleTo(baseQ) > 1e-7) key.baseQ = [baseQ];
		else key.q = null;
	}
	return entry;
}
