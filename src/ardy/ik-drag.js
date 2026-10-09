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
 * live pose: snapshot every node under `rig`, let `applyRaw(rig, frame)` pose the clip
 * alone (no correction layer), read chain b0..b2 quaternions and FK joint
 * quaternion + position, then put every node back.
 */
export function captureRawBase(rig, chains, fkJoints, ids, applyRaw, frame = null) {
	const saved = [];
	rig.traverse((node) => saved.push([node, node.position.clone(), node.quaternion.clone(), node.scale.clone()]));
	const baseQuats = new Map();
	const basePositions = new Map();
	try {
		applyRaw(rig, frame);
		for (const id of ids) {
			const chain = chains?.get(id);
			const joint = fkJoints?.get(id);
			if (chain) {
				baseQuats.set(id, chain.bones.map((bone) => bone.quaternion.clone()));
			}
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
	const base = applyRaw && rig ? captureRawBase(rig, chains, fkJoints, list, applyRaw, frame) : null;
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

/** Apply one drag's correction delta to a raw pose. The source key is captured
 * at the drag frame, while `base` belongs to a different raw frame. */
export function applyIkDragCorrection(chains, fkJoints, sourceEntry, base) {
	if (!sourceEntry || !base) return;
	for (const [id, key] of sourceEntry) {
		const chain = chains?.get(id);
		if (chain) {
			const rawQuats = base.baseQuats.get(id);
			if (rawQuats && key.q) {
				const sourceQuats = key.baseQ;
				chain.bones.forEach((bone, index) => {
					if (!rawQuats[index] || !key.q[index]) return;
					const delta = sourceQuats?.[index]
						? sourceQuats[index].clone().invert().multiply(key.q[index])
						: null;
					if (!delta) return;
					bone.quaternion.copy(rawQuats[index]).multiply(delta);
				});
			}
			// `chainP` is an absolute legacy/explicit translation payload. A drag
			// correction does not retain the source frame's raw chain positions, so
			// carrying it to another clip frame would freeze that frame's segment
			// lengths. Motion IK drags solve rotations; leave chain translations to
			// the raw clip unless a future key format carries a translation delta.
			chain.bones[0].updateMatrixWorld(true);
			continue;
		}
		const joint = fkJoints?.get(id);
		if (!joint) continue;
		const rawQ = base.baseQuats.get(id)?.[0];
		if (rawQ && key.q?.[0]) {
			const sourceQ = key.baseQ?.[0];
			if (sourceQ) {
				const delta = sourceQ.clone().invert().multiply(key.q[0]);
				joint.bone.quaternion.copy(rawQ).multiply(delta);
			}
		}
		const rawPos = base.basePositions.get(id);
		if (rawPos && key.p && key.basePos) {
			joint.bone.position.copy(rawPos).add(key.p.clone().sub(key.basePos));
		}
		joint.bone.updateMatrixWorld(true);
	}
}

/** Bake the captured drag correction at the inclusive range boundaries. */
export function bakeIkDragRange(chains, fkJoints, sourceEntry, startFrame, endFrame, ids, applyRaw = null) {
	const frames = [...new Set([Math.round(startFrame), Math.round(endFrame)])].sort((a, b) => a - b);
	const result = new Map();
	const rig = chains?.values().next().value?.rig;
	const saved = [];
	rig?.traverse((node) => saved.push([node, node.position.clone(), node.quaternion.clone(), node.scale.clone()]));
	const correctionRange = { start: frames[0], end: frames.at(-1) };
	try {
		for (const frame of frames) {
			if (!applyRaw || !rig) {
				result.set(frame, sourceEntry
					? new Map([...sourceEntry].map(([id, key]) => [id, { ...key, correctionRange: { ...correctionRange } }]))
					: null);
				continue;
			}
			const applyFrame = () => applyRaw(rig, frame);
			const base = captureRawBase(rig, chains, fkJoints, ids, applyFrame);
			applyFrame();
			applyIkDragCorrection(chains, fkJoints, sourceEntry, base);
			const entry = bakeIkDragKey(chains, fkJoints, frame, ids, applyFrame);
			result.set(frame, entry ? new Map([...entry].map(([id, key]) => [id, { ...key, correctionRange: { ...correctionRange } }])) : null);
		}
	} finally {
		for (const [node, position, quaternion, scale] of saved) {
			node.position.copy(position);
			node.quaternion.copy(quaternion);
			node.scale.copy(scale);
		}
		rig?.updateMatrixWorld(true);
	}
	return result;
}
