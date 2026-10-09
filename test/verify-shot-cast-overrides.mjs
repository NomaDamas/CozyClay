import assert from "node:assert/strict";
import { castFixture } from "./bus/cast-fixture.mjs";
import { shotsFixture } from "./bus/shots-fixture.mjs";
import { resolveCharacterPlacement } from "../src/root-path.js";

const f = castFixture(shotsFixture());
try {
	const character = f.cast.read()[0];
	const camera = f.actual.readStudioState().camera;
	const shots = f.shots;
	shots.load({
		shots: [
			{ id: "still-1", name: "Still 1", startFrame: 0, endFrame: 47, kind: "still", caption: "", cast: {}, stylizedAssetId: null, cameraKeys: [], camera },
			{ id: "still-2", name: "Still 2", startFrame: 48, endFrame: 95, kind: "still", caption: "", cast: {}, stylizedAssetId: null, cameraKeys: [], camera },
		],
		frameCount: 96,
		camera,
	});
	const base = { ...character, x: 0, z: 0, rot: 0 };
	f.live.current.timeline.currentFrame = 48;
	f.live.current.studioView.frame = 48;
	const beforeDepth = f.scope.appContext.undoClock;
	const moved = f.run("character.move", { characterId: character.id, x: 3, z: 0, rot: 0 });
	assert.equal(moved.ok, true, JSON.stringify(moved));
	assert.equal(f.cast.read()[0].x, 0, "still edit leaves base x unchanged");
	assert.equal(f.live.current.shots?.[1]?.cast?.[character.id]?.x, 3, "still edit writes shot cast");
	assert.equal(f.scope.appContext.undoClock, beforeDepth + 1, "still edit adds one undo entry");

	const first = f.live.current.shots[0];
	const second = f.live.current.shots[1];
	assert.deepEqual(resolveCharacterPlacement(base, 24, { shotAt: frame => f.live.current.shots.find(shot => shot.startFrame <= frame && frame <= shot.endFrame) }), { x: 0, z: 0, rot: 0, posture: base.posture, pose: base.pose });
	assert.deepEqual(resolveCharacterPlacement(base, 72, { shotAt: frame => f.live.current.shots.find(shot => shot.startFrame <= frame && frame <= shot.endFrame) }), { x: 3, z: 0, rot: 0, posture: base.posture, pose: base.pose });

	f.live.current.timeline.currentFrame = 48;
	const take = { frames: 96, fps: 24, subject: { x: 8, z: 0, rot: 22 } };
	f.scope.appContext.patchLive({ characters: [{ ...base, sessionMotion: take }] });
	const withTake = resolveCharacterPlacement({ ...base, id: character.id }, 72, {
		shotAt: frame => f.live.current.shots.find(shot => shot.startFrame <= frame && frame <= shot.endFrame),
		takeRoot: take.subject,
	});
	assert.equal(withTake.x, 8, "installed take root wins over shot override");

	const cleared = f.run("shot.setCastOverride", { shotId: second.id, characterId: character.id, override: null });
	assert.equal(cleared.ok, true, JSON.stringify(cleared));
	assert.equal(f.live.current.shots[1].cast[character.id], undefined, "clearing removes the override");
	assert.equal(f.scope.appContext.undoClock, beforeDepth + 2, "clear adds one undo entry");
	assert.equal(first.cast[character.id], undefined, "first still remains independent");
	console.log("PASS still cast override routes character.move to shot.cast and leaves base placement unchanged");
	console.log("PASS resolveCharacterPlacement returns base in still 1 and override in still 2");
	console.log("PASS installed take root wins over still cast override");
	console.log("PASS shot.setCastOverride null clears the override with one undo entry");
} finally {
	f.dispose();
}
