/**
 * True only when a GIZMO_LAYER ray hit belongs to another mounted gizmo's
 * actual pick proxy.
 *
 * Selection cages, grid meshes, camera furniture and the current gizmo's own
 * visible/pick meshes must never veto normal object selection. The caller has
 * already tried the current gizmo's handle picker; this guard exists solely
 * so the character gizmo and object gizmo do not steal each other's handles.
 */
export function isForeignGizmoHandleHit(object, ownRoot) {
	let handleRoot = null;
	for (let node = object; node; node = node.parent) {
		if (node.userData?.gizmoHandle) handleRoot = node;
		if (node.userData?.gizmoRoot) {
			return Boolean(handleRoot && node !== ownRoot);
		}
	}
	return false;
}

/** A real body hit belongs to a new selection when it is not the current one.
 * The object body must win over a fat invisible gizmo proxy drawn on top of it:
 * a selected cube must not make the next object unclickable. */
export function shouldObjectWinSelection(pickedId, selectedId) {
	return pickedId != null && pickedId !== selectedId;
}
