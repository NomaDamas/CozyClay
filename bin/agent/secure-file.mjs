import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Atomically replace a private JSON/config file with mode 0600. */
function writeSecureFile(file, contents) {
	const parent = dirname(file);
	const existed = existsSync(parent);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	if (!existed) chmodSync(parent, 0o700);
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, contents, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, file);
	chmodSync(file, 0o600);
}

export function writeSecureJson(file, value) {
	writeSecureFile(file, JSON.stringify(value, null, "\t"));
}
