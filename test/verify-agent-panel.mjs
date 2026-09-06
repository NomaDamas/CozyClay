#!/usr/bin/env node
// Source/layout contract for the workflow Agent panel (#126). The panel's
// behaviour is proved in the browser by test/qa-agent-panel-browser.mjs; this
// suite pins the things a refactor can silently break without any test going
// red: where the panel is mounted, the width contract, the no-token rule, and
// the presence of every state the issue enumerates.
import { readFileSync } from "node:fs";

const panel = readFileSync(new URL("../src/workflow/AgentPanel.jsx", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/workflow/agent-client.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/workflow/agent-panel.css", import.meta.url), "utf8");
const builder = readFileSync(new URL("../src/workflow/WorkflowBuilder.jsx", import.meta.url), "utf8");

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

// --- mount point --------------------------------------------------------
expect("WorkflowBuilder imports AgentPanel", builder.includes('import AgentPanel from "./AgentPanel.jsx"'));
expect("AgentPanel renders as a sibling AFTER .workflow-canvas", (() => {
	const canvasClose = builder.indexOf("</section>");
	const mount = builder.indexOf("<AgentPanel");
	const canvasOpen = builder.indexOf('<section className="workflow-canvas">');
	return canvasOpen !== -1 && canvasClose !== -1 && mount > canvasClose;
})(), "AgentPanel must follow the closing </section> of .workflow-canvas");
expect("the panel lives inside .workflow-main", (() => {
	const mainOpen = builder.indexOf('<div className="workflow-main">');
	const mount = builder.indexOf("<AgentPanel");
	return mainOpen !== -1 && mount > mainOpen;
})());
expect("the top bar carries a panel toggle", builder.includes("workflow-agent-toggle") && builder.includes("cozyclay:agent-panel-toggle"));
expect("AgentPanel imports its own stylesheet", panel.includes('import "./agent-panel.css"'));

// --- width contract -----------------------------------------------------
expect("css defines the default width token as 360px", /--agent-width-default:\s*360px/.test(css));
expect("css defines the min width token as 300px", /--agent-width-min:\s*300px/.test(css));
expect("css defines the max width token as 560px", /--agent-width-max:\s*560px/.test(css));
expect("css defines the collapsed rail token as 36px", /--agent-rail-width:\s*36px/.test(css));
expect("the collapsed rail uses the rail token", /\.agent-panel\.collapsed\s*\{[^}]*width:\s*var\(--agent-rail-width\)/.test(css));
expect("below 1100px the panel becomes an overlay drawer", /@media \(max-width:\s*1100px\)/.test(css) && /position:\s*fixed/.test(css));
expect("the panel has a left drag handle", css.includes(".agent-resize") && /\.agent-resize\s*\{[^}]*left:/.test(css) && panel.includes("agent-resize"));
expect("width persists under the agreed localStorage key", client.includes('"cozyclay.workflow.agentPanel.width"'));
expect("stored width is clamped to the min/max contract", client.includes("AGENT_PANEL_WIDTH_MIN") && client.includes("AGENT_PANEL_WIDTH_MAX") && client.includes("clampPanelWidth"));

// --- no token ever reaches the browser ----------------------------------
for (const [name, source] of [["agent-client.js", client], ["AgentPanel.jsx", panel]]) {
	expect(`${name} never handles access_token`, !/access_token/i.test(source));
	expect(`${name} never handles refresh_token`, !/refresh_token/i.test(source));
	expect(`${name} never sets an Authorization header`, !/authorization/i.test(source));
}
expect("the client only reads a session description over loopback", ["/oauth/status", "/oauth/start", "/oauth/logout", "/agent/turn", "/agent/stop", "/agent/models"].every((route) => client.includes(route)));

// --- every state name exists --------------------------------------------
for (const state of ["signed-out", "signing-in", "no-entitlement", "ready", "streaming", "rate-limited", "error"]) {
	expect(`state "${state}" exists in the client`, client.includes(`"${state}"`));
	const rendered = panel.includes(`"${state}"`) || panel.includes(`'${state}'`);
	expect(`state "${state}" is reachable from the panel`, rendered);
}

// --- SSE event types -----------------------------------------------------
for (const type of ["text.delta", "tool.start", "tool.done", "image", "quota", "error", "done"]) {
	expect(`the panel or client handles the "${type}" event`, client.includes(`"${type}"`) || panel.includes(`"${type}"`));
}
for (const code of ["auth", "entitlement", "rate_limit", "upstream"]) {
	expect(`error code "${code}" has copy`, client.includes(code));
}

// --- required controls ---------------------------------------------------
const controls = [
	["header title", 'className="agent-title"'],
	["New session button", "agent-new"],
	["History placeholder", "agent-history"],
	["overflow menu", "agent-overflow-toggle"],
	["Clear context action", "Clear context"],
	["Sign out action", "Sign out"],
	["collapse control", "agent-collapse"],
	["account strip", "agent-account"],
	["plan badge", "agent-plan-badge"],
	["resets-in label", "resets in "],
	["aria-live transcript", 'aria-live="polite"'],
	["user bubble", "agent-bubble"],
	["tool call card", "ToolCallCard"],
	["image result card", "ImageResultCard"],
	["Use in scene", "Use in scene"],
	["Download", "Download"],
	["Regenerate", "Regenerate"],
	["Placed / Undo", "Placed"],
	["lightbox", "agent-lightbox"],
	["attach frame chip", "Attach current frame"],
	["model select", "agent-model-select"],
	["stop control", "agent-stop"],
	["suggestion chips", "SUGGESTION_CHIPS"],
	["paused card", "PausedCard"],
	["Wait & retry", "Wait &amp; retry"],
	["Switch model", "Switch model"],
	["error Retry", ">Retry<"],
	["error Details", ">Details<"],
];
for (const [name, needle] of controls) expect(`composer/transcript exposes the ${name}`, panel.includes(needle), needle);

expect("Enter sends and Shift+Enter inserts a newline", panel.includes('event.key === "Enter" && !event.shiftKey'));
expect("Esc stops a running turn", panel.includes('event.key === "Escape" && streaming'));
expect("Cmd/Ctrl+B toggles the panel", panel.includes("event.metaKey || event.ctrlKey") && panel.includes('=== "b"'));
expect("focus moves to the composer on open", panel.includes("composerRef.current?.focus()"));
expect("the footer hint states the image cost", client.includes("Image generation uses about 3-5x a normal turn") && panel.includes("IMAGE_COST_HINT"));
expect("there is no hover-reveal for the collapsed rail", !/\.agent-panel\.collapsed:hover\s*\{[^}]*width/.test(css));
// (the chip count is asserted from the imported module below)

// --- mock transport ------------------------------------------------------
expect("mock mode is gated on ?agent=mock", client.includes('params.get("agent") !== "mock"'));
expect("mock mode reads ?state=", client.includes('params.get("state")'));
expect("the scripted turn captures then renders", client.includes("capture_blocking_frame") && client.includes("render_from_frame"));
expect("the scripted turn emits an image and a done event", client.includes('type: "image"') && client.includes('type: "done"'));

// --- behaviour of the pure helpers --------------------------------------
const module_ = await import("../src/workflow/agent-client.js");
expect("clampPanelWidth pins the floor", module_.clampPanelWidth(120) === 300);
expect("clampPanelWidth pins the ceiling", module_.clampPanelWidth(9000) === 560);
expect("clampPanelWidth keeps a legal width", module_.clampPanelWidth(412) === 412);
expect("clampPanelWidth falls back to the default", module_.clampPanelWidth("nonsense") === 360);
expect("formatResetIn renders minutes", module_.formatResetIn(1000 + 42 * 60000, 1000) === "42m 00s");
expect("formatResetIn renders hours", module_.formatResetIn(1000 + 95 * 60000, 1000) === "1h 35m");
expect("formatResetIn tolerates a missing reset", module_.formatResetIn(null) === null);
expect("formatResetIn parses an ISO reset", module_.formatResetIn(new Date(60000).toISOString(), 0) === "1m 00s");
expect("toolCallLabel reads as verb + target", module_.toolCallLabel({ name: "capture_blocking_frame" }) === "Capture blocking frame");
expect("toolCallLabel prefers an explicit label", module_.toolCallLabel({ name: "x", label: "Render from frame" }) === "Render from frame");
expect("formatElapsed switches to seconds", module_.formatElapsed(1412) === "1.4s" && module_.formatElapsed(268) === "268ms");
expect("parseSseChunk keeps a partial trailing frame", (() => {
	const parsed = module_.parseSseChunk('data: {"type":"text.delta","text":"hi"}\ndata: {"type":"do');
	return parsed.events.length === 1 && parsed.events[0].text === "hi" && parsed.tail === 'data: {"type":"do';
})());
expect("the empty ready state offers exactly three suggestion chips", module_.SUGGESTION_CHIPS.length === 3 && module_.SUGGESTION_CHIPS.every((chip) => typeof chip === "string" && chip.length > 8));
expect("mockConfigFromSearch stays off without ?agent=mock", module_.mockConfigFromSearch("?state=ready") === null);
expect("mockConfigFromSearch rejects an unknown state", module_.mockConfigFromSearch("?agent=mock&state=bogus").state === "ready");
expect("mockConfigFromSearch carries every listed state", module_.AGENT_STATES.every((state) => module_.mockConfigFromSearch(`?agent=mock&state=${state}`).state === state));

const mock = module_.createMockTransport({ state: "ready", speed: 60 });
const status = await mock.status();
expect("the mock signs in for the ready state", status.signedIn === true && typeof status.email === "string");
expect("the signed-out mock reports no session", (await module_.createMockTransport({ state: "signed-out" }).status()).signedIn === false);
expect("the no-entitlement mock withholds image entitlement", (await module_.createMockTransport({ state: "no-entitlement" }).status()).entitlements.image === false);

const seen = [];
await mock.turn({ sessionId: "s", text: "hi", attachFrame: false }, (event) => seen.push(event));
const types = seen.map((event) => event.type);
expect("the scripted turn streams text first", types[0] === "text.delta");
expect("the scripted turn runs capture then render", (() => {
	const starts = seen.filter((event) => event.type === "tool.start").map((event) => event.name);
	return starts[0] === "capture_blocking_frame" && starts[1] === "render_from_frame";
})(), types.join(","));
expect("every tool.start is answered by a tool.done", seen.filter((event) => event.type === "tool.start").length === seen.filter((event) => event.type === "tool.done").length);
expect("the scripted turn ends with an image, a quota and done", types.includes("image") && types.includes("quota") && types.at(-1) === "done");

const limited = [];
await module_.createMockTransport({ state: "rate-limited" }).turn({}, (event) => limited.push(event));
expect("the rate-limited mock emits a rate_limit error with a reset", limited.some((event) => event.type === "error" && event.code === "rate_limit" && event.resetAt));
const failed = [];
await module_.createMockTransport({ state: "error" }).turn({}, (event) => failed.push(event));
expect("the error mock fails a tool call", failed.some((event) => event.type === "tool.done" && event.ok === false));

if (failures) {
	console.error(`${failures} FAILURES`);
	process.exitCode = 1;
} else {
	console.log("all agent panel checks PASS");
}
