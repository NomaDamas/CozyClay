// Validated incremental scene creation: a streamed script is dry-run by sculpt-sketch.mjs,
// then each newly discovered create op runs ONCE through the real Studio tools. The final
// script replays only commands that have not run yet, so early visibility never duplicates objects.

const canonical = value => {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
	return value;
};
const signature = value => JSON.stringify(canonical(value));
const isCreate = op => op?.op === "create";

/** Flatten the scene records emitted by the sketch dry run into real creation commands. */
function creations(scene) {
	const out = [];
	for (const entry of Array.isArray(scene) ? scene : []) {
		if (entry.op && typeof entry.op === "object" && isCreate(entry.op)) out.push(entry); // already flattened by directCreations()
		else if (entry.add) out.push({ kind: entry.kind, add: entry.add });
		for (const op of Array.isArray(entry.ops) ? entry.ops : []) if (isCreate(op)) out.push({ kind: entry.kind, op });
	}
	return out;
}

/** The creation part of a direct tool call. Other actions stay for the final script. */
function directCreations(name, args) {
	if (name === "arrange_objects" || name === "arrange_characters") return creations([{ kind: name === "arrange_characters" ? "characters" : "objects", ops: args?.ops }]);
	if (name !== "run_action") return null;
	if (args?.action === "object.add") return creations([{ kind: "objects", add: args.args }]);
	if (args?.action === "character.add") return creations([{ kind: "characters", add: args.args?.character }]);
	if (args?.action === "objects.arrange" || args?.action === "characters.arrange") return creations([{ kind: args.action === "characters.arrange" ? "characters" : "objects", ops: args.args?.ops }]);
	if (args?.action === "objects.batch") {
		if (args.args?.atomic === true) return null;
		const scene = [];
		for (const op of Array.isArray(args.args?.ops) ? args.args.ops : []) {
			if (op?.name === "object.add" || op?.name === "place_object") scene.push({ kind: "objects", add: op.args });
			else if (op?.name === "objects.arrange") scene.push({ kind: "objects", ops: op.args?.ops });
		}
		return creations(scene);
	}
	return null;
}

/** Direct-call args with already-run creates removed. Null when everything ran early. */
function remainingArgs(name, args, executed) {
	if (name === "arrange_objects" || name === "arrange_characters") {
		const ops = (args?.ops ?? []).filter(op => !isCreate(op) || !executed.has(signature({ kind: name === "arrange_characters" ? "characters" : "objects", op })));
		return ops.length ? { ...args, ops } : null;
	}
	if (name !== "run_action") return args;
	if (["object.add", "character.add"].includes(args?.action)) return null;
	if (["objects.arrange", "characters.arrange"].includes(args?.action)) {
		const kind = args.action === "characters.arrange" ? "characters" : "objects";
		const ops = (args.args?.ops ?? []).filter(op => !isCreate(op) || !executed.has(signature({ kind, op })));
		return ops.length ? { ...args, args: { ...args.args, ops } } : null;
	}
	if (args?.action === "objects.batch") {
		const ops = [];
		for (const op of args.args?.ops ?? []) {
			if (op?.name === "object.add" || op?.name === "place_object") continue;
			if (op?.name === "objects.arrange") {
				const rest = (op.args?.ops ?? []).filter(part => !isCreate(part) || !executed.has(signature({ kind: "objects", op: part })));
				if (rest.length) ops.push({ ...op, args: { ...op.args, ops: rest } });
			} else ops.push(op);
		}
		return ops.length ? { ...args, args: { ...args.args, ops } } : null;
	}
	return args;
}

function aggregate(receipts) {
	if (!receipts.length) return null;
	const first = receipts[0], last = receipts.at(-1);
	return { ...last,
		affectedIds: [...new Set(receipts.flatMap(receipt => receipt?.affectedIds ?? []))],
		revision: { before: first?.revision?.before ?? last?.revision?.before, after: last?.revision?.after },
		warnings: receipts.flatMap(receipt => receipt?.warnings ?? []).slice(0, 12),
	};
}

/**
 * createIncrementalScene({ tools, signal }) -> { onScene, wrap }.
 * onScene is fed by createReasoningFrames. wrap(tools) returns the same tools with
 * creation calls deduplicated against what onScene already executed.
 */
export function createIncrementalScene({ tools, signal } = {}) {
	const original = new Map(tools.map(tool => [tool.name, tool]));
	const states = new Map(), named = new Map();
	let queue = Promise.resolve();
	const stateOf = callId => {
		if (!states.has(callId)) states.set(callId, { receipts: new Map(), inflight: new Map(), reserved: new Set(), failed: new Set(), executed: new Set(), createdNames: new Map(), streamed: 0, occurrences: new Map() });
		return states.get(callId);
	};
	const invoke = (toolName, args, call = {}) => original.get(toolName).handler(args, call);
	const reset = () => { states.clear(); named.clear(); };
	function invalidates(name, args) {
		if (name === "patch_elements" || name === "undo_edit") return true;
		if (name === "arrange_objects" || name === "arrange_characters") return (args?.ops ?? []).some(op => op.op !== "create");
		if (name !== "run_action") return false;
		if (args?.action === "objects.batch") return (args.args?.ops ?? []).some(op => !["object.add", "place_object", "objects.arrange"].includes(op.name) || op.args?.ops?.some(part => part.op !== "create"));
		return /^(object|character|edit|agent\.turn|task)\./.test(args?.action ?? "");
	}

	function runEntries(callId, scene, call, final, start = 0) {
		const state = stateOf(callId), counts = final ? new Map() : state.occurrences, jobs = [], previous = queue;
		for (const entry of creations(scene).slice(start)) {
			const id = signature(entry), occurrence = counts.get(id) ?? 0;
			counts.set(id, occurrence + 1);
			const key = `${id}#${occurrence}`;
			state.executed.add(id);
			const name = entry.add?.name ?? entry.add?.subject ?? entry.op?.name;
			const normalizedName = typeof name === "string" ? name.normalize("NFC").trim() : "";
			const namedKey = normalizedName ? `${entry.kind}:${normalizedName}` : null;
			if (namedKey && named.has(namedKey)) {
				jobs.push(async () => {
					const receipt = await named.get(namedKey);
					state.receipts.set(key, receipt);
					if (receipt?.affectedIds?.[0]) state.createdNames.set(normalizedName, receipt.affectedIds[0]);
					return receipt;
				});
				continue;
			}
			const retry = final && state.failed.has(key);
			if (state.receipts.has(key) || state.inflight.has(key) || (state.reserved.has(key) && !retry) || (!final && state.failed.has(key))) {
				jobs.push(() => state.receipts.get(key) ?? state.inflight.get(key) ?? previous.then(() => state.receipts.get(key)));
				continue;
			}
			state.reserved.add(key);
			let settleNamed;
			const namedResult = namedKey ? new Promise(resolve => { settleNamed = resolve; }) : null;
			if (namedKey) named.set(namedKey, namedResult);
			jobs.push(async () => {
				const action = entry.add ? "object.add" : "objects.arrange";
				const characterAction = entry.add ? "character.add" : "characters.arrange";
				const toolName = entry.kind === "characters" ? characterAction : action;
				// arrange() resolves a named parent only inside one batch. Incremental
				// creation splits that batch, so carry the created name → real id forward.
				const withParent = value => {
					const parent = value?.parent;
					if (typeof parent !== "string") return value;
					const id = state.createdNames.get(parent.normalize("NFC").trim());
					return id ? { ...value, parent: id } : value;
				};
				const args = entry.add ? withParent(entry.add) : { ops: [withParent(entry.op)] };
				try {
					// All creation commands use run_action; a direct arrange alias is normalized below.
					const pending = invoke("run_action", { action: toolName, args }, call);
					state.inflight.set(key, pending);
					const receipt = await pending;
					state.receipts.set(key, receipt);
					if (normalizedName && receipt?.affectedIds?.[0]) state.createdNames.set(normalizedName, receipt.affectedIds[0]);
					settleNamed?.(receipt);
					return receipt;
				} catch (error) {
					state.failed.add(key);
					if (namedKey && named.get(namedKey) === namedResult) named.delete(namedKey);
					settleNamed?.(null);
					if (final) throw error;
					return null;
				} finally {
					state.inflight.delete(key);
				}
			});
		}
		return jobs;
	}

	function schedule(callId, scene, call = {}, final = false, start = 0) {
		const jobs = runEntries(callId, scene, call, final, start);
		const receipts = [];
		queue = queue.then(async () => {
			for (const job of jobs) receipts.push(await job());
			return receipts;
		});
		const done = queue;
		return { receipts: () => done, state: stateOf(callId) };
	}

	return {
		settled() { return queue; },
		onScene({ scene, callId, index }) {
			if (signal?.aborted || !scene?.length) return;
			// Some providers name the tool call only at toolcall_end. Fold the
			// provisional index-keyed execution into that late id instead of replaying it.
			const provisional = `#${index}`;
			if (callId && callId !== provisional && states.has(provisional)) {
				const before = states.get(provisional), after = stateOf(callId);
				for (const [key, receipt] of before.receipts) after.receipts.set(key, receipt);
				for (const [key, pending] of before.inflight) after.inflight.set(key, pending);
				for (const key of before.reserved) after.reserved.add(key);
				for (const key of before.failed) after.failed.add(key);
				for (const id of before.executed) after.executed.add(id);
				for (const [name, id] of before.createdNames) after.createdNames.set(name, id);
				for (const [id, count] of before.occurrences) after.occurrences.set(id, count);
			after.streamed = Math.max(after.streamed, before.streamed);
			states.delete(provisional);
			}
			const state = stateOf(callId ?? provisional), count = creations(scene).length;
			schedule(callId ?? provisional, scene, { signal, callId }, false, state.streamed);
			state.streamed = count;
		},
		wrap(tool) {
			return { ...tool,
				handler: async (args, call = {}) => {
					const scene = directCreations(tool.name, args);
					if (!scene) {
						const result = await invoke(tool.name, args, call);
						if (invalidates(tool.name, args)) reset();
						return result;
					}
					const callId = call.callId ?? call.toolCallId ?? `#direct:${tool.name}`;
					const { receipts, state } = schedule(callId, scene, call, true);
					const pending = remainingArgs(tool.name, args, state.executed);
					let rest;
					if (pending) {
						// Preserve order: creations settle before the remaining update/remove/group ops.
						const run = queue.then(() => invoke(tool.name, pending, call));
						queue = run.then(() => undefined, () => undefined);
						rest = await run;
					}
					const own = await receipts();
					const result = rest ?? aggregate(own.filter(Boolean)) ?? invoke(tool.name, args, call);
					if (pending && invalidates(tool.name, args)) reset();
					return result;
				} };
		},
	};
}
