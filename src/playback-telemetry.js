// playback:summary: one event per playback run (play until stop, or until the fps or
// speed changes), at most 10 per session. `late_ticks` is an ESTIMATE of dropped
// frames: the share of playback-timer ticks that had to catch up more than one frame
// (createPlaybackClock steps > 1). It is not a measured render drop; `measured_fps`
// is the separate rAF sample taken during the same run. Every run, past the cap too,
// feeds app:friction_summary.late_tick_ratio through noteTick. Only closed buckets
// leave: never the scene, the take or the frame range.
import { analyticsActive, bucketFrameRate, track } from "./analytics.js";
import { admit, bucketLateTicks, noteTick } from "./analytics-friction.js";
import { bucketLong } from "./analytics-strict.js";

const RUNS_PER_SESSION = 10;
const IDLE_RUN = Object.freeze({ tick() {}, end() {} });
let send = track;

/** 1, 2, 3-5, gte6: the most frames one timer tick had to catch up. */
export function bucketCatchup(steps) {
	if (!(steps >= 2)) return "1";
	if (steps < 3) return "2";
	if (steps < 6) return "3-5";
	return "gte6";
}

/** The take's own frame rate: 12, 24, 30, 60, else other. */
export function bucketPlaybackFps(fps) {
	return [12, 24, 30, 60].includes(fps) ? String(fps) : "other";
}

/** Playback speed: 0.5, 1, 2, else other. */
export function bucketSpeed(speed) {
	return [0.5, 1, 2].includes(speed) ? String(speed) : "other";
}

/**
 * Start measuring one playback run. The caller reports every timer tick's step
 * count and calls end() when the run stops; end() is idempotent. While analytics
 * is off the run is a no-op and no rAF sampler starts.
 */
export function startPlaybackRun(fps, speed, {
	now = () => performance.now(),
	raf = globalThis.requestAnimationFrame,
	cancelRaf = globalThis.cancelAnimationFrame,
	active = analyticsActive,
} = {}) {
	try {
		if (!active()) return IDLE_RUN;
		const startedAt = now();
		let ticks = 0, late = 0, maxCatchup = 0, frames = 0, firstFrame = null, lastFrame = null, frameId = null, ended = false;
		const sample = (time) => {
			if (ended) return;
			if (firstFrame === null) firstFrame = time;
			else frames += 1;
			lastFrame = time;
			frameId = raf(sample);
		};
		if (typeof raf === "function") frameId = raf(sample);
		return {
			tick(steps) {
				if (ended || !Number.isFinite(steps) || steps < 0) return;
				ticks += 1;
				if (steps > 1) late += 1;
				maxCatchup = Math.max(maxCatchup, steps);
			},
			end() {
				if (ended) return;
				ended = true;
				try {
					if (frameId !== null && typeof cancelRaf === "function") cancelRaf(frameId);
					if (!ticks) return;
					noteTick(late, ticks);
					const span = lastFrame - firstFrame;
					const props = {
						duration: bucketLong(now() - startedAt), late_ticks: bucketLateTicks(late, ticks),
						max_catchup: bucketCatchup(maxCatchup), fps: bucketPlaybackFps(fps), speed: bucketSpeed(speed),
						measured_fps: bucketFrameRate(frames > 0 && span > 0 ? (frames * 1000) / span : NaN),
					};
					if (admit("playback:summary", RUNS_PER_SESSION)) send("playback:summary", props);
				} catch {
					// Telemetry must never affect playback.
				}
			},
		};
	} catch {
		return IDLE_RUN;
	}
}

/** Tests only: capture what is sent; returns the restore. */
export function playbackTelemetrySeam(capture) {
	const previous = send;
	send = capture;
	return () => { send = previous; };
}
