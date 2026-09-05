import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { PROMPT_MAX_CHARS } from "./tools/ardy/prompt-limits.mjs";

// Vite can run as a UI-only server. Do not silently proxy /ardy to the
// bridge's historical default port: a different local process may own it.
// dev-full supplies COZYCLAY_BRIDGE_PORT after starting its own sidecar;
// COZYCLAY_BRIDGE_URL remains an explicit escape hatch for a user-managed
// bridge.
const explicitBridgePort = process.env.COZYCLAY_BRIDGE_PORT?.trim();
const motionBridgeUrl = explicitBridgePort
	? `http://127.0.0.1:${explicitBridgePort}`
	: process.env.COZYCLAY_BRIDGE_URL?.trim() || null;
const explicitWorkflowBridgePort = process.env.COZYCLAY_WORKFLOW_BRIDGE_PORT?.trim();
const workflowBridgeUrl = explicitWorkflowBridgePort
	? `http://127.0.0.1:${explicitWorkflowBridgePort}`
	: process.env.COZYCLAY_WORKFLOW_BRIDGE_URL?.trim() || null;
const livePort = process.env.COZYCLAY_LIVE_PORT ?? "5184";

export default defineConfig({
	define: {
		"import.meta.env.VITE_COZYCLAY_LIVE_PORT": JSON.stringify(livePort),
		// The API imports the same shared constant. Do not make this client cap
		// environment-overridable: a divergent build would accept prompts the API rejects.
		"import.meta.env.VITE_DEMO_PROMPT_MAX_CHARS": JSON.stringify(String(PROMPT_MAX_CHARS)),
	},
	// Root-absolute on purpose: the site has its own apex domain, and the studio
	// is served from "/app/" while its public assets stay at the root. A relative
	// base would resolve those to "/app/models/..." and 404.
	base: "/",
	build: {
		rollupOptions: {
			input: {
				// The crawlable landing page: static HTML, no bundle.
				landing: resolve(import.meta.dirname, "index.html"),
				// The studio itself.
				app: resolve(import.meta.dirname, "app/index.html"),
				// Search-facing article on camera control for AI video.
				aiCameraControl: resolve(import.meta.dirname, "ai-camera-control/index.html"),
				// Standalone Vibe-Workflow inspired graph editor.
				workflow: resolve(import.meta.dirname, "workflow/index.html"),
				// Hosted demo composer and its queue/result ticket.
				demo: resolve(import.meta.dirname, "demo/index.html"),
				ticket: resolve(import.meta.dirname, "d/index.html"),
			},
		},
	},
	plugins: [
		react(),
		// A service worker registered by an earlier PRODUCTION visit to this same
		// origin outlives the tab and keeps serving its cached bundle to the dev
		// server's port — edits appear to do nothing, and no amount of reloading
		// helps because the worker answers before the network does. Dev therefore
		// serves a self-destructing worker: it unregisters itself, drops every
		// CozyClay cache, and reloads the clients it was holding.
		{
			name: "cozyclay-dev-kill-sw",
			apply: "serve",
			configureServer(server) {
				server.middlewares.use((req, res, next) => {
					const path = (req.url || "").split("?")[0];
					if (!motionBridgeUrl && /^\/ardy\/(health|bases|generate|footage|extract|motions)(\/|$)/.test(path)) {
						res.statusCode = 503;
						res.setHeader("content-type", "application/json; charset=utf-8");
						res.end(JSON.stringify({ error: "motion sidecar is not configured" }));
						return;
					}
					if (!workflowBridgeUrl && /^\/workflow-api\/(health|workflow\/|app\/get_file_upload_url(?:\/|$))/.test(path)) {
						res.statusCode = 503;
						res.setHeader("content-type", "application/json; charset=utf-8");
						res.setHeader("cache-control", "no-store");
						res.end(JSON.stringify({ ok: false, enabled: false, error: "workflow bridge is not configured", code: "workflow-bridge-missing" }));
						return;
					}
					// The lying clip is a browser-regression fixture. Serve it only from
					// the dev server so it can exercise the real UI without shipping a
					// second motion archive in production output.
					if (path === "/demo/qa-lying.npz") {
						res.statusCode = 200;
						res.setHeader("content-type", "application/octet-stream");
						res.setHeader("cache-control", "no-store");
						res.end(readFileSync(resolve(import.meta.dirname, "test/fixtures/qa-lying.npz")));
						return;
					}
					if ((req.url || "").split("?")[0] !== "/sw.js") return next();
					res.setHeader("content-type", "text/javascript; charset=utf-8");
					res.setHeader("cache-control", "no-store");
					res.end(
						`self.addEventListener("install", () => self.skipWaiting());\n` +
							`self.addEventListener("activate", (event) => {\n` +
							`\tevent.waitUntil((async () => {\n` +
							`\t\tconst keys = await caches.keys();\n` +
							`\t\tawait Promise.all(keys.filter((k) => k.startsWith("cozyclay-pwa-")).map((k) => caches.delete(k)));\n` +
							`\t\tawait self.registration.unregister();\n` +
							`\t\tconst clients = await self.clients.matchAll({ type: "window" });\n` +
							`\t\tfor (const client of clients) client.navigate(client.url);\n` +
							`\t})());\n` +
							`});\n`,
					);
				});
			},
		},
	],
	server: {
		port: 5180,
		// Dev-only: the motion sidecar (tools/ardy/bridge.mjs) is an optional
		// companion on loopback. The proxy is enabled only when dev-full (or a
		// user-managed bridge) explicitly provides its endpoint. The production
		// build stays fully static, so this proxy must never become a requirement.
		...(motionBridgeUrl || workflowBridgeUrl
			? {
				proxy: {
					...(workflowBridgeUrl
						? {
							"/workflow-api": {
								target: workflowBridgeUrl,
								rewrite: (path) => path.replace(/^\/workflow-api/, "") || "/",
							},
						}
						: {}),

					...(motionBridgeUrl
						? {
							// Only the routes the bridge actually owns. /ardy/ is ALSO a public
							// asset directory (cskel27-rest.json), and a blanket proxy would
							// hand those static files to the bridge, which 404s them.
							"/ardy": {
								target: motionBridgeUrl,
								bypass(req) {
									const path = (req.url || "").split("?")[0];
									if (/^\/ardy\/(health|bases|generate|footage|extract|motions)(\/|$)/.test(path)) return undefined;
									return req.url; // not a bridge route: serve the static asset
								},
							},
						}
						: {}),
				},
			}
			: {}),
	},
});
