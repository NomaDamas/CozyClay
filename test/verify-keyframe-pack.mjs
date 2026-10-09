import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { keyframePackEntries, keyframePackName, buildKeyframePack } from "../src/keyframe-pack.js";

const run = promisify(execFile);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);

const shot = { title: "Runs & Jumps!", index: 3, startFrame: 24, endFrame: 96 };
const clipData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const camera = { name: "Cam A", position: [1.5, 2, 3], fov: 40 };

const args = { shot, fps: 24, firstFramePng: png, lastFramePng: png, clip: { data: clipData, ext: "mp4" }, camera, prompt: "A fox sprints across a rooftop." };
const names = keyframePackEntries(args).map((entry) => entry.name);

assert.deepEqual(names, [
	"3-runs-jumps/first.png",
	"3-runs-jumps/last.png",
	"3-runs-jumps/clip.mp4",
	"3-runs-jumps/camera.json",
	"3-runs-jumps/prompt.txt",
	"3-runs-jumps/README.txt",
], "full pack has one entry per reference file inside <index>-<slug>/");
console.log("PASS keyframe pack: entry names cover frames, clip, camera, prompt, README");

const byName = Object.fromEntries(keyframePackEntries(args).map((entry) => [entry.name, entry.data]));
const text = (data) => (typeof data === "string" ? data : new TextDecoder().decode(data));

const cameraJson = JSON.parse(text(byName["3-runs-jumps/camera.json"]));
assert.equal(cameraJson.fps, 24, "camera.json carries fps");
assert.equal(cameraJson.startFrame, 24, "camera.json carries the start frame");
assert.equal(cameraJson.endFrame, 96, "camera.json carries the end frame");
assert.deepEqual(cameraJson.position, [1.5, 2, 3], "camera.json preserves the camera fields");
assert.match(text(byName["3-runs-jumps/camera.json"]), /\n\s+"name"/, "camera.json is pretty-printed");

assert.equal(text(byName["3-runs-jumps/prompt.txt"]), "A fox sprints across a rooftop.\n", "prompt.txt holds the prompt");
assert.equal(byName["3-runs-jumps/first.png"], png, "first.png is the first frame bytes");
assert.equal(byName["3-runs-jumps/last.png"], png, "last.png is the last frame bytes");
assert.equal(byName["3-runs-jumps/clip.mp4"], clipData, "clip.mp4 is the clip bytes");

const readme = text(byName["3-runs-jumps/README.txt"]);
assert.match(readme, /first\.png[^.]*identity reference/i, "README names first.png the identity reference");
assert.match(readme, /last\.png[^.]*motion endpoint reference/i, "README names last.png the motion endpoint reference");
assert.match(readme, /clip\.mp4[^.]*motion reference/i, "README names the clip the motion reference");
assert.match(readme, /camera\.json[^.]*camera reference/i, "README names camera.json the camera reference");
assert.match(readme, /prompt\.txt/, "README mentions prompt.txt");

// Omitting optional material drops exactly those entries.
const sparse = keyframePackEntries({ ...args, lastFramePng: null, clip: null }).map((entry) => entry.name);
assert.deepEqual(sparse, [
	"3-runs-jumps/first.png",
	"3-runs-jumps/camera.json",
	"3-runs-jumps/prompt.txt",
	"3-runs-jumps/README.txt",
], "a pack without a last frame or clip omits those entries");
const sparseReadme = text(keyframePackEntries({ ...args, lastFramePng: null, clip: null }).at(-1).data);
assert.match(sparseReadme, /last\.png: not included/i, "the README explains a missing last.png");
assert.match(sparseReadme, /clip\.mp4: not included/i, "the README explains a missing clip");
console.log("PASS keyframe pack: optional entries are omitted and the README says so");

// A still (storyboard panel) pack: one picture held for its hold, no clip.
{
	const still = { title: "Panel one", index: 1, startFrame: 48, endFrame: 71, kind: "still" };
	const stylized = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
	const stillArgs = { shot: still, fps: 24, firstFramePng: png, lastFramePng: null, clip: null, camera, prompt: "SHOT: wide\nCAPTION: she enters", folder: "panel-01" };
	const plain = keyframePackEntries(stillArgs);
	assert.deepEqual(plain.map((entry) => entry.name), ["panel-01/first.png", "panel-01/camera.json", "panel-01/prompt.txt", "panel-01/README.txt"], "a still pack has no clip.* or last.png");
	const withStylized = keyframePackEntries({ ...stillArgs, stylizedPng: stylized });
	assert.deepEqual(withStylized.map((entry) => entry.name), ["panel-01/first.png", "panel-01/stylized.png", "panel-01/camera.json", "panel-01/prompt.txt", "panel-01/README.txt"], "stylized.png joins the pack when given");
	assert.ok(!withStylized.some((entry) => /\/(clip\.[a-z0-9]+|last\.png)$/.test(entry.name)), "no clip.* or last.png entry");
	const stillFiles = Object.fromEntries(withStylized.map((entry) => [entry.name.split("/")[1], entry.data]));
	assert.equal(stillFiles["stylized.png"], stylized, "stylized.png is the stylized bytes");
	const stillCamera = JSON.parse(text(stillFiles["camera.json"]));
	assert.deepEqual([stillCamera.startFrame, stillCamera.endFrame, stillCamera.hold, stillCamera.kind, stillCamera.fps], [48, 48, 24, "still", 24], "camera.json: startFrame === endFrame === panel start, hold frames, kind still");
	assert.equal(text(stillFiles["prompt.txt"]), "SHOT: wide\nCAPTION: she enters\n");
	assert.match(text(stillFiles["README.txt"]), /stylized\.png/, "README names stylized.png when it is in the pack");
	assert.match(text(stillFiles["README.txt"]), /clip\.mp4: not included/i, "README uses the no-clip branch");
	assert.doesNotMatch(text(plain.at(-1).data), /stylized\.png/, "README does not mention stylized.png when it is absent");
	assert.equal("hold" in JSON.parse(text(byName["3-runs-jumps/camera.json"])), false, "a clip pack's camera.json is unchanged");
	const stillZip = buildKeyframePack({ ...stillArgs, stylizedPng: stylized });
	const stillDir = await mkdtemp(join(tmpdir(), "cozyclay-still-pack-"));
	try {
		await writeFile(join(stillDir, "panel.zip"), stillZip);
		const { stdout } = await run("unzip", ["-t", join(stillDir, "panel.zip")]);
		assert.match(stdout, /No errors detected/);
	} finally {
		await rm(stillDir, { recursive: true, force: true });
	}
	console.log("PASS keyframe pack: still pack = first.png, optional stylized.png, camera.json (start===end, hold, kind still), prompt.txt, README; no clip/last");
}

assert.equal(keyframePackName(shot), "cozyclay-shot-3-runs-jumps.zip", "pack file name is cozyclay-shot-<index>-<slug>.zip");

// The assembled pack must survive a real unzip round trip.
const zip = buildKeyframePack(args);
const dir = await mkdtemp(join(tmpdir(), "cozyclay-keyframe-pack-"));
const zipPath = join(dir, keyframePackName(shot));
try {
	await writeFile(zipPath, zip);
	const { stdout } = await run("unzip", ["-t", zipPath]);
	assert.match(stdout, /No errors detected/, `unzip -t reports a healthy pack:\n${stdout}`);
	console.log("PASS keyframe pack: assembled zip passes unzip -t");
	console.log(`  ${stdout.trim().split("\n").join("\n  ")}`);
} finally {
	await rm(dir, { recursive: true, force: true });
}

console.log("PASS keyframe-pack: entry names, README reference roles, and pack name");
