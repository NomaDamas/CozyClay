import assert from "node:assert/strict";
import { DEFAULT_NODE_SCHEMAS, defaultFormValues, schemaCategoryForType, schemaModelEntries, schemaProperties } from "../src/workflow/node-schema.js";

assert.equal(schemaCategoryForType("video-combiner"), "utility");
assert.equal(schemaCategoryForType("image"), "image");
assert.ok(schemaModelEntries(DEFAULT_NODE_SCHEMAS, "image").some((model) => model.id === "image-generation"));
const properties = schemaProperties(DEFAULT_NODE_SCHEMAS, "video", "video-generation");
assert.equal(properties.duration.type, "integer");
assert.deepEqual(defaultFormValues(properties), { prompt: "", duration: 5, aspect_ratio: "auto" });
assert.deepEqual(defaultFormValues({ urls: { type: "array" }, options: { type: "object" }, enabled: { type: "boolean" } }), { urls: [], options: {}, enabled: false });
console.log("Vibe node schema adapter checks passed");
