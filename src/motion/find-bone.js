import { normalizeBoneName } from "../poses.js";

/** A bone by Mixamo name; the matcher accepts the `mixamorig:` prefix and prefix-less rigs. */
export function findBone(root, name) {
	const target = normalizeBoneName(name);
	let found = null;
	root.traverse((object) => {
		if (found || !object.isBone) return;
		const norm = normalizeBoneName(object.name);
		if (norm === target || norm.endsWith(target)) found = object;
	});
	return found;
}
