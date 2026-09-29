import assert from "node:assert/strict";
import { buildRemoteCommand, gpuBusyDecision, normalizeTransfers } from "../tools/track/run-box.mjs";

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
console.log("verify-track-run-box: command builder and GPU-busy decision passed");
