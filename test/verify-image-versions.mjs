import assert from "node:assert/strict";
import { appendVersion, compareIndex, MAX_VERSIONS, pinnedInputs, selectVersion, versionLabel, versionState } from "../src/workflow/image-versions.js";

const url = (n) => `data:image/png;base64,v${n}`;
const entry = (n) => ({ dataUrl: url(n), prompt: `take ${n}`, referenceDataUrl: n % 2 ? `data:image/png;base64,ref${n}` : null, frameDataUrl: `data:image/png;base64,frame${n}`, at: 1700000000000 + n });

/* ------------------------------------------------------- appendVersion --- */
let data = {};
for (let n = 1; n <= 3; n += 1) data = { ...data, ...appendVersion(data, entry(n)) };
assert.equal(data.versions.length, 3, "each generation appends one version");
assert.equal(data.versionIndex, 2, "the new version becomes the shown one");
assert.deepEqual(data.outputs, [{ value: url(3) }], "outputs[0] carries the current version");
assert.equal(data.resultUrl, url(3), "resultUrl mirrors the current version");
assert.equal(data.versions[0].prompt, "take 1", "the entry keeps the prompt it was generated with");
assert.equal(data.versions[0].frameDataUrl, "data:image/png;base64,frame1", "the entry keeps the frame it was generated from");

const before = { versions: [entry(1)], versionIndex: 0 };
appendVersion(before, entry(2));
assert.equal(before.versions.length, 1, "appendVersion does not mutate the node data it is given");

let capped = {};
for (let n = 1; n <= MAX_VERSIONS + 4; n += 1) capped = { ...capped, ...appendVersion(capped, entry(n)) };
assert.equal(capped.versions.length, MAX_VERSIONS, `the history caps at ${MAX_VERSIONS} versions`);
assert.equal(capped.versions[0].dataUrl, url(5), "the oldest versions are dropped first");
assert.equal(capped.versions.at(-1).dataUrl, url(MAX_VERSIONS + 4), "the newest version survives the cap");
assert.equal(capped.versionIndex, MAX_VERSIONS - 1, "the index follows the capped array");
console.log(`PASS image versions: every generation appends, capped at ${MAX_VERSIONS}, newest shown`);

/* ------------------------------------------------------- selectVersion --- */
const three = { versions: [entry(1), entry(2), entry(3)], versionIndex: 2 };
assert.equal(selectVersion(three, 0).versionIndex, 0, "prev walks back to an earlier take");
assert.deepEqual(selectVersion(three, 0).outputs, [{ value: url(1) }], "selecting rewrites outputs[0]");
assert.equal(selectVersion(three, 0).resultUrl, url(1), "selecting rewrites resultUrl");
assert.equal(selectVersion(three, -1).versionIndex, 0, "prev at the first version is a no-op");
assert.equal(selectVersion(three, 9).versionIndex, 2, "next at the last version is a no-op");
assert.deepEqual(selectVersion({}, 1), { versions: [], versionIndex: 0, outputs: [], resultUrl: null }, "a node without versions selects nothing");
assert.equal(versionLabel(three), "3/3", "the toolbar reads 1-based over the total");
assert.equal(versionLabel(selectVersion(three, 1)), "2/3", "the label follows the selection");
assert.equal(versionLabel({}), "0/0", "an empty node reads 0/0");
assert.equal(versionState({ versions: [entry(1), entry(2)], versionIndex: 7 }).index, 1, "a stored index out of range clamps");
assert.equal(versionState({ versions: [entry(1), entry(2)] }).current.dataUrl, url(2), "a missing index shows the newest version");
console.log("PASS image versions: prev/next clamp at both ends and drive outputs");

/* -------------------------------------------------------- pinnedInputs --- */
const upstream = { source: "data:image/png;base64,newframe", reference: "data:image/png;base64,newref" };
assert.deepEqual(pinnedInputs(three, upstream), { ...upstream, pinned: false }, "unpinned runs use the upstream frame and reference");
const pinned = { ...three, pinReferences: true, versionIndex: 0 };
assert.deepEqual(pinnedInputs(pinned, upstream), { source: "data:image/png;base64,frame1", reference: "data:image/png;base64,ref1", pinned: true }, "pinned runs reuse the shown version's inputs");
assert.equal(pinnedInputs({ ...three, pinReferences: true, versionIndex: 1 }, upstream).reference, null, "a version generated without a reference pins a null reference");
assert.deepEqual(pinnedInputs({ pinReferences: true }, upstream), { ...upstream, pinned: false }, "pinning with no version yet falls back to upstream");
assert.deepEqual(pinnedInputs({ pinReferences: true, versions: [{ dataUrl: url(1) }], versionIndex: 0 }, upstream), { ...upstream, pinned: false }, "a version without a frame falls back to upstream");
assert.deepEqual(pinnedInputs({}, {}), { source: null, reference: null, pinned: false }, "nothing upstream and nothing pinned yields nulls");
console.log("PASS image versions: pinned references reuse the same frame and reference");

/* -------------------------------------------------------- compareIndex --- */
assert.equal(compareIndex(three), 1, "A/B defaults to the previous version");
assert.equal(compareIndex({ ...three, abIndex: 0 }), 0, "an explicit compare index is used");
assert.equal(compareIndex({ ...three, abIndex: 2 }), 1, "comparing against itself falls back to a neighbour");
assert.equal(compareIndex({ ...three, versionIndex: 0, abIndex: 0 }), 1, "at the first version the neighbour is the next one");
assert.equal(compareIndex({ ...three, abIndex: 99 }), 1, "an out-of-range compare index clamps");
assert.equal(compareIndex({ versions: [entry(1)], versionIndex: 0 }), 0, "one version has nothing to compare against");
console.log("PASS image versions: A/B picks a second version to alternate with");
