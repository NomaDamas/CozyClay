import assert from "node:assert/strict";
import { imageFileFromTransfer, fileToDataUrl, pastedImageNodeData, canvasTakesPaste } from "../src/workflow/clipboard-image.js";

const png = new File([Buffer.from("89504e470d0a1a0a", "hex")], "image.png", { type: "image/png" });
const txt = new File(["hi"], "note.txt", { type: "text/plain" });

assert.equal(imageFileFromTransfer({ files: [txt, png], items: [] }), png, "picks the first image among files");
assert.equal(imageFileFromTransfer({ files: [txt], items: [] }), null, "ignores non-image files");
assert.equal(imageFileFromTransfer({ files: [], items: [{ kind: "string", type: "text/plain" }, { kind: "file", type: "image/jpeg", getAsFile: () => png }] }), png, "falls back to items for pasted bitmaps");
assert.equal(imageFileFromTransfer(null), null, "tolerates a missing transfer");

const dataUrl = await fileToDataUrl(png);
assert.ok(dataUrl.startsWith("data:image/png;base64,"), "reads the file as a data URL");

const data = pastedImageNodeData(png, dataUrl);
assert.equal(data.image_url, dataUrl); assert.equal(data.fileUrl, dataUrl); assert.deepEqual(data.outputs, [{ value: dataUrl }]);
assert.match(data.fileName, /^pasted-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/, "clipboard images get a dated name instead of image.png");
assert.equal(pastedImageNodeData(new File([], "ref.jpg", { type: "image/jpeg" }), "data:image/jpeg;base64,").fileName, "ref.jpg", "dropped files keep their name");
console.log("PASS clipboard image: transfer extraction, data URL read, node data");

// The Agent composer autofocuses, so a real Cmd+V usually targets a textarea.
// A plain text field cannot hold an image: the canvas takes it. Text pastes
// stay in the field, and a rich editor keeps images it can hold.
const el = (tag, extra = {}) => ({ tagName: tag, matches: (sel) => sel.split(",").some((s) => s.trim().toLowerCase() === tag.toLowerCase()), isContentEditable: false, ...extra });
assert.equal(canvasTakesPaste(el("TEXTAREA"), { files: [png], items: [] }), true, "an image pasted into a textarea goes to the canvas");
assert.equal(canvasTakesPaste(el("INPUT"), { files: [png], items: [] }), true, "an image pasted into an input goes to the canvas");
assert.equal(canvasTakesPaste(el("TEXTAREA"), { files: [], items: [{ kind: "string", type: "text/plain" }] }), false, "text pasted into a textarea stays there");
assert.equal(canvasTakesPaste(el("DIV", { isContentEditable: true }), { files: [png], items: [] }), false, "a rich editor keeps images it can hold");
assert.equal(canvasTakesPaste(el("BODY"), { files: [png], items: [] }), true, "a paste with nothing focused goes to the canvas");
assert.equal(canvasTakesPaste(el("BODY"), { files: [], items: [] }), false, "no image, nothing to place");
console.log("PASS canvas takes image pastes aimed at plain text fields");
