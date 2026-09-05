#!/usr/bin/env node
// Issue #102: labels use the selected locale and icon-only actions explain
// themselves to both mouse and keyboard users.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

assert.match(app, /ko\("Live workspace", "라이브 작업공간"\)/, "workspace status needs a Korean label");
assert.match(app, /aria-label=\{tlPlaying \? ko\("Pause playback", "재생 일시중지"\) : ko\("Play playback", "재생 시작"\)\}/, "PlayView icon needs an accessible name");
assert.match(app, /title=\{tlPlaying \? ko\("Pause playback", "재생 일시중지"\) : ko\("Play playback", "재생 시작"\)\}/, "PlayView icon needs a tooltip");
assert.match(app, /aria-label=\{ko\("Download OTIO cut list", "OTIO 컷 목록 다운로드"\)\}/, "OTIO export needs a descriptive label");
assert.match(app, /title=\{ko\("Download OTIO cut list", "OTIO 컷 목록 다운로드"\)\}/, "OTIO export needs a tooltip");
assert.match(app, /aria-label=\{isKo \? `\$\{label\} 포즈 열기` : `Open pose studio for \$\{label\}`\}/, "pose glyph needs an accessible name");
assert.match(app, /title=\{isKo \? `\$\{label\} 포즈` : `Pose \$\{label\}`\}/, "pose glyph keeps a visible tooltip");

console.log("label and icon tooltip checks PASS");
