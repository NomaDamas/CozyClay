// Shot optics shared by the live camera, offscreen export and review slate.
// Shift is a crop offset, not a camera rotation; verticals stay parallel.

export function repairOptics(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const shiftX = Number.isFinite(value.shiftX) ? Math.max(-0.5, Math.min(0.5, value.shiftX)) : 0;
	const shiftY = Number.isFinite(value.shiftY) ? Math.max(-0.5, Math.min(0.5, value.shiftY)) : 0;
	const focusTargetId = typeof value.focusTargetId === "string" && value.focusTargetId.trim() ? value.focusTargetId.trim() : null;
	const optics = {
		shiftX,
		shiftY,
		focusTargetId,
	};
	return shiftX || shiftY || focusTargetId ? optics : null;
}

/** Apply without accumulating a previous shot's crop. Three's view offset is
 * expressed in pixels; a 1000 px virtual gate makes the stored values direct
 * fractions of that gate. */
export function applyCameraOptics(camera, optics) {
	if (!camera) return;
	camera.clearViewOffset();
	if (!optics || (!optics.shiftX && !optics.shiftY)) {
		camera.updateProjectionMatrix();
		return;
	}
	const gate = 1000;
	camera.setViewOffset(gate, gate, -(optics.shiftX ?? 0) * gate, (optics.shiftY ?? 0) * gate, gate, gate);
	camera.updateProjectionMatrix();
}

export function focusDistance(cameraPosition, target) {
	if (!cameraPosition || !target) return null;
	const distance = Math.hypot(cameraPosition.x - target.x, cameraPosition.y - target.y, cameraPosition.z - target.z);
	return Number.isFinite(distance) ? distance : null;
}
