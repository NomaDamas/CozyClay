// Frame-addressed scene placement. No renderer or waypoint authoring state.
export function sampleRootPath(character, frame, { fps = 24 } = {}) {
	const waypoints = character.layer?.waypoints ?? [];
	if (!waypoints.length) return null;
	const base = { x: character.x, z: character.z, heading: character.rot };
	if (frame <= 0) return base;
	let previous = { frame: 0, ...base };
	let sampled = base;
	for (const pin of waypoints) {
		const dx = pin.x - previous.x;
		const dz = pin.z - previous.z;
		const heading = pin.heading ?? (dx || dz ? Math.atan2(dx, dz) * 180 / Math.PI : sampled.heading);
		const weight = Math.min(1, (frame / fps - previous.frame / fps) / (pin.frame / fps - previous.frame / fps));
		sampled = {
			x: previous.x + dx * weight,
			z: previous.z + dz * weight,
			heading,
		};
		if (frame <= pin.frame) return sampled;
		previous = pin;
	}
	return sampled;
}

// takeRoot is an already sampled world-space { x, z, rot? } supplied by the
// take owner. Shot lookup is injected so this module does not own a timeline.
export function resolveCharacterPlacement(character, frame, { shotAt = () => null, takeRoot = null } = {}) {
	const base = { x: character.x, z: character.z, rot: character.rot, posture: character.posture, pose: character.pose };
	if (takeRoot) return { ...base, ...takeRoot };
	const root = sampleRootPath(character, frame);
	if (root) return { ...base, x: root.x, z: root.z, rot: root.heading };
	return { ...base, ...shotAt(frame)?.cast?.[character.id] };
}
