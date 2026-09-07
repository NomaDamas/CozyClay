import assert from "node:assert/strict";
import { imageFileFromTransfer, fileToDataUrl, pastedImageNodeData } from "../src/workflow/clipboard-image.js";

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
