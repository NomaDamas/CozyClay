import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Atomically replace a private JSON/config file with mode 0600. */
export function writeSecureFile(file, contents) {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, contents, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, file);
	chmodSync(file, 0o600);
}

export function writeSecureJson(file, value) {
	writeSecureFile(file, JSON.stringify(value, null, "\t"));
}
