#!/usr/bin/env node
/**
 * verify-resource-status (#230): the ResourceStatus and SaveBlockedDialog
 * components render the manifest's counts, the missing list with kind / id /
 * reference location, the per-item location labels, and every save-blocked
 * reason — from props alone, with no App state in reach.
 *
 * The components are JSX. Node cannot import that directly, so a module
 * loader hook hands `.jsx` files through Vite's oxc transform (the same one
 * the dev server and build use). Everything else loads untouched.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

const hook = `
let transform;
export async function initialize({ viteUrl }) { ({ transformWithOxc: transform } = await import(viteUrl)); }
export async function load(url, context, nextLoad) {
	if (!url.endsWith(".jsx")) return nextLoad(url, context);
	const { readFileSync } = await import("node:fs");
	const { fileURLToPath } = await import("node:url");
	const path = fileURLToPath(url);
	const { code } = await transform(readFileSync(path, "utf8"), path, { lang: "jsx", jsx: { runtime: "automatic" } });
	return { format: "module", source: code, shortCircuit: true };
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, { data: { viteUrl: import.meta.resolve("vite") } });

// locale.js reads localStorage once at import; without one it is English.
const { renderToStaticMarkup } = await import("react-dom/server");
const { ResourceStatus, SaveBlockedDialog, formatMiB, resourceRefLabel, resourceStatusLabel } = await import("../src/resource-status.jsx");
const { createElement: h } = await import("react");

const render = (component, props) => renderToStaticMarkup(h(component, props));
const count = (html, needle) => html.split(needle).length - 1;

/* ---------------------------------------------------------- fixtures --- */

const manifest = {
	items: [
		{ kind: "image", id: "img-0123456789abcdef0123456789abcdef", status: "embedded", bytes: 2048, refs: [{ sceneId: "scene-a", objectId: "obj-1", field: "assetId" }] },
		{ kind: "image", id: "img-ffffffffffffffffffffffffffffffff", status: "missing", stored: true, refs: [{ sceneId: "scene-a", objectId: "obj-2", field: "matteAssetId" }] },
		{ kind: "motion", id: "a".repeat(64), status: "embedded", bytes: 4096, refs: [{ sceneId: "scene-a", characterId: "char-1", field: "motionRef.motionId" }] },
		{ kind: "motion", id: "b".repeat(64), status: "missing", refs: [{ sceneId: "scene-b", characterId: "char-2", field: "motionRef.motionId" }] },
		{ kind: "pose", id: "pose-hero", status: "embedded", refs: [{ sceneId: "scene-a", characterId: "char-1", field: "pose" }] },
		{ kind: "workflow-output", id: "img-1234567890abcdef1234567890abcdef", status: "embedded", bytes: 512, refs: [{ nodeId: "image-1", field: "versions[0].dataUrl" }] },
		{ kind: "workflow-output", id: "https://example.com/take-3.mp4", status: "external", url: "https://example.com/take-3.mp4", refs: [{ nodeId: "video-2", field: "videoUrl" }] },
	],
};
manifest.totals = { embedded: 4, external: 1, missing: 2, bytes: 6656 };
manifest.missing = manifest.items.filter((item) => item.status === "missing");

/* ------------------------------------------------------------ labels --- */

assert.equal(resourceStatusLabel({ status: "embedded" }), "In project file");
assert.equal(resourceStatusLabel({ status: "external" }), "External URL");
assert.equal(resourceStatusLabel({ status: "missing", stored: true }), "Browser-only copy");
assert.equal(resourceStatusLabel({ status: "missing" }), "Missing");
assert.equal(resourceRefLabel({ sceneId: "scene-a", objectId: "obj-1", field: "assetId" }), "scene-a / obj-1 · assetId");
assert.equal(resourceRefLabel({ nodeId: "image-1", field: "versions[0].dataUrl" }), "image-1 · versions[0].dataUrl");
assert.equal(resourceRefLabel({ field: "pose" }), "pose");
assert.equal(resourceRefLabel(null), "");
assert.equal(formatMiB(6656), "0.0 MiB");
assert.equal(formatMiB(300 * 1024 * 1024), "300 MiB");
assert.equal(formatMiB(256 * 1024 * 1024 + 512 * 1024), "257 MiB", "large sizes round to whole MiB");
assert.equal(formatMiB(12 * 1024 * 1024 + 512 * 1024), "12.5 MiB", "small sizes keep one decimal");
assert.equal(formatMiB(-1), "");
console.log("PASS resource status: location labels and reference locations read as specified");

/* ---------------------------------------------------- ResourceStatus --- */

const full = render(ResourceStatus, { manifest });
assert.match(full, /<section class="resource-status has-missing" aria-label="Project resources" data-missing-count="2">/);
assert.match(full, /<dd data-total="embedded">4<\/dd>/);
assert.match(full, /<dd data-total="external">1<\/dd>/);
assert.match(full, /<dd data-total="missing">2<\/dd>/);
assert.match(full, /<dd data-total="bytes">0\.0 MiB<\/dd>/);
assert.match(full, /2 resources will not travel with this project file\./);
assert.equal(count(full, '<li class="resource-status-item'), 7, "every manifest item is listed");
const rowStatuses = [...full.matchAll(/<li class="resource-status-item[^>]*data-status="([a-z]+)"/g)].map((match) => match[1]);
assert.deepEqual(rowStatuses, ["missing", "missing", "embedded", "embedded", "embedded", "embedded", "external"], "missing items sort to the top; the rest keep manifest order");
// The missing rows carry kind, id and where they are referenced.
assert.match(full, new RegExp(`<li class="resource-status-item is-missing" data-kind="motion" data-id="${"b".repeat(64)}" data-status="missing">`));
assert.match(full, new RegExp(`<span class="resource-status-kind">Motion</span><code class="resource-status-id">${"b".repeat(64)}</code><span class="resource-status-state is-missing">Missing</span><span class="resource-status-refs">scene-b / char-2 · motionRef.motionId</span>`));
assert.match(full, /data-kind="image" data-id="img-ffffffffffffffffffffffffffffffff" data-status="missing" data-stored="true"/);
assert.match(full, /<span class="resource-status-state is-missing is-stored">Browser-only copy<\/span><span class="resource-status-refs">scene-a \/ obj-2 · matteAssetId<\/span>/);
// Every location label appears for the item that has it.
assert.match(full, /<span class="resource-status-kind">Image<\/span><code class="resource-status-id">img-0123456789abcdef0123456789abcdef<\/code><span class="resource-status-state is-embedded">In project file<\/span>/);
assert.match(full, /<span class="resource-status-kind">Workflow output<\/span><code class="resource-status-id">https:\/\/example\.com\/take-3\.mp4<\/code><span class="resource-status-state is-external">External URL<\/span><span class="resource-status-url" title="https:\/\/example\.com\/take-3\.mp4">https:\/\/example\.com\/take-3\.mp4<\/span>/);
assert.match(full, /<span class="resource-status-kind">Pose<\/span><code class="resource-status-id">pose-hero<\/code>/);
assert.match(full, /image-1 · versions\[0\]\.dataUrl/);
assert.doesNotMatch(full, /<button/, "without onSelect the rows are not buttons");
console.log("PASS resource status: counts, the sorted item list, and per-item kind / id / location / refs render");

const selectable = render(ResourceStatus, { manifest, onSelect: () => {} });
assert.equal(count(selectable, '<button type="button" class="resource-status-select">'), 7, "with onSelect every row is a button");

const compact = render(ResourceStatus, { manifest, compact: true });
assert.match(compact, /<section class="resource-status is-compact has-missing"/);
assert.match(compact, /<dd data-total="embedded">4<\/dd>/);
assert.match(compact, /2 resources will not travel/);
assert.equal(count(compact, '<li class="resource-status-item'), 2, "compact lists only the missing items");
assert.match(compact, /<ul class="resource-status-items is-missing-only" aria-label="Missing resources">/);
assert.doesNotMatch(compact, /pose-hero/, "compact hides the embedded rows");

const clean = render(ResourceStatus, { manifest: { items: manifest.items.filter((item) => item.status !== "missing") } });
assert.match(clean, /<section class="resource-status" aria-label="Project resources" data-missing-count="0">/);
assert.match(clean, /<dd data-total="embedded">4<\/dd>/, "totals are computed from items when the manifest omits them");
assert.match(clean, /<dd data-total="missing">0<\/dd>/);
assert.match(clean, /<dd data-total="bytes">0\.0 MiB<\/dd>/);
assert.doesNotMatch(clean, /will not travel/);
assert.doesNotMatch(clean, /resource-status-warning/);

const empty = render(ResourceStatus, { manifest: null });
assert.match(empty, /<dd data-total="embedded">0<\/dd>/);
assert.doesNotMatch(empty, /<ul/, "an empty manifest renders totals only");
assert.doesNotMatch(empty, /data-total="bytes"/, "a zero size is not shown");
console.log("PASS resource status: compact, select, empty and all-embedded variants");

/* -------------------------------------------------- SaveBlockedDialog --- */

const blocked = render(SaveBlockedDialog, {
	reasons: [
		{ code: "missing-resources", items: manifest.missing },
		{ code: "resources-too-large", bytes: 300 * 1024 * 1024, limit: 256 * 1024 * 1024 },
		{ code: "disk-full", message: "The drive is full." },
		{ code: "mystery" },
	],
	onClose: () => {},
});
assert.match(blocked, /<div class="modal-overlay"><div class="modal save-blocked-dialog" role="dialog" aria-modal="true" aria-labelledby="save-blocked-title">/);
assert.match(blocked, /<h3 id="save-blocked-title">The project was not saved<\/h3>/);
assert.match(blocked, /<button type="button" class="x" aria-label="Close">/);
assert.equal(count(blocked, '<li class="save-blocked-reason"'), 4, "every reason is listed");
assert.match(blocked, /<li class="save-blocked-reason" data-code="missing-resources"><strong>2 resources are missing\.<\/strong><ul class="save-blocked-missing">/);
assert.equal(count(blocked, '<li class="resource-status-item is-missing"'), 2, "the missing reason lists the missing items");
assert.match(blocked, new RegExp(`data-kind="motion" data-id="${"b".repeat(64)}" data-status="missing"`));
assert.match(blocked, /scene-b \/ char-2 · motionRef\.motionId/);
assert.match(blocked, /<li class="save-blocked-reason" data-code="resources-too-large"><strong>The project file would be too large\.<\/strong><span class="save-blocked-size" data-bytes="314572800" data-limit="268435456">300 MiB of embedded resources; the limit is 256 MiB\.<\/span>/);
assert.match(blocked, /<li class="save-blocked-reason" data-code="disk-full"><strong>The drive is full\.<\/strong>/);
assert.match(blocked, /<li class="save-blocked-reason" data-code="mystery"><strong>mystery<\/strong>/);
assert.match(blocked, /<button type="button" class="btn">OK<\/button>/);

const single = render(SaveBlockedDialog, { reasons: [{ code: "missing-resources", items: [manifest.missing[0]] }], onClose: () => {} });
assert.match(single, /<strong>1 resource is missing\.<\/strong>/);
const none = render(SaveBlockedDialog, { reasons: null, onClose: () => {} });
assert.match(none, /<ul class="save-blocked-reasons"><\/ul>/, "no reasons renders an empty list, not a crash");
console.log("PASS resource status: SaveBlockedDialog lists missing resources and the bytes/limit overflow");

/* ------------------------------------------------------------ source --- */

const source = readFileSync(new URL("../src/resource-status.jsx", import.meta.url), "utf8");
assert.doesNotMatch(source, /from "\.\/App\.jsx"|useContext|useState|useEffect|localStorage|indexedDB/, "the components are pure functions of their props");
assert.match(source, /import \{ ko \} from "\.\/locale\.js"/);
for (const label of ["프로젝트 파일에 포함됨", "브라우저 임시 저장", "외부 URL", "누락"]) assert.ok(source.includes(`"${label}"`), `Korean label present: ${label}`);
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
for (const selector of [".resource-status {", ".resource-status-totals {", ".resource-status-item {", ".resource-status-warning {", ".save-blocked-reason {", ".save-blocked-size {"]) assert.ok(css.includes(selector), `styles.css carries ${selector}`);
console.log("PASS resource status: pure props components, locale pairs, and stylesheet rules present");

console.log("verify-resource-status: ok");
