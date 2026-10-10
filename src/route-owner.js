/**
 * Whose route the studio shows for a selection.
 *
 * A route belongs to one record, but a car is a group: "Vintage Car" (an
 * Empty) → "Chassis" (owns the route) → parts. The operator selects the group,
 * so the rail, its dots and the route strip follow the group to the record
 * that actually owns the travel. Pure and flat-record based, like
 * object-travel.js: `parent` is grouping only.
 */

const hasRoute = (object) => !!object && !!object.path;

/**
 * The record whose route a selection stands for: the selected record when it
 * owns a path, else its nearest routed descendant (breadth-first; ties at one
 * depth go to the first in record order), else null. A descendant carried by a
 * character (`attach`) is skipped: its route never plays.
 *
 * @param {object[]|Map<string, object>} objects scene records
 * @param {string|null} selectedId
 */
export function routeOwnerFor(objects, selectedId) {
	if (!selectedId) return null;
	const list = objects instanceof Map ? [...objects.values()] : Array.isArray(objects) ? objects : [];
	const selected = list.find((object) => object && object.id === selectedId);
	if (!selected) return null;
	if (hasRoute(selected)) return selected;
	const childrenOf = new Map();
	for (const object of list) {
		if (!object || typeof object.parent !== "string") continue;
		if (!childrenOf.has(object.parent)) childrenOf.set(object.parent, []);
		childrenOf.get(object.parent).push(object);
	}
	const order = new Map(list.map((object, index) => [object, index]));
	const seen = new Set([selected.id]);
	let level = [selected];
	while (level.length) {
		const next = [];
		let best = null;
		for (const node of level) {
			for (const child of childrenOf.get(node.id) ?? []) {
				if (seen.has(child.id)) continue;
				seen.add(child.id);
				if (!child.attach && hasRoute(child) && (!best || order.get(child) < order.get(best))) best = child;
				next.push(child);
			}
		}
		if (best) return best;
		level = next;
	}
	return null;
}
