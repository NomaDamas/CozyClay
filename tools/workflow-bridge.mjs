#!/usr/bin/env node
/**
 * CozyClay workflow bridge.
 *
 * This optional loopback sidecar keeps MuAPI credentials out of the browser.
 * Vite proxies /workflow-api/* to this server in development. The bridge
 * intentionally exposes a small allowlist of workflow routes; all upstream
 * paths and payloads remain owned by MuAPI.
 */
import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.COZYCLAY_WORKFLOW_BRIDGE_PORT || "5182", 10);
const MUAPI_URL = (process.env.COZYCLAY_MUAPI_URL?.trim() || "https://api.muapi.ai").replace(/\/$/, "");
const MUAPI_KEY = process.env.COZYCLAY_MUAPI_KEY?.trim() || "";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = Number.parseInt(process.env.COZYCLAY_MUAPI_TIMEOUT_MS || "30000", 10);

const ROUTES = [
  { method: "POST", pattern: /^\/workflow\/create$/, upstream: "/workflow/create" },
  { method: "POST", pattern: /^\/workflow\/run$/, upstream: "/workflow/run" },
  { method: "POST", pattern: /^\/workflow\/([^/]+)\/node\/([^/]+)\/run$/, upstream: (match) => `/workflow/${encodeURIComponent(match[1])}/node/${encodeURIComponent(match[2])}/run` },
  { method: "GET", pattern: /^\/workflow\/run\/([^/]+)\/status$/, upstream: (match) => `/workflow/run/${encodeURIComponent(match[1])}/status` },
  { method: "GET", pattern: /^\/app\/get_file_upload_url$/, upstream: "/app/get_file_upload_url" },
  { method: "POST", pattern: /^\/app\/get_file_upload_url$/, upstream: "/app/get_file_upload_url" },
];

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function healthPayload() {
  const configured = Boolean(MUAPI_KEY && MUAPI_URL);
  return {
    ok: configured,
    enabled: configured,
    provider: "muapi",
    configured: { key: Boolean(MUAPI_KEY), url: Boolean(MUAPI_URL) },
  };
}

function routeFor(method, path) {
  return ROUTES.map((route) => {
    if (route.method !== method) return null;
    const match = path.match(route.pattern);
    return match ? { route, match } : null;
  }).find(Boolean);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function proxy(route, match, req, res) {
  if (!MUAPI_KEY) {
    json(res, 503, { ok: false, enabled: false, error: "MuAPI is not configured", code: "muapi-key-missing" });
    return;
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  let upstreamPath = typeof route.upstream === "function" ? route.upstream(match) : route.upstream;
  // MuAPI's run endpoint carries the workflow id in the URL. The bridge keeps
  // a stable body-based skeleton for the browser and adapts it here.
  if (route.pattern.source === "^\\/workflow\\/run$" && body?.length) {
    try {
      const workflowId = JSON.parse(body.toString()).workflow_id;
      if (typeof workflowId === "string" && workflowId) upstreamPath = `/workflow/${encodeURIComponent(workflowId)}/run`;
    } catch {
      // Let MuAPI return its normal validation error for a non-JSON payload.
    }
  }
  if (route.pattern.source === "^\\/app\\/get_file_upload_url$" && req.url?.includes("?")) {
    upstreamPath += req.url.slice(req.url.indexOf("?"));
  }
  // MuAPI's workflow service authenticates with x-api-key. Keep the Bearer
  // header as a compatibility fallback for older self-hosted gateways.
  const headers = { "x-api-key": MUAPI_KEY, authorization: `Bearer ${MUAPI_KEY}`, accept: "application/json" };
  if (body?.length) headers["content-type"] = req.headers["content-type"] || "application/json";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${MUAPI_URL}${upstreamPath}`, {
      method: req.method,
      headers,
      body,
      signal: controller.signal,
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("content-type", contentType);
    res.setHeader("cache-control", "no-store");
    res.end(bytes);
  } catch (error) {
    const timeoutError = error?.name === "AbortError";
    json(res, 502, { ok: false, error: timeoutError ? "MuAPI request timed out" : "MuAPI request failed", code: timeoutError ? "muapi-timeout" : "muapi-unreachable" });
  } finally {
    clearTimeout(timeout);
  }
}

export function createWorkflowBridgeServer() {
  return createServer(async (req, res) => {
    const path = new URL(req.url || "/", `http://${HOST}`).pathname;
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type,authorization");
      res.end();
      return;
    }
    if (path === "/health") {
      const payload = healthPayload();
      json(res, payload.ok ? 200 : 503, payload);
      return;
    }
    if (path === "/workflow-api/health") {
      const payload = healthPayload();
      json(res, payload.ok ? 200 : 503, payload);
      return;
    }
    const routePath = path.startsWith("/workflow-api/") ? path.slice("/workflow-api".length) : path;
    const matched = routeFor(req.method || "GET", routePath);
    if (!matched) {
      json(res, 404, { ok: false, error: "Unknown workflow bridge route", code: "route-not-found" });
      return;
    }
    try {
      await proxy(matched.route, matched.match, req, res);
    } catch (error) {
      json(res, error.statusCode || 400, { ok: false, error: error.message || "Invalid request", code: error.statusCode === 413 ? "body-too-large" : "invalid-request" });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createWorkflowBridgeServer();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[workflow-bridge] listening on http://${HOST}:${PORT} (MuAPI ${MUAPI_KEY ? "enabled" : "disabled"})`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
