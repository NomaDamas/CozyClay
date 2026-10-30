#!/usr/bin/env node
// The opt-in native MotionBricks fill (src/motion3/bricks/fill-native*.js) without the model: a stub runner answers every request
// with a still SOMA pose and the longest token count the request allows. Checks the engines' endpoint correction (the corrected
// motion starts on the context pose and ends on the target), the target count (4 at a pass-through key, 1 at the last), and the
// four timings: exact keeps the authored frames, free time-warps, retime moves the later keys to where the model arrives, and
// playground runs one chain whose middle key is a guide (not a key of the result) and whose last key is reached.
import { readFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { somaPose } from "../../src/motion3/bricks/reverse.js";
import { decodeMotion, MIN_TOKENS } from "../../src/motion3/bricks/model-io.js";
import { isFillKey } from "../../src/motion3/bricks/fill-src.js";
import { STEP } from "../../src/motion3/bricks/fill.js";
import { correctMotion } from "../../src/motion3/bricks/fill-native-core.js";
import { fillSpecNative } from "../../src/motion3/bricks/fill-native.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const FEAT = 366, ROT0 = 5 + 29 * 3;
/** A runner that always answers a still pose (identity rotations, hips 0.95 m up) at the longest allowed token count. */
function stubRunner(log = []) {
	return async feed => {
		const allowed = Array.from(feed.allowed_pred_num_tokens.data).map((on, i) => (on ? MIN_TOKENS + i : 0)).filter(Boolean);
		const tokens = Math.max(...allowed), out = new Float32Array(64 * FEAT);
		for (let f = 0; f < 64; f++) {
			const o = f * FEAT;
			out[o + 1] = 0.95;
			for (let j = 0; j < 30; j++) out.set([1, 0, 0, 0, 1, 0], o + ROT0 + j * 6);
			out.fill(1, o + FEAT - 4, o + FEAT);
		}
		log.push({ tokens, targets: Array.from(feed.has_local_poses.data).reduce((n, v) => n + v, 0) - 4 });
		return { out, tokens };
	};
}

const sk = skeletonFor("x-bot-tpose"), scene = motionScene([]), compile = s => compileSpec(s, { sk, scene });
const demo = JSON.parse(readFileSync(new URL("../../mcp/motionbricks/demo/sit.json", import.meta.url), "utf8"));
const authoredFrames = spec => [...new Set(spec.keys.filter(k => !isFillKey(k)).map(k => k.f))].sort((a, b) => a - b);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// endpoint correction: start on the context pose, end on the target, both exactly
{
	const r = compile(demo), start = somaPose(sk, r.out.frames[0].s), end = somaPose(sk, r.out.frames[20].s);
	const { out } = await stubRunner()({ allowed_pred_num_tokens: { data: Int32Array.from({ length: 11 }, (_, i) => +(i === 4)) }, has_local_poses: { data: new Int32Array(8) } });
	const motion = correctMotion(decodeMotion(out, 10, { Ap: [0, 0, 0], AR: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }), start, end);
	const worst = (a, b) => Math.max(...a.P.map((p, j) => dist(p, b.P[j])));
	expect("correctMotion: the first frame is the context pose", worst(motion[0], start) < 1e-6, `off by ${worst(motion[0], start)}`);
	expect("correctMotion: the last frame is the target pose", worst(motion.at(-1), end) < 1e-6, `off by ${worst(motion.at(-1), end)}`);
	expect("correctMotion: 34 valid frames for 10 tokens", motion.length === 34, `${motion.length}`);
}

// exact: authored frames stay, 4 targets at the middle key and 1 at the last, the model's longer length is a timing hint
{
	const log = [], r = await fillSpecNative(demo, { sk, compile, run: stubRunner(log) }, { timing: "exact", gate: false });
	expect("exact: the authored key frames stay 0, 20, 42", JSON.stringify(authoredFrames(r.spec)) === "[0,20,42]", JSON.stringify(authoredFrames(r.spec)));
	expect("exact: two gaps generated", r.calls === 2, `${r.calls}`);
	expect("exact: 4 target poses at the pass-through key, 1 at the last", JSON.stringify(r.gaps.map(g => g.targets)) === "[4,1]", JSON.stringify(r.gaps.map(g => g.targets)));
	expect("exact: fill keys between the authored keys", r.spec.keys.some(isFillKey));
	expect("exact: a timing hint when the model wants longer", (r.warnings ?? []).some(w => w.startsWith("timing f0-f20")), JSON.stringify(r.warnings));
	expect("exact: the filled spec compiles", compile(r.spec).out.frames.length === 43, `${compile(r.spec).out.frames.length}`);
}

// retime: each gap takes the model's length, the later keys move by the difference
{
	const r = await fillSpecNative(demo, { sk, compile, run: stubRunner() }, { timing: "retime" });
	const fs = authoredFrames(r.spec), len = Math.round((14 * 4 - 6) * STEP);
	expect("retime: every gap is the model's length", fs[1] - fs[0] === len && fs[2] - fs[1] === len, JSON.stringify(fs));
	expect("retime: reported as authored -> model frames", r.retimed?.length === 2 && r.retimed[0].authored === 20 && r.retimed[0].model === len, JSON.stringify(r.retimed));
	expect("retime: the take grows to the last key", r.spec.frames >= fs[2] + 1, `${r.spec.frames}`);
}

// playground: one chain, the middle key is a guide, the last key is reached where the chain arrives
{
	const r = await fillSpecNative(demo, { sk, compile, run: stubRunner() }, { timing: "playground" });
	const fs = authoredFrames(r.spec);
	expect("playground: the middle key is not a key of the result (a guide)", fs.length === 2 && !fs.includes(20), JSON.stringify(fs));
	expect("playground: the guide is reported with where it was passed", r.guides?.[0]?.authored === 20 && r.guides[0].at > 20, JSON.stringify(r.guides));
	expect("playground: the last key closes the take", fs[1] === r.spec.frames - 1 && r.guides.at(-1).at === fs[1], `${fs} / ${r.spec.frames}`);
	expect("playground: the guide step hands over 8 frames early", r.gaps[0].early === 8 && r.gaps[1].early === 0, JSON.stringify(r.gaps));
	expect("playground: installs as is (fix: false)", r.spec.fix === false && compile(r.spec).out.frames.length === r.spec.frames, `${compile(r.spec).out.frames.length} vs ${r.spec.frames}`);
}

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
