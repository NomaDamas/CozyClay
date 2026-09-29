#!/usr/bin/env node
/** Quality gates for one completed T1 run. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readNpz } from "../kimodo/read-npz.mjs";
import { hiddenJointError, occlusionAgreement, pelvisStepsDeg, truthStanceSlideCmPerS } from "./metrics.mjs";
import { validateDiagnostics } from "./remote.mjs";

const USAGE = "usage: node tools/track/gate.mjs --run <dir> --baseline <dir> [--ceiling <summary.json>]";
const TRUTH_SETS = new Set(["gt", "cube", "gt-skin", "cube-skin"]);
const HIDDEN_SETS = new Set(["cube", "cube-skin"]);
const HIDDEN_NAMES = new Set(["bump", "sit"]);
const SHADED_DETECTOR = ["p", "alette"].join("");

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		const key = argv[i];
		if (key === "--help" || key === "-h") { console.log(USAGE); process.exit(0); }
		if (!["--run", "--baseline", "--ceiling"].includes(key)) throw new Error(`unknown option ${key}`);
		const value = argv[++i];
		if (!value || value.startsWith("--")) throw new Error(`${key} needs a value`);
		out[key.slice(2)] = value;
	}
	if (!out.run) throw new Error("--run is required");
	if (!out.baseline) throw new Error("--baseline is required");
	return { run: resolve(out.run), baseline: resolve(out.baseline), ceiling: out.ceiling ? resolve(out.ceiling) : null };
}
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const isFile = path => Boolean(path && existsSync(path) && statSync(path).isFile());
const finite = value => typeof value === "number" && Number.isFinite(value);
const field = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const maximum = values => values.length ? Math.max(...values) : null;
const keyOf = item => `${item.set}/${item.name}`;

function itemDirs(root) {
	if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`no such run directory: ${root}`);
	const out = [];
	for (const set of readdirSync(root)) {
		const setDir = join(root, set);
		if (!statSync(setDir).isDirectory() || set.startsWith(".")) continue;
		for (const name of readdirSync(setDir)) {
			const dir = join(setDir, name);
			if (statSync(dir).isDirectory()) out.push({ set, name, dir });
		}
	}
	if (!out.length) throw new Error(`${root}: no item directories`);
	return out;
}

function readMotion(path) {
	if (!isFile(path)) return null;
	const members = readNpz(path);
	const joints = members.posed_joints;
	const rotations = members.local_rot_mats ?? members.rotMats;
	if (!joints?.data || JSON.stringify(joints.shape?.slice(1)) !== "[27,3]") return null;
	const frames = joints.shape[0], fps = members.fps?.data?.[0] ?? 24;
	if (!Number.isInteger(frames) || frames < 1 || !finite(fps) || fps <= 0 || !rotations?.data) return null;
	return { frames, fps, posedJoints: joints.data, rotMats: rotations.data };
}
function nestedJoints(motion) {
	return Array.from({ length: motion.frames }, (_, frame) => Array.from({ length: 27 }, (_, joint) => Array.from(motion.posedJoints.slice((frame * 27 + joint) * 3, (frame * 27 + joint + 1) * 3))));
}

function loadStep(item, step, { strict = true } = {}) {
	const itemDir = item.itemDir ?? item.dir;
	const dir = join(itemDir, step);
	const resultPath = join(dir, "result.json"), scorePath = join(dir, "score", "score.json"), motionPath = join(dir, "motion.npz"), diagnosticsPath = join(dir, "diagnostics.json");
	const errors = [];
	const result = isFile(resultPath) ? readJson(resultPath) : null;
	if (!result) errors.push(`${keyOf(item)}/${step}: missing result.json`);
	if (strict) {
		if (result?.step && result.step !== step) errors.push(`${keyOf(item)}/${step}: result.step is ${result.step}`);
		if (result && result.ok !== true) errors.push(`${keyOf(item)}/${step}: result.ok is not true`);
		if (result && result.fallback != null) errors.push(`${keyOf(item)}/${step}: fallback=${result.fallback}`);
		if (result?.diagnostics?.failure) errors.push(`${keyOf(item)}/${step}: diagnostics.failure=${result.diagnostics.failure}`);
	}
	const score = isFile(scorePath) ? readJson(scorePath) : null;
	const motion = readMotion(motionPath);
	const diagnostics = isFile(diagnosticsPath) ? readJson(diagnosticsPath) : null;
	if (strict && !score) errors.push(`${keyOf(item)}/${step}: missing score.json`);
	if (strict && score) {
		const required = TRUTH_SETS.has(item.set) ? ["pose.paMpjpeM", "trajectory.rootErrorRawM.rmse", "trajectory.ateAlignedM.rmse", "overlap.maskIoURawMean"] : ["overlap.maskIoURawMean"];
		for (const path of required) if (!finite(field(score, path))) errors.push(`${keyOf(item)}/${step}: missing score field ${path}`);
	}
	if (strict && !motion) errors.push(`${keyOf(item)}/${step}: missing or invalid motion.npz`);
	if (strict && !diagnostics) errors.push(`${keyOf(item)}/${step}: missing diagnostics.json`);
	if (strict && diagnostics) {
		try { validateDiagnostics(diagnostics); }
		catch (error) { errors.push(`${keyOf(item)}/${step}: ${error.message}`); }
		if (diagnostics.failure) errors.push(`${keyOf(item)}/${step}: diagnostics.failure=${diagnostics.failure}`);
	}
	if (strict && TRUTH_SETS.has(item.set)) {
		const source = field(result, "item.source") ?? field(result, "truthPath");
		if (!readMotion(source)) errors.push(`${keyOf(item)}/${step}: missing or invalid truth motion`);
	}
	return { ...item, itemDir, step, dir, result, score, motion, motionPath, diagnostics, errors, valid: errors.length === 0 };
}
function loadT1(item) { return loadStep(item, "T1", { strict: true }); }
function loadBaseline(item) { return loadStep(item, "Gbest", { strict: false }); }
function loadG5(item) { return loadStep({ ...item, dir: item.itemDir ?? item.dir }, "G5", { strict: false }); }
function truthPath(record) { return field(record.result, "item.source") ?? field(record.result, "truthPath"); }
function truthMotion(record) { return readMotion(truthPath(record)); }
function scoreValue(record, path) { const value = field(record.score, path); return finite(value) ? value : null; }
function variantOf(record) { return record.result?.item?.variant ?? (record.set.endsWith("-skin") ? "skin" : "shaded"); }
function isHiddenItem(record) { return HIDDEN_SETS.has(record.set) && HIDDEN_NAMES.has(record.name); }

function visibilityFor(record) {
	const values = [field(record.result, "truthVisibility"), field(record.result, "item.truthVisibility"), field(record.diagnostics, "truthVisibility")];
	for (const value of values) if (Array.isArray(value)) return value;
	for (const path of [join(record.dir, "truth-visibility.json"), join(record.dir, "visibility.json")]) if (isFile(path)) return readJson(path);
	return null;
}
function provenance(record) {
	const manifest = field(record.result, "inputs.obs.manifest") ?? field(record.result, "obs.manifest") ?? (isFile(join(record.dir, "obs-mannequin", "manifest.json")) ? readJson(join(record.dir, "obs-mannequin", "manifest.json")) : null);
	const video = field(record.result, "inputs.video") ?? field(record.result, "item.video");
	if (!manifest || !video || !isFile(video) || typeof manifest.detector !== "string" || !manifest.detector) return false;
	const variant = variantOf(record);
	if (variant === "skin" && manifest.detector !== "yolo") return false;
	if (variant !== "skin" && manifest.detector !== SHADED_DETECTOR) return false;
	const expected = createHash("sha256").update(readFileSync(video)).digest("hex");
	const declared = manifest.videoSha256 ?? manifest.video_sha256 ?? manifest.sha256;
	return typeof declared === "string" && declared.length > 0 && declared === expected;
}
function ceilingFor(ceiling, set) {
	const perSet = ceiling?.iouCeiling?.perSet?.[set];
	if (finite(perSet?.is1Threshold)) return perSet.is1Threshold;
	if (finite(perSet?.meanIoURaw)) return perSet.meanIoURaw * 0.9;
	return null;
}
function metric(record) {
	const truth = truthMotion(record), motion = record.motion, diagnostics = record.diagnostics;
	const out = {
		record, truth, motion, diagnostics,
		pa: scoreValue(record, "pose.paMpjpeM"), root: scoreValue(record, "trajectory.rootErrorRawM.rmse"), ate: scoreValue(record, "trajectory.ateAlignedM.rmse"), iou: scoreValue(record, "overlap.maskIoURawMean"),
		stance: null, steps: null, agreement: null, hidden: null, g5Hidden: null, g5: null,
	};
	if (motion) out.steps = Array.from(pelvisStepsDeg(motion.rotMats, motion.frames)).filter(value => value > 20).length;
	if (truth && motion) out.stance = truthStanceSlideCmPerS(motion, truth).meanCmPerS;
	if (isHiddenItem(record) && diagnostics && motion && truth) {
		const visibility = visibilityFor(record);
		if (visibility) {
			try { out.agreement = occlusionAgreement(diagnostics.occluded, visibility).agreement; }
			catch { out.agreement = null; }
		}
		const g5 = loadG5(record);
		out.g5 = g5;
		if (g5.motion) {
			try {
				out.hidden = hiddenJointError(nestedJoints(motion), nestedJoints(truth), diagnostics.occluded).meanM;
				out.g5Hidden = hiddenJointError(nestedJoints(g5.motion), nestedJoints(truth), diagnostics.occluded).meanM;
			} catch { out.hidden = null; out.g5Hidden = null; }
		}
	}
	return out;
}
function invalidDetails(metrics) { return metrics.flatMap(m => m.record.errors).join("; ") || "none"; }
function row(name, pass, detail) { return { name, pass: Boolean(pass), detail }; }
function allFinite(values) { return values.length > 0 && values.every(finite); }

function evaluate(runRecords, baselineRecords, ceiling) {
	const metrics = runRecords.map(metric);
	const baseline = new Map(baselineRecords.map(record => [keyOf(record), metric(record)]));
	const truth = metrics.filter(m => TRUTH_SETS.has(m.record.set));
	const fal = metrics.filter(m => m.record.set === "fal");
	const invalid = metrics.filter(m => !m.record.valid);
	const rows = [];
	const invalidText = invalidDetails(invalid);

	const truthPa = truth.map(m => m.pa), truthRoot = truth.map(m => m.root), truthAte = truth.map(m => m.ate), truthIou = truth.map(m => m.iou);
	const paGroups = [...new Set(truth.map(m => m.record.set))].map(set => ({ set, values: truth.filter(m => m.record.set === set).map(m => m.pa) }));
	const paComparisons = truth.map(m => [m.pa, baseline.get(keyOf(m.record))?.pa]);
	const paPass = !invalid.length && paGroups.length > 0 && paGroups.every(group => allFinite(group.values) && average(group.values) <= 0.05) && paComparisons.every(([value, baselineValue]) => finite(baselineValue) && value <= baselineValue + 0.005);
	rows.push(row("pose.paMpjpeM", paPass, invalidText !== "none" ? invalidText : `${paGroups.map(group => `${group.set} mean ${(average(group.values) ?? Infinity) * 1000} mm`).join(", ")} <= 50 mm per appearance set; each <= Gbest+5 mm`));
	rows.push(row("trajectory.rootErrorRawM", !invalid.length && allFinite(truthRoot) && average(truthRoot) <= 0.15, invalidText !== "none" ? invalidText : `${average(truthRoot) ?? "missing"} m <= 0.15 m`));
	rows.push(row("trajectory.ateAlignedM", !invalid.length && allFinite(truthAte) && average(truthAte) <= 0.15, invalidText !== "none" ? invalidText : `${average(truthAte) ?? "missing"} m <= 0.15 m`));

	const ceilingValues = truth.map(m => ceilingFor(ceiling, m.record.set));
	const setIoU = [...new Set(truth.map(m => m.record.set))].map(set => {
		const values = truth.filter(m => m.record.set === set).map(m => m.iou);
		const threshold = ceilingFor(ceiling, set);
		return { set, values, threshold, value: average(values) };
	});
	const iouPass = !invalid.length && setIoU.length > 0 && setIoU.every(group => allFinite(group.values) && finite(group.threshold) && group.value >= group.threshold);
	rows.push(row("overlap.maskIoURawMean", iouPass, !ceiling ? "missing --ceiling truth IoU measurements" : setIoU.map(group => `${group.set}: ${group.value ?? "missing"} >= ${group.threshold ?? "missing"}`).join(", ")));

	const falIou = fal.map(m => m.iou), falComparisons = fal.map(m => [m.iou, baseline.get(keyOf(m.record))?.iou]);
	const falPass = !invalid.length && (!fal.length || (allFinite(falIou) && average(falIou) >= 0.4 && falComparisons.every(([value, base]) => finite(base) && value >= base - 0.02)));
	rows.push(row("fal.overlapIoU", falPass, !fal.length ? "no fal items" : `mean ${average(falIou) ?? "missing"} >= 0.4; every item >= Gbest-0.02`));

	const stance = truth.map(m => m.stance), baselineStance = truth.map(m => baseline.get(keyOf(m.record))?.stance);
	const stancePass = !invalid.length && allFinite(stance) && allFinite(baselineStance) && average(stance) <= 2.5 && average(stance) <= average(baselineStance);
	rows.push(row("truthStanceSlideCmPerS", stancePass, invalidText !== "none" ? invalidText : `${average(stance) ?? "missing"} cm/s <= 2.5 and Gbest mean ${average(baselineStance) ?? "missing"}`));

	const boxPen = metrics.map(m => m.diagnostics?.penetration?.maxBoxCm), floorPen = metrics.map(m => m.diagnostics?.penetration?.maxFloorCm);
	rows.push(row("penetration.maxBoxCm", !invalid.length && allFinite(boxPen) && boxPen.every(value => value <= 1), invalidText !== "none" ? invalidText : `${maximum(boxPen) ?? "missing"} cm <= 1 cm`));
	rows.push(row("penetration.maxFloorCm", !invalid.length && allFinite(floorPen) && floorPen.every(value => value <= 1), invalidText !== "none" ? invalidText : `${maximum(floorPen) ?? "missing"} cm <= 1 cm`));

	const truthSteps = truth.map(m => m.steps), falSteps = fal.map(m => [m.steps, baseline.get(keyOf(m.record))?.steps]);
	const pelvisPass = !invalid.length && allFinite(truthSteps) && truthSteps.every(value => value === 0) && falSteps.every(([value, base]) => Number.isInteger(value) && Number.isInteger(base) && value <= base);
	rows.push(row("pelvisSteps>20", pelvisPass, invalidText !== "none" ? invalidText : `${maximum(truthSteps) ?? "missing"} truth frames; Fal within Gbest`));

	const hidden = metrics.filter(m => isHiddenItem(m.record));
	const visibilityPass = !invalid.length && hidden.every(m => finite(m.agreement) && m.agreement >= 0.9);
	rows.push(row("occlusionAgreement", visibilityPass, hidden.length ? hidden.map(m => `${keyOf(m.record)}: ${m.agreement ?? "missing"} >= 0.9`).join(", ") : "no cube occlusion items"));
	const hiddenPass = !invalid.length && hidden.every(m => finite(m.hidden) && finite(m.g5Hidden) && m.hidden <= m.g5Hidden);
	rows.push(row("hiddenJointErrorT1<=G5", hiddenPass, hidden.length ? hidden.map(m => `${keyOf(m.record)}: T1 ${m.hidden ?? "missing"} <= G5 ${m.g5Hidden ?? "missing"} on T1 flags`).join(", ") : "no cube occlusion items"));

	const provenancePass = !invalid.length && metrics.every(m => provenance(m.record));
	rows.push(row("obsProvenance", provenancePass, provenancePass ? "manifest video hash and detector match" : metrics.filter(m => !provenance(m.record)).map(m => `${keyOf(m.record)}: mismatch or missing detector/hash`).join(", ") || invalidText));
	const runtimes = metrics.map(m => m.diagnostics?.runtime?.trackerSeconds), vram = metrics.map(m => m.diagnostics?.runtime?.peakReservedMiB);
	const runtimePass = !invalid.length && allFinite(runtimes) && runtimes.every((value, index) => value <= ((metrics[index].motion?.frames ?? 0) <= 124 ? 180 : 540));
	rows.push(row("runtime.trackerSeconds", runtimePass, invalidText !== "none" ? invalidText : `${maximum(runtimes) ?? "missing"} s`));
	rows.push(row("runtime.peakReservedMiB", !invalid.length && allFinite(vram) && vram.every(value => value <= 5632), invalidText !== "none" ? invalidText : `${maximum(vram) ?? "missing"} MiB <= 5632 MiB`));
	return { rows, metrics, invalid };
}

export function runGate(options) {
	const runItems = itemDirs(options.run), baselineItems = itemDirs(options.baseline);
	const runRecords = runItems.map(loadT1), baselineRecords = baselineItems.map(loadBaseline);
	const ceiling = options.ceiling ? readJson(options.ceiling) : null;
	return evaluate(runRecords, baselineRecords, ceiling);
}
export { evaluate };

async function main() {
	let options;
	try { options = parseArgs(process.argv.slice(2)); }
	catch (error) { console.error(`${error.message}\n\n${USAGE}`); process.exitCode = 2; return; }
	try {
		const result = runGate(options);
		let failed = 0;
		for (const check of result.rows) { console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`); if (!check.pass) failed += 1; }
		if (failed) process.exitCode = 1;
	} catch (error) { console.error(`gate error: ${error.message}`); process.exitCode = 2; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
