// The stage's one-time WebGL check. It runs in a mount effect, never in render:
// probing creates a throwaway canvas and a GL context. The result is cached for
// the page, so a remount does not probe again.
import { useEffect, useState } from "react";
import { reportGlLost } from "./crash-telemetry.js";

let cached = null;

function probe() {
	if (cached !== null) return cached;
	try {
		const canvas = document.createElement("canvas");
		cached = Boolean(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
	} catch {
		cached = false;
	}
	return cached;
}

/** False once the mount check found no WebGL; true before it runs and when WebGL works. */
export function useWebGlAvailable() {
	const [available, setAvailable] = useState(cached ?? true);
	useEffect(() => {
		if (typeof document === "undefined") return undefined;
		// A task after the first commit keeps the throwaway GL context off the
		// commit path; a StrictMode remount clears the first timer.
		const timer = setTimeout(() => {
			const ok = probe();
			setAvailable(ok);
			if (!ok) reportGlLost("unavailable");
		}, 0);
		return () => clearTimeout(timer);
	}, []);
	return available;
}
