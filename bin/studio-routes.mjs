/**
 * The launcher's own /__cozyclay/* routes, kept out of bin/cozyclay.mjs:
 * the telemetry toggle the Studio's privacy setting posts to, and the update
 * routes behind the Studio's update chip.
 */
import { setTelemetryEnabled } from "./telemetry-state.mjs";
import { lookupLatest } from "./update-check.mjs";
import { canSelfUpdate, createInstaller } from "./update-install.mjs";
import { createUpdateRoutes } from "./update-routes.mjs";

/**
 * Returns a handler that answers a /__cozyclay/* request and returns true, or
 * returns false for any other path. `takeRuntime` re-reads the runtime
 * telemetry config after a change; `update` names this launch's version,
 * state dir, install kind, package root and whether update checks are on.
 */
export function createStudioRoutes({ port, stateFile, takeRuntime, update: { currentVersion, stateDir, kind, enabled, pkgRoot } }) {
	const updateRoute = createUpdateRoutes({
		currentVersion,
		kind,
		enabled,
		port,
		checkLatest: () => lookupLatest(currentVersion, stateDir),
		canSelfUpdate: () => canSelfUpdate({ pkgRoot }),
		installer: createInstaller(),
	});
	return function handleStudioRoute(req, res, url) {
		if (url.pathname === "/__cozyclay/update") {
			void updateRoute(req, res);
			return true;
		}
		if (url.pathname !== "/__cozyclay/telemetry") return false;
		if (req.method === "POST") {
			const origin = req.headers.origin;
			const expectedOrigin = `http://127.0.0.1:${port}`;
			if (origin !== expectedOrigin) {
				res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "forbidden origin" }));
				return true;
			}
			let body = "";
			req.setEncoding("utf8");
			req.on("data", (chunk) => {
				body += chunk;
				if (body.length > 1024) req.destroy();
			});
			req.on("end", () => {
				try {
					const value = JSON.parse(body);
					if (typeof value.enabled !== "boolean") throw new TypeError("enabled must be boolean");
					setTelemetryEnabled(stateFile, value.enabled);
					const runtimeTelemetry = takeRuntime();
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store",
					});
					res.end(JSON.stringify(runtimeTelemetry));
				} catch {
					res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: "invalid telemetry setting" }));
				}
			});
			return true;
		}
		res.writeHead(405, { allow: "POST", "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ error: "method not allowed" }));
		return true;
	};
}
