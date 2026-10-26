// Duration-balanced test shards (#632). tools/test-durations.json holds the
// per-file wall-clock seconds of a full run; `node tools/update-test-durations.mjs`
// refreshes it from the artifacts of the latest pages.yml run on main.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export const DURATIONS_PATH = new URL("./test-durations.json", import.meta.url);

export function readDurations(path = DURATIONS_PATH) {
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

// Sorted keys, seconds to one decimal: the format of tools/test-durations.json.
export function writeDurations(path, durations) {
	const entries = Object.entries(durations).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	writeFileSync(path, `${JSON.stringify(Object.fromEntries(entries.map(([file, seconds]) => [file, Math.round(seconds * 10) / 10])), null, "\t")}\n`);
}

function median(values) {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (sorted.length === 0) return 1;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// A file with no recorded time counts as the median of every recorded time,
// so a batch of new suites spreads over the shards instead of piling up.
export function estimate(files, durations) {
	const fallback = median(Object.values(durations));
	return new Map(files.map((file) => [file, Number.isFinite(durations[file]) ? durations[file] : fallback]));
}

// Longest first, ties by path, so the tail of a run is never one slow suite.
export function slowestFirst(files, durations) {
	const seconds = estimate(files, durations);
	return [...files].sort((a, b) => seconds.get(b) - seconds.get(a) || (a < b ? -1 : a > b ? 1 : 0));
}

// LPT: each file, longest first, goes to the shard with the smallest predicted
// sum (lowest index on a tie). Every CI shard computes the same split from the
// same inputs, so the shards never need to agree at run time.
export function assignShards(files, durations, total) {
	const seconds = estimate(files, durations);
	const shards = Array.from({ length: total }, () => ({ files: [], predicted: 0 }));
	for (const file of slowestFirst(files, durations)) {
		const lightest = shards.reduce((best, shard) => (shard.predicted < best.predicted ? shard : best));
		lightest.files.push(file);
		lightest.predicted += seconds.get(file);
	}
	return shards;
}

export function parseShard(value = "") {
	const match = /^(\d+)\/(\d+)$/.exec(value);
	const current = Number(match?.[1]);
	const total = Number(match?.[2]);
	if (!match || current < 1 || total < 1 || current > total) {
		throw new Error(`--shard must be INDEX/TOTAL with 1 <= INDEX <= TOTAL, got ${value}`);
	}
	return { current, total };
}

// Runs once the suite ends, pass or fail: writes --durations-out and, on a CI
// runner, one line of the job's step summary.
export function reportDurations(timings, { out, selected, predicted }) {
	const actual = [...timings.values()].reduce((sum, seconds) => sum + seconds, 0);
	if (out) writeDurations(out, Object.fromEntries(timings));
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary) appendFileSync(summary, `selected ${selected}, predicted ${predicted.toFixed(1)} s, actual ${actual.toFixed(1)} s\n`);
}
