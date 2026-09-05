#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

const NODE_FILES = [
	"test/ardy/verify-base-free.mjs",
	"test/ardy/verify-browser-motion.mjs",
	"test/ardy/verify-collision-blockers.mjs",
	"test/ardy/verify-compare-npz.mjs",
	"test/ardy/verify-fill.mjs",
	"test/ardy/verify-fk.mjs",
	"test/ardy/verify-gvhmr-worker.mjs",
	"test/ardy/verify-gvhmr-floor.mjs",
	"test/ardy/verify-key-runs.mjs",
	"test/ardy/verify-playback-skinning.mjs",
	"test/ardy/verify-playback-clock.mjs",
	"test/ardy/verify-pose-export.mjs",
	"test/ardy/verify-pose-pin.mjs",
	"test/ardy/verify-pose-shape.mjs",
	"test/ardy/verify-prompt-move.mjs",
	"test/ardy/verify-rest.mjs",
	"test/ardy/verify-root-drop.mjs",
	"test/ardy/verify-secure-artifacts.mjs",
	"test/ardy/verify-timeline-coordinates.mjs",
	"test/ardy/verify-timeline-resize.mjs",
	"test/demo/verify-demo-pages.mjs",
	"test/demo/verify-motion-url-allowlist.mjs",
	"test/demo/verify-queue-policy.mjs",
	"test/demo/verify-queue-concurrency.mjs",
	"test/demo/verify-ops.mjs",
	"test/demo/verify-demo-worker-signing.mjs",
	"test/demo/verify-demo-worker-loop.mjs",
	"test/ik/verify-fix-collisions.mjs",
	"test/ik/verify-auto-physics.mjs",
	"test/ik/verify-physics-review.mjs",
	"test/ik/verify-physics-support.mjs",
	"test/ik/verify-physics-surface.mjs",
	"test/ik/verify-ik.mjs",
	"test/verify-ik-camera-performance.mjs",
	"test/process/verify-bridge-launch.mjs",
	"test/process/verify-lifecycle.mjs",
	"test/process/verify-mcp-package-isolation.mjs",
	"test/process/verify-package-telemetry.mjs",
	"test/verify-analytics.mjs",
	"test/verify-appearance.mjs",
	"test/verify-auto-color.mjs",
	"test/verify-asset-shelf.mjs",
	"test/verify-blocking-depth.mjs",
	"test/verify-burn-in.mjs",
	"test/verify-bvh-cskel27.mjs",
	"test/verify-camera-block.mjs",
	"test/verify-camera-follow.mjs",
	"test/verify-camera-move.mjs",
	"test/verify-camera-rail-schedule.mjs",
	"test/verify-cuts.mjs",
	"test/verify-shot-guides.mjs",
	"test/verify-error-boundary.mjs",
	"test/verify-footage-bridge.mjs",
	"test/verify-g006-css.mjs",
	"test/verify-gizmo-claim.mjs",
	"test/verify-grid-view.mjs",
	"test/verify-hierarchy.mjs",
	"test/verify-history.mjs",
	"test/verify-image-pose.mjs",
	"test/verify-kimodo-cskel27.mjs",
	"test/verify-kimodo-edit.mjs",
	"test/verify-kimodo-effector.mjs",
	"test/verify-kimodo-pose.mjs",
	"test/verify-kimodo-preserve.mjs",
	"test/verify-kimodo-runner.mjs",
	"test/verify-kimodo-setup.mjs",
	"test/verify-motion-trail.mjs",
	"test/verify-kimodo-waypoints.mjs",
	"test/verify-korean-ui.mjs",
	"test/verify-label-tooltips.mjs",
	"test/verify-layout.mjs",
	"test/verify-beginner-screen.mjs",
	"test/verify-line-edit-draw.mjs",
	"test/verify-line-edit-pins.mjs",
	"test/verify-live-control.mjs",
	"test/verify-matte-editor.mjs",
	"test/verify-matte.mjs",
	"test/verify-mp4-duration.mjs",
	"test/verify-mcp-invariants.mjs",
	"test/verify-motion-edit.mjs",
	"test/verify-multimodel-ingest.mjs",
	"test/verify-offscreen-export.mjs",
	"test/verify-record-mp4-source.mjs",
	"test/verify-timeline-extent.mjs",
	"test/verify-otio.mjs",
	"test/verify-pose-extract.mjs",
	"test/verify-pose-library.mjs",
	"test/verify-pose-mirror.mjs",
	"test/verify-pose-yaw.mjs",
	"test/verify-preserve-bridge.mjs",
	"test/verify-project.mjs",
	"test/verify-projflow-bridge.mjs",
	"test/verify-projflow-cskel27.mjs",
	"test/verify-projflow-replay.mjs",
	"test/verify-projflow-runner.mjs",
	"test/verify-projflow-service.mjs",
	"test/verify-pwa.mjs",
	"test/verify-package-signature.mjs",
	"test/verify-resilience.mjs",
	"test/verify-retime.mjs",
	"test/verify-sample-at.mjs",
	"test/verify-scene-asset-cache.mjs",
	"test/verify-scene-assets.mjs",
	"test/verify-scene-objects.mjs",
	"test/verify-scenes.mjs",
	"test/verify-cozy-scene-node.mjs",
	"test/verify-motion-input.mjs",
	"test/verify-vibe-payload.mjs",
	"test/verify-vibe-node-schema.mjs",
	"test/verify-local-workflow.mjs",
	"test/verify-workflow-scene-asset-sync.mjs",
	"test/verify-stable-ids.mjs",
	"test/verify-shot-authoring.mjs",
	"test/verify-take-recipe.mjs",
	"test/verify-theme.mjs",
	"test/verify-telemetry-state.mjs",
	"test/verify-timeline-camera.mjs",
	"test/verify-timeline-shots.mjs",
	"test/verify-trim.mjs",
	"test/verify-update-check.mjs",
	"test/verify-usd-camera.mjs",
	"test/verify-video-frames.mjs",
	"mcp/verify.mjs",
	"mcp/verify-http-origin.mjs",
	"mcp/verify-live.mjs",
	"mcp/verify-live-motion-job.mjs",
	"mcp/verify-live-p0.mjs",
	"mcp/verify-live-port.mjs",
	"mcp/verify-live-routing.mjs",
	"mcp/verify-prompts.mjs",
	"mcp/verify-protocol-version.mjs",
	"mcp/verify-tool-annotations.mjs",
	"test/verify-object-path.mjs",
	"test/verify-number-field-scrub.mjs",
	"test/verify-speed-envelope.mjs",
];

const BROWSER_FILES = [
	"test/verify-camera-rail-browser.mjs",
	"test/verify-cutout-browser.mjs",
	"test/verify-first-success-guide-browser.mjs",
	"test/verify-ik-browser.mjs",
	"test/verify-motion-edit-browser.mjs",
	"test/verify-number-field-scrub-browser.mjs",
	"test/verify-object-colour-browser.mjs",
	"test/verify-object-gizmo.mjs",
	"test/verify-offscreen-export-browser.mjs",
	"test/verify-project-menu-browser.mjs",
];

function verificationFiles(directory) {
	return readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return entry.name === "node_modules" ? [] : verificationFiles(path);
			return entry.isFile() && /^verify(-.*)?\.mjs$/.test(entry.name) ? [relative(".", path)] : [];
		})
		.sort();
}

function parseArguments(arguments_) {
	let listOnly = false;
	let scope = "all";
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--list") {
			listOnly = true;
			continue;
		}
		if (argument === "--scope") {
			scope = arguments_[index + 1] ?? "";
			index += 1;
			continue;
		}
		throw new Error(`unknown argument: ${argument}`);
	}
	if (scope !== "all" && scope !== "ardy") throw new Error(`unknown test scope: ${scope}`);
	return { listOnly, scope };
}

function run(file) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [file], { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${file} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`));
		});
	});
}

// node:sqlite's DatabaseSync only ships unflagged from Node 22.13.0 (it lived
// behind --experimental-sqlite before that). package.json requires >=22.13,
// but older 22.x installs are still common enough that the manifest should
// degrade gracefully instead of aborting the whole run.
const NODE_SQLITE_MIN = [22, 13, 0];
const NODE_SQLITE_FILES = ["test/demo/verify-ops.mjs", "test/demo/verify-queue-concurrency.mjs"];

function meetsMinimumNodeVersion([major, minor, patch], current = process.versions.node) {
	const [currentMajor, currentMinor, currentPatch] = current.split(".").map(Number);
	if (currentMajor !== major) return currentMajor > major;
	if (currentMinor !== minor) return currentMinor > minor;
	return currentPatch >= patch;
}

const hasNodeSqlite = meetsMinimumNodeVersion(NODE_SQLITE_MIN);

// The MCP suites fork mcp/server.mjs, which imports the MCP SDK from
// mcp/node_modules — a tree the root `npm install` does not create. On a
// fresh clone those suites must degrade to an actionable EXCLUDE instead of
// a startup timeout that swallows the real ERR_MODULE_NOT_FOUND (CI installs
// them explicitly with `npm --prefix mcp ci`, so its coverage is unchanged).
// Probes the same dependency set bin/mcp-runtime.mjs verifies before running.
function hasMcpRuntimeDeps() {
	try {
		const requireFromMcp = createRequire(new URL("../mcp/package.json", import.meta.url));
		for (const dependency of ["@modelcontextprotocol/sdk/server/mcp.js", "three", "ws", "zod"]) {
			requireFromMcp.resolve(dependency);
		}
		return true;
	} catch {
		return false;
	}
}

const mcpDepsInstalled = hasMcpRuntimeDeps();

const categories = new Map([
	...NODE_FILES.map((file) => [file, { kind: "node", reason: "runs directly under Node" }]),
	...BROWSER_FILES.map((file) => [file, { kind: "browser", reason: "requires the QA browser wrapper and a running Vite app" }]),
	["test/process/verify-mcp-package-isolation.mjs", { kind: "package-integration", reason: "installs the MCP runtime from the npm registry with an isolated cache" }],
	...["mcp/verify-live-batch.mjs", "mcp/verify-live-capture.mjs", "mcp/verify-live-editor-model.mjs", "mcp/verify-live-scene-parity.mjs"].map(
		(file) => [file, { kind: "browser", reason: "drives a real Chrome editor over the live socket" }],
	),
	...NODE_SQLITE_FILES.map((file) => [
		file,
		hasNodeSqlite
			? { kind: "node", reason: "runs directly under Node" }
			: {
					kind: "sqlite",
					reason: `requires node:sqlite, unflagged only from Node >=${NODE_SQLITE_MIN.join(".")} (current runtime is Node ${process.versions.node})`,
				},
	]),
]);
if (!mcpDepsInstalled) {
	for (const [file, category] of categories) {
		if (!file.startsWith("mcp/") || category.kind !== "node") continue;
		categories.set(file, {
			kind: "mcp-deps",
			reason: "requires the MCP server dependencies; run `npm --prefix mcp ci` (or `cd mcp && npm install`) first",
		});
	}
}

const { listOnly, scope } = parseArguments(process.argv.slice(2));
const inventory = [...verificationFiles("test"), ...verificationFiles("mcp")];
const unclassified = inventory.filter((file) => !categories.has(file));
const stale = [...categories.keys()].filter((file) => !inventory.includes(file));
if (unclassified.length > 0 || stale.length > 0) {
	throw new Error([
		unclassified.length > 0 ? `unclassified test files: ${unclassified.join(", ")}` : null,
		stale.length > 0 ? `missing classified test files: ${stale.join(", ")}` : null,
	].filter(Boolean).join("\n"));
}

const scoped = inventory.filter((file) => scope === "all" || file.startsWith("test/ardy/") || file.startsWith("test/ik/"));
const runnable = scoped.filter((file) => categories.get(file).kind === "node");
console.log(`TEST MANIFEST scope=${scope} runnable=${runnable.length} total=${scoped.length}`);
for (const file of scoped) {
	const { kind, reason } = categories.get(file);
	console.log(`${kind === "node" ? "RUN" : "EXCLUDE"} ${kind} ${file} - ${reason}`);
}

if (!listOnly) {
	for (const file of runnable) {
		console.log(`\nRUNNING ${file}`);
		await run(file);
	}
	console.log(`\nPASS ${runnable.length} Node verification files`);
}
