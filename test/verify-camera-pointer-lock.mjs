#!/usr/bin/env node
// Viewport camera gestures lock the pointer for the hold so the system
// cursor stays at the press. Source contract: the behaviour is proved by
// flying the real studio; this suite pins the lock/unlock wiring a refactor
// can drop without any test going red.
import { readFileSync } from "node:fs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const controls = readFileSync(new URL("../src/controls.jsx", import.meta.url), "utf8");
const landing = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const manifest = readFileSync(new URL("../tools/run-tests.mjs", import.meta.url), "utf8");
const sliceBetween = (source, start, end) => {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	return from >= 0 && to > from ? source.slice(from, to) : "";
};

expect("fly, pan and orbit all request pointer lock", controls.includes("requestPointerLock") && /button === 2 \? "fly"/.test(controls) && controls.includes('"pan"') && controls.includes('"orbit"'));
expect("lock is requested from the pointerdown user activation", /onPointerDown[\s\S]*requestNavLock\(\)/.test(controls));
expect("a second attempt can retry on pointermove", /onPointerMove[\s\S]*requestNavLock\(\)/.test(controls));
expect("touch and pen keep capture and do not request lock", controls.includes('e.pointerType !== "touch"') && controls.includes('e.pointerType !== "pen"'));
expect("locked look uses movementX/movementY", controls.includes("e.movementX ?? 0") && controls.includes("e.movementY ?? 0"));
expect("unlocked look still uses clientX/clientY", controls.includes("e.clientX - active.x") && controls.includes("e.clientY - active.y"));
expect("release exits pointer lock", controls.includes("document.exitPointerLock()"));
expect("the gesture is cleared before exitPointerLock", /gesture\.current = null;[\s\S]*?releaseNavLock\(\)/.test(controls));
expect(
	"lostpointercapture does not end a camera gesture while lock is pending or active",
	controls.includes('addEventListener("lostpointercapture", onLostCapture)') &&
	controls.includes("if (gesture.current && (lockPending || isLocked())) return;"),
);
expect("unexpected unlock (Esc) ends the live gesture", /onPointerLockChange[\s\S]*if \(gesture\.current\) \{[\s\S]*endGesture\(\)/.test(controls));
expect("cleanup releases pointer lock", /return \(\) => \{[\s\S]*releaseNavLock\(\)/.test(controls));

const escapeFn = sliceBetween(controls, "const onEscapeCapture", "const endGesture");
expect("Esc during lock is a capture-phase stopPropagation", escapeFn.includes("e.stopPropagation()"));
expect(
	"Esc during lock does not preventDefault (that can keep the pointer locked)",
	escapeFn.includes("if (isLocked() || lockPending || gesture.current || performance.now() < suppressEscapeUntil) e.stopPropagation()") &&
	!escapeFn.includes("preventDefault"),
);
expect("the capture listener is registered in the capture phase", controls.includes('addEventListener("keydown", onEscapeCapture, true)'));
expect("the playground iframe allows pointer-lock", landing.includes('frame.allow = "fullscreen; pointer-lock"'));
expect("pointerup on window still ends the gesture if capture was lost", controls.includes('window.addEventListener("pointerup", endGesture)'));
expect("a pointerup for a different button does not end the hold", controls.includes('e?.type === "pointerup" && e.button !== active.button'));
expect("this suite is in the node manifest", manifest.includes('"test/verify-camera-pointer-lock.mjs"'));
expect("the browser QA is registered", manifest.includes('"test/qa-camera-pointer-lock-browser.mjs"'));

if (failures > 0) {
	console.error(`${failures} FAILURES`);
	process.exit(1);
}
console.log("verify-camera-pointer-lock: all checks passed");
