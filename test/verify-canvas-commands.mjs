import assert from "node:assert/strict";
import { dispatchLiveFrame } from "../src/live-control.js";
import { createCanvasCommands } from "../src/workflow/canvas-commands.js";
import { DEFAULT_NODE_SCHEMAS } from "../src/workflow/node-schema.js";
import { executeLocalWorkflowGraph } from "../src/workflow/local-workflow.js";

const makeNode = (type, id, position, model) => ({ id, type, position, data: { model: model?.id || `${type}-passthrough` } });
let graph = { version: 1, nodes: [], edges: [] };
const focused = [];
const store = { getGraph: () => graph, setGraph: (next) => { graph = next; }, run: () => { graph = executeLocalWorkflowGraph(graph, { runId: "test" }); return graph; }, focus: (id) => focused.push(id) };
const { handlers, undo, history } = createCanvasCommands({ store, makeNode, nodeSchemas: DEFAULT_NODE_SCHEMAS });
let sequence = 0;
const call = (name, args = {}) => dispatchLiveFrame(JSON.stringify({ type: "cmd", id: String(++sequence), name, args }), handlers);
const ok = async (name, args) => { const result = await call(name, args); assert.equal(result.ok, true, result.error); return result.value; };
const bad = async (name, args, pattern) => { const before = structuredClone(graph); const depth = history.length; const result = await call(name, args); assert.equal(result.ok, false); assert.match(result.error, pattern); assert.deepEqual(graph, before); assert.equal(history.length, depth, "rejections do not add undo entries"); };
const text = await ok("add_node", { type: "text", model: "text-generation", data: { prompt: "hello", temperature: 0.5 }, position: { x: 80, y: 100 } });
assert.equal(text.node.data.model, "text-generation");
const id = text.node.id;
await bad("add_node", { type: "bogus" }, /type/i);
await bad("add_node", { type: "text", model: "image-generation" }, /model/i);
await bad("add_node", { type: "image", position: { x: "bad", y: 0 } }, /position/i);
await bad("update_node", { id, data: { unknown_key: true } }, /Unknown.*key/);
await bad("update_node", { id, data: { image_url: "not a text input" } }, /Unknown.*key/);
await bad("update_node", { id, data: { formValues: { unknown_key: true } } }, /Unknown.*key/);
await ok("update_node", { id, data: { formValues: { temperature: 0.8 } } });
assert.equal(graph.nodes[0].data.temperature, 0.8);
await ok("update_node", { id, data: { prompt: "updated" } });
assert.equal(graph.nodes[0].data.prompt, "updated");
await ok("set_node_output", { id, value: { result: "done" } });
assert.deepEqual(graph.nodes[0].data.outputs, [{ value: { result: "done" } }]);
await ok("focus_node", { id }); assert.deepEqual(focused, [id]);
assert.equal(undo().undone, true); assert.equal(graph.nodes[0].data.outputs, undefined);
const image = await ok("add_node", { type: "image" });
const edge = await ok("connect", { source: id, target: image.node.id });
assert.equal(graph.edges.length, 1);
assert.equal(edge.edge.sourceHandle, "output"); assert.equal(edge.edge.targetHandle, "input");
await bad("connect", { source: "missing", target: id }, /Unknown node/);
await bad("connect", { source: id, target: image.node.id, targetHandle: "missing" }, /handle/i);
await bad("connect", { source: id, target: image.node.id }, /already connected/i);
const depth = history.length;
const run = await ok("run_workflow");
assert.deepEqual(run.outputs[id], [{ value: "updated" }]);
assert.deepEqual(run.outputs[image.node.id], [{ value: "updated" }]);
assert.equal(history.length, depth, "evaluation is derived state, not an authored edit");
const described = await ok("get_graph"); assert.equal(described.nodes[0].model, "text-generation");
assert.deepEqual(described.outputs[id], [{ value: "updated" }]);
assert.equal(undo().undone, true); assert.equal(graph.edges.length, 0);
assert.equal(undo().undone, true); assert.equal(graph.nodes.length, 1, "after run, undo removes edge then node");
const second = await ok("add_node", { type: "image" });
const connection = await ok("connect", { source: id, target: second.node.id });
await ok("disconnect", { edgeId: connection.edge.id }); assert.equal(graph.edges.length, 0); undo();
await ok("remove_node", { id }); assert.equal(graph.nodes.length, 1); assert.equal(graph.edges.length, 0); undo();
assert.equal(graph.nodes.length, 2); assert.equal(graph.edges.length, 1);
await bad("remove_node", { id: "missing" }, /Unknown node/);
await bad("disconnect", { edgeId: "missing" }, /Unknown edge/);
await bad("focus_node", { id: "missing" }, /Unknown node/);
for (let i = 0; i < 60; i++) await ok("update_node", { id, data: { prompt: String(i) } });
assert.equal(history.length, 50, "history is bounded");
while (history.length) undo(); assert.equal(undo().undone, false);
console.log("PASS canvas commands: all nine dispatch handlers, model/schema validation, rejected edits are atomic, output evaluation, focus, bounded undo");

// The live hub sends commands back to back. WorkflowBuilder's store publishes
// the graph through React state, which only reaches graphRef after a render,
// so a store whose getGraph lags one mutation behind must still be usable:
// the command layer has to thread its own latest graph between mutations.
{
	let committed = structuredClone(graph);
	let lagging = committed;
	const lagStore = { getGraph: () => lagging, setGraph: (next) => { lagging = committed; committed = next; }, run: (input) => { lagging = committed; committed = executeLocalWorkflowGraph(input, { runId: "lag" }); return committed; }, focus: () => {} };
	const lagged = createCanvasCommands({ store: lagStore, makeNode, nodeSchemas: DEFAULT_NODE_SCHEMAS });
	const first = lagged.add_node({ type: "text" }).node;
	const second = lagged.add_node({ type: "image" }).node;
	lagged.connect({ source: first.id, target: second.id });
	assert.equal(committed.nodes.filter((node) => [first.id, second.id].includes(node.id)).length, 2, "back-to-back add_node keeps both nodes");
	assert.equal(committed.edges.filter((edge) => edge.source === first.id && edge.target === second.id).length, 1, "connect sees nodes added a moment earlier");
	const ran = await lagged.run_workflow();
	assert.equal(ran.graph.edges.length, committed.edges.length, "run_workflow right after connect keeps the new edge");
	assert.ok(ran.outputs[second.id], "run_workflow evaluates the node added a moment earlier");
	console.log("PASS canvas commands survive a store whose reads lag one render");
}

// Scene nodes expose "render"/"scene" source handles, never "output"; an edge
// with the wrong handle is silently dropped by React Flow, so the command layer
// has to pick the right default and refuse the wrong one.
{
	let g = { version: 1, nodes: [], edges: [] };
	const st = { getGraph: () => g, setGraph: (next) => { g = next; }, run: () => g, focus: () => {} };
	const cmds = createCanvasCommands({ store: st, makeNode, nodeSchemas: DEFAULT_NODE_SCHEMAS });
	const scene = cmds.add_node({ type: "scene" }).node;
	const image = cmds.add_node({ type: "image", model: "image-generation" }).node;
	const edge = cmds.connect({ source: scene.id, target: image.id }).edge;
	assert.equal(edge.sourceHandle, "render", "a Scene source defaults to its render handle");
	assert.throws(() => cmds.connect({ source: scene.id, target: image.id, sourceHandle: "output" }), /Invalid source handle/, "a Scene has no output handle");
	const other = cmds.add_node({ type: "image" }).node;
	assert.equal(cmds.connect({ source: scene.id, target: other.id, sourceHandle: "scene" }).edge.sourceHandle, "scene", "the scene handle is accepted");
	const upload = cmds.add_node({ type: "upload", data: { image_url: "data:image/png;base64,AA==", fileName: "ref.png", mimeType: "image/png", outputs: [{ value: "data:image/png;base64,AA==" }] } }).node;
	assert.equal(upload.data.image_url, "data:image/png;base64,AA==", "an upload node can be created holding an image");
	assert.throws(() => cmds.connect({ source: upload.id, target: image.id, sourceHandle: "render" }), /Invalid source handle/, "non-Scene nodes only have output");
	console.log("PASS canvas commands: Scene source handles and upload node data");
}

// run_workflow republishes the graph the runner returns, node data included,
// so a result the runner attached (a generated image) survives the publish.
{
	let g = { version: 1, nodes: [], edges: [] };
	const st = { getGraph: () => g, setGraph: (next) => { g = next; }, run: async (input) => ({ graph: { ...input, nodes: input.nodes.map((node) => ({ ...node, data: { ...node.data, resultUrl: "data:image/png;base64,AA==", outputs: [{ value: "data:image/png;base64,AA==" }] } })) } }), focus: () => {} };
	const cmds = createCanvasCommands({ store: st, makeNode, nodeSchemas: DEFAULT_NODE_SCHEMAS });
	const image = cmds.add_node({ type: "image", model: "image-generation" }).node;
	await cmds.run_workflow();
	assert.equal(g.nodes.find((node) => node.id === image.id).data.resultUrl, "data:image/png;base64,AA==", "the runner's node data is what gets published");
	console.log("PASS run_workflow publishes the runner's node data");
}

// Issue #216: the agent sometimes pads node data keys with stray whitespace
// ("prompt "). The command layer trims keys before validating and merging,
// keeps strict unknown-key rejection on the trimmed key, and refuses edits
// where trimming would collide two keys into one.
{
	const node = await ok("add_node", { type: "text", model: "text-generation", data: { " prompt ": "created" } });
	const nid = node.node.id;
	const target = () => graph.nodes.find((entry) => entry.id === nid);
	assert.equal(target().data.prompt, "created", "a padded valid key on add_node is stored under its trimmed key");
	assert.ok(!("prompt " in target().data), "the padded key itself is never stored");
	await ok("update_node", { id: nid, data: { " temperature ": 0.9 } });
	assert.equal(target().data.temperature, 0.9, "a padded valid key on update_node is stored under its trimmed key");
	assert.ok(!("temperature " in target().data), "the padded key itself is never stored after update");
	await ok("update_node", { id: nid, data: { formValues: { " temperature ": 0.7 } } });
	assert.equal(target().data.temperature, 0.7, "a padded formValues key is merged into the node data top level");
	assert.equal(target().data.formValues.temperature, 0.7, "a padded formValues key is stored under its trimmed key");
	assert.ok(!("temperature " in target().data) && !("temperature " in target().data.formValues), "padded keys are absent from node data and formValues");
	await bad("update_node", { id: nid, data: { " unknown_key ": true } }, /Unknown.*key/);
	await bad("update_node", { id: nid, data: { formValues: { " unknown_key ": true } } }, /Unknown.*key/);
	await bad("update_node", { id: nid, data: { "   ": true } }, /Unknown.*key/);
	await bad("update_node", { id: nid, data: { prompt: "kept", " prompt ": "collides" } }, /collid|conflict/i);
	assert.equal(target().data.prompt, "created", "a collision rejection leaves the stored prompt untouched");
	await bad("add_node", { type: "text", model: "text-generation", data: { prompt: "a", " prompt ": "b" } }, /collid|conflict/i);
	console.log("PASS canvas commands tolerate padded node data keys: trimmed, rejected when unknown, refused on collision");
}
