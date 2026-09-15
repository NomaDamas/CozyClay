import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bucketCount, bucketMs, sanitizeProps } from "../src/analytics.js";
import { startWorkflowExecution } from "../src/execution-telemetry.js";
import { executeLocalWorkflowGraph } from "../src/workflow/local-workflow.js";
import { normalizeWorkflowGraph } from "../src/project.js";
import { pinnedInputs } from "../src/workflow/image-versions.js";

// Exercise the shipped React callback with real graph evaluation. Only the
// React setters and capture/model boundaries are replaced with small fakes.
const source = readFileSync(new URL("../src/workflow/WorkflowBuilder.jsx", import.meta.url), "utf8");
const start = source.indexOf("const runWorkflow = useCallback(") + "const runWorkflow = useCallback(".length;
const end = source.indexOf("\n\t}, [graph, setNodes]);", start) + "\n\t}".length;
assert.ok(start > 0 && end > start);
const callback = source.slice(start, end);
const graph = {
	version: 1,
	nodes: [{ id: "image-private", type: "image", position: { x: 0, y: 0 }, data: { model: "image-generation", prompt: "private prompt" } }],
	edges: [],
};
function fixture(input = graph, capture = async () => ({ dataUrl: "data:image/png;base64,AA==" })) {
	const events = [];
	const context = {
		graph: input, bucketCount, bucketMs, pinnedInputs,
		track(event, props) { events.push({ event, props: sanitizeProps(event, props) }); },
		startWorkflowExecution, executeLocalWorkflowGraph,
		setRunState() {}, setNodes() {}, updateNode() {},
		toast: { success() {} },
		captureSceneFrame: capture,
		serializableGraph: (nodes, edges) => normalizeWorkflowGraph({ nodes, edges }),
	};
	const run = new Function(...Object.keys(context), `return (${callback});`)(...Object.values(context));
	return { events, run };
}

// Given a generation node without inputs, When the actual run evaluates it,
// Then the requested run fails rather than calling the model or claiming output.
const missing = fixture();
const missingResult = await missing.run();
assert.equal(missingResult.graph.nodes[0].data.status, "error");
assert.deepEqual(missing.events.map(({ event }) => event), ["workflow:run_requested", "workflow:run_failed"]);

// Given overlapping frame captures, When a second run starts,
// Then both executions keep their outcomes; merely restarting is not an abort.
const release = Promise.withResolvers();
const sceneGraph = { ...graph, nodes: [{ ...graph.nodes[0], type: "scene", data: {} }] };
let captures = 0;
const overlapping = fixture(sceneGraph, async () => {
	captures += 1;
	if (captures === 1) await release.promise;
	return { dataUrl: "data:image/png;base64,AA==" };
});
const first = overlapping.run();
await overlapping.run();
release.resolve();
const firstResult = await first;
assert.equal(overlapping.events.filter(({ event }) => event === "workflow:run_cancelled").length, 0);
assert.equal(overlapping.events.filter(({ event }) => event === "workflow:run_succeeded").length, 2);
assert.equal(overlapping.events.filter(({ event }) => event === "workflow:result_applied").length, 2);
for (const { props } of overlapping.events) {
	assert.ok(!JSON.stringify(firstResult).includes(props.run_id), "telemetry ID must not persist in graph history");
}

// Given a rejected capture, When the run settles, Then failure cannot claim apply.
const rejected = fixture(sceneGraph, async () => { throw new Error("private capture failure"); });
await rejected.run();
assert.deepEqual(rejected.events.map(({ event }) => event), ["workflow:run_requested", "workflow:run_failed"]);
assert.equal(rejected.events.at(-1).props.failure_code, "capture_failed");

// Given a real AbortError, When capture fails, Then cancellation wins over the
// fallback failure classification and remains a single terminal event.
const aborted = fixture(sceneGraph, async () => { throw new DOMException("private", "AbortError"); });
await aborted.run();
assert.equal(aborted.events.at(-1).event, "workflow:run_cancelled");
assert.equal(aborted.events.at(-1).props.failure_code, "aborted");
const partial = fixture({ ...graph, nodes: [{ ...sceneGraph.nodes[0], id: "capture" }, graph.nodes[0]] });
await partial.run();
assert.deepEqual(partial.events.map(({ event }) => event), ["workflow:run_requested", "workflow:result_applied", "workflow:run_failed"], "partial output and failed run are independent");
const empty = fixture({ ...graph, nodes: [] });
await empty.run();
assert.deepEqual(empty.events.map(({ event }) => event), ["workflow:run_requested", "workflow:run_succeeded"]);
assert.equal(empty.events[0].props.node_count_bucket, "0");

const sceneStart = source.indexOf("const runScene = useCallback(") + "const runScene = useCallback(".length;
const sceneEnd = source.indexOf("\n\t}, [updateScene]);", sceneStart) + "\n\t}".length;
assert.ok(sceneStart > 0 && sceneEnd > sceneStart);
const singleEvents = [], updates = [];
const sceneContext = {
	startWorkflowExecution, bucketMs,
	track: (event, props) => singleEvents.push({ event, props }),
	updateScene: (update) => updates.push(update),
	captureSceneFrame: async () => ({ dataUrl: "data:image/png;base64,AA==" }),
	toast: { success() {} },
};
const runScene = new Function(...Object.keys(sceneContext), `return (${source.slice(sceneStart, sceneEnd)});`)(...Object.values(sceneContext));
await runScene({ id: "capture", data: {} });
assert.deepEqual(singleEvents.map(({ event }) => event), ["workflow:run_requested", "workflow:result_applied", "workflow:run_succeeded"]);
assert.equal(updates.at(-1).patch.resultUrl, "data:image/png;base64,AA==");
console.log("PASS actual Workflow run: failure, concurrent retry, output, cancellation and nonpersistent IDs");
