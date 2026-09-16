# Studio Agent slice 1 verification

Date: 2026-09-16

Branch: `feat/studio-agent-slice1-verified`

Issue: [#320](https://github.com/NomaDamas/CozyClay/issues/320)

Scope: the merged slice (#289–#296 via #297–#307, plus #309, #312, #314, #316, #319).

## Which path each step used

Both real services were probed before any QA was run. Raw results are in
`.omo/evidence/slice1-verified/backend-probes.json` (not committed).

| Probe | Result | Consequence |
| --- | --- | --- |
| `GET /oauth/status` | HTTP 200, signed in, `pro` plan | The real signed-in session works. |
| `GET /ardy/health` | HTTP 503, motion backend unavailable | No real motion generation was possible. |

The 503 is an environment fault, not a product fault: the bridge starts, but the
configured remote motion host fails its SSH probe, so the sidecar correctly reports
itself unavailable rather than pretending to generate.

Because of that, every step below ran against the CPU-only fixture transport in
`test/fixtures/studio-agent-motion.mjs`. Be precise about what that replaces:

- **Replaced:** the motion generator, and the model. The fixture supplies a scripted
  `codex` client, so the tool calls chosen for *every* turn — placement, framing and
  motion alike — are scripted rather than decided by a live model.
- **Not replaced:** the production Agent HTTP route and SSE stream, the Studio tool
  schemas and argument validation, the Studio motion runtime, LiveHub, the editor
  command journal, the candidate verifier and repairer, the installer, the timeline
  and native Undo. Those all executed for real, and they are what authored every
  change recorded here.

So this run verifies the Studio's execution path end to end. It does **not** verify
model behaviour, semantic motion quality, model vision, or GPU generation. The panel
says so itself: every installed take carries the `FIXTURE-ONLY` badge and the
runtime's own `semantic-and-visual-review-unavailable` limitation line.

## How the computer-use pass was driven

Every step was performed by hand in a computer-use browser session against the
running app: opening the `View ▾` menu and picking `Agent panel`, pressing
`Cmd/Ctrl+B`, clicking the Inspector ↔ Agent header switch, typing each request into
the composer and sending it, watching the result, and pressing `Cmd/Ctrl+Z`.

That session renders every tab at a fixed 1920 px logical viewport and exposes no
viewport control (no resize API, OS window resizing does not reach the web viewport,
popup size hints are ignored, and its debug port is authenticated). To reach the
required narrow width without leaving the session, the app was hosted in a
same-origin `390 x 844` frame and driven by hand there. The frame reports
`innerWidth 390`, `innerHeight 844`, so the app's own media queries and layout run at
exactly 390 px.

Screenshots are QA artifacts and are deliberately not committed. Paths below are
relative to `.omo/evidence/slice1-verified/`.

## What was verified

### 1. Panel admission and switching — PASS

`View ▾ › Agent panel` (`aria-checked` false → true) revealed the panel;
`Cmd/Ctrl+B` collapsed and reopened it; the header switch moved between Inspector
and Agent. The composer draft (`retained draft` / `narrow composer reachable`)
survived both the shortcut round trip and the header switch.

| | Desktop (1920) | Narrow (390) |
| --- | --- | --- |
| View menu open, item unchecked | `computer-use/01-view-menu-desktop.png` | `computer-use/21-view-menu-390.png` |
| Panel enabled from the menu | `computer-use/02-agent-enabled-desktop.png` | `computer-use/22-agent-open-390.png` |
| `Cmd/Ctrl+B` collapsed | `computer-use/03-shortcut-collapsed-desktop.png` | `computer-use/24-shortcut-collapsed-390.png` |
| `Cmd/Ctrl+B` reopened, draft intact | `computer-use/04-shortcut-reopened-desktop.png` | `computer-use/25-shortcut-reopened-390.png` |
| Header switch → Inspector | `computer-use/05-header-inspector-desktop.png` | `computer-use/26-header-inspector-390.png` |
| Header switch → Agent | `computer-use/06-header-agent-desktop.png` | `computer-use/27-header-agent-390.png` |

### 2. Placement by chat, then Undo — PASS

Typed: *"Put a cube on the floor one metre to camera-left of the selected character.
Add a second character two metres to camera-right."*

On the desktop pass the scene went from 0 objects / 1 character to 1 object / 2
characters. With the actor at `x = 0`, the cube landed at `x = -1.75` (camera-left)
and the second character at `x = +2.50` (camera-right), both grounded at `y = 0` —
the requested 1 m and 2 m clearances measured edge to edge. The Inspector then listed
`Subject 1` and `Subject 2`. Two `Cmd/Ctrl+Z` presses restored 0 objects / 1
character. The narrow pass showed the same through the Hierarchy, which gained
`Character 2` and `Props 1` and lost both again on Undo.

| | Desktop (1920) | Narrow (390) |
| --- | --- | --- |
| Cube + second character placed | `computer-use/07-placement-desktop.png` | `computer-use/28-placement-390.png` |
| Inspector lists both subjects | `computer-use/08-placement-inspector-desktop.png` | `computer-use/26-header-inspector-390.png` |
| Native Undo restores the scene | `computer-use/09-placement-undo-desktop.png` | `computer-use/29-placement-undo-390.png` |

### 3. Framing and camera key by chat, then Undo — PASS

Typed: *"Frame the selected character in a medium shot from the front at eye level
and save a camera key at the current frame."*

From a clean project the camera moved from `(0.969, 1.622, 2.397)` to
`(-0.000, 1.654, 2.196)` — centred on the character at eye level — and a new shot
appeared carrying a camera key at frame 0. `Cmd/Ctrl+Z` restored the camera to
exactly `(0.968641594183757, 1.621774004495899, 2.39747207543642)` and removed the
shot. The narrow pass showed the timeline going `No shots yet` → `Shot 1` → `No
shots yet`.

| | Desktop (1920) | Narrow (390) |
| --- | --- | --- |
| Framed, shot keyed at frame 0 | `computer-use/10-framing-desktop.png` | `computer-use/30-framing-390.png` |
| Native Undo restores camera and shot | `computer-use/11-framing-undo-desktop.png` | `computer-use/31-framing-undo-390.png` |

### 4. Generate, install, play, then Undo — PASS (fixture generator)

Typed: *"Make the selected character walk forward, wave, then return to the starting
pose over the current shot range. Verify the full take and install it."*

The job card reported `Generating 25%` with a live progress bar while the generator
was held, then installed. The receipt read `Installed 2s of motion on char-a —
verified over 48 frames`, and the character carried a 48-frame take with 3 prompt
blocks. Pressing play advanced the timeline (frame 43 of 47 on desktop, 21 of 47 on
narrow). `Cmd/Ctrl+Z` removed the take — `takeId: null`, 0 frames — and the timeline
returned to its 359-frame range.

| | Desktop (1920) | Narrow (390) |
| --- | --- | --- |
| Job progress while generating | `computer-use/12-motion-progress-desktop.png` | `computer-use/32-motion-progress-390.png` |
| Installed take, verified label | `computer-use/13-motion-installed-desktop.png` | `computer-use/33-motion-installed-390.png` |
| Take playing on the timeline | `computer-use/14-motion-playing-desktop.png` | `computer-use/34-motion-playing-390.png` |
| Native Undo removes the take | `computer-use/15-motion-undo-desktop.png` | `computer-use/35-motion-undo-390.png` |

### 5. Stop in flight — PASS, and it is honest about what it does not know

Stopping a held generation by clicking the panel's Stop control leaves the scene
untouched and says exactly what was established:

- the job card reads `Reconciling` with `Stopped, but the result is unknown —
  reconcile before editing this target.`;
- the generation tool row settles to `result unknown` in the alert tone rather than
  staying open on `running…`;
- the timeline keeps its pre-generation range and the character keeps its pose.

This is the honest answer for that scenario, and it is what the fix below changed.
The held bridge means the runtime cannot obtain editor-journal proof, so it ends in
`reconciling` with `mutated: "unknown"`. Before the fix the panel showed
`Not applied — scene unchanged.` here — a claim nothing had established.

The *proven* not-applied path is covered by the objective suite's `resilience` case,
where `cancel_motion_install` and the follow-up `reconcile_studio_command` both
answer `status: not_applied`, `mutated: false`,
`preserved.authoredState: "unchanged"` (`automated/transport.json`). In that case the
panel reads `Stopped` with `Not applied — scene unchanged.`

| | Desktop (1920) | Narrow (390) |
| --- | --- | --- |
| Generation running, Stop offered | `computer-use/16-cancellation-running-desktop.png` | `computer-use/32-motion-progress-390.png` |
| Stopped, outcome reported | `computer-use/cancellation-fixed.png` | `computer-use/36-cancellation-390.png` |

### 6. Narrow layout — PASS

At exactly 390 px with the panel open: `innerWidth 390`, `innerHeight 844`,
`documentElement.scrollWidth 382` and `body.scrollWidth 382` — both inside the
viewport, so there is no horizontal overflow. Exactly one Inspector column and one
Agent panel are mounted. The composer sits below the fold; scrolling to it brings it
fully into view (`top 410`, `bottom 478` within 844), it takes focus, it accepts
typed text, and Send enables. Horizontally it spans `x 11 → 371`, comfortably inside
390.

Evidence: `computer-use/20-boot-390.png` (boot at 390),
`computer-use/22-agent-open-390.png` (panel open), `computer-use/23-composer-390.png`
(composer focused, filled, Send enabled).

The objective suite additionally swept 375, 768, 1040, 1100 and 1600 px
(`automated/responsive-*.png`).

## Objective harness

`test/qa-studio-agent-browser.mjs` passed **6/6 cases** (binding, intent, framing,
motion, resilience, responsive) against this build, with its own captures under
`automated/`. It is not a substitute for the computer-use pass above; it is the
machine-checked complement that asserts authoritative editor state rather than
pixels.

## Fixes made

Two defects were found by driving the app, and both are fixed here with regressions.

**1. Stopping a generation did not say what happened to the scene.** After Stop the
job card flipped to `Stopped` while the `Generate motion` tool row stayed open on
`running…`, and nothing told the author whether the scene had been modified. The
runtime knew; the panel never surfaced it. An acknowledged Stop now records a
structured outcome, settles the running tool card in the alert tone, and states the
result on the card. A settled outcome also survives later job frames the way a
receipt already did, so a frame buffered before the abort cannot erase it.

**2. An unproven Stop was rendered as a safe one.** The Studio stop route discarded
the motion runtime's outcome and always answered `{ok: true, status: "stopped"}`, so
the panel treated any HTTP 200 as proof and claimed `Not applied — scene unchanged.`
even when the runtime had ended in `reconciling` with `mutated: "unknown"`. The route
now forwards the runtime's `status` / `code` / `mutated`, and the panel claims an
unchanged scene only when the runtime actually reported not-applied; anything else is
shown as unknown with a reconcile instruction, and the job stays non-terminal.

`test/verify-agent-panel.mjs` covers both: a proven Stop, an acknowledged Stop whose
runtime outcome is unknown, a host that answers with no outcome at all, tool-card
settlement, abort propagation, and late-frame survival. It drives the real chat store
against a stub transport and awaits the abort signal — no sleeps, no polling. Every
assertion was confirmed red before its fix and green after.

## Verification commands

```sh
npm install
npm --prefix mcp ci
npm install --no-save playwright-core   # the browser harness needs it; no manifest change

node test/verify-agent-panel.mjs
node test/verify-studio-agent-jobs.mjs --case precommit-stop-journal
node test/verify-agent-routes.mjs

QA_PROBES=.omo/evidence/slice1-verified/backend-probes.json \
QA_SHOT_DIR=.omo/evidence/slice1-verified/automated \
QA_PORT=5291 CDP_PORT=9492 QA_HEADLESS=1 \
  node test/qa-studio-agent-browser.mjs
```

Results: agent panel checks all PASS; `precommit-stop-journal` PASS; agent routes
PASS; `qa-studio-agent-browser: 6/6 cases PASS`. `npm test` (build +
`tools/run-tests.mjs`) passes in full.

## Known limitations

- **No real motion model.** `/ardy/health` was 503 for this entire run, so semantic
  motion quality, model vision and GPU generation are unverified.
- **No real model decisions.** Tool selection for every turn came from the fixture's
  scripted client, so this run proves the execution path, not the model's judgement.
- **Top bar breaks at 1100 px.** `automated/responsive-1100.png` shows the
  `Live workspace <uuid>` label wrapping to four lines and colliding with `Settings`
  and the Inspector/Agent switch. Pre-existing Studio chrome — the
  `.live-workspace-handle` span has no CSS rule — not the Agent panel, which lays out
  correctly at that width. Filed as
  [#321](https://github.com/NomaDamas/CozyClay/issues/321) and deliberately not fixed
  here to keep this branch to the Agent slice.
- **The responsive assertions cannot see overlap.** They check scroll width and
  composer bounds, which colliding grid-placed chrome does not violate; that is why
  #321 survived the suite. A fix for it should add an overlap assertion.
- **Job phases still show raw enum tokens.** `automated/resilience-stale.png` reads
  `Target changed` / `stale_target`. Pre-existing and cosmetic.
- **The Agent panel is English-only.** It contains no `ko()` calls, so in Korean mode
  its copy sits beside translated Studio chrome. Pre-existing for the whole panel,
  and it means the narrow captures do not exercise CJK wrapping in the panel.

## Follow-ups

- [#321](https://github.com/NomaDamas/CozyClay/issues/321) — top bar collision at
  1100 px, with an overlap assertion so the suite can catch it.
- Re-run this document's commands against a working `/ardy/health` and a real model
  session to close the model and motion-quality gaps.
- Decide whether the Agent panel should be localised; if so, add a CJK capture at
  390 px, where wrapping pressure is highest.
