import assert from "node:assert/strict";
import { PREVIS_FLAG_KEY, previsModesEnabled } from "../src/previs-flag.js";

const storage = new Map();
globalThis.localStorage = {
	getItem: (key) => storage.get(key) ?? null,
	setItem: (key, value) => storage.set(key, String(value)),
	removeItem: (key) => storage.delete(key),
};
globalThis.location = { search: "" };

const setSearch = (search) => {
	globalThis.location.search = search;
};

assert.equal(PREVIS_FLAG_KEY, "cozyclay.previs-modes");
assert.equal(previsModesEnabled(), false, "flag defaults off");

setSearch("?previs=1");
assert.equal(previsModesEnabled(), true, "?previs=1 enables the flag");
assert.equal(storage.get(PREVIS_FLAG_KEY), "1", "?previs=1 persists the flag");

setSearch("");
assert.equal(previsModesEnabled(), true, "persisted flag remains enabled");

setSearch("?previs=0");
assert.equal(previsModesEnabled(), false, "?previs=0 disables the flag");
assert.equal(storage.has(PREVIS_FLAG_KEY), false, "?previs=0 clears the persisted flag");

setSearch("");
assert.equal(previsModesEnabled(), false, "cleared flag remains disabled");

storage.set(PREVIS_FLAG_KEY, "other");
assert.equal(previsModesEnabled(), false, "only the enabled value activates the flag");

console.log("PASS previs flag: URL enable/persist, URL disable/clear, and stored state");
