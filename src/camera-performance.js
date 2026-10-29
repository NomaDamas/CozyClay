// Walk-recorded camera performance. Capture is wall-clock based; conversion to
// production keys is absolute-frame based and happens once, on Stop.

export function framingFromCamera(camera, look) {
	if (!camera || !look) return null;
	const { x, y, z } = camera.position;
	return [x, y, z, look.yaw, look.pitch, camera.fov].every(Number.isFinite)
		? { pos: { x, y, z }, yaw: look.yaw, pitch: look.pitch, fovDeg: camera.fov }
		: null;
}

/** Keep the newest sample for each addressed frame. A fast mouse can produce
 * several samples in one frame; a slow gesture can leave holds between keys. */
export function cameraPerformanceKeys(samples, { startFrame, endFrame, fps = 24 } = {}) {
	if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || endFrame < startFrame) throw new RangeError("Invalid camera recording range");
	if (!Number.isFinite(fps) || fps <= 0) throw new RangeError("Invalid recording fps");
	const byFrame = new Map();
	for (const sample of Array.isArray(samples) ? samples : []) {
		if (!sample || !Number.isFinite(sample.seconds) || !sample.framing) continue;
		const offset = Math.max(0, Math.min(endFrame - startFrame, Math.round(sample.seconds * fps)));
		byFrame.set(startFrame + offset, sample.framing);
	}
	if (!byFrame.size) return [];
	if (!byFrame.has(startFrame)) byFrame.set(startFrame, samples.find(sample => sample?.framing)?.framing);
	const last = [...byFrame.keys()].at(-1);
	if (last < endFrame && samples.at(-1)?.framing) byFrame.set(endFrame, samples.at(-1).framing);
	const ordered = [...byFrame.entries()].sort((a, b) => a[0] - b[0]);
	// The shot command accepts at most 600 keys. Long takes are retimed onto an
	// evenly spaced subset while both performance boundaries stay exact.
	const limited = ordered.length <= 600 ? ordered : Array.from({ length: 600 }, (_, index) => ordered[Math.round(index * (ordered.length - 1) / 599)]);
	return limited.map(([frame, framing]) => ({ frame, framing }));
}

export function createCameraPerformance({ now = () => performance.now() / 1000, sample, onFrame } = {}) {
	let active = null;
	let raf = 0;
	const tick = () => {
		if (!active) return;
		const framing = sample?.();
		if (framing) {
			const point = { seconds: Math.max(0, now() - active.startedAt), framing };
			active.samples.push(point);
			onFrame?.(point);
		}
		raf = requestAnimationFrame(tick);
	};
	return {
		start(range) {
			if (active) return false;
			const first = sample?.();
			if (!first) return false;
			active = { ...range, startedAt: now(), samples: [{ seconds: 0, framing: first }] };
			raf = requestAnimationFrame(tick);
			return true;
		},
		stop() {
			if (!active) return [];
			cancelAnimationFrame(raf);
			const finished = active;
			active = null;
			const last = sample?.();
			if (last) finished.samples.push({ seconds: Math.max(0, now() - finished.startedAt), framing: last });
			return cameraPerformanceKeys(finished.samples, finished);
		},
		cancel() { cancelAnimationFrame(raf); active = null; },
		get active() { return Boolean(active); },
	};
}
