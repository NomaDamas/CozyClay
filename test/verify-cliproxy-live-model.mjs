import assert from "node:assert/strict";
import { cliproxyLiveModel } from "../bin/agent/providers.mjs";

const sonnet = {
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	api: "anthropic-messages",
	provider: "anthropic",
	reasoning: true,
	thinkingLevelMap: { off: "off", minimal: "low", low: "low", medium: "medium", high: "high" },
	contextWindow: 200000,
	maxTokens: 64000,
};
const gpt = { id: "gpt-5.1", name: "GPT 5.1", api: "openai-responses", provider: "openai", reasoning: true, contextWindow: 400000, maxTokens: 128000 };
const known = [sonnet, gpt];

for (const id of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
	const model = cliproxyLiveModel(id, "anthropic", known);
	assert.equal(model.thinkingLevelMap.off, null, `${id} must not send thinking disabled`);
	assert.deepEqual({ ...model, id: sonnet.id, name: sonnet.name, thinkingLevelMap: sonnet.thinkingLevelMap }, sonnet, `${id} keeps every other template field`);
	assert.equal(model.id, id);
	assert.equal(model.name, id);
}
assert.equal(sonnet.thinkingLevelMap.off, "off", "the catalogue template is not mutated");

assert.deepEqual(cliproxyLiveModel("claude-sonnet-4-9", "anthropic", known), { ...sonnet, id: "claude-sonnet-4-9", name: "claude-sonnet-4-9" });
assert.deepEqual(cliproxyLiveModel("gpt-5.9", "openai", known), { ...gpt, id: "gpt-5.9", name: "gpt-5.9" });
console.log("PASS cliproxy live model thinking compat");
