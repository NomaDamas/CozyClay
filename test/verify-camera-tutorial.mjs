#!/usr/bin/env node
// Source contract for the Studio's camera tutorial (#206). The behaviour is
// proved against the real studio by test/qa-camera-tutorial-browser.mjs (real
// CDP input, one step at a time); this suite pins what a refactor can break
// without any test going red: the step table, the signals it listens to, the
// single mount site and its guard, and the Settings entry point.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createFirstShotHandoff } from "../src/first-shot-handoff.js";

const tutorial = readFileSync(new URL("../src/camera-tutorial.jsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/settings-menu.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const manifest = readFileSync(new URL("../tools/run-tests.mjs", import.meta.url), "utf8");
const landing = readFileSync(new URL("../index.html", import.meta.url), "utf8");

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

/* ------------------------------------------------------- the step table -- */

const table = tutorial.slice(tutorial.indexOf("export const CAMERA_TUTORIAL_STEPS"), tutorial.indexOf("const NAV_KINDS"));
expect("the module exports the step table", table.startsWith("export const CAMERA_TUTORIAL_STEPS"));
const kinds = [...table.matchAll(/\bkind: "([a-z]+)"/g)].map((match) => match[1]);
expect(
	"the seven steps are the landing page's, in order",
	JSON.stringify(kinds) === '["fly","walk","dolly","orbit","shot","rail","play"]',
	JSON.stringify(kinds),
);
expect("every step carries a label and a how()", table.match(/\blabel: /g)?.length === 7 && table.match(/\bhow: /g)?.length === 7);
expect("every step's copy goes through ko()", table.match(/\bko\(/g)?.length >= 7);

// The walk rule is the landing page's: six keys, each pressed once, and only
// then is the step done. Both surfaces must agree on the key set.
expect("the walk keys are w a s d q e", /export const WALK_KEYS = \["w", "a", "s", "d", "q", "e"\]/.test(tutorial));
expect("the landing page teaches the same six keys", /const WALK_KEYS = \["w", "a", "s", "d", "q", "e"\]/.test(landing));
expect(
	"walk only completes once every key has been pressed",
	tutorial.includes('WALK_KEYS.every((walkKey) => next.has(walkKey))') && tutorial.includes('complete("walk")'),
);

/* ------------------------------------------------------- the signals ----- */

expect("it listens to the navigation events the controls already emit", tutorial.includes('window.addEventListener("cozyclay:nav", onNav)'));
expect("it listens to the shot/rail signals the studio already emits", tutorial.includes('window.addEventListener("cozyclay:playground-signal", onSignal)'));
expect("both listeners are removed on unmount", tutorial.includes('removeEventListener("cozyclay:nav", onNav)') && tutorial.includes('removeEventListener("cozyclay:playground-signal", onSignal)'));
expect("nav kinds are fly/walk/dolly/orbit", tutorial.includes('const NAV_KINDS = new Set(["fly", "walk", "dolly", "orbit"])'));
expect("signal kinds are shot/rail", tutorial.includes('const SIGNAL_KINDS = new Set(["shot", "rail"])'));
expect(
	"the play step needs the rail first, then the player",
	/if \(!previewing\) return;[\s\S]*?current\.has\("rail"\)[\s\S]*?add\("play"\)/.test(tutorial),
);
expect("the component never drives the studio back", !/dispatchEvent/.test(tutorial));

/* ------------------------------------------------------- the surface ----- */

for (const [name, needle] of [
	["the root", 'data-testid="camera-tutorial"'],
	["each step chip", 'data-testid="camera-tutorial-step"'],
	["the hint card", 'data-testid="camera-tutorial-card"'],
	["the close button", 'data-testid="camera-tutorial-close"'],
]) expect(`${name} is addressable`, tutorial.includes(needle), needle);
expect("chips publish kind/done/current", /data-kind=\{step\.kind\}[\s\S]*?data-done=\{done\.has\(step\.kind\) \? 1 : 0\}[\s\S]*?data-current=\{step === current \? 1 : 0\}/.test(tutorial));
expect("the walk chips publish their own done state", tutorial.includes("data-done={walked.has(key) ? 1 : 0}"));
expect("the Done state is readable off the root", tutorial.includes('data-state={complete ? "done" : "active"}'));
expect("the close button is labelled in both locales", tutorial.includes('ko("Close tutorial", "튜토리얼 닫기")'));

/* --------------------------------------------------------- the wiring ---- */

expect("App imports the component", app.includes('import { CameraTutorial } from "./camera-tutorial.jsx"'));
expect(
	"the query string requests it, and never inside an embed",
	/const \[cameraTutorialQuery\] = useState\(\(\) => !embedMode && !playgroundMode[\s\S]*?get\("tutorial"\) === "camera"[\s\S]*?!cameraTutorialSuppressed\(\)/.test(app),
);
expect("Settings can open it through a window event", app.includes('window.addEventListener("cozyclay:camera-tutorial", onTutorial)'));
expect("the same event still closes it", /event\.detail\?\.open === false\)? \{\s*setCameraTutorial\(false\)/.test(app));
expect("the listener is removed on unmount", app.includes('removeEventListener("cozyclay:camera-tutorial", onTutorial)'));
expect("opening it is tracked once, under a declared feature name", app.includes('trackFeature("camera_tutorial")'));
expect(
	"the analytics contract knows the name",
	readFileSync(new URL("../src/analytics.js", import.meta.url), "utf8").includes('"camera_tutorial"'),
);
expect("there is exactly one mount site", (app.match(/<CameraTutorial/g) ?? []).length === 1);
expect(
	"it is mounted only while the tutorial is on and outside embeds",
	/\{cameraTutorial && !embedMode && \(\s*<CameraTutorial\s+key=\{cameraTutorialAttempt\}\s+analytics=\{cameraTutorialAnalytics\.current\}\s+previewing=\{lookThroughShot\}/.test(app),
);
expect(
	"the mount sits inside the viewport pane, above the stage",
	(() => {
		const viewport = app.indexOf('<div className="viewport" data-drop=');
		const mount = app.indexOf("<CameraTutorial");
		const stage = app.indexOf('<div className="stage" id="stage"');
		return viewport !== -1 && viewport < mount && mount < stage;
	})(),
);
/* ------------------------------------------- the seeded set (#209) ------ */

// The seven steps need a set and somebody walking through it. Both entries go
// through one function that opens the city-block starter and puts the shipped
// walk take on its character — the state the landing playground gets for free
// because a statically served build has no motion bridge.
const start = app.slice(app.indexOf("async function startCameraTutorial"), app.indexOf("startCameraTutorialRef.current = startCameraTutorial;"));
expect("there is a single startCameraTutorial", (app.match(/async function startCameraTutorial/g) ?? []).length === 1 && start.length > 0);
expect("it takes the entry it was called from", /async function startCameraTutorial\(\{ source = "settings" \} = \{\} \)?/.test(start) || start.includes('async function startCameraTutorial({ source = "settings" } = {})'));
expect(
	"the query entry routes through it",
	/if \(!cameraTutorialQuery \|\| cameraTutorialStarted\.current\) return;[\s\S]{0,160}startCameraTutorialRef\.current\?\.\(\{ source: "query" \}\)/.test(app),
);
expect(
	"the window-event entry routes through it",
	/startCameraTutorialRef\.current\?\.\(\{ source: event\.detail\?\.source \?\? "settings" \}\)/.test(app),
);
expect(
	"nothing else opens the tutorial behind its back",
	(app.match(/setCameraTutorial\(true\)/g) ?? []).length === 1 && start.includes("setCameraTutorial(true)"),
);
expect("the entry is reachable from the listeners through a ref", app.includes("startCameraTutorialRef.current = startCameraTutorial;"));
expect("it opens the city-block starter", start.includes('await openStarterScene("city-block", "tutorial")'));
expect(
	"a scene it could not fetch still opens the tutorial (openStarterScene toasts)",
	/const opened = await openStarterScene\("city-block", "tutorial"\);[\s\S]*?setCameraTutorial\(true\)/.test(start)
		&& app.includes('setToast(ko("That starter scene is not in this build", "이 빌드에는 그 시작 장면이 없어요"))'),
);
// #275 strengthens replacement confirmation into preservation: existing work
// runs the same steps in place and never enters the sample-loading path.
for (const scenario of [
	{ name: "pristine new document", seeded: true },
	{ name: "dirty named document", projectName: "My work", projectDirty: true },
	{ name: "clean named document", projectName: "My work" },
	{ name: "unnamed authored document", snapshot: "authored" },
	{ name: "cached document", startupCreatedScene: false },
	{ name: "tutorial restart", tutorialStarter: true },
	{ name: "previously completed user", suppressed: true },
]) {
	const effects = [];
	const runtime = {
		window: {}, embedMode: false, playgroundMode: false,
		tutorialLoadingRef: { current: false }, tutorialStarterRef: { current: scenario.tutorialStarter ?? false },
		startupCreatedScene: scenario.startupCreatedScene ?? true, projectName: scenario.projectName ?? null,
		projectDirty: scenario.projectDirty ?? false, cameraTutorialSuppressed: () => scenario.suppressed ?? false,
		tutorialInitialSnapshotRef: { current: "initial" }, collectProjectSnapshot: () => scenario.snapshot ?? "initial",
		openStarterScene: async () => { effects.push("seed"); return true; },
		setTutorialSeedPending: () => effects.push("motion"), exitPreview: () => effects.push("camera"),
		setTlFrame: () => effects.push("frame"), setProjectStartupOpen() {}, setFirstSuccessGuideOpen() {},
		setCameraTutorialHandoff() {}, createFirstShotHandoff: () => ({}),
		cameraTutorialAnalytics: { current: null }, createTutorialAnalytics: () => ({}),
		setCameraTutorialAttempt() {}, setCameraTutorial: () => effects.push("opened"),
		cameraTutorialCompletedRef: { current: false },
		tutorialProjectEpochRef: { current: 2 }, tutorialSeedEpochRef: { current: null },
		demoSeeded: { current: false },
	};
	await runInNewContext(`(${start})()`, runtime);
	expect(`${scenario.name}: only a fresh sample may change scene, motion, camera or frame`,
		effects.join() === (scenario.seeded ? "seed,motion,camera,frame,opened" : "opened"), effects.join());
}
expect("the tutorial's own starter is not re-confirmed", app.includes("tutorialStarterRef.current = true;") && /tutorialStarterRef\.current = false;/.test(app));
expect("it opens on frame 0 with the free camera", start.includes("exitPreview()") && start.includes("setTlFrame(0)"));
expect("it leaves the project chooser closed", start.includes("setProjectStartupOpen(false)"));
expect(
	"the query entry also suppresses the startup chooser",
	app.includes("useState(() => !playgroundMode && !cameraTutorialQuery && !playgroundSceneUrl(globalThis.location?.search) && !loadProjectSession()?.name)"),
);
expect("the seed is armed by state, so an effect can wait on the rig", start.includes("setTutorialSeedPending(true)"));

const seed = app.slice(app.indexOf("// The camera tutorial's seed (#209)"), app.indexOf("}, [tutorialSeedPending, activeRig, motionBusy]);"));
expect("the seed effect exists", seed.length > 0);
expect(
	"it waits on the new character's rig, never on a timer",
	seed.includes("if (!tutorialSeedPending || !activeRig || motionBusy) return;") && !/setTimeout|requestAnimationFrame/.test(seed),
);
expect("it loads the shipped walk take", seed.includes("loadMotion(DEMO_MOTION_URL, DEMO_MOTION_PROMPT,"));
expect("it fires regardless of bridge state", !/if \([^)]*bridge/.test(seed));
expect("it consumes the flag once", seed.includes("setTutorialSeedPending(false)") && seed.includes("demoSeeded.current = true"));
expect(
	"the hosted-demo seed keeps its own bridge rule",
	/if \(!demoSeed\.seed\) return;\s*demoSeeded\.current = true;/.test(app),
);
expect("the take the tutorial seeds is the landing page's", app.includes("DEMO_MOTION_URL,") && app.includes("DEMO_MOTION_PROMPT,"));
expect(
	"the walk clip still ships with the build",
	readFileSync(new URL("../src/app-stage.jsx", import.meta.url), "utf8").includes('export const DEMO_MOTION_URL = "/demo/walk-then-stop.npz"'),
);
expect(
	"the starter it opens is a real bundled scene named City Block",
	(() => {
		const project = JSON.parse(readFileSync(new URL("../public/scenes/city-block.cclayproject", import.meta.url), "utf8"));
		return project.name === "City Block" && (project.scenes?.scenes?.[0]?.objects?.length ?? 0) > 0;
	})(),
);
expect("opening it still changes no mode beyond the camera and the playhead", !/setCameraTutorial\(true\)[\s\S]{0,200}set(WorkflowMode|IkMode|Posing)/.test(app));

/* -------------------------------------------------------- Settings ▾ ----- */

expect("Settings grows a Help group", settings.includes('<h4>{ko("Help", "도움말")}</h4>'));
expect("the item is addressable", settings.includes('data-testid="settings-camera-tutorial"'));
expect("the item is labelled Camera tutorial", settings.includes('{ko("Camera tutorial", "카메라 튜토리얼")}'));
expect(
	"it opens the tutorial through the window event",
	settings.includes('new CustomEvent("cozyclay:camera-tutorial", { detail: { open: true } })'),
);
expect("it closes the menu behind itself", /cozyclay:camera-tutorial[\s\S]{0,120}setOpen\(false\)/.test(settings));
expect("no topbar button was added (R4)", (settings.match(/topbar-action/g) ?? []).length === 1 && !/topbar-action[^"]*tutorial/i.test(app));

/* ------------------------------------------- the step → control map (#211) */

// The overlay names the gesture; the studio has to show WHERE. The current
// step leaves the component through onStepChange, lands on the .app root as
// data-tutorial-step, and styles.css spotlights that step's control.
expect("the overlay reports its current step outward", tutorial.includes("onStepChange?.(currentKind)"));
expect("it reports null when it unmounts", tutorial.includes("useEffect(() => () => onStepChange?.(null), [onStepChange])"));
expect("App keeps the reported step", app.includes("const [cameraTutorialStep, setCameraTutorialStep] = useState(null);"));
expect(
	"the .app root publishes it only while the tutorial is open",
	app.includes("data-tutorial-step={cameraTutorial ? cameraTutorialStep ?? undefined : undefined}"),
);
expect(
	"the landing playground's own hint attribute is untouched",
	app.includes("data-playground-hint={playgroundMode ? playgroundHint ?? undefined : undefined}"),
);
expect("the beacon and the gesture cue are exported", /export function TutorialBeacon\(/.test(tutorial) && /export function GestureCue\(/.test(tutorial));
expect("the beacon targets are declared as a table", tutorial.includes("export const TUTORIAL_BEACONS = {"));
for (const [name, needle] of [
	["the Shots lane's add button", '.tl-track.shots .tl-track-add"'],
	["the shot to select", '.tl-track.shots .tl-shot-block:not(.selected)"'],
	["Draw rail", '".tl-rail-draw"'],
	["the Top-View inset", '".vp-inset"'],
	["the look-through button", '".vp-look-through"'],
]) expect(`the map names ${name}`, tutorial.includes(needle), needle);
expect(
	"the rail step swaps its advice on the camera bar's own existence",
	tutorial.includes('absent: ".tl-rail-draw"') && tutorial.includes('requires: ".tl-rail-draw"'),
);
expect("the beacon and the cue are addressable", tutorial.includes('data-testid="camera-tutorial-beacon"') && tutorial.includes('data-testid="camera-tutorial-gesture"'));
expect("the beacon publishes the step kind and which target it is on", /data-kind=\{kind\}[\s\S]{0,80}data-role=\{role\}/.test(tutorial));
expect("the beacon rides a portal so no pane can clip it", tutorial.includes("createPortal(") && tutorial.includes("document.body,"));
expect(
	"it re-measures on resize, on the panes, and on DOM churn",
	tutorial.includes('window.addEventListener("resize", schedule)')
		&& tutorial.includes("new ResizeObserver(schedule)")
		&& tutorial.includes("new MutationObserver(schedule)"),
);
expect(
	"every observer is torn down with the beacon",
	tutorial.includes("resize.disconnect()") && tutorial.includes("mutations.disconnect()") && tutorial.includes('window.removeEventListener("resize", schedule)'),
);
expect("the gesture cue only stands in for the four nav steps", /NAV_KINDS\.has\(currentKind\)/.test(tutorial));
expect("the walk cue reads the same pressed-key set as the card", /walked\?\.has\(walkKey\)/.test(tutorial));
expect("the card points at the region the control lives in", tutorial.includes('where: ko("\u2193 Timeline, Shots lane"') && tutorial.includes('where: ko("\u2192 Viewport"'));
expect("the card renders that pointer before the copy", /camera-tutorial-where"?>\{current\.where\}/.test(tutorial));

/* ------------------------------------------------------------ styles ----- */

expect("the overlay has its own block", css.includes(".camera-tutorial {"));
expect("it hangs under the 27px viewport titlebar", /\.camera-tutorial \{[^}]*top: 35px/.test(css));
expect("the overlay never takes the pointer", /\.camera-tutorial \{[^}]*pointer-events: none/.test(css));
expect("except on the close button", /\.camera-tutorial-close \{[^}]*pointer-events: auto/.test(css));
expect("it uses the studio's own tokens", /\.camera-tutorial \{[^}]*var\(--panel\)/.test(css) && /\.camera-tutorial \{[^}]*var\(--line2\)/.test(css));

// The spotlight (#211): the same idea as the landing page's hint pulse, keyed
// on the Studio's own attribute and one region louder.
for (const selector of [
	'.app[data-tutorial-step="shot"] .tl-track.shots .tl-track-add',
	'.app[data-tutorial-step="rail"] .tl-track.shots .tl-shot-block:not(.selected)',
	'.app[data-tutorial-step="rail"] .tl-rail-draw',
	'.app[data-tutorial-step="play"] .vp-look-through',
]) expect(`the spotlight covers ${selector}`, css.includes(selector), selector);
expect("the rail step also outlines the Top-View it is drawn into", /\.app\[data-tutorial-step="rail"\] \.vp-inset \{[^}]*var\(--accent-ring\)/.test(css));
expect("the spotlight has its own, stronger keyframes", /@keyframes tutorial-spotlight \{[^}]*0 0 0 3px var\(--accent\)/.test(css));
expect("the landing page's own hint pulse is untouched", css.includes('.app[data-playground-hint="look"] .vp-look-through') && /@keyframes playground-pulse \{/.test(css));
expect("the beacon never takes the pointer", /\.tutorial-beacon \{[^}]*pointer-events: none/.test(css));
expect("the beacon clears every viewport and timeline layer", /\.tutorial-beacon \{[^}]*z-index: 14/.test(css));
expect("the cue never takes the pointer either", /\.tutorial-cue \{[^}]*pointer-events: none/.test(css));
expect("the cue fades rather than blinking out", /\.tutorial-cue \{[^}]*transition: opacity/.test(css) && /\.tutorial-cue\[data-leaving="1"\] \{[^}]*opacity: 0/.test(css));
expect("every cue and beacon colour is a studio token", /\.tutorial-beacon-dot \{[^}]*background: var\(--accent\)/.test(css) && /\.tutorial-cue-caption \{[^}]*color: var\(--fg\)/.test(css));
expect(
	"reduced motion keeps the pointing and drops the movement",
	(() => {
		const block = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
		return block.includes('.app[data-tutorial-step="shot"] .tl-track.shots .tl-track-add')
			&& block.includes(".tutorial-cue,")
			&& block.includes(".tutorial-beacon,")
			&& /animation: none/.test(block);
	})(),
);

/* ---------------------------------------------------------- top view ----- */

// The Rail step is drawn on the Top-View. The landing playground clears that
// board down to camera, cast and rail (PlanBoard's `minimal`); the studio
// tutorial must get the same board, not 34 footprints under the stroke.
expect(
	"the top view is minimal while the tutorial is open",
	/<PlanBoard\s+minimal=\{playgroundMode \|\| cameraTutorial\}/.test(app),
);

/* ---------------------------------------------------------- manifest ----- */

expect("the browser suite is registered", manifest.includes('"test/qa-camera-tutorial-browser.mjs"'));
expect("and it is in the inventory sweep", manifest.slice(manifest.indexOf("const EXTRA_INVENTORY")).includes("test/qa-camera-tutorial-browser.mjs"));

/* -------------------------------------- executable analytics lifecycle --- */

expect("Studio observes committed done/current state rather than driving gestures", tutorial.includes("analytics?.observe(done, currentKind)") && tutorial.includes("[analytics, done, currentKind]"));
expect("Studio's close button reports explicit dismissal", tutorial.includes("analytics?.dismiss(); onClose?.();"));
expect("the window close entry also reports dismissal", /setCameraTutorial\(false\);\s*cameraTutorialAnalytics\.current\?\.dismiss\(\)/.test(app));
expect("each explicit Studio start creates fresh analytics and resets the mounted progression", start.includes('createTutorialAnalytics({ surface: "studio", startSource: source })') && start.includes("setCameraTutorialAttempt((attempt) => attempt + 1)"));
expect("tutorial sample seeding still bypasses semantic editing", !/markSemanticEdit|first_edit/.test(seed) && !/markSemanticEdit|first_edit/.test(start));

// Explicit clocks and a manually resolved initialization promise: no gesture,
// StrictMode replay, or SDK race is allowed to depend on scheduling luck.
try {
	const { createTutorialAnalytics } = await import("../src/tutorial-analytics.js");
	const fixture = (surface = "studio", startSource = "query") => {
		let clock = 0;
		let optedOut = false;
		let initialize;
		const initialized = new Promise((resolve) => { initialize = resolve; });
		const events = [];
		const start = () => createTutorialAnalytics({ surface, startSource }, {
			now: () => clock,
			initialize: () => initialized,
			capture: (event, props) => events.push({ event, props }),
			optedOut: () => optedOut,
		});
		return { events, start, initialize, time: (value) => { clock = value; }, optOut: (value) => { optedOut = value; } };
	};
	const named = (fixture, name) => fixture.events.filter(({ event }) => event === `tutorial:${name}`);
	const hasNoOrphans = (events) => {
		const entered = new Set();
		return events.every(({ event, props }) => {
			if (event === "tutorial:started") entered.clear();
			if (event === "tutorial:step_entered") entered.add(props.step_kind);
			return event !== "tutorial:step_completed" || entered.has(props.step_kind);
		});
	};
	for (const surface of ["studio", "playground"]) {
		const f = fixture(surface, surface === "studio" ? "query" : "landing");
		const attempt = f.start();
		const done = new Set();
		attempt.observe(done, "fly");
		attempt.observe(done, "fly"); // mount effect replay
		expect(`${surface}: SDK initialization buffers started and entered`, f.events.length === 0);
		f.initialize();
		await attempt.ready;
		expect(`${surface}: started precedes the first entered exactly once`, f.events.map(({ event }) => event).join() === "tutorial:started,tutorial:step_entered");
		for (const [index, kind] of kinds.entries()) {
			f.time((index + 1) * 2000);
			done.add(kind);
			attempt.observe(done, kinds[index + 1] ?? null);
			attempt.observe(done, kinds[index + 1] ?? null); // held keys/repeated rail strokes
		}
		expect(`${surface}: all seven completions occur once`, named(f, "step_completed").map(({ props }) => props.step_kind).join() === kinds.join());
		expect(`${surface}: all seven entered markers occur once`, named(f, "step_entered").map(({ props }) => props.step_kind).join() === kinds.join());
		expect(`${surface}: elapsed step buckets use first entry time`, named(f, "step_completed").every(({ props }) => props.elapsed_bucket === "1-3s"));
		expect(`${surface}: completion is once with attempt elapsed`, named(f, "completed").length === 1 && named(f, "completed")[0].props.elapsed_bucket === "10-30s");
		attempt.dismiss();
		attempt.dismiss();
		expect(`${surface}: closing a finished tutorial is not dismissal`, named(f, "dismissed").length === 0);
		expect(`${surface}: every completed kind has an earlier entry`, hasNoOrphans(f.events));
		expect(`${surface}: metadata contains only closed fields, never attempt IDs or content`, f.events.every(({ props }) => props.surface === surface && props.tutorial_version === 1 && Object.keys(props).every((key) => ["surface", "tutorial_version", "start_source", "step_kind", "elapsed_bucket"].includes(key))));
	}
	{
		const f = fixture();
		const attempt = f.start();
		attempt.observe(new Set(), "fly");
		f.time(4000);
		attempt.observe(new Set(["rail"]), "fly");
		attempt.dismiss();
		attempt.dismiss();
		attempt.observe(new Set(kinds), null);
		f.initialize();
		await attempt.ready;
		expect("out-of-order completion inserts entry without advancing navigation", named(f, "step_entered").map(({ props }) => props.step_kind).join() === "fly,rail" && named(f, "step_completed").length === 1 && hasNoOrphans(f.events));
		expect("explicit unfinished close emits one dismissal for the actual current step", named(f, "dismissed").length === 1 && named(f, "dismissed")[0].props.step_kind === "fly");
		expect("post-dismiss callbacks cannot complete an attempt", named(f, "completed").length === 0);
	}
	{
		const f = fixture("studio", "private path or arbitrary event source");
		let attempt = f.start();
		attempt.observe(new Set(["fly"]), "walk");
		f.time(6000);
		attempt = f.start(); // explicit restart, including while still open
		attempt.observe(new Set(), "fly");
		f.time(8000);
		attempt.observe(new Set(["fly"]), "walk");
		f.initialize();
		await attempt.ready;
		expect("restart creates a fresh started boundary and resets completion dedupe/timing", named(f, "started").length === 2 && named(f, "step_completed").length === 2 && named(f, "step_completed")[1].props.elapsed_bucket === "1-3s" && hasNoOrphans(f.events));
		expect("untrusted start sources normalize to settings", named(f, "started").every(({ props }) => props.start_source === "settings"));
		expect("restart does not invent a close event", named(f, "dismissed").length === 0);
	}
	{
		const f = fixture();
		const attempt = f.start();
		attempt.observe(new Set(["fly"]), "walk");
		f.initialize();
		await attempt.ready;
		const beforeLeave = f.events.length;
		f.time(45000); // no invocation on visibility/pagehide/unmount
		expect("leaving mid-step produces no synthetic dismissal or completion", f.events.length === beforeLeave && named(f, "dismissed").length === 0 && named(f, "completed").length === 0);
		attempt.observe(new Set(["fly"]), "walk"); // same-mounted BFCache resume
		attempt.observe(new Set(["fly", "walk"]), "dolly");
		expect("same-mounted resume retains dedupe and the original step timer", named(f, "started").length === 1 && named(f, "step_completed").length === 2 && named(f, "step_completed")[1].props.elapsed_bucket === "gte30s");
		const reload = f.start(); // a new document has no persisted attempt
		reload.observe(new Set(), "fly");
		await reload.ready;
		expect("reload starts fresh without an invented close event", named(f, "started").length === 2 && named(f, "dismissed").length === 0);
	}
	// Execute the real landing tutorial script, not a reimplementation of its
	// done/walked progression. Readiness is a message, never its timeout fallback.
	{
		const f = fixture("playground", "landing");
		const attempts = [];
		const listeners = new Map();
		const element = () => ({
			dataset: {}, classList: { add() {}, remove() {} },
			addEventListener(name, listener) { this[name] = listener; },
			appendChild(child) { this.child = child; }, remove() {},
			contentWindow: { postMessage() {} },
		});
		const elements = new Map();
		const get = (id) => {
			if (!elements.has(id)) elements.set(id, element());
			return elements.get(id);
		};
		const window = {
			location: { origin: "https://cozyclay.org" },
			addEventListener(name, listener) {
				if (!listeners.has(name)) listeners.set(name, new Set());
				listeners.get(name).add(listener);
			},
			removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
		};
		const script = landing.match(/<script(?: type="module")?>\s*([\s\S]*?const box = document\.getElementById\("playground"\)[\s\S]*?)<\/script>/)?.[1];
		if (!script) throw new Error("landing tutorial script missing");
		runInNewContext(script.replace(/import \{ (?:createTutorialAnalytics|createFirstShotHandoff) \} from [^;]+;/g, ""), {
			window, document: { getElementById: get, createElement: element, querySelectorAll: () => [] },
			matchMedia: () => ({ matches: true }), setTimeout: () => 1, clearTimeout() {},
			createFirstShotHandoff,
			createTutorialAnalytics(metadata) {
				expect("landing supplies its own safe surface/source", metadata.surface === "playground" && metadata.startSource === "landing");
				const attempt = f.start(); attempts.push(attempt); return attempt;
			},
		});
		const message = (data, source = get("playground").child?.contentWindow, origin = window.location.origin) => {
			for (const listener of [...(listeners.get("message") ?? [])]) listener({ data, source, origin });
		};
		const nav = (kind, key) => message({ type: "cozyclay:playground-nav", kind, key });
		get("playground-start").click();
		message({ type: "cozyclay:playground-ready" });
		f.initialize();
		await attempts[0]?.ready;
		message({ type: "cozyclay:playground-nav", kind: "fly" }, {});
		message({ type: "cozyclay:playground-nav", kind: "fly" }, get("playground").child.contentWindow, "https://other.example");
		expect("landing ignores signals from another window or origin", named(f, "step_completed").length === 0);
		for (const kind of kinds) {
			if (kind === "walk") {
				for (const key of ["w", "a", "s", "d", "q"]) { nav(kind, key); nav(kind, key); }
				expect("landing walk waits for the sixth distinct key", !named(f, "step_completed").some(({ props }) => props.step_kind === "walk"));
				nav(kind, "e");
			} else nav(kind);
			nav(kind);
		}
		expect("real landing handlers complete all seven once", named(f, "step_completed").map(({ props }) => props.step_kind).join() === kinds.join() && named(f, "completed").length === 1);
		get("playground-close").click();
		expect("landing completed close is not a dismissal", named(f, "dismissed").length === 0);
		get("playground-start").click();
		message({ type: "cozyclay:playground-ready" });
		nav("fly");
		get("playground-close").click();
		get("playground-close").click();
		await attempts[1]?.ready;
		expect("landing reopen resets progression and explicit close dedupes", named(f, "started").length === 2 && named(f, "step_completed").length === 8 && named(f, "dismissed").length === 1 && named(f, "dismissed")[0].props.step_kind === "walk");
		get("playground-start").click();
		message({ type: "cozyclay:playground-ready" });
		nav("fly");
		const oldFrame = get("playground").child.contentWindow;
		get("playground-start").click(); // explicit restart while unfinished/open
		message({ type: "cozyclay:playground-ready" }, oldFrame);
		expect("landing restart rejects readiness from the replaced iframe", get("playground").dataset.state === "loading");
		message({ type: "cozyclay:playground-ready" });
		message({ type: "cozyclay:playground-nav", kind: "rail" }, oldFrame);
		nav("fly");
		await attempts[2]?.ready;
		await attempts[3]?.ready;
		expect("real unfinished landing restart creates a new attempt without synthetic dismissal", named(f, "started").length === 4 && named(f, "dismissed").length === 1);
		expect("real unfinished landing restart resets done and ignores replaced-frame gestures", named(f, "step_completed").length === 10 && named(f, "step_completed").filter(({ props }) => props.step_kind === "fly").length === 4 && hasNoOrphans(f.events));
	}
	for (const optOutAt of ["start", "during-init", "after-init"]) {
		const f = fixture();
		if (optOutAt === "start") f.optOut(true);
		const attempt = f.start();
		attempt.observe(new Set(), "fly");
		if (optOutAt === "during-init") f.optOut(true);
		f.initialize();
		await attempt.ready;
		if (optOutAt === "after-init") f.optOut(true);
		const before = f.events.length;
		attempt.observe(new Set(["fly"]), "walk");
		f.optOut(false);
		attempt.observe(new Set(kinds), null);
		attempt.dismiss();
		expect(`opt-out ${optOutAt} drops pending/future events without opt-in replay`, f.events.length === before && (optOutAt === "after-init" || before === 0));
	}
} catch (error) {
	expect("executable tutorial analytics lifecycle fixtures", false, error.stack);
}

if (failures) {
	console.error(`${failures} FAILURES`);
	process.exitCode = 1;
} else {
	console.log("all camera tutorial checks PASS");
}
