// Browser QA: a mocap take with bone_scale must change the RIG's actual limb
// lengths (world-space bone distances) relative to the same take without it.
// Driven through tools/qa-browser.mjs with QA_URL=…/app/?motion=/demo/qa-prop.npz
// then QA_URL=…/app/?motion=/demo/qa-canon.npz; each run prints the measured
// lengths, and the comparison is done by the caller.
const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { id += 1; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
	const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate failed");
	return r.result?.value;
};
const waitFor = async (expr, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr).catch(() => false)) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
if (!(await waitFor("!!(window.__cozyclay && window.__cozyclay.motion && window.__cozyclay.rigA)"))) throw new Error("motion/rig never became ready");
const out = await evaluate(`(() => {
	const { rigA, motion, scrub } = window.__cozyclay;
	scrub(10);
	return new Promise((resolve) => setTimeout(() => {
		rigA.updateMatrixWorld(true);
		const find = (n) => { let f = null; rigA.traverse((o) => { if (!f && o.isBone && o.name.toLowerCase().replace(/[^a-z0-9]/g, "").endsWith(n.toLowerCase())) f = o; }); return f; };
		const W = (n) => { const b = find(n); const v = b.getWorldPosition(new b.position.constructor()); return [v.x, v.y, v.z]; };
		const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
		const P = (a, b) => +(d(W(a), W(b)) * 100).toFixed(1);
		resolve({ boneScale: motion.boneScale ? Array.from(motion.boneScale).map((v) => +v.toFixed(2)) : null,
			thigh: P("LeftUpLeg", "LeftLeg"), shin: P("LeftLeg", "LeftFoot"), upperArm: P("LeftArm", "LeftForeArm"), forearm: P("LeftForeArm", "LeftHand"), spine: P("Hips", "Spine2"), hipsY: +(W("Hips")[1] * 100).toFixed(1) });
	}, 300));
})()`);
console.log(JSON.stringify(out));
ws.close();
process.exit(0);
