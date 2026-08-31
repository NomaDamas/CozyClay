// Where the QA Chrome lives, resolved the same way tools/qa-browser.mjs does
// it: an explicit CHROME_PATH wins, then the macOS app bundle, then the Linux
// system binaries the CI runner images ship. The live-editor suites spawned
// their own hardcoded macOS path before, which is why none of them could run
// in CI at all.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function resolveChromePath() {
	const candidates = [
		process.env.CHROME_PATH,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
	].filter(Boolean);
	const found = candidates.find(existsSync);
	if (!found) throw new Error("Google Chrome/Chromium not found; set CHROME_PATH");
	return found;
}

/** Standard headless-QA argv: an isolated throwaway profile so parallel or
 * dirty runner state can never bleed into a suite. Caller appends its URL. */
export function chromeArgs(cdpPort) {
	return [
		"--headless=new",
		"--no-first-run",
		"--no-default-browser-check",
		`--remote-debugging-port=${cdpPort}`,
		`--user-data-dir=${mkdtempSync(join(tmpdir(), "cozyclay-live-qa-"))}`,
	];
}
