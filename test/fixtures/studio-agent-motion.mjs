#!/usr/bin/env node
/** Deterministic, CPU-only motion fixture for the real Studio candidate path. */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";

export function createFixtureMotion({ frames = 48, fps = 24 } = {}) {
  if (!Number.isInteger(frames) || frames < 1) throw new TypeError("frames must be a positive integer");
  const rootPos = new Float32Array(frames * 3);
  const posedJoints = new Float32Array(frames * 27 * 3);
  const rotMats = new Float32Array(frames * 27 * 9);
  for (let frame = 0; frame < frames; frame += 1) {
    rootPos[frame * 3 + 1] = 0.9544128;
    for (let joint = 0; joint < 27; joint += 1) {
      const pose = frame * 27 * 3 + joint * 3;
      posedJoints[pose + 1] = 0.9544128;
      const rotation = (frame * 27 + joint) * 9;
      rotMats[rotation] = rotMats[rotation + 4] = rotMats[rotation + 8] = 1;
    }
  }
  return { frames, fps, personScale: 1, rootPos, posedJoints, rotMats, mode: "fixture-only" };
}

export async function startFixtureMotionBackend({ port = 0 } = {}) {
  const motion = createFixtureMotion();
  const server = createServer((request, response) => {
    if (request.url === "/ardy/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, mode: "fixture-only", device: "cpu" }));
      return;
    }
    if (request.url === "/ardy/generate") {
      request.resume();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ event: "done", mode: "fixture-only", motion }));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return { server, origin: `http://127.0.0.1:${server.address().port}`, mode: "fixture-only", motion };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fixture = JSON.parse(readFileSync(new URL("./studio-agent-scene.json", import.meta.url)));
  const backend = await startFixtureMotionBackend();
  console.log(JSON.stringify({ mode: backend.mode, origin: backend.origin, scene: fixture.scene.id, frames: backend.motion.frames }));
  process.on("SIGTERM", () => backend.server.close(() => process.exit(0)));
}
