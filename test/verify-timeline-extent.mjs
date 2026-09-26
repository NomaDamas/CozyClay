#!/usr/bin/env node
import assert from "node:assert/strict";
import { timelineContentExtent, timelineSpan } from "../src/timeline-extent.js";

const charA = { id: "characterA", sessionMotion: { frames: 136 } };
const charB = { id: "characterB", sessionMotion: { frames: 192 } };

assert.equal(
	timelineContentExtent([charA, charB], "characterA", { frames: 136 }, []),
	192,
	"the shared clock spans the longest remaining cast take",
);
assert.equal(
	timelineContentExtent([charA], "characterA", { frames: 136 }, []),
	136,
	"deleting the longer character shrinks the clock",
);
assert.equal(
	timelineContentExtent([charA], "characterA", { frames: 136 }, [{ startFrame: 136, endFrame: 192 }]),
	192,
	"prompt content still extends the production clock",
);
assert.equal(
	timelineContentExtent(
		[{ id: "characterA", sessionMotion: { frames: 136 } }, { id: "characterB", sessionMotion: { frames: 192 }, layer: { promptClips: [] } }],
		"characterA",
		{ frames: 136 },
		[],
	),
	192,
	"the remaining longer cast take remains on the shared clock",
);
assert.equal(
	timelineContentExtent(
		[{ id: "characterA", sessionMotion: { frames: 136 }, layer: { promptClips: [] } }],
		"characterA",
		{ frames: 136 },
		[],
	),
	136,
	"the clock shrinks to the remaining motion after a cast deletion",
);
assert.equal(
	timelineContentExtent([], null, null, [], 240),
	240,
	"ingested footage remains on the shared clock before extraction",
);
assert.equal(
	timelineContentExtent(
		[{ id: "characterA", sessionMotion: { frames: 136 }, layer: { promptClips: [] } }],
		"characterA",
		{ frames: 136 },
		[],
		240,
	),
	136,
	"a shorter take wins over its older, longer source footage",
);
assert.equal(
	timelineContentExtent([], null, null, [], 0),
	0,
	"empty content leaves the existing authored duration untouched",
);

const shots = [{ startFrame: 0, endFrame: 95 }, { startFrame: 96, endFrame: 239 }];
assert.equal(timelineSpan(136, shots), 240, "the timeline covers the last shot's inclusive end frame");
assert.equal(timelineSpan(300, shots), 300, "longer content keeps its own extent");
assert.equal(timelineSpan(136, []), 136, "no shots: the content extent wins");
assert.equal(timelineSpan(0, shots, 120), 240, "an empty scene still grows to cover its shots");
assert.equal(timelineSpan(0, [{ startFrame: 0, endFrame: 47 }], 120), 120, "an empty scene never shrinks under its authored duration");
assert.equal(timelineSpan(0, [], 120), 120, "no content and no shots keep the existing duration");
assert.equal(timelineSpan(136, [{ startFrame: 0 }, null]), 136, "a shot without an end frame sets no floor");

console.log("verify-timeline-extent: all checks passed");
