import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

const readyPath = process.argv[2];
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
	stdio: "ignore",
});
// Write-then-rename: the watcher in verify-lifecycle fires on creation, and
// under a loaded runner it read an empty file before the JSON landed (#413).
// A rename makes the file appear with its whole content.
writeFileSync(`${readyPath}.tmp`, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
renameSync(`${readyPath}.tmp`, readyPath);
setInterval(() => {}, 1000);
