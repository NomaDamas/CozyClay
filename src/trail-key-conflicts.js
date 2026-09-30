const CHAIN_BY_EFFECTOR = Object.freeze({
	LeftHand: "leftHand",
	RightHand: "rightHand",
	LeftFoot: "leftFoot",
	RightFoot: "rightFoot",
});
const EFFECTOR_BY_CHAIN = Object.freeze({
	leftHand: "LeftHand",
	rightHand: "RightHand",
	leftFoot: "LeftFoot",
	rightFoot: "RightFoot",
});

function trackIds(track) {
	const id = typeof track === "string" ? track : track?.id ?? track?.joint ?? track?.effector;
	const chain = typeof track === "object" ? track?.chain : null;
	return new Set([id, chain, CHAIN_BY_EFFECTOR[id], EFFECTOR_BY_CHAIN[id]].filter(Boolean));
}

function entryFor(entries, id) {
	return typeof entries?.get === "function" ? entries.get(id) : entries?.[id];
}

/** Return absolute IK-key frames that can override a trail edit. */
export function findAbsoluteIkKeyConflicts({ keys, track, startFrame, endFrame }) {
	const ids = trackIds(track);
	const frames = [];
	for (const [frame, entries] of keys ?? []) {
		if (frame < startFrame || frame >= endFrame) continue;
		for (const id of ids) {
			const key = entryFor(entries, id);
			if (key && key.baseQ == null) {
				frames.push(frame);
				break;
			}
		}
	}
	return [...new Set(frames)].sort((a, b) => a - b);
}
