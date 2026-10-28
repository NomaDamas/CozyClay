// The MotionBricks fill as a request the dev server answers (POST /agent/motion-fill, tools/dev-full.mjs):
// { spec, at?, model? } -> { spec (the filled spec, fill keys src: "fill"), gaps, calls, ms }. The Studio's motion.fill
// action sends the authored spec here because the model runs on onnxruntime-node, not in the browser. One runner per process.
import { compileSpec } from "../../src/motion3/pipeline.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { motionScene } from "../../src/motion3/scene.js";
import { fillSpec } from "../../src/motion3/bricks/fill.js";
import { createRunner } from "./model.mjs";

let runner;

export async function fillRequest({ spec, at, model = "x-bot-tpose" } = {}) {
	if (!spec || typeof spec !== "object" || !Array.isArray(spec.keys)) throw Object.assign(new Error("spec must be a motion spec with keys"), { code: "INVALID_ARGUMENT" });
	if (at !== undefined && !Number.isInteger(at)) throw Object.assign(new Error("at must be a whole frame"), { code: "INVALID_ARGUMENT" });
	const sk = skeletonFor(model);
	if (!sk) throw Object.assign(new Error(`${model} is not a rig the fill can drive`), { code: "TARGET_NOT_READY" });
	const t0 = performance.now();
	const run = await (runner ??= createRunner().catch(error => { runner = undefined; throw error; }));
	const scene = motionScene([]);
	const filled = await fillSpec(spec, { sk, compile: s => compileSpec(s, { sk, scene }), run }, { at });
	return { ...filled, ms: Math.round(performance.now() - t0) };
}

const BODY_LIMIT = 1024 * 1024;

/** POST /agent/motion-fill on the dev server (tools/dev-full.mjs): JSON { spec, at?, model? } in, fillRequest's answer or { error: { code, message } } out. */
export async function handleFillRoute(req, res) {
	const send = (status, value) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); };
	try {
		let size = 0;
		const chunks = [];
		for await (const chunk of req) {
			size += chunk.length;
			if (size > BODY_LIMIT) throw Object.assign(new Error("request body is over 1 MB"), { code: "INVALID_ARGUMENT" });
			chunks.push(chunk);
		}
		send(200, await fillRequest(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
	} catch (error) {
		const bad = error.code === "INVALID_ARGUMENT" || error instanceof SyntaxError || /^(FILL_GAP_TOO_LONG|MOTION_SPEC_INVALID)/.test(error.message);
		send(bad ? 400 : 500, { error: { code: bad ? "INVALID_ARGUMENT" : error.code === "TARGET_NOT_READY" ? error.code : "FILL_FAILED", message: error.message.replace(/^MOTION_SPEC_INVALID:\s*/, "") } });
	}
}
