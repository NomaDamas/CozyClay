#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PROMPT_MAX_CHARS } from "../../tools/ardy/prompt-limits.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const path = (...parts) => join(ROOT, ...parts);

function requireFile(relativePath, hint = "run npm run build first") {
  const absolutePath = path(relativePath);
  assert.ok(existsSync(absolutePath), `${relativePath} is missing; ${hint}`);
  return absolutePath;
}

const distFiles = [
  "dist/demo/index.html",
  "dist/demo/walk-then-stop.npz",
  "dist/d/index.html",
];
for (const relativePath of distFiles) requireFile(relativePath);
console.log(`PASS build outputs present: ${distFiles.join(" ")}`);

const hostedBundles = readdirSync(path("dist/assets"))
  .filter((name) => /^(?:config|demo|ticket)-.*\.js$/u.test(name))
  .map((name) => readFileSync(path("dist/assets", name), "utf8"))
  .join("\n");
assert.ok(hostedBundles, "hosted demo JavaScript bundles are missing; run npm run build first");
assert.match(hostedBundles, new RegExp(`\\b${PROMPT_MAX_CHARS}\\b`, "u"));
assert.doesNotMatch(hostedBundles, /\bInfinity\b/u);
console.log(`PASS built demo bundles embed shared prompt cap ${PROMPT_MAX_CHARS} with no Infinity path`);

const worker = readFileSync(path("public/sw.js"), "utf8");
const fetchStart = worker.indexOf('self.addEventListener("fetch"');
assert.ok(fetchStart >= 0, "public/sw.js must register a fetch handler");
const demoGuard = worker.indexOf('url.pathname.startsWith("/demo/")', fetchStart);
const ticketGuard = worker.indexOf('url.pathname.startsWith("/d/")', fetchStart);
const methodGuard = worker.indexOf('if (request.method !== "GET") return;', fetchStart);
assert.ok(ticketGuard > fetchStart, "public/sw.js must bypass /d/ requests");
assert.ok(demoGuard > fetchStart, "public/sw.js must bypass /demo/ requests");
assert.ok(methodGuard < 0 || ticketGuard < methodGuard, "/d/ bypass must run before the GET guard");
assert.match(worker, /const CACHE_NAME\s*=\s*`\$\{CACHE_PREFIX\}v7`/u);
console.log("PASS service worker keeps /d/ and /demo/ network-only with cache v6");

const ticketHtml = readFileSync(path("d/index.html"), "utf8");
const demoHtml = readFileSync(path("demo/index.html"), "utf8");
assert.match(ticketHtml, /<meta\s+name="robots"\s+content="noindex, nofollow"\s*\/?>(?:\s*)/u);
assert.match(ticketHtml, /<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>(?:\s*)/u);
assert.match(ticketHtml, /id="ticket-bookmark-notice"/u);
assert.match(ticketHtml, /Bookmark this page[^<]*only way back to your result/u);
assert.doesNotMatch(ticketHtml, /ticket-email-notice|emailStatus|promotable|promote-button/iu);

const providers = [...demoHtml.matchAll(/data-provider="([^"]+)"/gu)].map((match) => match[1]);
assert.deepEqual(providers, ["google"], "the v1 demo exposes exactly one Google provider button");
assert.doesNotMatch(demoHtml, /data-provider="github"|star-card|priority lane|promote|emailStatus/iu);
assert.doesNotMatch(demoHtml, /1x00000000000000000000AA/u);
const robots = readFileSync(path("public/robots.txt"), "utf8");
assert.match(robots, /^Disallow:\s*\/d\/\s*$/m);
// Unlisted mode: the composer is reachable by URL only, never via search.
assert.match(robots, /^Disallow:\s*\/demo\/\s*$/m);
assert.match(demoHtml, /<meta\s+name="robots"\s+content="noindex, nofollow"\s*\/?>(?:\s*)/u);
// The sitemap is generated into dist/ by tools/sitemap.mjs at build time; its
// PAGES table is the source of truth for what search engines are told about.
const sitemapSource = readFileSync(path("tools/sitemap.mjs"), "utf8");
assert.doesNotMatch(sitemapSource, /path:\s*"\/demo\//u);
assert.doesNotMatch(sitemapSource, /path:\s*"\/d\//u);
console.log("PASS ticket bookmark notice, Google-only sign-in, robots rule, and sitemap visibility");

for (const relativePath of ["demo/demo.js", "d/ticket.js"]) {
  const source = readFileSync(path(relativePath), "utf8");
  assert.doesNotMatch(source, /\binnerHTML\b/u, `${relativePath} must not use innerHTML`);
}
const demoSource = readFileSync(path("demo/demo.js"), "utf8");
const ticketSource = readFileSync(path("d/ticket.js"), "utf8");
const configSource = readFileSync(path("demo/config.js"), "utf8");
const viteSource = readFileSync(path("vite.config.js"), "utf8");
assert.doesNotMatch(demoSource, /const\s+API_BASE\s*=/u);
assert.doesNotMatch(demoSource, /1x00000000000000000000AA/u);
assert.doesNotMatch(demoSource, /\b500\b/u);
assert.doesNotMatch(demoSource, /const\s+PROMPT_MAX_CHARS\s*=/u);
assert.doesNotMatch(demoSource, /\b(?:github|star-card|promotable|emailStatus)\b/iu);
assert.doesNotMatch(ticketSource, /\b(?:github|star-card|promotable|emailStatus|ticket-email-notice)\b/iu);
assert.match(configSource, /import\.meta\.env\?\.VITE_DEMO_API_BASE/u);
assert.match(configSource, /import\.meta\.env\?\.VITE_TURNSTILE_SITE_KEY/u);
assert.match(configSource, /import\.meta\.env\?\.VITE_DEMO_PROMPT_MAX_CHARS/u);
assert.match(configSource, /shared API prompt limit/u);
assert.match(ticketSource, /credentials:\s*"omit"/u);
assert.match(viteSource, /import\s+\{\s*PROMPT_MAX_CHARS\s*\}\s+from\s+["']\.\/tools\/ardy\/prompt-limits\.mjs["']/u);
assert.match(viteSource, /"import\.meta\.env\.VITE_DEMO_PROMPT_MAX_CHARS":\s*JSON\.stringify\(String\(PROMPT_MAX_CHARS\)\)/u);
assert.doesNotMatch(viteSource, /process\.env\.VITE_DEMO_PROMPT_MAX_CHARS/u);
console.log("PASS demo and ticket render user text without removed v1 surfaces");

const priorPromptCapEnv = process.env.VITE_DEMO_PROMPT_MAX_CHARS;
let viteConfigModule;
try {
  process.env.VITE_DEMO_PROMPT_MAX_CHARS = "999";
  viteConfigModule = await import(`../../vite.config.js?verify-prompt-cap=${Date.now()}`);
} finally {
  if (priorPromptCapEnv === undefined) delete process.env.VITE_DEMO_PROMPT_MAX_CHARS;
  else process.env.VITE_DEMO_PROMPT_MAX_CHARS = priorPromptCapEnv;
}
assert.equal(
  viteConfigModule.default.define["import.meta.env.VITE_DEMO_PROMPT_MAX_CHARS"],
  JSON.stringify(String(PROMPT_MAX_CHARS)),
);
console.log(`PASS Vite ignores divergent prompt-cap env and injects fixed shared value ${PROMPT_MAX_CHARS}`);

function element() {
  const classes = new Set();
  const listeners = new Map();
  return {
    textContent: "",
    hidden: false,
    href: "#",
    disabled: false,
    value: "",
    maxLength: PROMPT_MAX_CHARS,
    dataset: {},
    style: {},
    classList: {
      toggle(name, force) {
        if (force === undefined ? !classes.has(name) : force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    replaceChildren() {
      this.textContent = "";
    },
    append(...nodes) {
      this.textContent += nodes.map((node) => node?.textContent ?? String(node)).join("");
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    setAttribute() {},
    select() {},
    remove() {},
  };
}

function domFor(ids) {
  const elements = new Map(ids.map((id) => [id, element()]));
  return {
    elements,
    readyState: "complete",
    visibilityState: "visible",
    getElementById(id) {
      return elements.get(id) ?? null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    createTextNode(text) {
      return { textContent: String(text) };
    },
  };
}

const originalDocument = globalThis.document;
const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;
const originalHistory = globalThis.history;
const demo = await import("../../demo/demo.js");
const ticket = await import("../../d/ticket.js");

try {
  assert.match(demo.errorMessageFor("queue_full"), /queue is full/u);
  assert.match(demo.errorMessageFor("daily_cap"), /today's motion limit/u);
  assert.match(demo.errorMessageFor("turnstile_failed"), /security check/u);
  assert.equal(demo.promptLimit({ maxLength: 0 }), PROMPT_MAX_CHARS);
  console.log("PASS executable submission error-code mapping");

  let sessionRequest;
  globalThis.fetch = async (_url, options) => {
    sessionRequest = options;
    return new Response(JSON.stringify({ signedIn: true, provider: "google", dailyRemaining: 2 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await demo.getSession();
  assert.equal(sessionRequest.credentials, "include");
  assert.equal(demo.getSessionState().signedIn, true);
  assert.equal(demo.getSessionState().provider, "google");
  assert.equal(demo.getSessionState().sessionError, false);

  globalThis.fetch = async () => new Response(JSON.stringify({ error: "upstream_down" }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });
  assert.equal(await demo.getSession(), null);
  assert.equal(demo.getSessionState().sessionError, true);

  globalThis.fetch = async () => new Response("not-json", { status: 200 });
  assert.equal(await demo.getSession(), null);
  assert.equal(demo.getSessionState().sessionError, true);

  globalThis.fetch = async () => new Response(JSON.stringify({ signedIn: false, activeJobToken: null }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
  await demo.getSession();
  assert.equal(demo.getSessionState().signedIn, false);
  assert.equal(demo.getSessionState().sessionError, false);
  console.log("PASS session distinguishes unauthenticated responses from API failures");

  globalThis.location = { href: "https://cozyclay.org/demo/", pathname: "/demo/", search: "" };
  demo.signIn("github");
  assert.equal(globalThis.location.href, "https://cozyclay.org/demo/", "removed GitHub provider does not navigate");
  demo.signIn("google");
  assert.match(globalThis.location.href, /\/auth\/google\/start\?next=/u);

  globalThis.document = domFor([
    "session-notice",
    "session-status",
    "sign-in-panel",
    "ticket-bookmark-notice",
    "ticket-state-title",
    "ticket-position",
    "ticket-eta",
    "ticket-prompt",
    "ticket-message",
    "open-result",
    "copy-link",
    "ticket-result",
    "report-link",
  ]);
  demo.updateSessionUi({ signedIn: true, provider: "google", dailyRemaining: 2 });
  const sessionStatus = globalThis.document.elements.get("session-status");
  assert.equal(sessionStatus.textContent, "Signed in with Google · 2 left today");
  assert.equal(globalThis.document.elements.get("sign-in-panel").classList.contains("is-hidden"), true);

  let replaced = "";
  globalThis.location = { href: "https://cozyclay.org/d/?t=qa-token" };
  globalThis.history = { replaceState(_state, _title, next) { replaced = next; } };
  assert.equal(ticket.readToken(), "qa-token");
  assert.equal(replaced, "/d/#t=qa-token");
  globalThis.location = { href: "https://cozyclay.org/d/?t=%3Cinvalid%3E" };
  assert.equal(ticket.readToken(), null);
  assert.equal(replaced, "/d/");

  ticket.renderState({
    status: "queued",
    position: 4,
    etaText: "Usually within a few hours — at most 48 hours.",
    etaMinutes: null,
    promptText: "<img src=x onerror=alert(1)>",
  });
  assert.equal(globalThis.document.elements.get("ticket-position").textContent, "You are #4 in line");
  assert.equal(globalThis.document.elements.get("ticket-prompt").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(globalThis.document.elements.get("ticket-bookmark-notice").textContent, "");

  ticket.renderState({ status: "queued", position: 2, etaText: "About 3 minutes", etaMinutes: 3 });
  assert.equal(globalThis.document.elements.get("ticket-eta").textContent, "About 3 minutes");

  ticket.renderState({
    status: "done",
    promptText: "<b>literal</b>",
    resultUrl: "https://api.cozyclay.org/r/qa-token.npz",
  });
  assert.equal(globalThis.document.elements.get("ticket-prompt").textContent, "<b>literal</b>");
  assert.equal(
    globalThis.document.elements.get("open-result").href,
    "/app/?motion=https%3A%2F%2Fapi.cozyclay.org%2Fr%2Fqa-token.npz",
  );
  assert.equal(globalThis.document.elements.get("open-result").classList.contains("is-hidden"), false);
  assert.equal(globalThis.document.elements.get("copy-link").classList.contains("is-hidden"), false);
  console.log("PASS executable queued/done ticket rendering and safe prompt text");

  let ticketRequest;
  globalThis.fetch = async (_url, options) => {
    ticketRequest = options;
    return new Response(JSON.stringify({ status: "queued", position: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await ticket.fetchTicket("qa-token");
  assert.equal(ticketRequest.credentials, "omit");
  console.log("PASS ticket polling request omits credentials");
} finally {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = originalFetch;
  if (originalLocation === undefined) delete globalThis.location;
  else globalThis.location = originalLocation;
  if (originalHistory === undefined) delete globalThis.history;
  else globalThis.history = originalHistory;
}

console.log("all CozyClay hosted demo page checks PASS");
