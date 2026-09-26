#!/usr/bin/env node
// Issue #102: labels use the selected locale and icon-only actions explain
// themselves to both mouse and keyboard users.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
// Playback lives in the timeline transport only (#193 removed the PlayView
// bar's duplicate), so its icon contract is asserted where the buttons are.
const timeline = readFileSync(new URL("../src/ardy/timeline.jsx", import.meta.url), "utf8");

assert.match(app, /ko\("Live workspace", "라이브 작업공간"\)/, "workspace status needs a Korean label");
assert.match(timeline, /aria-label=\{playing \? ko\("Pause playback", "재생 일시중지"\) : ko\("Play playback", "재생 시작"\)\}/, "the play icon needs an accessible name");
assert.match(timeline, /title=\{ko\("Play \/ pause \(Space\)", "재생\/일시중지 \(Space\)"\)\}/, "the play icon needs a tooltip");
assert.match(app, /title=\{ko\("Download OTIO cut list", "OTIO 컷 목록 다운로드"\)\}/, "the OTIO export item needs a tooltip");
assert.match(app, /aria-label=\{isKo \? `\$\{label\} 포즈 열기` : `Open pose studio for \$\{label\}`\}/, "pose glyph needs an accessible name");
assert.match(app, /title=\{isKo \? `\$\{label\} 포즈` : `Pose \$\{label\}`\}/, "pose glyph keeps a visible tooltip");

console.log("label and icon tooltip checks PASS");
