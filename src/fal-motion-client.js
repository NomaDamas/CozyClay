export const FAL_MOTION_MODEL = "minimax/h3-max-turbo/image-to-video";
export const FAL_MOTION_RESOLUTION = "480P";
export const FAL_MOTION_MIN_DURATION = 5;
export const FAL_MOTION_MAX_DURATION = 15;
// The durations the Fal card offers. 15 s (362 frames) is the measured upper
// end the H3 endpoint accepts and the extractor handles (#380 sit-to-bench).
export const FAL_MOTION_DURATIONS = Object.freeze([5, 10, 15]);
// H3's 480P output is 832x480. The reference still is captured at exactly
// twice that canvas, and the Studio switches its viewport to the matching
// "fal 480P" ratio when A is captured, so the user composes the shot on the
// canvas the clip will have.
export const FAL_MOTION_STILL_OUTPUT = Object.freeze({ width: 1664, height: 960 });
export const FAL_MOTION_SHOT_ASPECT = "fal 480P";

export function motionApiOrigin(location = globalThis.location) {
  const configured = globalThis.__COZYCLAY_MOTION_API__;
  if (configured) return String(configured).replace(/\/+$/u, "");
  if (location?.hostname === "127.0.0.1" || location?.hostname === "localhost") return "http://127.0.0.1:8787";
  return "https://api.cozyclay.org";
}

export function buildH3MotionPrompt(action, { interpolate = false } = {}) {
  const text = String(action ?? "").trim();
  // An interpolate call WITH a description leads with the action: measured on
  // #380, "walk to the bench and sit" between the poses produces the motion,
  // while the bare pose-difference lead lets the model invent the transition.
  const lead = interpolate
    ? (text || "Move the character naturally from the first reference pose to the final reference pose.")
    : text || "Perform the requested character action.";
  // Camera and scene stay locked — the extractor reads a locked-off plate and
  // the studio keeps its set. Only the motion-level heading/rotation lock is
  // dropped (#380): it fought any action that turns and made the motion stiff.
  return `${lead}\nKeep the camera fixed and preserve the full-body character framing. Keep the scene, lighting, floor, and every object unchanged. Use one continuous shot with no cuts, zooms, pan, tilt, orbit, crop, reframing, or time jump.`;
}

async function request(path, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${motionApiOrigin()}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* preserve the HTTP status below */ }
  if (!response.ok) {
    const error = new Error(payload?.detail || payload?.error || `Motion request failed (${response.status})`);
    error.code = payload?.error || "motion_request_failed";
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function submitFalMotion(input, fetchImpl = fetch) {
  const kind = input?.kind === "interpolate" ? "interpolate" : "act";
  const body = {
    ...(kind === "interpolate" ? { stillA: input.stillA, stillB: input.stillB } : { still: input.still }),
    prompt: input.prompt,
    duration: Number(input.duration ?? FAL_MOTION_MIN_DURATION),
  };
  return request(`/v1/motion/${kind}`, body, fetchImpl);
}

export function getFalMotionJob(id, fetchImpl = fetch) {
  return request(`/v1/motion/jobs/${encodeURIComponent(id)}`, undefined, fetchImpl);
}

export async function waitForFalMotionJob(id, { intervalMs = 500, timeoutMs = 120_000, fetchImpl = fetch, onUpdate } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await getFalMotionJob(id, fetchImpl);
    const job = payload?.job ?? null;
    onUpdate?.(job, payload);
    if (job?.status === "done" || job?.status === "failed") return payload;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const error = new Error("Motion generation timed out while waiting for the server.");
  error.code = "motion_timeout";
  throw error;
}
