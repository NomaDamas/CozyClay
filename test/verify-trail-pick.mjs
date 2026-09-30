#!/usr/bin/env node
/** Regression checks for playhead-local motion-trail picking. */
import assert from "node:assert/strict";
import { nearestFrameToRay } from "../src/motion-trail.js";
import { pickTrailPoint } from "../src/trail-pick.js";

const rayOrigin = { x: 0, y: 0, z: 0 };
const rayDirection = { x: 0, y: 0, z: 1 };

function flatTrack(id, frameCount, pointAt) {
	const flat = new Float32Array(frameCount * 3);
	for (let frame = 0; frame < frameCount; frame += 1) {
		const point = pointAt(frame);
		flat[frame * 3] = point.x;
		flat[frame * 3 + 1] = point.y;
		flat[frame * 3 + 2] = point.z;
	}
	return { id, flat };
}

// The old all-frame scan grabs a later pass; the playhead-local picker must not.
{
	const head = flatTrack("head", 120, (frame) => ({
		x: frame === 80 ? 0 : frame === 50 ? 0.04 : 0.2,
		y: 0,
		z: 1,
	}));
	const legacy = nearestFrameToRay(head.flat, rayOrigin, rayDirection, 0.2);
	assert.equal(legacy.frame, 80, "the base all-frame scan reproduces the far-pass grab");
	const picked = pickTrailPoint({
		tracks: [head],
		playheadFrame: 50,
		falloffFrames: 3,
		rayOrigin,
		rayDirection,
		maxDistance: 0.2,
	});
	assert.deepEqual(picked, { track: "head", grabFrame: 50 }, "head picking stays within the playhead window");
}

// An overlapping pelvis and hand trail choose the nearer body part.
{
	const hips = flatTrack("hips", 80, () => ({ x: 0, y: 0, z: 1 }));
	const hand = flatTrack("leftHand", 80, () => ({ x: 0.1, y: 0, z: 1 }));
	assert.deepEqual(
		pickTrailPoint({
			tracks: [hand, hips],
			playheadFrame: 40,
			falloffFrames: 4,
			rayOrigin,
			rayDirection,
			maxDistance: 0.2,
		}),
		{ track: "hips", grabFrame: 40 },
		"pelvis wins over a hand trail 10 cm farther from the ray",
	);
}

assert.equal(
	pickTrailPoint({
		tracks: [flatTrack("head", 30, () => ({ x: 1, y: 0, z: 1 }))],
		playheadFrame: 12,
		falloffFrames: 3,
		rayOrigin,
		rayDirection,
		maxDistance: 0.2,
	}),
	null,
	"a ray with no candidate within maxDistance does not start a drag",
);

console.log("verify-trail-pick: ok");
