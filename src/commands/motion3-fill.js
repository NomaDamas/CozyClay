// motion.fill: MotionBricks fills the gaps between the authored key poses of a spec (src/motion3/bricks/fill.js), then the
// filled spec runs the motion.compile path (compile, QA, install) and answers as it does. The model runs on onnxruntime-node,
// so the authored spec goes to the dev server's agent routes (POST /agent/motion-fill, mcp/motionbricks/service.mjs); a static
// build has no such server and the action says so instead of waiting.
import { fail, characterOf } from "./shared.js";
import { specIdOf } from "../motion3/spec-store.js";
import { MOTION_ACTION_HELP as HELP } from "../motion3/docs.js";

const id = { type: "string", minLength: 1 };
const openObject = { type: "object", properties: {}, required: [], additionalProperties: true };
const FILL_TIMEOUT_MS = 90000;

export const declarations = Object.freeze([
	{ id: "motion.fill", label: "Fill motion between key poses", kind: "job", domain: "motion", timeoutMs: 120000, description: HELP.fill,
		input: { type: "object", properties: { characterId: id, spec: openObject, base: { type: "string", pattern: "^spec-[0-9a-f]{12}$" },
			at: { type: "integer", minimum: 0 }, install: { oneOf: [{ type: "boolean" }, { const: "ifClean" }, { const: "never" }], default: true } },
		required: ["characterId"], additionalProperties: false } },
]);

const NO_SERVER = "MotionBricks fill needs the local dev server (npm run dev): this Studio has no Node side to run the model.";

/** POST the authored spec to the dev server; the filled spec, or a StudioProtocolError. */
async function requestFill(fetcher, body) {
	let res;
	try {
		res = await fetcher("/agent/motion-fill", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(FILL_TIMEOUT_MS) });
	} catch (error) {
		fail("CAPABILITY_MISSING", `${NO_SERVER} (${error.name === "TimeoutError" ? "no answer in 90 s" : error.message})`);
	}
	const answer = await res.json().catch(() => null);
	if (!answer) fail("CAPABILITY_MISSING", `${NO_SERVER} (HTTP ${res.status})`);
	if (!res.ok) fail(answer.error?.code === "INVALID_ARGUMENT" ? "INVALID_ARGUMENT" : answer.error?.code === "TARGET_NOT_READY" ? "TARGET_NOT_READY" : "CAPABILITY_MISSING",
		answer.error?.message ?? (res.status === 503 ? NO_SERVER : `motion fill failed (HTTP ${res.status})`));
	return answer;
}

/** The spec motion.fill fills: spec, or base (a compiled specId, or the installed take's). Exported for the argument test. */
export function fillSource({ spec, base }, specOf, installedSpec) {
	if ((spec === undefined) === (base === undefined)) fail("INVALID_ARGUMENT", "Send exactly one of spec or base (the specId of a compiled spec).");
	const source = spec ?? specOf(base) ?? (specIdOf(installedSpec ?? null) === base ? installedSpec : null)
		?? fail("INVALID_ARGUMENT", `base "${base}" is not known (the editor keeps the last compiled specs this session); send spec`);
	if (!Array.isArray(source.keys) || new Set(source.keys.filter(k => k?.src !== "fill").map(k => k?.f)).size < 2)
		fail("INVALID_ARGUMENT", "motion.fill needs at least 2 authored key poses in spec.keys (keys without src: \"fill\"); a gap is filled between neighbours.");
	return structuredClone(source);
}

export function register(registry, ports) {
	const mounted = () => Boolean(ports.storeDomain?.("motion")) || "The motion owner is not mounted.";
	registry.register({ ...declarations[0], available: mounted, target: args => args.characterId, async run({ characterId, spec, base, at, install = true }, context) {
		const character = characterOf(ports, characterId);
		const source = fillSource({ spec, base }, b => registry.motionSpecOf?.(b), ports.storeDomain("motion")?.motionFor(characterId)?.spec);
		const filled = await requestFill(ports.fetch ?? globalThis.fetch, { spec: source, model: character.model, ...(at === undefined ? {} : { at }) });
		const r = await registry.get("motion.compile").run({ characterId, spec: filled.spec, install }, context);
		const keys = filled.spec.keys.filter(k => k.src === "fill").length;
		return { ...r, summary: `MotionBricks filled ${filled.gaps.length} gap${filled.gaps.length === 1 ? "" : "s"} (${keys} fill keys, ${filled.calls} model calls). ${r.summary}`,
			output: { ...r.output, fill: { gaps: filled.gaps, calls: filled.calls, keys, ms: filled.ms } } };
	} });
}
