/** Pure picking for motion-trail pointer rays. */

const FRAME_PENALTY = 0.001;
const TIE_DISTANCE = 0.01;
const MIN_FRAME_WINDOW = 12;

/** Pick the trail track/frame intended by a ray near the current playhead. */
export function pickTrailPoint({
	tracks,
	playheadFrame,
	falloffFrames,
	rayOrigin,
	rayDirection,
	maxDistance,
}) {
	if (!Array.isArray(tracks) || !rayOrigin || !rayDirection) return null;
	const directionLength = Math.hypot(rayDirection.x, rayDirection.y, rayDirection.z);
	if (!Number.isFinite(directionLength) || directionLength === 0) return null;
	const dx = rayDirection.x / directionLength;
	const dy = rayDirection.y / directionLength;
	const dz = rayDirection.z / directionLength;
	const center = Number.isFinite(playheadFrame) ? playheadFrame : 0;
	const radius = Math.max(2 * (Number.isFinite(falloffFrames) ? falloffFrames : 0), MIN_FRAME_WINDOW);
	const limit = Number.isFinite(maxDistance) ? maxDistance : 0;
	let best = null;

	for (const track of tracks) {
		const points = track?.flat;
		if (!track?.id || !points || points.length < 3) continue;
		const firstFrame = Math.max(0, Math.ceil(center - radius));
		const lastFrame = Math.min(Math.floor(points.length / 3) - 1, Math.floor(center + radius));
		for (let frame = firstFrame; frame <= lastFrame; frame += 1) {
			const offset = frame * 3;
			const px = points[offset] - rayOrigin.x;
			const py = points[offset + 1] - rayOrigin.y;
			const pz = points[offset + 2] - rayOrigin.z;
			const depth = px * dx + py * dy + pz * dz;
			if (depth < 0) continue;
			const ox = px - depth * dx;
			const oy = py - depth * dy;
			const oz = pz - depth * dz;
			const distance = Math.hypot(ox, oy, oz);
			if (distance > limit) continue;
			const score = distance + Math.abs(frame - center) * FRAME_PENALTY;
			const scoreDelta = score - (best?.score ?? Infinity);
			if (
				!best
				|| scoreDelta < -TIE_DISTANCE
				|| (Math.abs(scoreDelta) <= TIE_DISTANCE && (
					depth < best.depth
					|| (depth === best.depth && score < best.score)
				))
			) {
				best = { track: track.id, grabFrame: frame, score, depth };
			}
		}
	}
	return best ? { track: best.track, grabFrame: best.grabFrame } : null;
}
