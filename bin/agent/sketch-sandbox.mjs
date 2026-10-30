// The dry run behind the live sketch (sculpt-sketch.mjs): a cut of the script the model is still writing
// (sketch-code.mjs) runs in its own throwaway QuickJS sandbox (pi-codemode, like the real `script` tool) with a
// short deadline and a small heap. Every `tools.*` call there is a stub that changes nothing and answers a benign
// fake result; object.sculpt and scene-creation calls are only recorded. The model's code is the same code that
// runs for real moments later, with the real tools; here it can only fill arrays and report the parts it wrote.

const TIMEOUT_MS = 250;
const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
/** Parts one sketch carries back, whatever the script built. */
export const SKETCH_MAX_PARTS = 300;

/**
 * Runs INSIDE the sandbox, ahead of the model's code, so it takes everything as arguments. The sandbox freezes the
 * built-ins, so nothing is patched: the stub tools record each object.sculpt call (its parts array, name and
 * placement), and the finally block shows see() every name the cut declared. dump() returns the arrays that hold
 * parts (objects with a known shape and a size) as groups: object.sculpt calls first (they carry name and
 * placement), then the named arrays in source order, each part in the first group that holds it.
 */
function sandboxPrelude(shapes, fields, maxParts) {
	const SHAPES = new Set(shapes), tracked = [], calls = [], sceneCalls = [];
	const isPart = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && SHAPES.has(value.shape) && value.size !== null && typeof value.size === "object";
	const track = (list) => {
		if (!Array.isArray(list) || tracked.includes(list)) return false;
		for (let index = 0; index < list.length && index < 4096; index += 1) if (isPart(list[index])) { tracked.push(list); return true; }
		return false;
	};
	const fake = () => ({ ok: true, status: "completed", receiptId: "sketch", revision: 0, affectedIds: [], delta: [], warnings: [], summary: "", id: "sketch", ids: [] });
	const call = (name, args) => {
		const inner = args && typeof args === "object" ? args.args : null;
		const payload = name === "run_action" ? inner : args;
		if (name === "run_action" && inner && args.action === "object.sculpt" && inner.recipe && Array.isArray(inner.recipe.parts)) {
			calls.push({ parts: inner.recipe.parts, name: inner.name, id: inner.id, placement: inner.placement });
		}
		// Scene previews use the same dry run, but these calls only record intent.
		// They never resolve ids, mutate a document or reach the real editor.
		const arrangement = name === "arrange_objects" || name === "arrange_characters" ? name
			: name === "run_action" && (args.action === "objects.arrange" || args.action === "characters.arrange") ? args.action : null;
		if (arrangement && Array.isArray(payload?.ops)) sceneCalls.push({ kind: arrangement.includes("character") ? "characters" : "objects", ops: payload.ops });
		if (name === "run_action" && inner && args.action === "object.add") sceneCalls.push({ kind: "objects", add: inner });
		if (name === "run_action" && inner && args.action === "character.add") sceneCalls.push({ kind: "characters", add: inner.character });
		if (name === "run_action" && args.action === "objects.batch" && inner?.atomic === true) sceneCalls.push({ kind: "objects", atomic: true });
		else if (name === "run_action" && args.action === "objects.batch" && Array.isArray(inner?.ops)) for (const op of inner.ops) {
			if (op?.name === "object.add" || op?.name === "place_object") sceneCalls.push({ kind: "objects", add: op.args });
			else if (op?.name === "objects.arrange" && Array.isArray(op.args?.ops)) sceneCalls.push({ kind: "objects", ops: op.args.ops });
		}
		return Promise.resolve(fake());
	};
	const tools = new Proxy({}, { get: (_target, name) => (typeof name === "string" ? (args) => call(name, args) : undefined) });
	// A named value: an array of parts, a recipe ({ parts }), or one level of either inside an object or array.
	const see = (value) => {
		if (value === null || typeof value !== "object" || track(value)) return;
		if (Array.isArray(value.parts)) track(value.parts);
		const entries = Array.isArray(value) ? value.slice(0, 64) : Object.keys(value).slice(0, 64).map((key) => value[key]);
		for (const entry of entries) {
			if (Array.isArray(entry)) track(entry);
			else if (entry && typeof entry === "object" && Array.isArray(entry.parts)) track(entry.parts);
		}
	};
	const pick = (part) => {
		const out = {};
		for (const key of fields) {
			const value = part[key];
			if (value !== undefined && typeof value !== "function") out[key] = Array.isArray(value) && value.length > 256 ? value.slice(0, 256) : value;
		}
		if (part.op !== undefined && part.op !== null) out.op = true;
		return out;
	};
	const dump = () => {
		const claimed = new Set(), groups = [];
		const take = (list) => {
			const out = [];
			for (let index = 0; index < list.length && claimed.size < maxParts; index += 1) {
				const part = list[index];
				if (isPart(part) && !claimed.has(part)) { claimed.add(part); out.push(pick(part)); }
			}
			return out;
		};
		calls.forEach((entry, index) => {
			const at = tracked.indexOf(entry.parts);
			groups.push({ key: at >= 0 ? `a${at}` : `c${index}`, name: entry.name, id: entry.id, placement: entry.placement, parts: take(entry.parts) });
		});
		tracked.forEach((list, index) => groups.push({ key: `a${index}`, parts: take(list) }));
		return { groups: groups.filter((group) => group.parts.length > 0), scene: sceneCalls };
	};
	return { tools, see, dump };
}

/** What runs in the sandbox: the prelude, the cut inside a try, and a finally that shows the prelude every declared name and always reports. */
function sandboxSource(source, names, shapes, keys) {
	const fields = ["id", "shape", "size", "position", "rotation", "color", "parent", "mirror", ...keys];
	const seen = names.map((name) => `try { __cozySketch.see(${name}); } catch {}`).join(" ");
	return [
		`const __cozySketch = (${sandboxPrelude})(${JSON.stringify(shapes)}, ${JSON.stringify(fields)}, ${SKETCH_MAX_PARTS});`,
		"tools = __cozySketch.tools;",
		`try {\n${source}\n} finally { ${seen} return __cozySketch.dump(); }`,
	].join("\n");
}

/**
 * dryRunSketch(source, names, { shapes, keys }) -> { groups, scene } | null. `source` is a compiled cut (runnablePrefix),
 * `names` its declared names (declaredNames), `shapes`/`keys` the sculpt shapes and their shape-only keys. Null when
 * the run failed (deadline, heap, a parse error the compile check missed): the caller keeps its last sketch.
 */
export async function dryRunSketch(source, names, { shapes, keys, timeoutMs = TIMEOUT_MS } = {}) {
	const { CodemodeSandbox } = await import("@earendil-works/pi-codemode");
	const sandbox = new CodemodeSandbox({ timeoutMs, memoryLimitBytes: MEMORY_LIMIT_BYTES, tools: [] });
	try {
		const result = await sandbox.execute(sandboxSource(source, names, shapes, keys));
		return result.ok && Array.isArray(result.value?.groups) ? result.value : null;
	} catch {
		return null;
	} finally {
		await sandbox.close();
	}
}
