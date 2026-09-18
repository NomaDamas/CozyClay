export const FAL_MOTION_MODEL = "minimax/h3-max-turbo/image-to-video";
export const FAL_MOTION_RESOLUTION = "480P";
export const FAL_MOTION_MIN_DURATION = 5;
export const FAL_MOTION_MAX_DURATION = 15;
// H3's 480P output is 832x480. Capture a 16:9 still so the model does not
// inherit the Studio's currently selected cinematic or portrait aspect.
export const FAL_MOTION_STILL_OUTPUT = Object.freeze({ width: 1920, height: 1080 });

export function motionApiOrigin(location = globalThis.location) {
  const configured = globalThis.__COZYCLAY_MOTION_API__;
  if (configured) return String(configured).replace(/\/+$/u, "");
  if (location?.hostname === "127.0.0.1" || location?.hostname === "localhost") return "http://127.0.0.1:8787";
  return "https://api.cozyclay.org";
}

export function buildH3MotionPrompt(action, { interpolate = false } = {}) {
  const text = String(action ?? "").trim();
  const lead = interpolate
    ? "Move the character naturally from the first reference pose to the final reference pose."
    : text || "Perform the requested character action.";
  return `${lead}\nKeep the camera fixed and preserve the full-body character framing. Animate only the character; keep the scene, lighting, floor, and every object unchanged. Use one continuous shot with no cuts, zooms, pan, tilt, orbit, crop, reframing, or time jump.`;
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
