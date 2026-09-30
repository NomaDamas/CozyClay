import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRemoteCommand, gpuBusyDecision, normalizeTransfers, runBox } from "../tools/track/run-box.mjs";

const command = buildRemoteCommand("/tmp/cozyfit-test", "check_env.py");
assert.match(command, /GPU idle for GVHMR/);
assert.match(command, /cozyfit\/\.venv\/bin\/python/);
assert.match(command, /check_env\.py/);
assert.match(command, /set -e/);
assert.equal(gpuBusyDecision({ processes: ["python cclay_gvhmr_extract.py"], usedMiB: 0 }), true);
assert.equal(gpuBusyDecision({ processes: ["python cclay_bench_extract.py"], usedMiB: 0 }), true);
assert.equal(gpuBusyDecision({ processes: ["python unrelated.py"], usedMiB: 1600 }), false);
assert.equal(gpuBusyDecision({ processes: [], usedMiB: 1601 }), true);
assert.equal(gpuBusyDecision({ processes: [], usedMiB: 1200 }), false);
assert.match(buildRemoteCommand("/tmp/x", "pytest", ["-q", "test_scene.py"]), /cozyfit\/\.venv\/bin\/pytest/);
assert.deepEqual(normalizeTransfers([{ localPath: "/tmp/input.bin", remoteRelPath: "inputs/input.bin" }], "upload"), [{ localPath: "/tmp/input.bin", remoteRelPath: "inputs/input.bin" }]);
assert.deepEqual(normalizeTransfers(["outputs/result.bin:/tmp/result.bin"], "fetch"), [{ localPath: "/tmp/result.bin", remoteRelPath: "outputs/result.bin" }]);
assert.throws(() => normalizeTransfers([{ localPath: "/tmp/x", remoteRelPath: "../escape" }], "upload"), /unsafe remote relative path/);
assert.throws(() => buildRemoteCommand("/tmp/x", "no_such.sh"), /invalid Python entry/);

// Fetch-on-failure through the real runBox flow; the fake box holds only the files in `remoteFiles`.
const root = mkdtempSync(join(tmpdir(), "run-box-"));
try {
	const fakeBox = ({ runFails, remoteFiles }) => {
		const calls = [];
		const spawnCommand = async (program, argv) => {
			const last = argv.at(-1), source = argv.at(-2);
			calls.push({ program, last });
			if (program === "ssh" && last.includes("exec ")) {
				if (runFails) throw new Error("ssh exited 3: [track] keypoint-residual");
				return "[track] result ok";
			}
			if (program === "scp" && source.startsWith("box:")) {
				const name = source.split("/").at(-1);
				if (!(name in remoteFiles)) throw new Error(`scp exited 1: ${name}: No such file or directory`);
				writeFileSync(last, remoteFiles[name]);
			}
			return "";
		};
		return { calls, spawnCommand };
	};
	const fetch = (dir) => [{ remoteRelPath: "motion.npz", localPath: join(root, dir, "motion.npz") }, { remoteRelPath: "diagnostics.json", localPath: join(root, dir, "diagnostics.json") }];

	// Failed command, diagnostics present, motion absent: original error, diagnostics fetched.
	const failed = fakeBox({ runFails: true, remoteFiles: { "diagnostics.json": "{\"failure\":\"keypoint-residual\"}" } });
	const error = await runBox({ entry: "track.py", hostName: "box", fetch: fetch("failed"), spawnCommand: failed.spawnCommand }).then(() => null, (e) => e);
	assert.ok(error, "non-zero remote exit still rejects");
	assert.match(error.message, /^ssh exited 3: \[track\] keypoint-residual/);
	assert.deepEqual(error.fetched, [join(root, "failed", "diagnostics.json")]);
	assert.equal(JSON.parse(readFileSync(join(root, "failed", "diagnostics.json"), "utf8")).failure, "keypoint-residual");
	assert.equal(existsSync(join(root, "failed", "motion.npz")), false);
	assert.ok(failed.calls.at(-1).last.startsWith("rm -rf "), "remote dir still cleaned up");

	// Failed command with no outputs at all: the command error, not an scp error.
	const empty = fakeBox({ runFails: true, remoteFiles: {} });
	await assert.rejects(runBox({ entry: "track.py", hostName: "box", fetch: fetch("empty"), spawnCommand: empty.spawnCommand }),
		(e) => /^ssh exited 3/.test(e.message) && Array.isArray(e.fetched) && e.fetched.length === 0);

	// Successful command keeps strict fetching: both outputs, and a missing one is an error.
	const ok = fakeBox({ runFails: false, remoteFiles: { "motion.npz": "m", "diagnostics.json": "{}" } });
	const result = await runBox({ entry: "track.py", hostName: "box", fetch: fetch("ok"), spawnCommand: ok.spawnCommand });
	assert.deepEqual(result, { output: "[track] result ok", fetched: fetch("ok").map((item) => item.localPath) });
	const partial = fakeBox({ runFails: false, remoteFiles: { "diagnostics.json": "{}" } });
	await assert.rejects(runBox({ entry: "track.py", hostName: "box", fetch: fetch("partial"), spawnCommand: partial.spawnCommand }), /scp exited 1: motion\.npz/);
} finally { rmSync(root, { recursive: true, force: true }); }
console.log("verify-track-run-box: command builder, GPU-busy decision and fetch-on-failure passed");
