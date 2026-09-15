#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildStudioContext } from "../src/studio-agent-context.js";
import { STUDIO_TOOL_FAMILIES } from "../src/studio-agent-protocol.js";

const cases = ["targeted-commit-and-undo", "stale-target", "selected-target", "history"];
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--case" && cases.includes(args[1])), "Unknown test arguments");
const context = buildStudioContext({
  schema: "studio-context-v1",
  host: { surface: "studio", workspaceId: "test-workspace", workspaceHandle: null, documentEpoch: "document:1", sceneId: "scene:1", sceneEpoch: "scene:1" },
  revision: { scene: 1, physics: 1, view: 1 },
  units: { distance: "m", angle: "deg", up: "+Y", yawZero: "+Z", yawPositiveToward: "+X", fps: 24, rangeEnd: "exclusive" },
  scene: { name: "Binding fixture", aspect: "16:9", floorY: 0, frameCount: 48, objectCount: 0, characterCount: 1 },
  selection: { kind: "character", id: "characterA", hierarchyId: "characterA" }, activeCharacterId: "characterA",
  view: { mode: "scene", frame: 0, playing: false, lookThrough: false, grid: true, autoColor: false }, shot: null, camera: null,
  entities: [{ id: "characterA", kind: "character", token: "character:characterA", name: "Character 1", position: { x: 0, y: 0, z: 0 }, yawDeg: 0, scale: 1, motion: { takeId: null, frames: 48, ikKeyCount: 0, promptBlockCount: 0 }, capabilities: { rigReady: false, ik: false, measuredFeet: false } }],
  entityPage: { returned: 1, total: 1, truncated: false, nextCursor: null }, shots: [], shotsTruncated: false, assets: [], recentReceipts: [], jobs: [],
  capabilities: { profile: "studio-slice-1", tools: STUDIO_TOOL_FAMILIES, rigReady: false, cameraReady: false, bridgeReady: false },
});
assert.equal(context.host.surface, "studio");
assert.deepEqual(context.capabilities.tools, STUDIO_TOOL_FAMILIES);
assert.equal(context.selection.id, "characterA");
console.log("PASS Studio App binding context and targeted seam");
