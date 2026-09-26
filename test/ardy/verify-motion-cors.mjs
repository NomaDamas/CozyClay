#!/usr/bin/env node
// The Studio agent pins a generated motion's URL to the bridge's own origin,
// so the editor page (another loopback port) downloads it cross-origin. Only
// loopback pages may read it; any other origin gets no CORS grant.
import assert from "node:assert/strict";
import { motionCorsHeaders } from "../../tools/ardy/bridge.mjs";

for (const origin of ["http://127.0.0.1:5180", "http://localhost:5184", "http://[::1]:5180"]) {
	assert.deepEqual(motionCorsHeaders(origin), { "Access-Control-Allow-Origin": origin }, `${origin} is echoed`);
}
for (const origin of ["https://example.com", "http://example.com:5180", "https://127.0.0.1:5180", "http://127.0.0.1.example.com:5180", "http://127.0.0.1", "null", "", undefined]) {
	assert.deepEqual(motionCorsHeaders(origin), {}, `${String(origin)} gets no CORS grant`);
}

console.log("verify-motion-cors: all checks passed");
