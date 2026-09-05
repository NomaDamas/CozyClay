#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isForeignGizmoHandleHit, shouldObjectWinSelection } from "../src/object-picking.js";

const ownRoot = { userData: { gizmoRoot: true }, parent: null };
const foreignRoot = { userData: { gizmoRoot: true }, parent: null };
const ownHandle = { userData: { gizmoHandle: true }, parent: ownRoot };
const foreignHandle = { userData: { gizmoHandle: true }, parent: foreignRoot };
const cageLine = { userData: {}, parent: ownRoot };
const gridMesh = { userData: { gridFloor: true }, parent: null };

assert.equal(isForeignGizmoHandleHit(ownHandle, ownRoot), false, "the selected gizmo cannot block its own object switch");
assert.equal(isForeignGizmoHandleHit(foreignHandle, ownRoot), true, "the other gizmo can protect its handles");
assert.equal(isForeignGizmoHandleHit(cageLine, ownRoot), false, "selection cage lines are not competing gizmo handles");
assert.equal(isForeignGizmoHandleHit(gridMesh, ownRoot), false, "grid furniture is not a competing gizmo handle");
assert.equal(shouldObjectWinSelection("Sphere", "Cube"), true, "a different body wins over the selected gizmo");
assert.equal(shouldObjectWinSelection("Cube", "Cube"), false, "the selected body does not switch selection");
assert.equal(shouldObjectWinSelection(null, "Cube"), false, "empty space is not an object selection");

const gizmoSource = readFileSync(new URL("../src/object-gizmo.jsx", import.meta.url), "utf8");
assert.match(gizmoSource, /pickedObject = pickObject\(\)/, "the body is picked before gizmo handles");
assert.match(gizmoSource, /shouldObjectWinSelection\(pickedObject\.id, stateRef\.current\.object\?\.id\)/, "a different body wins before gizmo drag");
assert.match(gizmoSource, /isForeignGizmoHandleHit\(entry\.object, rootRef\.current\)/, "only foreign gizmo handles veto selection");

console.log("verify-object-picking: all checks passed");
