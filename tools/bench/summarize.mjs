#!/usr/bin/env node
/**
 * Collect tools/bench/score.mjs results into one table (#431).
 *
 *   node tools/bench/summarize.mjs [--md <file>] [--csv <file>] <score dir ...>
 *
 * Every argument is a score.mjs --out directory (holding score.json). The
 * markdown table is printed to stdout and, with --md, written to that file;
 * --csv writes the same columns as CSV (full precision).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const mm = (m) => (m === null || m === undefined ? null : m * 1000);
const cm = (m) => (m === null || m === undefined ? null : m * 100);
const resultFor = (dir) => {
	const file = join(dirname(resolve(dir)), "result.json");
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
};

/** [header, unit note, value(score), markdown digits] */
const COLUMNS = [
	["case", "", (s, dir) => basename(dir), null],
	["frames", "scored/GT", (s) => `${s.timeline.scoredFrames}/${s.gt.frames}`, null],
	["MPJPE raw", "mm, root-relative", (s) => mm(s.pose.mpjpeRootRelativeRawM), 1],
	["MPJPE aligned", "mm, root-relative", (s) => mm(s.pose.mpjpeRootRelativeAlignedM), 1],
	["PA-MPJPE", "mm", (s) => mm(s.pose.paMpjpeM), 1],
	["align yaw", "deg", (s) => s.alignment.yawDeg, 2],
	["align shift", "m (XZ)", (s) => Math.hypot(s.alignment.translationM[0], s.alignment.translationM[2]), 3],
	["root err raw", "m RMSE", (s) => s.trajectory.rootErrorRawM.rmse, 3],
	["ATE aligned", "m RMSE", (s) => s.trajectory.ateAlignedM.rmse, 3],
	["path ratio", "pred/GT", (s) => s.trajectory.pathLengthRatio, 3],
	["disp ratio", "pred/GT", (s) => s.trajectory.displacementRatio, 3],
	["first err aligned", "m", (s) => s.endpoints.firstFrame.jointErrorAlignedM, 3],
	["last err raw", "m", (s) => s.endpoints.lastFrame.jointErrorRawM, 3],
	["last err aligned", "m", (s) => s.endpoints.lastFrame.jointErrorAlignedM, 3],
	["IoU raw", "mean", (s) => s.overlap.maskIoURawMean, 4],
	["IoU aligned", "mean", (s) => s.overlap.maskIoUAlignedMean, 4],
	["foot slide pred", "cm/s", (s) => s.physical.pred.footSlideCmPerS, 2],
	["foot slide GT", "cm/s", (s) => s.physical.gt?.footSlideCmPerS, 2],
	["jitter pred", "mm/s^2", (s) => s.physical.pred.jitterMmPerS2, 0],
	["jitter GT", "mm/s^2", (s) => s.physical.gt?.jitterMmPerS2, 0],
	["below floor pred", "frames", (s) => s.physical.pred.framesBelowFloor, null],
	["box min dist pred", "cm, aligned", (s) => cm(s.contact?.predAligned?.minDistanceM), 1],
	["box min dist GT", "cm", (s) => cm(s.contact?.gt?.minDistanceM), 1],
	["box penetration pred", "cm, aligned", (s) => cm(s.contact?.predAligned?.maxPenetrationM), 1],
	["box penetration GT", "cm", (s) => cm(s.contact?.gt?.maxPenetrationM), 1],
	["npz frame-0 offset", "m", (s) => s.npz.frame0RootOffsetM, 3],
	["runtimeS", "s", (s, dir) => resultFor(dir)?.runtimeS, 2],
	["peakVramMB", "MB", (s, dir) => resultFor(dir)?.peakVramMB, 0],
	["LR switches", "count", (s, dir) => resultFor(dir)?.lrSwitches, null],
	["occluded frames", "frames", (s, dir) => resultFor(dir)?.occludedFrames, null],
];

function main() {
	const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { md: { type: "string" }, csv: { type: "string" }, help: { type: "boolean", short: "h", default: false } } });
	if (values.help || !positionals.length) {
		console.log("usage: node tools/bench/summarize.mjs [--md <file>] [--csv <file>] <score dir ...>");
		process.exit(values.help ? 0 : 2);
	}
	const rows = positionals.map((dir) => {
		const file = join(resolve(dir), "score.json");
		if (!existsSync(file)) throw new Error(`${dir}: no score.json`);
		const score = JSON.parse(readFileSync(file, "utf8"));
		return COLUMNS.map(([, , value]) => value(score, resolve(dir)));
	});
	const show = (value, digits) => (value === null || value === undefined ? "-" : typeof value === "number" && digits !== null ? value.toFixed(digits) : String(value));
	const md = [
		`| ${COLUMNS.map(([name, unit]) => (unit ? `${name} (${unit})` : name)).join(" | ")} |`,
		`|${COLUMNS.map((_, i) => (i === 0 ? " --- " : " ---: ")).join("|")}|`,
		...rows.map((row) => `| ${row.map((value, i) => show(value, COLUMNS[i][3])).join(" | ")} |`),
	].join("\n");
	console.log(md);
	if (values.md) writeFileSync(values.md, `${md}\n`);
	if (values.csv) {
		const quote = (v) => {
			const text = v === null || v === undefined ? "" : String(v);
			return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
		};
		const csv = [COLUMNS.map(([name, unit]) => quote(unit ? `${name} (${unit})` : name)).join(","), ...rows.map((row) => row.map(quote).join(","))];
		writeFileSync(values.csv, `${csv.join("\n")}\n`);
	}
}

main();
