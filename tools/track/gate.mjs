#!/usr/bin/env node
/** Quality gates for one completed T1 run. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readNpz } from "../kimodo/read-npz.mjs";
import { cameraFromJson } from "../bench/obs/extrinsics.mjs";
import { resolveObsOrigin } from "./masks.mjs";
import { hiddenJointError, occlusionAgreement, pelvisStepsDeg, resampleMotion, truthStanceSlideCmPerS } from "./metrics.mjs";
import { validateDiagnostics } from "./remote.mjs";
import { jointOccluded } from "./study-2d.mjs";

const USAGE = "usage: node tools/track/gate.mjs --run <dir> [--baseline <dir>] [--ceiling <summary.json>]\n  Gbest comparisons use --run's own Gbest step. --baseline, if given, must be a run dir with item\n  directories; no row reads values from it (historical run-492f comparisons live in study-2d / todo 14 tables).";
const TRUTH_SETS = new Set(["gt", "cube", "gt-skin", "cube-skin"]);
const HIDDEN_SETS = new Set(["cube", "cube-skin"]);
const HIDDEN_NAMES = new Set(["bump", "sit"]);
const SHADED_DETECTOR = ["p", "alette"].join("");
/** Score fields per scorer: tools/bench/score.mjs for truth sets, obs-bench scoreFal for fal. */
const TRUTH_SCORE_FIELDS = ["pose.paMpjpeM", "trajectory.rootErrorRawM.rmse", "trajectory.ateAlignedM.rmse", "overlap.maskIoURawMean"];
const FAL_SCORE_FIELDS = ["overlapIoU", "endpointFirstM", "endpointLastM", "maxPenetrationM"];
/** Obs manifest provenance the gate accepts: hashed at extraction, or hashed later from the path the sweep used. */
const ACCEPTED_PROVENANCE = ["recorded", "backfilled-path"];

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
	return { run: resolve(out.run), baseline: out.baseline ? resolve(out.baseline) : null, ceiling: out.ceiling ? resolve(out.ceiling) : null };
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

/**
 * { motion } or { motion: null, error }. Every measured series (pelvis angles,
 * stance slide, joint errors) derives from posed_joints / local_rot_mats, so a
 * non-finite value there makes the motion unmeasurable here, at the file
 * boundary: downstream counts such as `angles.filter(v => v > 20)` would
 * otherwise silently drop NaN and report a clean 0.
 */
function readMotionChecked(path) {
	if (!isFile(path)) return { motion: null, error: "missing" };
	const members = readNpz(path);
	const joints = members.posed_joints;
	const rotations = members.local_rot_mats ?? members.rotMats;
	if (!joints?.data || JSON.stringify(joints.shape?.slice(1)) !== "[27,3]") return { motion: null, error: "posed_joints is not [T,27,3]" };
	const frames = joints.shape[0], fps = members.fps?.data?.[0] ?? 24;
	if (!Number.isInteger(frames) || frames < 1 || !finite(fps) || fps <= 0) return { motion: null, error: "bad frame count or fps" };
	if (!rotations?.data || rotations.data.length !== frames * 27 * 9) return { motion: null, error: "local_rot_mats is not [T,27,3,3]" };
	for (const [name, data] of [["posed_joints", joints.data], ["local_rot_mats", rotations.data]]) {
		const bad = data.findIndex(value => !Number.isFinite(value));
		if (bad >= 0) return { motion: null, error: `non-finite ${name}[${bad}] = ${data[bad]}` };
	}
	return { motion: { frames, fps, posedJoints: joints.data, rotMats: rotations.data }, error: null };
}
function readMotion(path) { return readMotionChecked(path).motion; }
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
	const { motion, error: motionError } = readMotionChecked(motionPath);
	const diagnostics = isFile(diagnosticsPath) ? readJson(diagnosticsPath) : null;
	if (strict && !score) errors.push(`${keyOf(item)}/${step}: missing score.json`);
	if (strict && score) {
		const required = TRUTH_SETS.has(item.set) ? TRUTH_SCORE_FIELDS : FAL_SCORE_FIELDS;
		for (const path of required) if (!finite(field(score, path))) errors.push(`${keyOf(item)}/${step}: missing score field ${path}`);
	}
	if (strict && !motion) errors.push(`${keyOf(item)}/${step}: motion.npz ${motionError}`);
	if (strict && !diagnostics) errors.push(`${keyOf(item)}/${step}: missing diagnostics.json`);
	if (strict && diagnostics) {
		try { validateDiagnostics(diagnostics); }
		catch (error) { errors.push(`${keyOf(item)}/${step}: ${error.message}`); }
		if (diagnostics.failure) errors.push(`${keyOf(item)}/${step}: diagnostics.failure=${diagnostics.failure}`);
	}
	if (strict && TRUTH_SETS.has(item.set)) {
		const source = field(result, "item.source") ?? field(result, "truthPath");
		const truth = readMotionChecked(source);
		if (!truth.motion) errors.push(`${keyOf(item)}/${step}: truth motion ${source ?? "?"} ${truth.error}`);
	}
	return { ...item, itemDir, step, dir, result, score, motion, motionError, motionPath, diagnostics, errors, valid: errors.length === 0 };
}
function loadT1(item) { return loadStep(item, "T1", { strict: true }); }
function loadG5(item) { return loadStep({ ...item, dir: item.itemDir ?? item.dir }, "G5", { strict: false }); }
function truthPath(record) { return field(record.result, "item.source") ?? field(record.result, "truthPath"); }
function truthMotion(record) { return readMotion(truthPath(record)); }
function scoreValue(record, path) { const value = field(record.score, path); return finite(value) ? value : null; }
function variantOf(record) { return record.result?.item?.variant ?? (record.set.endsWith("-skin") ? "skin" : "shaded"); }
function isHiddenItem(record) { return HIDDEN_SETS.has(record.set) && HIDDEN_NAMES.has(record.name); }

/**
 * Truth visibility on the prediction's timeline: truth joints (spline-resampled
 * to pred fps/frames) tested along the camera ray against the item's scene
 * boxes, the same segment test the tracker's `occluded` flags use (true = visible).
 */
function truthVisibility(record, truthOnPred) {
	const cameraPath = field(record.result, "inputs.camera.path"), scenePath = field(record.result, "item.scene") ?? field(record.result, "inputs.scene");
	if (!truthOnPred || !isFile(cameraPath) || !isFile(scenePath)) return null;
	const centre = cameraFromJson(readJson(cameraPath)).t_c2w;
	const scene = readJson(scenePath);
	const boxes = Array.isArray(scene) ? scene : [scene];
	const joints = truthOnPred.posedJoints.length / (truthOnPred.frames * 3);
	return Array.from({ length: truthOnPred.frames }, (_, t) => Array.from({ length: joints }, (_, j) => {
		const o = (t * joints + j) * 3;
		return !jointOccluded(centre, [truthOnPred.posedJoints[o], truthOnPred.posedJoints[o + 1], truthOnPred.posedJoints[o + 2]], boxes);
	}));
}
const sha256File = path => createHash("sha256").update(readFileSync(path)).digest("hex");
/**
 * The obs the step consumed, traced to its original manifest (run copies are
 * followed via `source`/`sourceSha256`, as masks.mjs does). Passes when that
 * manifest's provenance is recorded|backfilled-path, its detector matches the
 * appearance, the obs still has the recorded sha, and the item's extraction
 * video (item.video for fal, else inputs.video) hashes to videoSha256.
 */
function provenance(record) {
	const fail = reason => ({ ok: false, kind: null, reason });
	const obs = field(record.result, "inputs.obs");
	let manifest = obs?.manifest ?? null, originObs = null;
	if (isFile(obs?.obs)) {
		try { ({ manifest, obs: originObs } = resolveObsOrigin(obs.obs)); }
		catch (error) { return fail(error.message); }
	} else if (manifest?.source) return fail(`obs copy ${obs?.obs ?? "?"} is missing`);
	if (!manifest) return fail("no obs manifest");
	const kind = manifest.provenance ?? "recorded";
	if (!ACCEPTED_PROVENANCE.includes(kind)) return fail(`provenance ${kind} is not ${ACCEPTED_PROVENANCE.join("|")}`);
	if (typeof manifest.videoSha256 !== "string" || !manifest.videoSha256) return fail("manifest has no videoSha256");
	if (kind === "backfilled-path" && (typeof manifest.backfilledAt !== "string" || typeof manifest.obsSha256 !== "string")) return fail("backfilled manifest lacks backfilledAt/obsSha256");
	if (typeof manifest.detector !== "string" || !manifest.detector) return fail("manifest has no detector");
	const wanted = variantOf(record) === "skin" ? "yolo" : SHADED_DETECTOR;
	if (manifest.detector !== wanted) return fail(`detector ${manifest.detector}, expected ${wanted}`);
	if (originObs && manifest.obsSha256 && sha256File(originObs) !== manifest.obsSha256) return fail(`${originObs} changed after its manifest was written`);
	const video = field(record.result, "item.video") ?? field(record.result, "inputs.video");
	if (!isFile(video)) return fail(`video ${video ?? "?"} is missing`);
	if (sha256File(video) !== manifest.videoSha256) return fail(`video ${video} does not hash to the manifest's videoSha256`);
	return { ok: true, kind, reason: null };
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
		pa: scoreValue(record, "pose.paMpjpeM"), root: scoreValue(record, "trajectory.rootErrorRawM.rmse"), ate: scoreValue(record, "trajectory.ateAlignedM.rmse"),
		iou: scoreValue(record, record.set === "fal" ? "overlapIoU" : "overlap.maskIoURawMean"),
		endpointA: scoreValue(record, "endpointFirstM"), endpointB: scoreValue(record, "endpointLastM"),
		scorerPenetrationCm: record.set === "fal" && finite(field(record.score, "maxPenetrationM")) ? record.score.maxPenetrationM * 100 : null,
		stance: null, steps: null, agreement: null, hidden: null, g5Hidden: null, g5: null, hiddenError: null,
	};
	if (motion) out.steps = Array.from(pelvisStepsDeg(motion.rotMats, motion.frames)).filter(value => value > 20).length;
	if (truth && motion) out.stance = truthStanceSlideCmPerS(motion, truth).meanCmPerS;
	if (record.step === "T1") Object.assign(out, sameRunGbest(record, truth));
	if (isHiddenItem(record) && diagnostics && motion && truth) {
		try {
			// Truth is compared on the prediction's timeline (e.g. 30 fps truth vs a 24 fps T1).
			const truthOnPred = resampleMotion(truth, motion.fps, motion.frames);
			const visibility = truthVisibility(record, truthOnPred);
			if (!visibility) throw new Error("no truth visibility: item needs inputs.camera.path and item.scene");
			out.agreement = occlusionAgreement(diagnostics.occluded, visibility).agreement;
			const g5 = loadG5(record);
			out.g5 = g5;
			if (!g5.motion) throw new Error(`same-run G5 motion.npz ${g5.motionError}`);
			out.hidden = hiddenJointError(nestedJoints(motion), nestedJoints(truthOnPred), diagnostics.occluded).meanM;
			out.g5Hidden = hiddenJointError(nestedJoints(g5.motion), nestedJoints(truthOnPred), diagnostics.occluded).meanM;
		} catch (error) { out.hiddenError = error.message; }
	}
	out.provenance = provenance(record);
	return out;
}
/**
 * Every "<= its Gbest" comparison in the IS table (IS-1 fal IoU and pelvis steps,
 * IS-2 PA +5 mm, IS-4 stance slide re-measured with the same metric) uses the
 * Gbest step of the SAME run dir, scored by the same scorer on the same obs;
 * --baseline may not even hold this appearance set. Each value that cannot be
 * read comes with a concrete `<name>Reason` instead.
 */
function sameRunGbest(record, truth) {
	const gbest = loadStep({ ...record, dir: record.itemDir ?? record.dir }, "Gbest", { strict: false });
	const why = text => `${keyOf(record)}: ${text}`;
	// Only a genuine Gbest result can be the comparator: a declared fallback or another step's
	// result under Gbest/ (e.g. G5 standing in) would make a weaker baseline look like Gbest.
	const declared = gbest.result, declaredItem = declared?.item;
	const blocked = !declared ? why("no same-run Gbest/result.json")
		: declared.ok !== true ? why("same-run Gbest result.ok is not true")
		: declared.step !== "Gbest" ? why(`same-run Gbest/result.json declares step ${JSON.stringify(declared.step ?? null)}, not "Gbest"`)
		: declared.fallback != null ? why(`same-run Gbest declares fallback=${declared.fallback}; not a Gbest comparator`)
		: declaredItem && (declaredItem.set !== record.set || declaredItem.name !== record.name) ? why(`same-run Gbest/result.json is for ${declaredItem.set}/${declaredItem.name}`)
		: null;
	const out = {};
	const put = (name, value, reason) => {
		if (!blocked && finite(value)) { out[name] = value; out[`${name}Reason`] = null; }
		else { out[name] = null; out[`${name}Reason`] = blocked ?? why(reason); }
	};
	put("gbestPa", scoreValue(gbest, "pose.paMpjpeM"), `same-run Gbest ${gbest.score ? "score.json has no pose.paMpjpeM" : "score/score.json missing"}`);
	const iouField = record.set === "fal" ? "overlapIoU" : "overlap.maskIoURawMean";
	put("gbestIou", scoreValue(gbest, iouField), `same-run Gbest ${gbest.score ? `score.json has no ${iouField}` : "score/score.json missing"}`);
	const motionReason = `same-run Gbest motion.npz ${gbest.motionError}`;
	put("gbestSteps", gbest.motion ? Array.from(pelvisStepsDeg(gbest.motion.rotMats, gbest.motion.frames)).filter(value => value > 20).length : null, motionReason);
	const stance = gbest.motion && truth ? truthStanceSlideCmPerS(gbest.motion, truth).meanCmPerS : null;
	put("gbestStance", stance, !gbest.motion ? motionReason : !truth ? "truth motion missing or invalid" : "same-run Gbest has no truth-stance samples");
	return out;
}
/** Per-item "vs same-run Gbest" sub-check: missing Gbest values and violations are named, never compared as NaN. */
function gbestCheck(items, name, holds, describe) {
	const missing = items.filter(m => !finite(m[name])).map(m => m[`${name}Reason`]);
	const failing = items.filter(m => finite(m[name]) && !holds(m)).map(describe);
	const problems = [...failing, ...missing];
	return { pass: problems.length === 0, text: problems.length ? `[FAIL: ${problems.join("; ")}]` : "[ok]" };
}
function invalidDetails(metrics) { return metrics.flatMap(m => m.record.errors).join("; ") || "none"; }
function row(name, pass, detail) { return { name, pass: Boolean(pass), detail }; }
function allFinite(values) { return values.length > 0 && values.every(finite); }

function evaluate(runRecords, ceiling) {
	const metrics = runRecords.map(metric);
	const truth = metrics.filter(m => TRUTH_SETS.has(m.record.set));
	const fal = metrics.filter(m => m.record.set === "fal");
	const invalid = metrics.filter(m => !m.record.valid);
	const rows = [];
	const invalidText = invalidDetails(invalid);

	const truthPa = truth.map(m => m.pa), truthRoot = truth.map(m => m.root), truthAte = truth.map(m => m.ate), truthIou = truth.map(m => m.iou);
	const paGroups = [...new Set(truth.map(m => m.record.set))].map(set => ({ set, values: truth.filter(m => m.record.set === set).map(m => m.pa) }));
	const paGbest = gbestCheck(truth, "gbestPa", m => finite(m.pa) && m.pa <= m.gbestPa + 0.005, m => `${keyOf(m.record)} ${finite(m.pa) ? m.pa * 1000 : "missing"} mm > Gbest ${m.gbestPa * 1000}+5 mm`);
	const paMeanPass = paGroups.length > 0 && paGroups.every(group => allFinite(group.values) && average(group.values) <= 0.05);
	const paPass = !invalid.length && paMeanPass && paGbest.pass;
	rows.push(row("pose.paMpjpeM", paPass, invalidText !== "none" ? invalidText : `${paGroups.map(group => `${group.set} mean ${(average(group.values) ?? Infinity) * 1000} mm`).join(", ")} <= 50 mm per appearance set [${paMeanPass ? "ok" : "FAIL"}]; each <= same-run Gbest+5 mm ${paGbest.text}`));
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

	const falIou = fal.map(m => m.iou);
	const falGbest = gbestCheck(fal, "gbestIou", m => finite(m.iou) && m.iou >= m.gbestIou - 0.02, m => `${keyOf(m.record)} IoU ${m.iou ?? "missing"} < Gbest ${m.gbestIou}-0.02`);
	const falMeanPass = allFinite(falIou) && average(falIou) >= 0.4;
	const falPass = !invalid.length && (!fal.length || (falMeanPass && falGbest.pass));
	const falItems = fal.map(m => `${keyOf(m.record)} IoU ${m.iou ?? "missing"} (Gbest ${m.gbestIou ?? "missing"}) A ${m.endpointA ?? "missing"} m B ${m.endpointB ?? "missing"} m pen ${m.scorerPenetrationCm ?? "missing"} cm`).join("; ");
	rows.push(row("fal.overlapIoU", falPass, !fal.length ? "no fal items" : `mean ${average(falIou) ?? "missing"} >= 0.4 [${falMeanPass ? "ok" : "FAIL"}]; every item >= same-run Gbest-0.02 ${falGbest.text} [${falItems}]`));

	const stance = truth.map(m => m.stance), gbestStance = truth.map(m => m.gbestStance);
	const stanceMissing = truth.filter(m => !finite(m.stance)).map(m => `${keyOf(m.record)}: T1 has no truth-stance samples`);
	const gbestMissing = truth.filter(m => !finite(m.gbestStance)).map(m => m.gbestStanceReason);
	const stanceMean = stanceMissing.length ? null : average(stance), gbestMean = gbestMissing.length ? null : average(gbestStance);
	const capPass = finite(stanceMean) && stanceMean <= 2.5, gbestPass = finite(stanceMean) && finite(gbestMean) && stanceMean <= gbestMean;
	const stanceText = `${stanceMean ?? `missing (${stanceMissing.join("; ") || "no truth items"})`} cm/s <= 2.5 [${capPass ? "ok" : "FAIL"}]; <= same-run Gbest mean ${gbestMean ?? `missing (${gbestMissing.join("; ") || "no truth items"})`} [${gbestPass ? "ok" : "FAIL"}]`;
	rows.push(row("truthStanceSlideCmPerS", !invalid.length && capPass && gbestPass, invalidText !== "none" ? invalidText : stanceText));

	// Fal items also carry the scorer's independent box penetration; the larger of the two counts.
	const boxPen = metrics.map(m => { const own = m.diagnostics?.penetration?.maxBoxCm; return finite(own) && finite(m.scorerPenetrationCm) ? Math.max(own, m.scorerPenetrationCm) : own; }), floorPen = metrics.map(m => m.diagnostics?.penetration?.maxFloorCm);
	rows.push(row("penetration.maxBoxCm", !invalid.length && allFinite(boxPen) && boxPen.every(value => value <= 1), invalidText !== "none" ? invalidText : `${maximum(boxPen) ?? "missing"} cm <= 1 cm`));
	rows.push(row("penetration.maxFloorCm", !invalid.length && allFinite(floorPen) && floorPen.every(value => value <= 1), invalidText !== "none" ? invalidText : `${maximum(floorPen) ?? "missing"} cm <= 1 cm`));

	const truthSteps = truth.map(m => m.steps);
	const truthStepsPass = allFinite(truthSteps) && truthSteps.every(value => value === 0);
	const falSteps = gbestCheck(fal, "gbestSteps", m => Number.isInteger(m.steps) && m.steps <= m.gbestSteps, m => `${keyOf(m.record)} ${m.steps ?? "missing"} frames > Gbest ${m.gbestSteps}`);
	const pelvisPass = !invalid.length && truthStepsPass && falSteps.pass;
	rows.push(row("pelvisSteps>20", pelvisPass, invalidText !== "none" ? invalidText : `${maximum(truthSteps) ?? "missing"} truth frames == 0 [${truthStepsPass ? "ok" : "FAIL"}]; Fal <= same-run Gbest ${fal.length ? falSteps.text : "[no fal items]"}`));

	const hidden = metrics.filter(m => isHiddenItem(m.record));
	const visibilityPass = !invalid.length && hidden.every(m => finite(m.agreement) && m.agreement >= 0.9);
	rows.push(row("occlusionAgreement", visibilityPass, hidden.length ? hidden.map(m => `${keyOf(m.record)}: ${m.agreement ?? `missing (${m.hiddenError ?? "no T1 diagnostics/motion/truth"})`} >= 0.9`).join(", ") : "no cube occlusion items"));
	const hiddenPass = !invalid.length && hidden.every(m => finite(m.hidden) && finite(m.g5Hidden) && m.hidden <= m.g5Hidden);
	rows.push(row("hiddenJointErrorT1<=G5", hiddenPass, hidden.length ? hidden.map(m => `${keyOf(m.record)}: T1 ${m.hidden ?? "missing"} <= G5 ${m.g5Hidden ?? "missing"} on T1 flags`).join(", ") : "no cube occlusion items"));

	// Input provenance is a property of the obs, independent of whether T1 itself fell back.
	const provenancePass = metrics.length > 0 && metrics.every(m => m.provenance.ok);
	const byKind = ACCEPTED_PROVENANCE.map(kind => [kind, metrics.filter(m => m.provenance.ok && m.provenance.kind === kind).map(m => keyOf(m.record))]).filter(([, items]) => items.length);
	const provenanceText = [...byKind.map(([kind, items]) => `${kind} ${items.length} (${items.join(", ")})`), ...metrics.filter(m => !m.provenance.ok).map(m => `${keyOf(m.record)}: ${m.provenance.reason}`)].join("; ");
	rows.push(row("obsProvenance", provenancePass, provenanceText || "no items"));
	const runtimes = metrics.map(m => m.diagnostics?.runtime?.trackerSeconds), vram = metrics.map(m => m.diagnostics?.runtime?.peakReservedMiB);
	const runtimePass = !invalid.length && allFinite(runtimes) && runtimes.every((value, index) => value <= ((metrics[index].motion?.frames ?? 0) <= 124 ? 180 : 540));
	rows.push(row("runtime.trackerSeconds", runtimePass, invalidText !== "none" ? invalidText : `${maximum(runtimes) ?? "missing"} s`));
	rows.push(row("runtime.peakReservedMiB", !invalid.length && allFinite(vram) && vram.every(value => value <= 5632), invalidText !== "none" ? invalidText : `${maximum(vram) ?? "missing"} MiB <= 5632 MiB`));
	return { rows, metrics, invalid };
}

export function runGate(options) {
	const runRecords = itemDirs(options.run).map(loadT1);
	// --baseline stays accepted (the plan's gate command passes run-492f) but no IS row compares to
	// it: every Gbest comparison uses the run's own Gbest step (sameRunGbest).
	if (options.baseline) itemDirs(options.baseline);
	const ceiling = options.ceiling ? readJson(options.ceiling) : null;
	return evaluate(runRecords, ceiling);
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
