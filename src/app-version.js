// The version Help › About names. The npm launcher injects the running
// package's version as window.__COZYCLAY_RUNTIME__.appVersion; the hosted
// site and Vite dev have no runtime, so they fall back to package.json the
// way the start screen does (src/project-browser.jsx).
import packageInfo from "../package.json" with { type: "json" };

export function appVersion(win = globalThis.window, fallback = packageInfo.version) {
	try {
		const runtime = win?.__COZYCLAY_RUNTIME__?.appVersion;
		if (typeof runtime === "string" && runtime.trim()) return runtime.trim();
	} catch { /* a throwing getter reads as no runtime */ }
	return fallback;
}
