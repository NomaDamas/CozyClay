<p align="center">
  <img src="docs/images/cozyclay-logo.png" alt="CozyClay" width="340">
</p>

<p align="center">
  <em>Block a scene, pose the cast, cut the camera — in a browser tab.</em>
</p>

<p align="center">
  Created and maintained by <a href="https://github.com/HaD0Yun">Doyun</a> at <a href="https://github.com/NomaDamas">NomaDamas</a>.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
  <a href="https://www.npmjs.com/package/cozyclay"><img alt="npm" src="https://img.shields.io/npm/v/cozyclay"></a>
  <img alt="Node 22.13+" src="https://img.shields.io/badge/node-22.13%2B-brightgreen">
  <a href="https://github.com/NomaDamas/CozyClay/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/NomaDamas/CozyClay?style=flat"></a>
</p>

<p align="center">
  <a href="https://cozyclay.org/#try">Try it in the browser</a> ·
  <a href="https://cozyclay.org/greybox-to-video/">Greybox to AI video</a> ·
  <a href="https://cozyclay.org/previs-software/">Previs software compared</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-you-can-do">Features</a> ·
  <a href="#ai-control-mcp">AI control</a> ·
  <a href="#controls">Controls</a> ·
  <a href="https://github.com/NomaDamas/CozyClay/issues">Issues</a>
</p>

---

CozyClay is a browser-based previs studio built with Three.js and React Three Fiber. Block a scene, pose the cast, cut the camera on a timeline, then hand the same shot to an AI video model (Seedance, Kling, Veo, or your own) as a first frame, a reference clip, or a prompt — all from one local workspace.

```bash
npx cozyclay
```

That is the whole install. Not sure yet? **[Try it in the browser first](https://cozyclay.org/#try)** — a seven-step camera tutorial on a live scene — then keep going on your machine with the same set:

```bash
npx cozyclay --scene city-block
```

The studio ships seeded with a pre-generated motion clip, so you can scrub the timeline, drive the cameras and draw a dolly rail straight away — generating *new* motion is optional and uses the Kimodo bridge when configured.

New to the camera? The same seven-step tutorial runs inside the Studio on the City Block set: **Settings ▾ → Camera tutorial**, or open `http://127.0.0.1:5180/app/?tutorial=camera`. Each step points at the control it needs and completes only when you actually make the move.

## Demo

https://github.com/user-attachments/assets/1d0113e5-6922-443d-affc-1bdabc666247

## What you can do

|  | |
| --- | --- |
| **Stage a scene** | Create primitives and set pieces, then move, rotate and scale them with the transform strip's gizmo. Grid snapping is a preference, not a law — hold `Ctrl` mid-drag to invert it. A bird's-eye Top-View drives 2D root waypoints for character paths. **View ▾** on the viewport bar holds the reference grid and Auto Color — Blender's random viewport color, so twenty grey blockout boxes stay tellable apart without touching the colors you authored (captures include the display colors while it is on). |
| **Fly the camera** | Right-drag flies (WASD walks, Q/E cranes), middle-drag pans, Alt+drag orbits the selection, click selects, `F` frames — the muscle memory you already have from a 3D editor. Selecting the camera switches to Camera mode; the viewport's look-through button shows the shot camera, `Esc` returns. |
| **Cut and move the camera** | Add shots on the timeline, draw a dolly rail on the Top-View, set speed, height and crane, and preview the move through the shot camera. Each shot carries a **Target model** (Seedance 2.5, Kling 2, Veo 3, self-hosted MiniMax-H3) and is flagged when the cut runs past that model's limits. |
| **Export for AI video** | One **Export ▾** menu: a keyframe pack (first/last frame, clip, camera JSON, prompt, README) as a zip, an mp4 of the shot, depth + normal conditioning passes, a storyboard contact sheet, and an OTIO cut list. The **Shot Prompt** turns the framing into a structured prompt for the model you picked. |
| **Undo anything** | Every scene mutation goes through one history store: a drag, a scrub, an inspector edit is exactly one undo entry. `Esc` cancels an in-flight drag and restores the pre-drag transform. |
| **Generate motion** | Pose characters and export poses, sequence multi-phase motion as Prompt Blocks on a resizable timeline, send them to Kimodo, then play the result back with sparse IK correction where the generated motion needs fixing. Draw over a joint's trail to reshape a take, keep most of it and regenerate a window, and step back through its history. |
| **Capture motion from video or a photo** | Drop a clip or a still: the GPU box runs [GVHMR](https://github.com/zju3dv/GVHMR) and the result is retargeted onto the character with stabilisation, contact correction and a quality gate. |
| **Direct it with an AI** | Connect Claude — or any MCP client — and ask for a shot in plain language. It places the cast, frames “a low wide profile”, generates multi-phase motion, and the viewport moves in front of you. See [AI control](#ai-control-mcp). Inside the Studio, **View ▾ → Panels → Agent panel** (or `Cmd/Ctrl+B`) opens a chat column that signs in with your ChatGPT account and works the same scene. |

## Requirements

- Node.js 22.13 or newer
- npm, or bun
- A Chromium-based browser
- A machine running Kimodo, for motion generation — run `npm run kimodo:setup` once; the installer detects the host and picks the best-supported backend (see the route table below), then downloads the matching checkpoint and text-encoder stack. An SSH-accessible NVIDIA box is the classic target; the same box runs GVHMR for video and photo mocap (`CCLAY_EXTRACT_BACKEND=gvhmr` is the default; there is no browser fallback).

## Quick start

```bash
npx cozyclay
# or
bunx cozyclay
```

That downloads the built studio and opens it at `http://127.0.0.1:5180/app/`. Nothing to compile, no dependency tree to install. Useful flags: `--port 5200`, `--no-open`, `--no-motion`, `--scene city-block` (start on the bundled starter scene instead of an empty room; the first-run dialog offers the same under **Start from a scene**, and a `.cclayproject` downloaded from the browser tutorial opens with **Open a project**).

A global install gives you `cclay`, the same command with less typing. Once a day the launcher checks npm for a newer release and prints a one-line notice after the studio is up; it stays quiet when you're current or offline. `cclay update` installs the latest release, and `--no-update-check` skips the check entirely.

Motion generation uses Kimodo by default once you point it at a Kimodo host:

```bash
CCLAY_KIMODO_HOST=user@your-gpu-box npx cozyclay
```

Install the worker once, on whichever machine should generate motion:

```bash
CCLAY_KIMODO_HOST=user@your-gpu-box npm run kimodo:setup
# or directly on the machine itself:
bash tools/kimodo/setup-on-box.sh
```

The installer is a router — it detects OS, architecture, RAM and CUDA, and installs the best-supported Kimodo variant for that host:

| Host | Backend installed | Why |
| --- | --- | --- |
| macOS Apple Silicon, RAM > 32 GB | [kimodo-mlx](https://github.com/NomaDamas/kimodo-mlx) (MLX/Metal) | The 15 GB text encoder stays resident in unified memory: ~0.9 s warm generation vs ~37 s streaming on an M4 Max 64 GB |
| macOS Apple Silicon, RAM ≤ 32 GB | [kimodo.cpp](https://github.com/localai-org/kimodo.cpp) + Metal (GGML) | Residency doesn't fit; streaming transformer layers from disk is the right trade |
| Linux + working NVIDIA CUDA | [NVIDIA Kimodo](https://github.com/nv-tlabs/kimodo) (PyTorch) | Full CUDA acceleration with the upstream stack |
| Other Unix, no CUDA | kimodo.cpp CPU (Vulkan when available) | Local GGML execution without a GPU |

Inspect the route without changing anything — and override it when you know better:

```bash
bash tools/kimodo/setup-on-box.sh --dry-run
bash tools/kimodo/setup-on-box.sh --backend kimodo.cpp-metal   # or CCLAY_KIMODO_BACKEND=...
```

The RAM threshold between the two macOS routes defaults to 32 GB (`CCLAY_KIMODO_MLX_MIN_RAM_GB`).

## AI control (MCP)

The studio ships an [MCP](https://modelcontextprotocol.io) server, so an AI assistant can drive it — the same scene, the same viewport, live:

> “Put a detective and a courier in an alley, give me a low wide profile shot,
> then make her stand up from the chair, sprint, and trip.”

```json
{
  "mcpServers": {
    "cozyclay": {
      "command": "npx",
      "args": ["-y", "cozyclay", "mcp"]
    }
  }
}
```

Drop that into `claude_desktop_config.json` (or any MCP client config) and restart the client. The
first run automatically installs the MCP SDK's 95-package tree; opening the studio never waits on
it, so those dependencies are fetched only when you actually want the server.

- **Editor open?** Tool calls move the visible viewport — camera, cast, set, generated motion, prompt blocks on the timeline.
- **No editor?** Scene and project tools run headless: block scenes, derive film vocabulary
  (“wide shot · right profile · knee level · 24mm”), render AI video prompts, and write
  `.cclayproject` files. `capture_frame`, `set_prompt_blocks`, `generate_motion`, and
  `apply_batch` require the live editor.

Tools, transports and the live-control protocol are documented in [`mcp/README.md`](mcp/README.md).

### From a clone

```bash
git clone https://github.com/NomaDamas/CozyClay.git
cd CozyClay
npm install
npm run dev
```

Open `http://127.0.0.1:5180/app/` for the Studio (the root redirects there). The Workflow canvas is at `http://127.0.0.1:5180/workflow/`. `npm run dev` starts the studio together with its local Kimodo bridge once `CCLAY_KIMODO_HOST` points at a GPU box; without that variable it starts the studio alone and says so, and Block Generation stays unavailable until you set it. `npm run dev:ui` starts the browser UI alone in every case. The bridge listens on loopback only; Kimodo host variables are documented in [`tools/kimodo/setup-on-box.sh`](tools/kimodo/setup-on-box.sh).

### Workflow canvas

The Workflow canvas at `http://127.0.0.1:5180/workflow/` is a node editor around the Studio: a **CozyClay Scene** node with a live viewport that previews the shot camera, a **Shot Prompt** node that builds a structured prompt from the capture, **Image** nodes (versions, A/B, pinned references) and a **Video** node that runs through your own ComfyUI (`COZYCLAY_COMFY_URL`) or fal (`FAL_KEY`) — bring your own key, nothing is proxied. The **Agent** panel on the right signs in with your ChatGPT account (Codex OAuth, token stored in `~/.config/cozyclay/`) and builds and runs canvas nodes for you. Graphs are saved in the browser and execute locally.

## Hosted demo

Installing a GPU motion backend is the hard part, so `cozyclay.org` also runs a queued demo: a visitor writes one prompt, gets a ticket link, and a GPU box owned by the maintainer generates the motion and uploads it. The visitor never installs anything and never leaves the site — the result opens in the studio itself.

The pieces live in this repository, under `AGPL-3.0-or-later` like everything else:

| Path | Role |
| --- | --- |
| `demo/`, `d/` | Static composer and ticket/result pages, built into `dist/` by the same `npm run build` |
| `workers/api/` | Cloudflare Worker queue API (D1 for state, R2 for results), with its own pinned toolchain |
| `tools/demo-worker/` | The GPU-box poller. Outbound fetch only — it never opens a listening socket |

**Queue policy.** Jobs run in a single FIFO queue. All of these values live in `workers/api/src/policy.js`; nothing else carries a copy.

| Rule | Value |
| --- | --- |
| Active jobs per account | 1 |
| Daily cap | 2 per account |
| Global waiting cap | 200, then submissions are refused |
| Lease / heartbeat / hard timeout | 15 min lease, renewed every 60 s, 20 min hard stop |
| Attempts | 2 (one automatic retry); a failed job refunds the daily cap |
| Result retention | 30 days, then the R2 object is deleted |
| Prompt limit | shared with the studio via `tools/ardy/prompt-limits.mjs` |

**Secrets.** Never committed. Configure each with `wrangler secret put` against `workers/api/wrangler.toml`:
`GOOGLE_CLIENT_SECRET`, `CC_WORKER_SECRET`, `SESSION_SIGNING_KEY`, `TURNSTILE_SECRET_KEY`. The non-secret `GOOGLE_CLIENT_ID` and `TURNSTILE_SITE_KEY` vars in `wrangler.toml` must also be replaced before a real deployment.

**Running the API locally.**

```bash
npm run demo:api:install   # npm --prefix workers/api ci
npm --prefix workers/api exec -- wrangler d1 migrations apply cozyclay-demo --local
npm run demo:api           # wrangler dev on 127.0.0.1:8787
```

**Running the GPU-box worker.** The hosted queue worker has its own isolated runtime and reaches the API outbound only. It is independent from the local Studio's Kimodo backend.

```bash
CC_DEMO_API_BASE=https://api.cozyclay.org \
CC_WORKER_ID=box1 \
CC_WORKER_SECRET=... \
  npm run demo:worker
```

See [`workers/api/README.md`](workers/api/README.md) for the deployment, migration and rollback runbook, and [`tools/demo-worker/README.md`](tools/demo-worker/README.md) for service units, environment-file permissions and the listening-socket check.

## Controls

| Input | Action |
| --- | --- |
| Right-drag | Look around (fly) |
| RMB + WASD | Walk while flying |
| RMB + Q/E | Crane down / up |
| RMB + Shift | Boost fly speed 2.6× |
| Middle-drag | Pan |
| Alt + drag | Orbit the selection |
| Scroll | Dolly; while flying, sets the fly speed instead |
| Click | Select; empty space clears |
| Transform strip | Move / rotate / scale tool, snap |
| Ctrl/Cmd (during drag) | Invert grid snapping |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | Undo / redo |
| Esc | Cancel the in-flight drag |
| End | Drop the selection to the surface |
| Ctrl/Cmd+D | Duplicate the selection |
| Delete / Backspace | Delete the selection |
| F | Frame the selection |
| Look-through button / Esc | Enter / leave the shot camera |
| Cmd/Ctrl+B | Show / hide the Agent panel |

Every control's home is recorded in [`docs/studio-ui-ia.md`](docs/studio-ui-ia.md), with the rule behind each placement.

## Validate

| Command | Covers |
| --- | --- |
| `npm run test:history` | Undo/redo store and transaction coordinator |
| `npm run test:scene-objects` | Scene-object model |
| `npm run test:hierarchy` | Hierarchy panel model |
| `npm run test:objects` | Gizmo interaction in a real browser — needs `npm run dev:ui` in another shell |
| `npm run test:theme` / `test:appearance` / `test:layout` | UI theme, appearance, layout |
| `npm run test:lifecycle` | Dev-server process lifecycle |
| `npm run test:ardy` | Motion conversion, playback, and IK pipeline |
| `node tools/run-tests.mjs` | Every Node verification file (what CI runs) |
| `npm run qa:browser -- node test/qa-camera-tutorial-browser.mjs` | The seven-step tutorial driven with real input, beacons pinned to their controls |
| `QA_URL=… CDP_PORT=… OUT=/tmp/count npm run qa:browser -- node tools/qa/studio-control-count.mjs` | Simultaneously visible controls per mode (budget: Scene ≤35 / Camera ≤38 / Motion ≤52) |
| `cd mcp && npm install && npm run verify` | MCP server over real stdio — all 420 framing combinations |
| `cd mcp && npm run verify:live` | Live-control protocol against a fake editor (same `npm install` first) |
| `npm run build` | Production build |

Ad-hoc browser QA, while a dev server is available (the browser opens the studio at `/app/`):

```bash
npm run qa:browser -- node <qa-script>
```

## Contributing

Found something broken, or want a feature? [Open an issue](https://github.com/NomaDamas/CozyClay/issues) — bug reports with a repro are the most useful thing you can send. Contributions are accepted under `AGPL-3.0-or-later`.

**Repository hygiene.** Generated motion archives, QA output, build output, logs and local runtime artifacts are not source files and must not be committed. Keep `tools/ardy/out/`, `artifacts/`, `dist/`, `.gjc/` and `.npz` files local.

All runtime libraries intentionally live in `devDependencies` because the published npm package ships the prebuilt `dist/`, so `npx cozyclay` must not install the studio's dependency tree.

## Analytics & privacy

The hosted site at [cozyclay.org](https://cozyclay.org/) collects anonymous usage analytics via [PostHog](https://posthog.com/) (US Cloud). There are no cookies and no session recording, and Do-Not-Track is respected. A random pseudonymous identifier is kept in your browser's localStorage so that returning visits and retention can be counted; it is never linked to an account or project content and is removed by clearing site data or using the opt-out toggle.

Events collected:

| Event | Purpose |
| --- | --- |
| `install:first_launch` | First run of the official npm package |
| `app:session_started` | Start of an official npm package session |
| `app:session_ended` | Session duration, action count, and scenes touched (bucketed) |
| `feature:used` | One signal per feature per session |
| `$pageview` | Funnel and drop-off analysis |
| `scene:created` | Funnel and drop-off analysis |
| `scene:loaded` | Funnel and drop-off analysis |
| `project:saved` | User-owned project persistence |
| `project:opened` | Return to a saved project (age bucket) |
| `craft:first_action` | Funnel and drop-off analysis |
| `motion:backend_state` | Motion capability at session start (`none`, `local_kimodo`, or `hosted`) |
| `motion:generate_blocked` | Generate intent when no motion backend is available |
| `motion:job_started` | Motion reliability |
| `motion:job_succeeded` | Motion reliability |
| `motion:job_failed` | Motion reliability |
| `export:blocking_frame_succeeded` | Funnel and drop-off analysis |
| `activation:completed` | Funnel and drop-off analysis |
| `hosted:composer_viewed`, `hosted:login_started`, `hosted:ticket_created` | Hosted demo funnel |
| `hosted:result_opened`, `hosted:opened_in_studio` | Hosted result funnel |

Geo data comes from ingest-time GeoIP country lookup only — no precise location is collected. Prompt text, asset names, file names, project content, local paths, and any user-entered text are never collected.

The official npm package also measures anonymous first launches, sessions, and
the same in-app funnel on its `127.0.0.1` studio. It stores one random
installation identifier in `~/.config/cozyclay/state.json` so returning use can
be counted across ports and browser storage resets. Source checkouts, forks,
development servers, CI, and tests do not send analytics. Official npm
artifacts carry a signature checked by the launcher, so copying or repackaging
the source does not enable telemetry.

Each event is registered with `origin_kind` (`local` or `hosted`), a coarse
operating-system label, and (for npm sessions) `install_kind` (`npx` or
`global`). Source checkouts are classified as `clone` and remain telemetry-off.
The first npm launch may optionally answer a one-line channel question
(`x`, `hn`, `reddit`, `github`, `friend`, `other`, or `skip`); `skip` sends no
acquisition value. Session duration and action counts are buckets, and project
events never include names, paths, prompts, or timestamps.

The npm package prints this disclosure once on first launch. Control it at any
time:

```bash
cclay telemetry status
cclay telemetry off
cclay telemetry on
```

`COZYCLAY_TELEMETRY=0` and `DO_NOT_TRACK=1` disable collection for a launch.
The in-app toggle under **Settings ▾ → Privacy** changes the same npm-package
setting and removes its anonymous installation identifier. Hosted-site visitors can opt out with that
toggle, browser Do-Not-Track, or a content blocker.

PostHog's free plan retains events for 1 year.

## License & credits

GNU Affero General Public License v3.0 or later — see [`LICENSE`](LICENSE) and the transition details in [`LICENSING.md`](LICENSING.md). Modified network services must offer their users the corresponding source. Third-party projects retain their own licenses and copyright; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

The hosted demo worker may use an externally installed [NVIDIA ARDY](https://github.com/nv-tlabs/ardy) runtime. ARDY is a separate third-party project owned and maintained by NVIDIA; it is not included in this repository, and CozyClay is not affiliated with or endorsed by NVIDIA. The local Studio uses Kimodo instead.
