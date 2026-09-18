import {
  handleCallback,
  readSession,
  startOAuth,
  clearSessionCookie,
} from "./auth.js";
import { mutationGuard, requireOrigin, withCors } from "./cors.js";
import { etaFor } from "./eta.js";
import {
  API_ORIGIN,
  environmentFor,
  POLICY,
  utcDay,
} from "./policy.js";
import {
  claimNext,
  cleanupExpiredResults,
  cleanupOrphanResults,
  completeJob,
  enqueue,
  expireHardTimeouts,
  failJob,
  jobByToken,
  positionOf,
  reclaimExpiredLeases,
  renewLease,
  revokeJob,
} from "./queue.js";
import { promptHash, validatePrompt } from "./prompt.js";
import { verifyTurnstile } from "./turnstile.js";
import { verifyWorkerRequest } from "./worker-auth.js";
import { DAILY_CAP as MOTION_DAILY_CAP, generateMotion, MODEL as MOTION_MODEL, validateInput } from "./motion.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function json(data, status = 200, headers = {}) {
  const result = new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE, ...headers },
  });
  return result;
}

function errorResponse(error, status, request, env, extra = {}) {
  return withCors(json({ error, ...extra }, status), request, env);
}

async function accountFor(env, accountId) {
  if (!accountId) return null;
  return env.DB.prepare("SELECT * FROM accounts WHERE id=?").bind(accountId).first();
}

async function activeFor(env, accountId) {
  return env.DB.prepare(
    "SELECT token, status FROM jobs WHERE account_id=? AND status IN ('queued','running') ORDER BY created_at, id LIMIT 1",
  ).bind(accountId).first();
}

async function usageFor(env, accountId, now = Date.now()) {
  const row = await env.DB.prepare("SELECT used FROM daily_usage WHERE account_id=? AND day=?").bind(accountId, utcDay(now)).first();
  return Math.max(0, POLICY.DAILY_CAP - Number(row?.used ?? 0));
}

async function readOperationalState(env) {
  const row = await env.DB.prepare("SELECT submissions_enabled FROM operational_state WHERE id=1").first();
  return row ? Number(row.submissions_enabled) === 1 : true;
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
}

function jobResponseUrl(env, token, request) {
  const base = env.API_ORIGIN ?? API_ORIGIN[environmentFor(env, request)] ?? API_ORIGIN.production;
  return `${base.replace(/\/$/u, "")}/r/${encodeURIComponent(token)}.npz`;
}

async function meHandler(request, env) {
  const session = await readSession(request, env);
  if (!session) return withCors(json({ signedIn: false, activeJobToken: null }), request, env);
  const account = await accountFor(env, session.sub);
  if (!account) return withCors(json({ signedIn: false, activeJobToken: null }), request, env);
  const active = await activeFor(env, account.id);
  return withCors(json({
    signedIn: true,
    provider: (await env.DB.prepare("SELECT provider FROM identities WHERE account_id=? ORDER BY created_at LIMIT 1").bind(account.id).first())?.provider ?? null,
    dailyRemaining: await usageFor(env, account.id),
    activeJobToken: active?.token ?? null,
  }), request, env);
}

function motionEnabled(env) {
  return String(env.MOTION_GENERATION_ENABLED ?? "false").toLowerCase() === "true";
}

function publicMotionJob(row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    prompt: row.prompt,
    duration: Number(row.duration),
    resolution: row.resolution,
    model: MOTION_MODEL,
    video: row.video_url ? { url: row.video_url } : null,
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    fps: row.fps == null ? null : Number(row.fps),
    resultDuration: row.result_duration == null ? null : Number(row.result_duration),
    cost: row.cost_usd == null ? null : Number(row.cost_usd),
    requestId: row.request_id ?? null,
    error: row.error ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
  };
}

async function motionUsageFor(env, accountId, now = Date.now()) {
  const row = await env.DB.prepare("SELECT used FROM motion_usage WHERE account_id=? AND day=?").bind(accountId, utcDay(now)).first();
  return Math.max(0, MOTION_DAILY_CAP - Number(row?.used ?? 0));
}

async function runMotionJob(env, jobId, kind, input, accountId) {
  const now = Date.now();
  await env.DB.prepare("UPDATE motion_jobs SET status='running', updated_at=? WHERE id=? AND status='queued'").bind(now, jobId).run();
  try {
    const result = await generateMotion({ kind, input, env });
    const metadata = result.metadata ?? {};
    const video = result.video ?? {};
    const width = Number.isFinite(metadata.width) ? metadata.width : null;
    const height = Number.isFinite(metadata.height) ? metadata.height : null;
    const fps = Number.isFinite(metadata.fps) ? metadata.fps : null;
    const resultDuration = Number.isFinite(metadata.duration) ? metadata.duration : null;
    const finished = Date.now();
    await env.DB.batch([
      env.DB.prepare(`UPDATE motion_jobs SET status='done', video_url=?, width=?, height=?, fps=?, result_duration=?, cost_usd=?, request_id=?, updated_at=?, finished_at=? WHERE id=?`)
        .bind(video.url, width, height, fps, resultDuration, Number(env.FAL_CLIP_COST_USD ?? 0.0625), result.requestId ?? null, finished, finished, jobId),
      env.DB.prepare(`INSERT INTO motion_usage(account_id, day, used) VALUES (?, ?, 1)
        ON CONFLICT(account_id, day) DO UPDATE SET used=motion_usage.used+1`).bind(accountId, utcDay(finished)),
    ]);
  } catch (error) {
    await env.DB.prepare("UPDATE motion_jobs SET status='failed', error=?, updated_at=?, finished_at=? WHERE id=?")
      .bind(String(error?.message ?? error).slice(0, 500), Date.now(), Date.now(), jobId).run();
  }
}

async function submitMotion(request, env, ctx, kind) {
  const guarded = mutationGuard(request, env);
  if (guarded) return guarded;
  if (!motionEnabled(env)) return errorResponse("submissions_disabled", 503, request, env, { detail: "Motion generation is disabled while launch QA is in progress." });
  const session = await readSession(request, env);
  if (!session) return errorResponse("signed_in_required", 401, request, env);
  let body;
  try { body = await request.json(); } catch { return errorResponse("invalid_json", 400, request, env); }
  let input;
  try { input = validateInput(body, kind); } catch (error) {
    return errorResponse(error.code ?? "invalid_motion_request", error.status ?? 400, request, env, { detail: error.message });
  }
  const account = await accountFor(env, session.sub);
  if (!account) return errorResponse("signed_in_required", 401, request, env);
  const usage = await motionUsageFor(env, account.id);
  if (usage <= 0) return errorResponse("daily_cap", 429, request, env, { dailyRemaining: 0 });
  const active = await env.DB.prepare("SELECT id FROM motion_jobs WHERE account_id=? AND status IN ('queued','running') LIMIT 1").bind(account.id).first();
  if (active) return errorResponse("active_job_exists", 409, request, env, { jobId: active.id });
  const id = crypto.randomUUID();
  const created = Date.now();
  await env.DB.prepare(`INSERT INTO motion_jobs(id, account_id, kind, status, prompt, duration, resolution, created_at, updated_at)
    VALUES (?, ?, ?, 'queued', ?, ?, '480P', ?, ?)`).bind(id, account.id, kind, input.prompt, input.duration, created, created).run();
  const task = () => runMotionJob(env, id, kind, input, account.id);
  if (ctx?.waitUntil) ctx.waitUntil(task()); else void task();
  return withCors(json({ job: { id, kind, status: "queued", duration: input.duration, resolution: "480P", model: MOTION_MODEL }, dailyRemaining: usage }, 202), request, env);
}

async function getMotionJob(request, env, id) {
  const session = await readSession(request, env);
  if (!session) return errorResponse("signed_in_required", 401, request, env);
  const row = await env.DB.prepare("SELECT * FROM motion_jobs WHERE id=? AND account_id=?").bind(id, session.sub).first();
  if (!row) return errorResponse("not_found", 404, request, env);
  return withCors(json({ job: publicMotionJob(row), dailyRemaining: await motionUsageFor(env, session.sub) }), request, env);
}

async function motionMeHandler(request, env) {
  const session = await readSession(request, env);
  if (!session) return withCors(json({ signedIn: false, dailyRemaining: MOTION_DAILY_CAP }), request, env);
  const active = await env.DB.prepare("SELECT id FROM motion_jobs WHERE account_id=? AND status IN ('queued','running') LIMIT 1").bind(session.sub).first();
  return withCors(json({ signedIn: true, enabled: motionEnabled(env), dailyRemaining: await motionUsageFor(env, session.sub), activeJobId: active?.id ?? null }), request, env);
}

async function submitJob(request, env) {
  const guarded = mutationGuard(request, env);
  if (guarded) return guarded;
  const session = await readSession(request, env);
  if (!session) return errorResponse("signed_in_required", 401, request, env);
  let body;
  try { body = await request.json(); } catch { return errorResponse("invalid_json", 400, request, env); }
  const validationError = validatePrompt(body?.prompt);
  if (validationError) return errorResponse("invalid_prompt", 400, request, env, { detail: validationError });
  if (!(await verifyTurnstile(body?.turnstileToken, clientIp(request), env))) return errorResponse("turnstile_failed", 403, request, env);
  if (!(await readOperationalState(env))) return errorResponse("submissions_disabled", 503, request, env);

  const account = await accountFor(env, session.sub);
  if (!account) return errorResponse("signed_in_required", 401, request, env);
  const hash = await promptHash(body.prompt);
  const result = await enqueue(env, {
    accountId: account.id,
    prompt: body.prompt,
    promptHash: hash,
  });
  const statuses = { active_job_exists: 409, daily_cap: 429, queue_full: 503, admission_failed: 500 };
  if (!result.ok) return errorResponse(result.error, statuses[result.error] ?? 500, request, env);
  return withCors(json({ token: result.token, position: result.position, dedupHit: Boolean(result.dedupHit) }, 201), request, env);
}

async function getJob(request, env, token) {
  // The opaque ticket token is intentionally a capability so a bookmarked
  // ticket works in a browser that has no API session. Mutation routes still
  // require the owning session.
  const job = await jobByToken(env, token);
  if (!job) return errorResponse("not_found", 404, request, env);
  const now = Date.now();
  if (job.status === "revoked" || job.status === "canceled") return errorResponse("gone", 410, request, env);
  if (job.expires_at != null && Number(job.expires_at) <= now) return errorResponse("expired", 410, request, env);
  let position = 0;
  let eta = { etaMinutes: null, etaText: "Usually within a few hours — at most 48 hours." };
  if (job.status === "queued") {
    position = await positionOf(env, job);
    eta = await etaFor(env, position, now);
  }
  return withCors(json({
    status: job.status,
    position,
    promptText: job.prompt,
    etaText: eta.etaText,
    etaMinutes: eta.etaMinutes,
    resultUrl: job.status === "done" && job.result_key ? jobResponseUrl(env, job.token, request) : null,
    createdAt: job.created_at,
  }), request, env);
}

async function revokeUserJob(request, env, token) {
  const guarded = mutationGuard(request, env);
  if (guarded) return guarded;
  const session = await readSession(request, env);
  if (!session) return errorResponse("signed_in_required", 401, request, env);
  const job = await jobByToken(env, token, session.sub);
  if (!job) return errorResponse("not_found", 404, request, env);
  const result = await revokeJob(env, job.id, {
    reason: "user_revoked",
    expectedStatus: job.status,
    leaseToken: job.lease_token,
  });
  return result.ok ? withCors(json({ token, status: "revoked" }), request, env) : errorResponse(result.error, 409, request, env);
}

async function workerAuthOrResponse(request, env) {
  const result = await verifyWorkerRequest(request, env);
  if (!result.ok) return { response: errorResponse(result.error, result.status ?? 401, request, env), auth: null };
  return { response: null, auth: result };
}

async function workerNext(request, env) {
  const checked = await workerAuthOrResponse(request, env);
  if (checked.response) return checked.response;
  const workerId = checked.auth.workerId;
  const job = await claimNext(env, workerId);
  if (!job) return withCors(new Response(null, { status: 204 }), request, env);
  return withCors(json({ job_id: job.jobId, prompt: job.prompt, duration: job.durationS, lease_token: job.leaseToken, lease_expires_at: job.leaseExpiresAt }), request, env);
}

function npzLooksValid(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 30) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return false;
  // Locate the ordinary ZIP end-of-central-directory record. ZIP64 is outside
  // the result contract and is rejected rather than parsed ambiguously.
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(4, bytes.length - 65_557); index -= 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > bytes.length) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (!entries || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) return false;
  if (centralOffset + centralSize > eocd) return false;
  let index = centralOffset;
  for (let entry = 0; entry < entries; entry += 1) {
    if (index + 46 > bytes.length || view.getUint32(index, true) !== 0x02014b50) return false;
    const nameLength = view.getUint16(index + 28, true);
    const extraLength = view.getUint16(index + 30, true);
    const commentLength = view.getUint16(index + 32, true);
    const end = index + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) return false;
    const name = new TextDecoder().decode(bytes.slice(index + 46, index + 46 + nameLength));
    if (!name.endsWith(".npy") || name.includes("..") || name.startsWith("/")) return false;
    index = end;
  }
  return index <= centralOffset + centralSize;
}

async function workerComplete(request, env) {
  const contentLength = request.headers.get("content-length");
  if (contentLength == null) return errorResponse("content_length_required", 411, request, env);
  const length = Number(contentLength);
  if (!Number.isSafeInteger(length) || length < 0 || length > POLICY.RESULT_MAX_BYTES) return errorResponse("result_too_large", 413, request, env);
  if ((request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/octet-stream") return errorResponse("content_type_required", 415, request, env);
  const checked = await workerAuthOrResponse(request, env);
  if (checked.response) return checked.response;
  const { auth } = checked;
  if (!auth.jobId || !auth.leaseToken) return errorResponse("lease_required", 400, request, env);
  if (auth.body.byteLength !== length) return errorResponse("content_length_mismatch", 400, request, env);
  if (!npzLooksValid(auth.body)) return errorResponse("not_npz", 422, request, env);
  const job = await env.DB.prepare("SELECT id, token, account_id, status, lease_token FROM jobs WHERE id=?").bind(auth.jobId).first();
  if (!job) return errorResponse("not_found", 404, request, env);
  if (job.status !== "running" || job.lease_token !== auth.leaseToken) return errorResponse("lease_lost", 409, request, env);
  // A lease-specific object key makes a late completion unable to overwrite a
  // newer attempt's result before its CAS is rejected.
  const resultKey = `results/${job.token}/${auth.leaseToken}.npz`;
  if (!env.RESULTS?.put) return errorResponse("results_unavailable", 503, request, env);
  await env.RESULTS.put(resultKey, auth.body, { httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" } });
  const completed = await completeJob(env, auth.jobId, auth.leaseToken, resultKey);
  if (!completed.ok) {
    try { await env.RESULTS.delete?.(resultKey); } catch { /* orphan cleanup is best effort */ }
    return errorResponse(completed.error, 409, request, env);
  }
  return withCors(json({ status: "done", token: job.token }), request, env);
}

async function workerFail(request, env) {
  const checked = await workerAuthOrResponse(request, env);
  if (checked.response) return checked.response;
  const { auth } = checked;
  if (!auth.jobId || !auth.leaseToken) return errorResponse("lease_required", 400, request, env);
  let body = {};
  try { body = auth.body.length ? JSON.parse(auth.bodyText) : {}; } catch { return errorResponse("invalid_json", 400, request, env); }
  const result = await failJob(env, auth.jobId, auth.leaseToken, body.reason ?? "worker_failed");
  if (!result.ok) return errorResponse(result.error, 409, request, env);
  return withCors(json({ status: result.status }), request, env);
}

async function workerHeartbeat(request, env) {
  const checked = await workerAuthOrResponse(request, env);
  if (checked.response) return checked.response;
  const { auth } = checked;
  let body = {};
  try { body = auth.body.length ? JSON.parse(auth.bodyText) : {}; } catch { return errorResponse("invalid_json", 400, request, env); }
  // Job and lease travel in signed headers, not in a mutable JSON-only field.
  const jobId = auth.jobId;
  const leaseToken = auth.leaseToken;
  if (!jobId || !leaseToken) return errorResponse("lease_required", 400, request, env);
  const now = Date.now();
  if (!(await renewLease(env, jobId, leaseToken, now))) return errorResponse("lease_lost", 409, request, env);
  await env.DB.prepare(
    `INSERT INTO worker_health(worker_id, last_seen, jobs_done_10m) VALUES (?, ?, ?)
     ON CONFLICT(worker_id) DO UPDATE SET last_seen=excluded.last_seen, jobs_done_10m=excluded.jobs_done_10m`,
  ).bind(auth.workerId, now, Number(body.jobsDone10m ?? body.jobs_done_10m ?? 0)).run();
  return withCors(json({ ok: true, lease_expires_at: now + POLICY.LEASE_TTL_MS }), request, env);
}

async function resultProxy(request, env, token) {
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(token)) return withCors(json({ error: "not_found" }, 404), request, env, { credentials: false });
  const job = await env.DB.prepare("SELECT status, result_key, expires_at FROM jobs WHERE token=?").bind(token).first();
  const now = Date.now();
  if (!job) return withCors(json({ error: "not_found" }, 404), request, env, { credentials: false });
  if (job.status === "revoked" || job.status === "canceled" || (job.expires_at != null && Number(job.expires_at) <= now)) return withCors(json({ error: "gone" }, 410), request, env, { credentials: false });
  if (job.status !== "done" || !job.result_key) return withCors(json({ error: "not_ready" }, 404), request, env, { credentials: false });
  const object = await env.RESULTS?.get?.(job.result_key);
  if (!object) return withCors(json({ error: "gone" }, 410), request, env, { credentials: false });
  const headers = {
    "content-type": "application/octet-stream",
    "cache-control": "private, no-store",
    "accept-ranges": "none",
  };
  if (object.size != null) headers["content-length"] = String(object.size);
  return withCors(new Response(object.body, { status: 200, headers }), request, env, { credentials: false });
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "content-type, authorization, x-cc-worker-id, x-cc-ts, x-cc-nonce, x-cc-job-id, x-cc-lease, x-cc-kid, x-cc-sig",
        "Access-Control-Max-Age": "600",
      },
    }), request, env);
  }
  if (pathname.startsWith("/auth/") && request.method === "GET") {
    const match = pathname.match(/^\/auth\/google\/(start|callback)$/u);
    if (!match) return errorResponse("not_found", 404, request, env);
    const response = match[1] === "start"
      ? await startOAuth(request, "google", env, { nextPath: url.searchParams.get("next") ?? "/demo/" })
      : await handleCallback(request, "google", env);
    return withCors(response, request, env);
  }
  if (pathname === "/me" && request.method === "GET") return meHandler(request, env);
  if (pathname === "/v1/motion/me" && request.method === "GET") return motionMeHandler(request, env);
  const motionSubmitMatch = pathname.match(/^\/v1\/motion\/(interpolate|act)$/u);
  if (motionSubmitMatch && request.method === "POST") return submitMotion(request, env, ctx, motionSubmitMatch[1]);
  const motionJobMatch = pathname.match(/^\/v1\/motion\/jobs\/([A-Za-z0-9_-]+)$/u);
  if (motionJobMatch && request.method === "GET") return getMotionJob(request, env, motionJobMatch[1]);
  if (pathname === "/jobs" && request.method === "POST") return submitJob(request, env);
  const jobMatch = pathname.match(/^\/jobs\/([^/]+)(\/revoke)?$/u);
  if (jobMatch) {
    const token = decodeURIComponent(jobMatch[1]);
    if (!jobMatch[2] && request.method === "GET") return getJob(request, env, token);
    if (jobMatch[2] && request.method === "POST") return revokeUserJob(request, env, token);
  }
  const resultMatch = pathname.match(/^\/r\/([^/]+)\.npz$/u);
  if (resultMatch && request.method === "GET") return resultProxy(request, env, decodeURIComponent(resultMatch[1]));
  if (pathname === "/worker/next" && request.method === "GET") return workerNext(request, env);
  if (pathname === "/worker/complete" && request.method === "POST") return workerComplete(request, env);
  if (pathname === "/worker/fail" && request.method === "POST") return workerFail(request, env);
  if (pathname === "/worker/heartbeat" && request.method === "POST") return workerHeartbeat(request, env);
  return errorResponse("not_found", 404, request, env);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      console.error("cozyclay api error", error?.message ?? error);
      return errorResponse("internal_error", 500, request, env);
    }
  },
  async scheduled(_event, env, ctx) {
    const work = (async () => {
      await expireHardTimeouts(env);
      await reclaimExpiredLeases(env);
      await cleanupExpiredResults(env);
      try {
        await cleanupOrphanResults(env);
      } catch {
        // Prefix listing is auxiliary; nonce/state maintenance must continue
        // even during a transient R2 list outage.
      }
      const now = Date.now();
      await env.DB.prepare("DELETE FROM worker_nonce WHERE seen_at <= ?").bind(now - POLICY.WORKER_NONCE_TTL_MS).run();
      await env.DB.prepare("DELETE FROM oauth_state WHERE created_at <= ?").bind(now - POLICY.OAUTH_STATE_TTL_MS).run();
    })();
    if (ctx?.waitUntil) ctx.waitUntil(work);
    // Await as well as registering waitUntil so local adapters and operational
    // smoke tests observe completed cleanup before the handler resolves.
    await work;
  },
};

export {
  route,
  json,
  withCors,
  npzLooksValid,
  requireOrigin,
  mutationGuard,
  clearSessionCookie,
  motionEnabled,
  motionUsageFor,
  publicMotionJob,
  runMotionJob,
  submitMotion,
};
