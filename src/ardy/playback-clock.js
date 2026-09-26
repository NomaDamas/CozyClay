/** Presentation time must not slow down when rendering delays a timer.
 * Return only newly elapsed frames; callers render the latest frame instead
 * of replaying every missed frame. A new clock is made on play/speed changes.
 */
export function createPlaybackClock(fps, speed, startMs) {
	const rate = Math.max(1, fps * speed);
	let emitted = 0;
	return (nowMs) => {
		if (!Number.isFinite(nowMs)) return 0;
		const due = Math.max(emitted, Math.floor(Math.max(0, nowMs - startMs) * rate / 1000 + 1e-8));
		const steps = due - emitted;
		emitted = due;
		return steps;
	};
}
