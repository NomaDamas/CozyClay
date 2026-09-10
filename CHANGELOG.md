# Changelog

## 1.8.1

The Studio camera tutorial now starts where the landing page does and shows
where to click.

- Opening the tutorial (Settings ▾ → Camera tutorial or `/app/?tutorial=camera`)
  loads the City Block starter scene with the walk take on its character, at
  frame 0 in the free camera, so Shot / Rail / Play have something to frame.
  A scene with unsaved changes is replaced only after a confirm.
- Each step points at its control: a pulsing spotlight plus a numbered beacon
  and caption pinned to `+ Add shot`, the shot block and `Draw rail`, the
  top view, and the look-through button; the Look / Walk / Dolly / Orbit steps
  show an animated mouse-and-keys cue in the viewport, with the walk keycaps
  turning green as they are pressed. The hint card names the region ("↓
  Timeline, Shots lane", "→ Viewport"). Overlays never take the pointer and go
  static under `prefers-reduced-motion`.

## 1.8.0

The Studio's chrome gets a research-backed cut: the same capabilities, a third
fewer controls on screen at once, and one place for each of them. A first-time
creator can now learn the camera inside the Studio itself, or on cozyclay.org
before installing, and keep the scene they made. Video mocap gets a quality
gate, and AI video takes are checked against the scene they were supposed to
preserve.

### Studio UI simplification

- Simultaneously visible controls drop from 49 / 54 / 65 (Scene / Camera /
  Motion mode) to 35 / 38 / 51, measured by `tools/qa/studio-control-count.mjs`
  and recorded with the per-control rationale in `docs/studio-ui-ia.md`.
- The top bar keeps five actions. One **Export ▾** menu leads with the keyframe
  pack and folds the mp4, depth/normal passes, storyboard and blocking frame
  under it; the three Record buttons and the inspector's duplicate FOV/Recenter
  are gone. **Settings ▾** holds language and analytics.
- **View ▾** on the viewport bar owns the reference grid, Auto Color and body
  part colours; Move/Rotate/Scale stay on the transform strip only.
- The scene switcher sits on the hierarchy's root row; the Projects… button,
  the root fold caret and the Characters group row are removed and characters
  sit directly under the scene.
- Timeline motion tools (IK, Foot, Body, speed, Clear, take bar) render only in
  Motion mode; Foot snap and Body contact appear only while IK is on.
- The Scene/PlayView tabs are replaced by the viewport's look-through button:
  it enters an explicit preview of the shot camera and Esc returns.
- Selecting the camera switches to Camera mode; the Placement row appears in
  Motion mode; Generate all waits for at least one prompt block.
- The `advancedMode` / `beginnerMode` gates that had been hardcoded on are
  removed.

### Learn the camera

- A seven-step camera tutorial runs inside the Studio: Look, Walk (W A S D
  Q E), Dolly, Orbit, Shot, Rail, Play. Open it from Settings ▾ → Camera
  tutorial or `/app/?tutorial=camera`; each step completes only when the
  gesture actually happens, and the strip never takes the pointer.
- cozyclay.org embeds a live Studio playground on a preset city block with the
  same seven steps, a second demo reel, and leaner copy. The tutorial ends by
  handing over `npx cozyclay --scene city-block`, which opens the local Studio
  on that starter scene; starter scenes are also offered from the project
  browser, and the visitor can download the scene they made.

### Agent panel in the Studio

- The Workflow page's Agent chat column is available in the Studio, toggled
  from View ▾ → Panels → Agent panel or Cmd/Ctrl+B. It boots collapsed so the
  mode budgets above are unchanged.

### Video mocap and AI video takes

- GVHMR is the only extraction backend; the bridge and the Studio return a
  named error instead of silently falling back to browser MediaPipe.
- GVHMR output goes through adaptive position/rotation stabilisation, explicit
  contact correction, support-surface height (a chair lifts the motion), a
  mocap quality gate, and scene calibration that survives restore. Palette
  segmentation diagnostics are exposed for AI-rendered mannequin clips.
- H3 video takes are checked against the requested scene and camera: the
  Workflow shows a lock receipt on success and rejects a take whose background
  or camera drifted, keeping no stale preview.

### Site

- Four search-facing pages (greybox to video, previs software, Seedance camera
  control, privacy), `robots.txt` with an explicit AI-crawler policy,
  `llms.txt`, a generated sitemap with real last-modified dates, and IndexNow
  pings on deploy.

## 1.7.1

- Open the complete Studio at the development server root; the unfinished
  Workflow canvas remains available at `/workflow/`.

## 1.7.0

Kimodo becomes the default motion-generation backend, and a full edit-and-refine
loop lands on top of it: draw over a trail to reshape it, keep most of a take
and regenerate only a window, and step back through 20 checkpoints of a
take's history. Multi-character rigs, prop motion, and camera work all get
real editing surfaces, and three failure modes that used to blank the whole
studio now degrade with a way back instead.

### Kimodo motion backend, now default

- Kimodo, introduced behind `CCLAY_MOTION_BACKEND=kimodo`, is now the default
  motion-generation backend.
- Root 2D path constraints, pose pinning (via Kimodo's fullbody constraints),
  and motion-edit-by-regeneration (IK-adjust a span, then regenerate) now all
  work on Kimodo — base clips still refuse, since Kimodo has no autoregressive
  history input for them.
- The prompt-block cap is raised from 4s to 5s after measuring seam quality
  across block lengths — 5s scored best short of a single seamless take, while
  8s blocks collapsed and sub-2s blocks lost a third of their frames to the
  transition window.

### Draw to edit a take (line editing)

- A new line-edit mode: drag a joint's motion trail to reshape it, or draw a
  fresh stroke across empty space when the trail doesn't reach where you want.
  Stroke endpoints snap to the take's own nearby frames so edits land where
  you meant, and a smoothstep seam keeps the join from popping.
- Pin exact moments in 3D: scrub the playhead, drag a joint into place, and
  pin up to 8 moments across a take.
- Runs on a new ProjFlow-based backend on the Kimodo box; edits are
  seed-deterministic, so a release-quality regenerate reproduces the preview
  bit for bit.
- Ctrl/Cmd+Z undoes the last pull; releasing a drag previews at reduced
  quality first (~1s), then a full-quality generate confirms with the same
  seed.

### Keep most of a take (preserve mode)

- A preserve slider and grouped per-limb masks let you regenerate only part of
  a take — free one limb, or a masked region — instead of the whole clip.
- Effector constraints keep specific joints anchored through a regeneration.

### Take recipes and version history

- Every generate or edit now records its own recipe (seed, prompt blocks, and
  edits in order), and extending a take re-sends its edits so refining before
  extending no longer throws work away.
- A version strip above the timeline checkpoints every generate/edit up to 20
  deep — click any entry to restore that take and its recipe.
- The edit surface collapses to two modes: 장면 (Kimodo blocking — new, again,
  add-block) and 다듬기 (line-edit refinement, one click from a loaded take).

### Multi-character rigs and IK

- Every cast member now gets its own namespaced rig subtree in the Hierarchy
  panel, not just the first — bones, IK badges, and focus all follow the
  active character correctly (#76, #77, #78).
- IK corrections on an inactive character now survive a focus switch instead
  of silently reverting to the uncorrected take (#77).
- Timeline pins (IK correction keys, prompt-clip ranges) migrate through
  segment retimes instead of firing on the wrong frame after a slow-mo (#79).
- Body Contact: dragging a character down during IK editing now stops the
  pelvis at the floor and holds any planted foot or reaching hand there,
  measured per character from the actual skinned mesh — no more clay figures
  hovering above the ground.
- Motion trails now render per body part in IK handle colors, with trail
  editing and IK editing split into separate tools instead of one ambiguous
  shared gizmo.
- A One-Euro filter now smooths SAM-extracted wrist tremor by speed —
  quieting rest-state jitter while leaving fast strikes untouched (#84).

### Prop motion: travel paths and speed

- Scene objects (props) can now be given a travel path, authored the same way
  as a camera rail: draw it in Top-View, refine it in the 3D scene, with a
  mid-route point insertable by double-click.
- A speed graph — shared by props and the camera dolly — lets you drag a
  stretch of the timeline faster or slower; the area under the curve is the
  distance, so the rest of the segment compensates automatically, and a cut
  pins the take at an exact time/distance point.
- Drag a prop onto a character or a specific rig bone in the Hierarchy to
  attach it — it now rides that character's motion (a carried bat stays in a
  walking character's hand instead of staying world-anchored).

### Viewport and lighting

- Auto Color mode: a topbar toggle stamps a stable, automatically derived
  color onto every set object, the way Blender's random viewport shading
  colors objects — display-only, so authored colors, saved projects, undo
  history, and the MCP scene view are untouched.
- A new Grid view swaps the clay stage for a dark, Blender-style reference
  grid for blocking work — overlay-only, so exports and the plan board never
  see it.
- The key light is now a grabbable sun: move it like any other object, and
  dial its warmth between cool daylight and warm sunset amber.
- Blender-style composition guides (thirds, golden ratio, center+diagonals,
  safe areas) on the shot preview, and exported frames can burn in a slate +
  zero-padded frame counter.

### Camera

- Crane marks get a 3-axis gizmo; a rail now always carries a crane profile,
  and the old on/off toggle is gone (a flat profile at the follow height reads
  as "off").

### Project workflow

- A startup chooser and local project session replace the always-on implicit
  scene.
- New workflow-focused camera motion modes, plus several passes cleaning up
  timeline control grouping, control visibility, and removing legacy
  console/generation panels.

### AI control (MCP)

- `describe_scene` now reports the key light and the shot list; `update_object`
  can set a prop's travel path; `load_motion` can target a specific character
  by letter/slot/id and re-install an assembled take without a full
  regeneration.
- Editors now identify themselves (project, scene, cast size) in
  `live_status`, so multi-tab routing no longer depends on an opaque UUID.

### Hosted demo v1

- cozyclay.org's install-free demo got a real backend: a Cloudflare Worker
  queue (Google OAuth + Turnstile, single-FIFO D1 queue, private R2 result
  proxy) and an outbound-polling GPU box worker with zero inbound sockets.

### Reliability

- Three failure modes that used to blank the whole studio now degrade
  instead: a render error anywhere in the app shows a message with a
  reload-and-resume, a lost WebGL context (sleep/wake, driver restart) shows
  an overlay and repaints on restore, and layout-save writes are guarded like
  every other write in the app (#64).
- A selected object's own gizmo cage no longer blocks clicks meant for a
  different object (#81).
- Recording no longer exports frozen tail frames after a cast member or
  motion segment shrinks (#80).

### Also in this release

- Onboarding: a hosted-demo visitor now gets a "watch the sample" path instead
  of landing on an empty stage, and three funnel-measurement gaps (startup
  scene creation, video export, cutout import) are closed.
- The studio's PWA update banner finally has a listener, so a waiting version
  reloads on request instead of running stale indefinitely.
- Objects can now be parented from the Inspector's own Parent picker, not
  only through MCP.

## 1.6.0

The official npm package now records anonymous product usage so downloads can
be distinguished from real launches and returning use.

- `npx cozyclay`, `bunx cozyclay`, and global `cclay` launches get a
  signed-package-verified anonymous installation ID.
- The existing scene, edit, motion, export, and activation funnel is available
  for npm sessions with `distribution: npm` and `app_version` properties.
- Source checkouts, forks, CI, tests, malformed or unsigned packages, and
  opted-out launches remain untracked.
- `cclay telemetry status|on|off` controls the package-wide setting; the
  in-app toggle stays synchronized with it.
- URL/referrer/campaign-derived values are scrubbed before any event leaves the
  browser, and corrupted telemetry state fails closed.

## 1.5.0

The release where the camera can climb a shaped path, recordings leave the studio as
standard MP4 files, and generated falls finally reach the ground.

### Shape a crane move

Rail Follow now carries a persisted crane-height profile with two to eight points instead
of only a start and end height. The camera evaluates the profile with a monotone cubic
curve, so it passes through every authored height without overshooting. Purple handles in
the scene and matching markers in each Shot card stay synchronized: drag vertically to set
height, Shift-drag along the rail, double-click to add a point, and delete an interior point.
One undo reverses one complete gesture, and older `{start,end}` projects migrate to pinned
endpoints automatically.

### Record a real MP4

Record now downloads a fast-start H.264 MP4 at 24 fps instead of WebM. The exporter tries
High, Main, then Baseline AVC profiles, keeps frame-addressed deterministic rendering, and
fails by name when the browser has no compatible H.264 WebCodecs encoder rather than
producing a misleading MP4 that desktop editors cannot open. Mediabunny performs the
in-browser muxing and is documented in the third-party notices.

### Falls that read in previs

When generated motion walks off its support, CozyClay can stage a ballistic root drop with
horizontal drift, a readable fall clock, and an impact hold instead of leaving the character
suspended at the roof edge. Motion completion now means the editor acknowledged and
installed the take: explicit rejection fails visibly, reconnects do not duplicate the
installation, and an uncertain lost acknowledgement is never retried as though nothing
happened.

### ARDY bridge fixes

- Local runner options now reach the bridge instead of disappearing between processes.
- Camera-clause cleanup no longer mistakes ordinary object nouns for camera instructions.
- The prompt guide distinguishes measured upstream behavior from local authoring heuristics.
- Demo and operations documentation now use supported options and cite the four-second
  waypoint-history evidence honestly.

## 1.4.1

Gizmo drags survive past their first tick again. The split-camera work in 1.4.0 wrapped the
gizmo's change callback in a shot-camera dispatcher that dropped the drag-transaction token,
so every arrow, plane, knob, and ring drag was closed by its own first move — objects moved
one snap step and stopped. The token now round-trips, and the gizmo suite drives the ring
with a real arc and the plan puck in the Top-View inset, matching how the studio actually
works today.

## 1.4.0

The release where every edit can be taken back.

### Undo, everywhere

One Ctrl+Z history now covers the whole editor, not just character moves. Newly undoable:

- **Prompt blocks** — add, remove, drag, edge-resize, and text edits (one entry per editing
  session, not per keystroke).
- **Root waypoints** — floor-click placement, timeline removal, and Top-View drags.
- **Camera authoring** — camera keys (add / re-time / remove / clear), camera-block settings,
  rail schedule moves and resizes, rail removal, and viewport or plan framing commits.
- **Shots** — delete, add, split, duplicate, reorder, boundary resize, and rename.
- **The Full-Body take** — segment cuts, retimes, deletions, trims, and clearing the take
  (the cleared clip, IK keys, and stature all come back).
- **Poses and the cast** — pose apply / reset / save, model swap, tint, subject text, and
  inspector position scrubs.
- **IK keys** — add, remove, and drag-bake; undo snapshots now carry the key map itself.

Every continuous drag records exactly once at gesture start, so a long drag is one Ctrl+Z,
never a hundred.

### Cut the take like film

The Full-Body strip is now a cutting room: cut at the playhead, then grab a segment's amber
right-edge grip and stretch it — the width IS the playback rate (wider is slower, 0.1×–4× on
the same grid as the numeric editor). Right-click a segment to delete it outright. All of it
is non-destructive: the source frames stay whole, and a right-click on a trim handle still
restores the full take.

### Two cameras, one stage

The editing view and the recording camera are no longer the same eye. The main pane belongs
to a free editor camera — fly it, inspect the set, scrub playback — while the shot camera
records through a chrome-free 16:9 preview and stands in the scene as a selectable ghost you
block like any other body. Look-through hands you the old framing-by-flying when you want it,
and leaves your view alone when you don't.

### A hardened MCP

The server now enforces loopback-only hosting, rejects forged HTTP origins, refuses project
files with hard links, isolates live scene documents and generation artifacts per session,
and preserves motion-job ownership across reconnects. HTTP session children inherit the
parent's configuration (a configured bridge URL no longer silently vanishes), and a session
that cannot own the live editor port now says exactly why instead of pretending no editor
exists.

### Everything else

- **Selection** — clicking empty floor or sky reliably clears the selection; the selection
  cage's generous line hitbox no longer swallows the press.
- **Timeline** — the camera block's preview button plays its shot instead of throwing.
- **CI** — pull requests are gated on the node and browser suites.
- CozyClay now ships as an `AGPL-3.0-or-later` combined work. Modified versions offered over
  a network must offer their users the corresponding source, and the Studio footer carries
  that source offer.

## 1.3.0

The release where the studio stops being something only a person can drive.

### Direct it with an AI

CozyClay now ships an [MCP](https://modelcontextprotocol.io) server. Point Claude, Cursor, or any
MCP client at it and ask for a shot in plain language — it places the cast, frames "a low wide
profile", generates multi-phase motion, and **the viewport moves while you watch**.

```json
{ "mcpServers": { "cozyclay": { "command": "npx", "args": ["-y", "cozyclay", "mcp"] } } }
```

It computes nothing of its own. Every answer comes from the modules the studio already renders
with — `shot.js` for film vocabulary, `scenes.js` for the stage, `camera-move.js` for moves — so
the server and the UI cannot disagree about what a 35 mm medium shot is.

- **Live or headless.** With a studio tab open, tool calls drive the real viewport over a local
  socket. With no tab, scene/project tools still block scenes, derive framing, render prompts,
  and write `.cclayproject` files; capture, prompt-block installation, motion generation and
  atomic live batches remain editor-only.
- **Motion from plain beats.** `generate_motion` preserves composite physical wording while
  stripping camera, scenery and internal-state language ARDY cannot animate, splits only beats
  that exceed ARDY's duration bound, and lands each phase as a Prompt Block on the timeline.
- **24 tools**, all documented in [`mcp/README.md`](mcp/README.md).

### Cut a photograph out and stand it up

Drop an image on Props — or straight onto the shot — and it becomes a card you can place, turn and
block against. The background editor lives in the card's own inspector: paint or erase the
selection, zoom and pan with the wheel, and the picture sits on a stage rather than being framed
by one. Assets are stored once by content hash, so the same picture imported twice costs one copy.

### An open stage

The two-walled room corner is gone. The set is a 500 m open deck — far enough that no ordinary
blocking meets its edge — with a two-tier grid (quiet 1 m cells, assertive 10 m lines) and a
distance falloff that dissolves the floor into the background instead of ending at a horizon.
Movement clamps moved from ±11 m to ±240 m, so a run or a chase finally has room.

### Group props and move them as one

Scene objects now carry a parent. Build a rocket from ten primitives, group them, and the whole
thing drags as one body — through the gizmo, the inspector and the MCP tools alike. Deleting a
parent promotes its children rather than taking them with it.

### Everything else

- **Gizmo** — the cast rides the same gizmo as scene objects, with rotate and scale; an XZ pad for
  free ground drags; pick targets balanced so the pad no longer swallows every press.
- **Mocap** — a video capture panel, takes assigned to cast members, and take trimming.
- **Timeline** — authoring runs on a 24 fps production clock while ARDY is still spoken to at
  20 fps, and exports record at true motion speed.
- **Multi-character** — an unbounded cast with per-character motion layers.

### Fixes

- Props reported `1x1x1` regardless of how they were built: scale never crossed the live protocol,
  and the server reset whatever did arrive. Sizes are now real, and per-axis scale is exposed.
- A 6 m ceiling survived the walls it belonged to, silently decapitating anything tall.
- Generating four Prompt Blocks produced one. IK keys from a discarded take made a fresh run look
  like a local edit, and that path ships no schedule. Replacing a take now clears the corrections
  authored against it.
- A stale service worker served yesterday's bundle to the dev server, so edits appeared to do
  nothing. Dev now serves a self-destructing worker.
- Prompt blocks are capped at 4 s everywhere, not just in the UI — longer beats chain instead of
  being authored into something the timeline would refuse.

### Packaging

- `mcp/` ships with the package, so `npx cozyclay mcp` works without a clone.
- `exports` makes `cozyclay/src/*` a public contract instead of an accident.
- `three` is declared as an optional peer: the studio bundles its own copy, but anything importing
  `cozyclay/src/*` needs it, and now npm says so.

## 1.2.0

- `npx cozyclay` opens the studio again.
- Stopped shipping 26 MB of scratch files.

## 0.1.0

First public release.
