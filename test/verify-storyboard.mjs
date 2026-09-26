import assert from "node:assert/strict";
import { composeStoryboard } from "../src/storyboard.js";

function recordingContext() {
	const calls = { drawImage: [], fillText: [], fillRect: [] };
	return {
		calls,
		drawImage(...args) { calls.drawImage.push(args); },
		fillText(...args) { calls.fillText.push(args); },
		fillRect(...args) { calls.fillRect.push(args); },
	};
}

function stubCanvasFactory() {
	const canvases = [];
	return {
		canvases,
		createCanvas(width, height) {
			const ctx = recordingContext();
			const canvas = { width, height, ctx, getContext: (kind) => {
				assert.equal(kind, "2d", "storyboard asks for a 2d context");
				return ctx;
			} };
			canvases.push(canvas);
			return canvas;
		},
	};
}

const image = (n) => ({ width: 640, height: 360, tag: `img-${n}` });
const shots = [
	{ title: "Establish rooftop", durationSeconds: 3.5, prompt: "Wide shot as the fox lands on the rooftop and scans the skyline.", image: image(1) },
	{ title: "Sprint left", durationSeconds: 2, prompt: "The fox sprints past the chimney.", image: image(2) },
	{ title: "Jump cut", durationSeconds: 1.5, prompt: "Leap across the gap between buildings.", image: null },
];

const factory = stubCanvasFactory();
const canvas = composeStoryboard({ shots, columns: 3, cell: { width: 320, height: 180 }, createCanvas: factory.createCanvas });

assert.equal(canvas, factory.canvases[0], "composeStoryboard returns the injected canvas");
assert.equal(canvas.width, 960, "3 columns of 320px");
assert.equal(canvas.height, 180, "one row of 180px for three shots");

assert.equal(canvas.ctx.calls.drawImage.length, 2, "drawImage runs once per shot that has an image");
assert.equal(canvas.ctx.calls.drawImage[0][0], shots[0].image, "the first drawImage receives the shot's image");
assert.equal(canvas.ctx.calls.drawImage[1][0], shots[1].image, "the second drawImage receives the shot's image");
assert.equal(typeof canvas.ctx.calls.drawImage[0][1], "number", "drawImage gets a destination x");
assert.equal(typeof canvas.ctx.calls.drawImage[0][2], "number", "drawImage gets a destination y");

const texts = canvas.ctx.calls.fillText.map((call) => call[0]);
for (const shot of shots) {
	assert.ok(texts.includes(shot.title), `fillText includes the title ${JSON.stringify(shot.title)}`);
	assert.ok(texts.includes(`${shot.durationSeconds}s`), `fillText includes the duration of ${shot.title}`);
}
const promptText = texts.find((t) => t.startsWith("Wide shot"));
assert.ok(promptText, "the prompt is drawn");
assert.ok(promptText.length <= 90, "the drawn prompt is truncated to 90 characters");
assert.equal(promptText, "Wide shot as the fox lands on the rooftop and scans the skyline.".slice(0, 90), "the prompt is the first 90 characters");

// The imageless shot gets a placeholder fill instead of a drawImage call.
assert.equal(canvas.ctx.calls.fillRect.length, 2, "background plus one placeholder for the imageless shot");

// A fourth shot wraps to a second row and grows the canvas.
const taller = composeStoryboard({ shots: [...shots, { title: "Extra", durationSeconds: 1, prompt: "", image: null }], columns: 3, cell: { width: 320, height: 180 }, createCanvas: factory.createCanvas });
assert.equal(taller.height, 360, "four shots wrap into two rows");
assert.equal(taller.ctx.calls.fillText.map((c) => c[0]).includes("Extra"), true, "the wrapped shot still gets its title");

// Defaults: three columns and the 320x180 cell.
const defaults = composeStoryboard({ shots, createCanvas: factory.createCanvas });
assert.equal(defaults.width, 960, "default layout is three 320px columns");

console.log("PASS storyboard: grid sizing, drawImage per shot, titles, durations, 90-char prompts");
