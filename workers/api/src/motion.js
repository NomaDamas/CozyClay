const MODEL = "minimax/h3-max-turbo/image-to-video";
const STORAGE_INIT = "https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";
const QUEUE_ORIGIN = "https://queue.fal.run";
const DAILY_CAP = 10;
const MAX_STILL_BYTES = 12 * 1024 * 1024;
const MIN_DURATION = 5;
const MAX_DURATION = 15;

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

function fail(code, message, status = 400) {

  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(String(value ?? ""));
  if (!match) throw fail("invalid_still", "Still must be an image data URL.");
  const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
  if (!bytes.byteLength || bytes.byteLength > MAX_STILL_BYTES) throw fail("still_too_large", "Still exceeds the 12 MB limit.");
  return { bytes, contentType: match[1] };
}

async function stillBlob(value) {
  if (String(value).startsWith("data:image/")) {
    const parsed = parseDataUrl(value);
    return new Blob([parsed.bytes], { type: parsed.contentType });
  }
  if (!/^https:\/\//u.test(String(value))) throw fail("invalid_still", "Still must be a hosted image or image data URL.");
  const response = await fetch(value);
  if (!response.ok) throw fail("still_fetch_failed", "Could not fetch the supplied still.", 400);
  const blob = await response.blob();
  if (!blob.type.startsWith("image/") || blob.size > MAX_STILL_BYTES) throw fail("invalid_still", "Supplied still is not a supported image.");
  return blob;
}

function falHeaders(env, contentType = null) {
  if (!env.FAL_KEY) throw fail("fal_not_configured", "Fal provider is not configured.", 503);
  return { authorization: `Key ${env.FAL_KEY}`, ...(contentType ? { "content-type": contentType } : {}) };
}

export async function uploadStill(value, env, name = "cozyclay-still.png") {
  const blob = await stillBlob(value);
  const contentType = blob.type || "image/png";
  const init = await fetch(STORAGE_INIT, {
    method: "POST",
    headers: falHeaders(env, "application/json"),
    body: JSON.stringify({ file_name: name, content_type: contentType }),
  });
  if (!init.ok) throw fail("fal_upload_init_failed", "Fal storage upload could not be initialized.", 502);
  const target = await init.json();
  if (!target.upload_url || !target.file_url) throw fail("fal_upload_init_failed", "Fal storage returned no upload URL.", 502);
  const put = await fetch(target.upload_url, { method: "PUT", headers: { "content-type": contentType }, body: blob });
  if (!put.ok) throw fail("fal_upload_failed", "Fal storage rejected the still upload.", 502);
  return target.file_url;
}

function validateInput(body, kind) {
  const first = kind === "interpolate" ? body?.stillA : body?.still;
  if (!first) throw fail("invalid_still", "A source still is required.");
  if (kind === "interpolate" && !body?.stillB) throw fail("invalid_still", "An end still is required for interpolation.");
  const duration = body?.duration === undefined ? 5 : body.duration;
  if (!Number.isSafeInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION) throw fail("invalid_duration", "Duration must be an integer from 5 to 15 seconds.");
  const prompt = kind === "act" ? String(body?.prompt ?? "").trim() : String(body?.prompt ?? "Interpolate the character naturally from the first pose to the last pose.").trim();
  if (!prompt || prompt.length > 4000) throw fail("invalid_prompt", "Prompt is required and must be at most 4000 characters.");
  return { duration, prompt, first, second: body?.stillB ?? null };
}

function dimensionsFrom(value) {
  let result = { width: null, height: null, fps: null, duration: null };
  const visit = (item) => {
    if (!item || typeof item !== "object") return;
    for (const key of ["width", "height", "fps", "duration"]) if (Number.isFinite(item[key])) result[key] = Number(item[key]);
    for (const child of Object.values(item)) if (child && typeof child === "object") visit(child);
  };
  visit(value);
  return result;
}

async function submitFal(inputs, env) {
  const response = await fetch(`${QUEUE_ORIGIN}/${MODEL}`, {
    method: "POST",
    headers: falHeaders(env, "application/json"),
    body: JSON.stringify(inputs),
  });
  if (!response.ok) throw fail("fal_submit_failed", "Fal rejected the motion request.", 502);
  return response.json();
}

async function runFal(requestId, statusUrl, responseUrl, env) {
  const deadline = Date.now() + 90_000;
  let current = null;
  while (Date.now() < deadline) {
    const statusResponse = await fetch(statusUrl ?? `${QUEUE_ORIGIN}/${MODEL}/requests/${encodeURIComponent(requestId)}/status`, { headers: falHeaders(env) });
    if (!statusResponse.ok) throw fail("fal_status_failed", "Fal status request failed.", 502);
    current = await statusResponse.json();
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(current.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!current || current.status !== "COMPLETED") throw fail("fal_generation_failed", current?.error ?? "Fal generation did not complete.", 502);
  const resultResponse = await fetch(responseUrl ?? `${QUEUE_ORIGIN}/${MODEL}/requests/${encodeURIComponent(requestId)}`, { headers: falHeaders(env) });
  if (!resultResponse.ok) throw fail("fal_result_failed", "Fal result request failed.", 502);
  return resultResponse.json();
}

export async function generateMotion({ kind, input, env }) {
  const firstUrl = await uploadStill(input.first, env, "cozyclay-motion-a.png");
  const secondUrl = input.second ? await uploadStill(input.second, env, "cozyclay-motion-b.png") : null;
  const prompt = `${input.prompt}\n\nKeep the camera fixed and preserve the full-body character framing. Animate only the character; keep the scene and all objects unchanged. No cuts, zooms, pan, tilt, orbit, crop, reframing, or time jump.`;
  const submitted = await submitFal({
    image_url: firstUrl,
    ...(secondUrl ? { end_image_url: secondUrl } : {}),
    prompt,
    duration: input.duration,
    resolution: "480P",
    prompt_expansion_mode: "disabled",
  }, env);
  const result = await runFal(submitted.request_id, submitted.status_url, submitted.response_url, env);
  const video = result?.video ?? result?.data?.video;
  if (!video?.url) throw fail("fal_result_invalid", "Fal returned no video URL.", 502);
  return { video, result, requestId: submitted.request_id, sourceUrls: { first: firstUrl, second: secondUrl }, metadata: dimensionsFrom(result) };
}

export { DAILY_CAP, MAX_DURATION, MAX_STILL_BYTES, MIN_DURATION, MODEL, validateInput };
