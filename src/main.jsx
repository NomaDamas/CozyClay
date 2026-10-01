import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// First stylesheet on the page: it fixes the cascade-layer order before any
// component sheet (topbar.css, viewport.css, pose.css...) opens a layer.
import "./styles/tokens.css";
import "./styles/themes.css";
import { applyTheme, readTheme } from "./theme.js";
import App from "./App.jsx";
import ErrorBoundary from "./error-boundary.jsx";
import "./styles.css";
import { registerPwa } from "./pwa.js";
import { LOCALE } from "./locale.js";
import { initAnalytics } from "./analytics.js";
import { fetchPlaygroundProject, isPlaygroundEmbed, playgroundSceneUrl, stashPlaygroundProject } from "./playground.js";

registerPwa();
void initAnalytics();
document.documentElement.lang = LOCALE;
applyTheme(readTheme());

async function boot() {
	// The landing-page playground needs its preset in hand before the first
	// render: scene startup is synchronous, and a fetch racing the mount
	// would flash the empty default room first.
	if (isPlaygroundEmbed(location.search)) {
		const url = playgroundSceneUrl(location.search);
		const project = url ? await fetchPlaygroundProject(url) : null;
		stashPlaygroundProject(project ?? { name: "Playground", document: null });
	}
	createRoot(document.getElementById("root")).render(
		<StrictMode>
			<ErrorBoundary>
				<App />
			</ErrorBoundary>
		</StrictMode>,
	);
}

void boot();
