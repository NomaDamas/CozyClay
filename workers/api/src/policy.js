import { PROMPT_MAX_CHARS } from "../../../tools/ardy/prompt-limits.mjs";

/**
 * All queue policy values live here. Runtime code and verification scripts import
 * this object rather than carrying copies of limits around.
 */
export const POLICY = Object.freeze({
  ACTIVE_JOBS_PER_ACCOUNT: 1,
  DAILY_CAP: 2,
  MOTION_DAILY_CAP: 10,
  QUEUE_MAX_WAITING: 200,
  LEASE_TTL_MS: 15 * 60_000,
  HEARTBEAT_INTERVAL_MS: 60_000,
  JOB_HARD_TIMEOUT_MS: 20 * 60_000,
  CLAIM_MAX_RETRIES: 5,
  MAX_ATTEMPTS: 2,
  RESULT_RETENTION_DAYS: 30,
  RESULT_MAX_BYTES: 64 * 1024 * 1024,
  RESULT_ORPHAN_GRACE_MS: 60 * 60_000,
  POSITION_POLL_MS: 30_000,
  HEARTBEAT_FRESH_MS: 10 * 60_000,
  PROMPT_MAX_CHARS,
  DEMO_DURATION_S: 4,
  OAUTH_STATE_TTL_MS: 10 * 60_000,
  SESSION_TTL_DAYS: 30,
  WORKER_CLOCK_SKEW_MS: 120_000,
  WORKER_NONCE_TTL_MS: 240_000,
});

export const ETA_FALLBACK_TEXT = "Usually within a few hours — at most 48 hours.";
export const SITE_ORIGIN = Object.freeze({
  production: "https://cozyclay.org",
  development: "http://127.0.0.1:5180",
});
export const API_ORIGIN = Object.freeze({
  production: "https://api.cozyclay.org",
  development: "http://127.0.0.1:8787",
});

export function dailyCapFor() {
  return POLICY.DAILY_CAP;
}

export function utcDay(value = Date.now()) {
  return new Date(value).toISOString().slice(0, 10);
}

export function environmentFor(env = {}, request = null) {
  if (env.ENVIRONMENT === "development" || env.ENVIRONMENT === "production") {
    return env.ENVIRONMENT;
  }
  const origin = request?.headers?.get?.("origin") ?? "";
  if (origin.startsWith("http://127.0.0.1") || origin.startsWith("http://localhost")) return "development";
  try {
    const hostname = new URL(request?.url ?? "").hostname;
    if (hostname === "127.0.0.1" || hostname === "localhost") return "development";
  } catch {
    // A Worker request always has an absolute URL; this keeps helpers total.
  }
  return "production";
}

export function siteOriginFor(env = {}, request = null) {
  const configured = env.SITE_ORIGIN;
  if (configured) return configured;
  return SITE_ORIGIN[environmentFor(env, request)] ?? SITE_ORIGIN.production;
}

export function apiOriginFor(env = {}, request = null) {
  const configured = env.API_ORIGIN;
  if (configured) return configured;
  return API_ORIGIN[environmentFor(env, request)] ?? API_ORIGIN.production;
}
