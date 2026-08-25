#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const NODE_FILES = [
	"test/ardy/verify-base-free.mjs",
	"test/ardy/verify-browser-motion.mjs",
	"test/ardy/verify-compare-npz.mjs",
	"test/ardy/verify-fill.mjs",
	"test/ardy/verify-fk.mjs",
	"test/ardy/verify-playback-skinning.mjs",
	"test/ardy/verify-pose-pin.mjs",
	"test/ardy/verify-pose-shape.mjs",
	"test/ardy/verify-prompt-move.mjs",
	"test/ardy/verify-rest.mjs",
	"test/ardy/verify-root-drop.mjs",
	"test/ardy/verify-runner-parity.mjs",
	"test/ardy/verify-secure-artifacts.mjs",
	"test/verify-ardy-setup-path.mjs",
	"test/ardy/verify-sequence-bridge.mjs",
	"test/ardy/verify-timeline-coordinates.mjs",
	"test/ardy/verify-timeline-resize.mjs",
	"test/generation/verify-bridge.mjs",
	"test/generation/verify-generation-e2e.mjs",
	"test/generation/verify-job-store.mjs",
	"test/generation/verify-kling-provider.mjs",
	"test/generation/verify-runway-provider.mjs",
	"test/generation/verify-seedance-provider.mjs",
	"test/generation/verify-session.mjs",
	"test/generation/verify-shot-spec.mjs",
	"test/generation/verify-veo-provider.mjs",
	"test/ik/verify-ik.mjs",
	"test/process/verify-bridge-launch.mjs",
	"test/process/verify-generation-bridge-launch.mjs",
	"test/process/verify-lifecycle.mjs",
	"test/process/verify-mcp-package-isolation.mjs",
	"test/process/verify-package-telemetry.mjs",
	"test/verify-analytics.mjs",
	"test/verify-appearance.mjs",
	"test/verify-asset-shelf.mjs",
	"test/verify-blocking-depth.mjs",
	"test/verify-bvh-cskel27.mjs",
	"test/verify-camera-block.mjs",
	"test/verify-camera-follow.mjs",
	"test/verify-camera-move.mjs",
	"test/verify-camera-rail-schedule.mjs",
	"test/verify-cuts.mjs",
	"test/verify-footage-bridge.mjs",
	"test/verify-g006-css.mjs",
	"test/verify-hierarchy.mjs",
	"test/verify-history.mjs",
	"test/verify-image-pose.mjs",
	"test/verify-korean-ui.mjs",
	"test/verify-layout.mjs",
	"test/verify-live-control.mjs",
	"test/verify-matte-editor.mjs",
	"test/verify-matte.mjs",
	"test/verify-mp4-duration.mjs",
	"test/verify-mcp-invariants.mjs",
	"test/verify-motion-edit.mjs",
	"test/verify-multimodel-ingest.mjs",
	"test/verify-offscreen-export.mjs",
	"test/verify-record-mp4-source.mjs",
	"test/verify-otio.mjs",
	"test/verify-pose-extract.mjs",
	"test/verify-pose-library.mjs",
	"test/verify-project.mjs",
	"test/verify-pwa.mjs",
	"test/verify-package-signature.mjs",
	"test/verify-retime.mjs",
	"test/verify-sample-at.mjs",
	"test/verify-scene-asset-cache.mjs",
	"test/verify-scene-assets.mjs",
	"test/verify-scene-objects.mjs",
	"test/verify-scenes.mjs",
	"test/verify-stable-ids.mjs",
	"test/verify-shot-authoring.mjs",
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
];

const BROWSER_FILES = [
	"test/verify-camera-rail-browser.mjs",
	"test/verify-cutout-browser.mjs",
	"test/verify-ik-browser.mjs",
	"test/verify-motion-edit-browser.mjs",
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

const categories = new Map([
	...NODE_FILES.map((file) => [file, { kind: "node", reason: "runs directly under Node" }]),
	...BROWSER_FILES.map((file) => [file, { kind: "browser", reason: "requires the QA browser wrapper and a running Vite app" }]),
	["test/ardy/verify-npz.mjs", { kind: "external", reason: "requires a configured remote ARDY host and NumPy environment" }],
	["test/process/verify-mcp-package-isolation.mjs", { kind: "package-integration", reason: "installs the MCP runtime from the npm registry with an isolated cache" }],
	...["mcp/verify-live-batch.mjs", "mcp/verify-live-capture.mjs", "mcp/verify-live-editor-model.mjs", "mcp/verify-live-scene-parity.mjs"].map(
		(file) => [file, { kind: "browser", reason: "drives a real Chrome editor over the live socket" }],
	),
]);
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
