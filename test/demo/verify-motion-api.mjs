#!/usr/bin/env node
import assert from "node:assert/strict";
import api from "../../workers/api/src/index.js";
import { generateMotion, MODEL, validateInput } from "../../workers/api/src/motion.js";
import { POLICY } from "../../workers/api/src/policy.js";

assert.equal(POLICY.MOTION_DAILY_CAP, 10);
assert.equal(MODEL, "minimax/h3-max-turbo/image-to-video");
assert.deepEqual(validateInput({ stillA: "data:image/png;base64,AAAA", stillB: "data:image/png;base64,AAAA" }, "interpolate"), {
  duration: 5,
  prompt: "Interpolate the character naturally from the first pose to the last pose.",
  first: "data:image/png;base64,AAAA",
  second: "data:image/png;base64,AAAA",
});
assert.equal(validateInput({ still: "https://cdn.example.test/a.png", prompt: "walk", duration: 15 }, "act").duration, 15);
for (const duration of [0, 4, 16, 5.5, "5.0"]) {
  assert.throws(() => validateInput({ still: "https://cdn.example.test/a.png", prompt: "walk", duration }, "act"), /Duration/u);
}

const disabledResponse = await api.fetch(new Request("http://127.0.0.1:8787/v1/motion/act", {
  method: "POST",
  headers: { origin: "http://127.0.0.1:5180", "content-type": "application/json" },
  body: JSON.stringify({ still: "data:image/png;base64,AAAA", prompt: "walk", duration: 5 }),
}), { ENVIRONMENT: "development", SITE_ORIGIN: "http://127.0.0.1:5180", MOTION_GENERATION_ENABLED: "false" });
assert.equal(disabledResponse.status, 503);
assert.equal((await disabledResponse.json()).error, "submissions_disabled");

const originalFetch = globalThis.fetch;
const calls = [];
let uploadNumber = 0;
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  if (String(url).includes("storage/upload/initiate")) {
    uploadNumber += 1;
    return new Response(JSON.stringify({ upload_url: `https://upload.example.test/${uploadNumber}`, file_url: `https://cdn.example.test/still-${uploadNumber}.png` }), { status: 200 });
  }
  if (String(url).startsWith("https://upload.example.test/")) return new Response(null, { status: 200 });
  if (String(url) === "https://queue.fal.run/minimax/h3-max-turbo/image-to-video") {
    const body = JSON.parse(options.body);
    assert.match(body.image_url, /^https:\/\/cdn\.example\.test/u);
    assert.match(body.end_image_url, /^https:\/\/cdn\.example\.test/u);
    assert.equal(body.resolution, "480P");
    assert.equal(body.prompt_expansion_mode, "disabled");
    assert.equal(body.duration, 5);
    return new Response(JSON.stringify({ request_id: "req-motion-test", status_url: "https://queue.example.test/status", response_url: "https://queue.example.test/result" }), { status: 200 });
  }
  if (String(url) === "https://queue.example.test/status") return new Response(JSON.stringify({ status: "COMPLETED" }), { status: 200 });
  if (String(url) === "https://queue.example.test/result") return new Response(JSON.stringify({ video: { url: "https://cdn.example.test/result.mp4", width: 832, height: 480, fps: 24, duration: 5 } }), { status: 200 });
  throw new Error(`unexpected fetch ${url}`);
};
try {
  const generated = await generateMotion({
    kind: "interpolate",
    input: validateInput({ stillA: "data:image/png;base64,AAAA", stillB: "data:image/png;base64,AAAA", prompt: "move", duration: 5 }, "interpolate"),
    env: { FAL_KEY: "test-key" },
  });
  assert.equal(generated.video.url, "https://cdn.example.test/result.mp4");
  assert.equal(generated.requestId, "req-motion-test");
  assert.deepEqual(generated.metadata, { width: 832, height: 480, fps: 24, duration: 5 });
  const queueCall = calls.find((call) => call.url.startsWith("https://queue.fal.run/"));
  assert.ok(queueCall, "Fal queue was not called");
  assert.doesNotMatch(queueCall.options.body, /data:image/u, "Fal input must use hosted URLs, never base64");
} finally {
  globalThis.fetch = originalFetch;
}
console.log("PASS H3 Max Turbo motion validation, QA lock, hosted-image upload, 480P input, polling, and metadata");
