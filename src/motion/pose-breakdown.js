/** Nearest authored keys on opposite sides of the playhead. */
export function breakdownNeighbors(keyedFrames, frame) {
	const before = Math.max(...keyedFrames.filter(value => value < frame));
	const after = Math.min(...keyedFrames.filter(value => value > frame));
	if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
	return { before, after, weight: (frame - before) / (after - before) };
}

export function snapshotLocalRig(rig) {
	const bones = new Map();
	rig?.traverse(node => {
		if (!node.isBone || bones.has(node.name)) return;
		bones.set(node.name, {
			position: node.position.clone(),
			quaternion: node.quaternion.clone(),
		});
	});
	return bones;
}

export function restoreLocalRig(rig, snapshot) {
	rig?.traverse(node => {
		const saved = snapshot?.get(node.name);
		if (!node.isBone || !saved) return;
		node.position.copy(saved.position);
		node.quaternion.copy(saved.quaternion);
	});
	rig?.updateMatrixWorld(true);
}

/** Quaternion/hip-local interpolation: deterministic, cheap and editable. The
 * result is applied to the live rig and then baked through the ordinary Key
 * route, so Undo and the Dope Sheet see one normal authored key. */
export function applyBreakdownPose(rig, before, after, weight) {
	const t = Math.max(0, Math.min(1, weight));
	rig?.traverse(node => {
		if (!node.isBone) return;
		const a = before.get(node.name), b = after.get(node.name);
		if (!a || !b) return;
		node.position.lerpVectors(a.position, b.position, t);
		node.quaternion.copy(a.quaternion).slerp(b.quaternion, t);
	});
	rig?.updateMatrixWorld(true);
}

export function breakdownPlacement(before, after, weight) {
	const t = Math.max(0, Math.min(1, weight));
	return {
		x: before.x + (after.x - before.x) * t,
		z: before.z + (after.z - before.z) * t,
		rot: before.rot + (after.rot - before.rot) * t,
	};
}

