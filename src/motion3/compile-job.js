// One motion compile as a job of plain data, the same in the compile worker (compile-worker.js) and on
// the calling thread (commands/motion3-compile.js, where no worker runs: Node, tests): the rig by model
// name, the motion scene (scene.js motionScene of the editor's objects: oriented boxes; shapes.js reads a sphere or a cylinder round from them), the spec as sent, and
// what to do with it (probes, checks, lenient, repair, bake). The answer is plain data and typed arrays
// only (the compiler's out holds closures), so it crosses a worker boundary: QA, observations, the stored
// spec, and the baked take when asked. The hint patches QA offers are compiled first (hint-check.js).
// A refusal is an Error with a code (INVALID_ARGUMENT, MOTION_SPEC_INVALID turned into it), which the
// client turns back into the Studio's protocol error.
import { compileSpec, liftRequest } from "./pipeline.js";
import { prepareSpec } from "./correct.js";
import { repairSpec } from "./repair.js";
import { checkHints } from "./hint-check.js";
import { bakeTake } from "./take.js";
import { skeletonFor } from "./rigs/index.js";
import { keptPeople } from "./people.js";

const TIMELINE_FPS = 24, FINISH_AT = 2;
const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** Runs `run`, turning a MOTION_SPEC_INVALID error into INVALID_ARGUMENT with the exact message. */
function asArgument(run) {
	try {
		return run();
	} catch (error) {
		if (/^MOTION_SPEC_INVALID/.test(error.message)) refuse("INVALID_ARGUMENT", error.message.replace(/^MOTION_SPEC_INVALID:\s*/, ""));
		throw error;
	}
}

/**
 * The same plain data as fresh literals. Objects that came through a structured clone (a worker message) make
 * the compiler's hot loops ~60% slower in V8 (their shapes); a copy built from literals runs at full speed and
 * keeps every value exactly (unlike a JSON round trip: -0, NaN, Infinity).
 */
const fresh = value => (Array.isArray(value) ? value.map(fresh) : value && typeof value === "object" && !ArrayBuffer.isView(value)
	? Object.fromEntries(Object.keys(value).map(k => [k, fresh(value[k])])) : value);

/**
 * runCompileJob({ model, scene, spec, probes?, checks?, lenient?, repair?, bake? }) -> { stored, qa, observations,
 * used, fixed, search, timeline, probes?, notes?, ms (+ repair: its wall ms), frameCount, label, repair?, take? }
 * bake: { position, yaw, prompt? } bakes the final result's take (prompt: given, else the final spec's label).
 */
export function runCompileJob({ model, scene, spec: asked, probes: sentProbes, checks, lenient, repair, finish, bake }) {
	const sk = skeletonFor(model);
	const opts = { ...(checks ? { checks } : {}), ...(lenient ? { lenient: true } : {}) };
	// spec.probes and bare moved ids are lifted before fps is filled in, so the specId stays the spec's own
	const once = s => {
		const { spec, probes } = liftRequest(s, sentProbes);
		if (spec?.fps !== undefined && spec.fps !== TIMELINE_FPS) refuse("INVALID_ARGUMENT", `spec.fps must be ${TIMELINE_FPS}, the timeline rate.`);
		const sent = { fps: TIMELINE_FPS, ...spec };
		const r = asArgument(() => compileSpec(sent, { sk, scene }, { ...opts, probes }));
		return { ...r, stored: r.spec === sent ? spec : r.spec };
	};
	// repair patches address the stored spec, so a repair starts from it corrected (correct.js), and says what was
	const corrected = [], start = repair && !lenient ? prepareSpec(asked, { sk, scene }, corrected) : asked;
	// every compile's QA by its spec, so a hint patch repair already tried is not compiled again (hint-check.js)
	const seen = new Map(), measured = s => { const r = once(s); seen.set(JSON.stringify(s), r.qa); return r; };
	const t0 = performance.now(), first = repair ? repairSpec(start, repair, measured) : { spec: asked, result: measured(asked) };
	// the finish pass (finish: an installing compile): a take left with 1-2 QA groups (variant I: 1-4 ran it on 11 compiles at ~20 s each) repairs once more, up to 6 rounds (deep research 10:
	// about +5 s; offline -0.5 groups mean, 0 worse, 21% of 1-2-group takes reach 0; it fixes a single SLIDE or BODY, not POP, SELF or REACH)
	const left = first.result.qa?.groups?.length ?? 0, more = repair && finish && left > 0 && left <= FINISH_AT ? repairSpec(first.spec, { ...repair, rounds: 6 }, measured) : null;
	const fixed = more?.repair.applied.length ? { spec: more.spec, result: more.result, repair: { ...first.repair, rounds: first.repair.rounds + more.repair.rounds,
		compiles: first.repair.compiles + more.repair.compiles, applied: [...first.repair.applied, ...more.repair.applied], rejected: first.repair.rejected + more.repair.rejected, finish: more.repair.rounds } }
		: more ? { ...first, repair: { ...first.repair, finish: 0 } } : first;
	// a hint's patch is offered only when its compile helped (hint-check.js), and only by a compile that repairs: repair has
	// compiled most of the patches already (seen), where a plain compile paid two more compiles for them (bench replay: first
	// compile 1.6 -> 5.2 s median) and the agent applied an offered patch as sent once in the 60 bench runs (374 direct
	// compiles, 319 with repair; a plain compile is mostly a variant in a sweep); a plain compile keeps the hint's words only
	if (repair) checkHints(fixed.spec, fixed.result.qa, s => seen.get(JSON.stringify(s)) ?? measured(s).qa);
	else for (const g of fixed.result.qa?.groups ?? []) delete g.patch;
	// ms.repair: the whole repair's wall time, so a sweep that repairs every variant shows what it costs
	const r = fixed.result, label = fixed.spec?.label ?? null, ms = fixed.repair ? { ...r.ms, repair: Math.round(performance.now() - t0) } : r.ms;
	const take = bake ? bakeTake(sk, r.out, { position: bake.position, yaw: bake.yaw }, { spec: r.stored, prompt: ("prompt" in bake ? bake.prompt : label) ?? "" }) : undefined;
	// a person anchor's joints (and the bodies fix.person pushed an arm out of) ride with the take, so its saved source
	// compiles the same without the others' takes (people.js)
	const people = take && keptPeople(scene, [r.expanded, r.stored], r.out);
	if (people) take.people = people;
	return { stored: r.stored, qa: r.qa, observations: r.observations, used: r.used, fixed: r.fixed, search: r.search, timeline: r.timeline,
		...(r.probes ? { probes: r.probes } : {}), ...(r.notes || corrected.length ? { notes: [...corrected, ...(r.notes ?? [])] } : {}), ms, frameCount: r.out.frameCount, label,
		...(fixed.repair ? { repair: fixed.repair } : {}), ...(take ? { take } : {}) };
}

/** The ArrayBuffers under a job answer's typed arrays (each once), to transfer instead of copy. */
function buffersOf(value, found = new Set()) {
	if (ArrayBuffer.isView(value)) found.add(value.buffer);
	else if (value && typeof value === "object") for (const v of Object.values(value)) buffersOf(v, found);
	return [...found];
}

/** The worker's answer to { id, job }: { message: { id, value }, transfer } or { message: { id, error: { message, code, name } }, transfer: [] }. */
export function answerOf({ id, job }) {
	try {
		const value = runCompileJob(fresh(job));
		return { message: { id, value }, transfer: buffersOf(value) };
	} catch (error) {
		return { message: { id, error: { message: String(error?.message ?? error), code: error?.code ?? null, name: error?.name ?? "Error" } }, transfer: [] };
	}
}
