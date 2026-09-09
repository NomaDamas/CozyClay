// Count the Studio's simultaneously visible controls per workflow mode and
// screenshot each state. This is the before/after metric behind
// docs/studio-ui-ia.md §1 (R6 mode budget: Scene <=35 / Camera <=38 / Motion <=52).
//
//   QA_URL=http://127.0.0.1:5180/app/ CDP_PORT=9241 OUT=/tmp/studio-count \
//     node tools/qa-browser.mjs -- node tools/qa/studio-control-count.mjs
//
// Writes <OUT>-<state>.png and <OUT>-counts.json. A "control" is a rendered
// button/select/range/checkbox/a.topbar-action with a non-zero box; CSS
// display:none does not count, hover-revealed chevrons do.
const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import("node:fs");

await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
if (process.env.QA_URL) await send("Page.navigate", { url: process.env.QA_URL });
const t0 = Date.now();
while (Date.now() - t0 < 60000) { if (await ev("!!(window.__cozyclay&&window.__cozyclay.rigA&&window.__cozyclay.editorCam)").catch(() => false)) break; await sleep(250); }
await sleep(1500);
// hide the project chooser if present
await ev(`(()=>{for(const el of document.querySelectorAll("body *")){const text=el.textContent||"";const style=getComputedStyle(el);if(style.position==="fixed"&&/Choose a project to begin|Project name|시작할 프로젝트/i.test(text))el.style.display="none";}return true;})()`);

const COUNT = `(()=>{
  const vis=(el)=>{const r=el.getBoundingClientRect();if(r.width<2||r.height<2)return false;const s=getComputedStyle(el);return s.visibility!=="hidden"&&s.display!=="none"&&s.opacity!=="0";};
  const all=[...document.querySelectorAll("button, select, input[type=range], input[type=checkbox], a.topbar-action")].filter(vis);
  const region=(el)=>{
    if(el.closest("header.topbar"))return "topbar";
    if(el.closest(".viewport-titlebar"))return "viewport-bar";
    if(el.closest(".hierarchy-left"))return "hierarchy";
    if(el.closest(".inspector, .panel.right, aside.right, .inspector-panel"))return "inspector";
    if(el.closest(".timeline, .tl-surface, .take-bar, footer"))return "timeline";
    if(el.closest(".asset-pane, .assets"))return "assets";
    return "other:"+(el.closest("aside, section, div[class]")?.className||"").toString().slice(0,30);
  };
  const by={};for(const el of all){const k=region(el);(by[k]??=[]).push((el.getAttribute("aria-label")||el.textContent||el.tagName).trim().replace(/\\s+/g," ").slice(0,24));}
  return {total:all.length,by};
})()`;

const clickTab = async (label) => ev(`(()=>{const b=[...document.querySelectorAll(".workflow-mode-switch button")].find(b=>b.textContent.trim()==="${label}");if(!b)return false;b.click();return true;})()`);
const states = [
  ["scene-none", async () => { await clickTab("Scene"); await ev("window.__cozyclay.selectHierarchy?.(null)").catch(()=>{}); }],
  ["scene-char", async () => { await clickTab("Scene"); await ev(`(()=>{const el=[...document.querySelectorAll('.hierarchy-left [role=treeitem], .hierarchy-left button, .hierarchy-left li')].find(e=>/Alpha|Character|캐릭터|A\\b/.test(e.textContent));el?.click();return !!el;})()`); }],
  ["camera", async () => { await clickTab("Camera"); }],
  ["motion", async () => { await clickTab("Motion"); }],
];
const out = {};
for (const [name, setup] of states) {
  await setup(); await sleep(600);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${process.env.OUT}-${name}.png`, Buffer.from(shot.data, "base64"));
  out[name] = await ev(COUNT);
  console.log(name, out[name].total);
}
fs.writeFileSync(`${process.env.OUT}-counts.json`, JSON.stringify(out, null, 2));
ws.close(); process.exit(0);
