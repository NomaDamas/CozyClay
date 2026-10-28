#!/usr/bin/env node
// motion.compile's automatic MotionBricks fill (src/commands/motion3-fill.js autoFill, the hook motion.compile runs before it
// compiles): key poses on the 24-frame grid come back with src: "fill" keys and output.fill; fill: false and skill specs are
// left alone; a 100-frame gap gets pass-through poses first; no fetcher (a Node compile) changes nothing. The fill itself runs
// the real model through the dev server's route (mcp/motionbricks/service.mjs); without the cached model this file skips.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { autoFill } from "../../src/commands/motion3-fill.js";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { isFillKey } from "../../src/motion3/bricks/fill-src.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const model = process.env.COZYCLAY_MOTIONBRICKS_MODEL ?? join(homedir(), ".cache", "cozyclay", "motionbricks", "mmm_v6_soma_fp16.onnx");
const character = { id: "actor-a", model: "x-bot-tpose" };
const demo = JSON.parse(readFileSync(new URL("../../mcp/motionbricks/demo/sit.json", import.meta.url), "utf8"));
const grid = { ...demo, frames: 49, keys: demo.keys.map((k, i) => ({ ...k, f: i * 24 })) };

expect("no fetcher (a Node compile): nothing sent, the spec compiles as written", JSON.stringify(autoFill({}, character, grid)) === JSON.stringify({ spec: grid, fill: null }));
const never = () => { throw new Error("must not fetch"); };
expect("fill: false: nothing sent", autoFill({ fetch: never }, character, { ...grid, fill: false }).fill === null);
const skill = autoFill({ fetch: never }, character, { ...grid, use: [{ skill: "walkTo", f0: 0, args: { to: [0, 1] } }] });
expect("a spec with use is not filled and says so", /use or generators is not filled/.test(skill.fill?.note ?? ""), JSON.stringify(skill.fill));
const down = await autoFill({ fetch: async () => { throw new TypeError("fetch failed"); } }, character, grid);
expect("no dev server: compiles as written with a note, never an error", down.spec === grid && /did not run/.test(down.fill?.note ?? ""), JSON.stringify(down.fill));

// the runtime lives next to the server (mcp/node_modules, installed with --no-save), not in the root package
const onnx = existsSync(new URL("../../mcp/node_modules/onnxruntime-node", import.meta.url));
if (!existsSync(model) || !onnx) console.log(`SKIP the model runs: ${existsSync(model) ? "onnxruntime-node is not installed" : `no model at ${model}`}`);
else {
	process.env.COZYCLAY_MOTIONBRICKS_MODEL = model;
	const { fillRequest } = await import("../../mcp/motionbricks/service.mjs");
	const fetch = async (_url, init) => { try { return new Response(JSON.stringify(await fillRequest(JSON.parse(init.body))), { status: 200 }); } catch (error) { return new Response(JSON.stringify({ error: { code: "INVALID_ARGUMENT", message: error.message } }), { status: 400 }); } };
	const sk = skeletonFor("x-bot-tpose"), scene = motionScene([]);
	const three = await autoFill({ fetch }, character, grid);
	const fillKeys = three.spec.keys.filter(k => isFillKey(k)).length;
	const qa = compileSpec(three.spec, { sk, scene }).qa;
	expect("f0, f24, f48: two gaps filled, src: \"fill\" keys, output.fill", three.fill?.calls === 2 && fillKeys > 0 && three.fill.keys === fillKeys, JSON.stringify(three.fill));
	expect("the filled spec compiles", Array.isArray(qa.groups), "");
	const long = { ...grid, frames: 101, keys: [{ ...grid.keys[0], f: 0 }, { ...grid.keys[2], f: 100 }] };
	const split = await autoFill({ fetch }, character, long);
	expect("a 100-frame gap: 3 pass-through poses, 4 gaps filled", split.fill?.passThrough === 3 && split.fill?.calls === 4 && split.spec.keys.filter(k => k.src === "pass").length === 3, JSON.stringify(split.fill));
	// the loop the hint drives: patch a fill key (src kept), compile again: the edit stays, only the two gaps beside it run
	const target = three.spec.keys.find(k => isFillKey(k) && k.f > 0 && k.f < 24 && Object.keys(k.set).length);
	const ch = Object.keys(target.set)[0], edited = Array.isArray(target.set[ch]) ? target.set[ch].map(v => v + 0.03) : target.set[ch] + 3;
	const patched = { ...three.spec, keys: three.spec.keys.map(k => (k === target ? { ...k, set: { ...k.set, [ch]: edited } } : k)) };
	const again = await autoFill({ fetch }, character, patched);
	const kept = again.spec.keys.find(k => k.f === target.f && !isFillKey(k));
	expect("an edited fill key stays (its value, no src) and becomes authored", kept && JSON.stringify(kept.set[ch]) === JSON.stringify(edited) && again.fill.promoted === 1, JSON.stringify({ kept, fill: again.fill }));
	// the edit splits f0-f24 in two; a part under 14 frames stays the compiler's curve, so 1 or 2 calls, all inside f0-f24
	const ran = again.fill.gaps.filter(g => !g.kept && !g.skipped);
	expect("only the gaps beside it ran again (inside f0-f24); f24-f48 kept its fill", ran.length >= 1 && ran.length <= 2 && ran.every(g => g.f[0] >= 0 && g.f[1] <= 24) && again.fill.gaps.some(g => g.kept && g.f[0] === 24), JSON.stringify(again.fill.gaps));
	const hinted = compileSpec(again.spec, { sk, scene }).qa.groups.map(g => g.cause).filter(c => /MotionBricks fill key/.test(c ?? ""));
	// parkour shape: approach f0-f18, hands on the wall f18-f30, flight f30-f42, landing f42-f60: only the first and last gaps fill
	const pose = (f, { root = [0, 1.016, 0], foot = 0.087, hand = 0.9, z = 0 } = {}) => ({ f, set: { ...grid.keys[0].set, root: [root[0], root[1], root[2] + z],
		foot_l: [0.1, foot, z], foot_r: [-0.1, foot, z], hand_l: [0.24, hand, z + 0.1], hand_r: [-0.24, hand, z + 0.1] } });
	const parkour = { ...grid, frames: 61, keys: [pose(0), pose(18, { z: 0.4 }), pose(30, { z: 0.7, foot: 0.45, root: [0, 1.25, 0], hand: 1.0 }), pose(42, { z: 1.4, root: [0, 1.0, 0] }), pose(60, { z: 1.7 })],
		goals: [{ name: "hands on the wall top", near: ["joint:LeftHand", "joint:RightHand"], tol: 0.6, at: [18, 30] }] };
	const vault = await autoFill({ fetch }, character, parkour);
	const filledGaps = vault.fill.gaps.filter(g => !g.skipped && !g.kept).map(g => g.f.join("-"));
	expect("parkour: only the approach and the landing gaps fill; the hand plant and the flight stay authored", JSON.stringify(filledGaps) === '["0-18","42-60"]'
		&& JSON.stringify(vault.fill.skipped?.map(s => `${s.f.join("-")} ${s.reason}`)) === '["18-30 hand_contact","30-42 airborne"]', JSON.stringify(vault.fill));
	console.log(`  edit loop: promoted ${again.fill.promoted}, ${again.fill.calls} calls, kept ${again.fill.gaps.filter(g => g.kept).length} gap; fill-key hints: ${hinted.length}`);
	console.log(`  3-key grid: ${three.fill.calls} calls, ${fillKeys} fill keys, QA ${qa.groups.length} groups; 100-frame gap: ${split.fill.passThrough} pass-through, ${split.fill.calls} calls`);
}
if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("all passed");
