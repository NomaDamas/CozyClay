// Writes dist/sitemap.xml after `vite build`. lastmod comes from the last git
// commit that touched each page's source, so Google sees real change dates
// instead of a hand-edited constant it learns to ignore. changefreq/priority
// are omitted on purpose: Google does not read them.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ORIGIN = "https://cozyclay.org";
const PAGES = [
	{ path: "/", sources: ["index.html", "public/media", "public/scenes"] },
	{ path: "/greybox-to-video/", sources: ["greybox-to-video/index.html"] },
	{ path: "/previs-software/", sources: ["previs-software/index.html"] },
	{ path: "/seedance-camera-control/", sources: ["seedance-camera-control/index.html"] },
	{ path: "/ai-camera-control/", sources: ["ai-camera-control/index.html"] },
	{ path: "/privacy/", sources: ["privacy/index.html"] },
];

function lastCommitDate(paths) {
	try {
		const out = execFileSync("git", ["log", "-1", "--format=%cs", "--", ...paths], { encoding: "utf8" }).trim();
		if (/^\d{4}-\d{2}-\d{2}$/.test(out)) return out;
	} catch {
		/* shallow clone or no git: fall through */
	}
	return new Date().toISOString().slice(0, 10);
}

const entries = PAGES.map(({ path, sources }) => `  <url>\n    <loc>${ORIGIN}${path}</loc>\n    <lastmod>${lastCommitDate(sources)}</lastmod>\n  </url>`);
const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
const dist = resolve(import.meta.dirname, "..", "dist");
mkdirSync(dist, { recursive: true });
writeFileSync(resolve(dist, "sitemap.xml"), xml);
console.log(`sitemap: ${PAGES.length} urls`);
