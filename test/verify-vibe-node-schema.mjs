import assert from "node:assert/strict";
import { DEFAULT_NODE_SCHEMAS, defaultFormValues, schemaCategoryForType, schemaModelEntries, schemaProperties } from "../src/workflow/node-schema.js";

assert.equal(schemaCategoryForType("video-combiner"), "utility");
assert.equal(schemaCategoryForType("image"), "image");
assert.ok(schemaModelEntries(DEFAULT_NODE_SCHEMAS, "image").some((model) => model.id === "image-generation"));
const properties = schemaProperties(DEFAULT_NODE_SCHEMAS, "video", "video-generation");
assert.equal(properties.duration_seconds.type, "number");
assert.equal(properties.prompt.title, "Motion prompt");
assert.deepEqual(properties.provider.enum, ["comfy", "fal"]);
assert.deepEqual(properties.aspect.enum, ["16:9", "9:16", "1:1", "21:9", "12:7"]);
assert.deepEqual(defaultFormValues(properties), { provider: "comfy", prompt: "", duration_seconds: 5, aspect: "16:9" });
assert.deepEqual(defaultFormValues({ urls: { type: "array" }, options: { type: "object" }, enabled: { type: "boolean" } }), { urls: [], options: {}, enabled: false });
console.log("Vibe node schema adapter checks passed");
