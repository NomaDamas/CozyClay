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
| `GET /ardy/health` | HTTP 503, `local_kimodo` unreachable | No real motion generation was possible. |

The 503 is an environment fault, not a product fault: the bridge starts, but its
configured remote Kimodo box (`yun@ubuntu-baremetal`) fails its SSH probe, so the
sidecar correctly reports itself unavailable rather than pretending to generate.

Because of that, **every motion step below used the CPU-only scripted fixture
generator** in `test/fixtures/studio-agent-motion.mjs`. The fixture replaces the
*transport and the model only*. It still drives the production Agent route, Studio
motion runtime, LiveHub, editor command journal, candidate verifier, repairer,
installer, timeline and native Undo. Every non-motion step (panel admission,
placement, framing, camera keys, Undo, layout) exercised the real code end to end.

No claim is made here about semantic motion quality, model vision, or GPU
generation. The panel itself says so: every installed take in the captures carries
the `FIXTURE-ONLY` badge and the runtime's own
`semantic-and-visual-review-unavailable` limitation line.

## What was verified

Two independent surfaces were used:

- **Computer use** — the Studio was opened in Aside Browser and driven through its
  visible controls (menus, header switch, composer, Stop button, keyboard chords).
- **Objective harness** — `test/qa-studio-agent-browser.mjs`, which asserts
  authoritative editor state rather than pixels, and saves a capture per step.

The harness passed **6/6 cases** (`binding`, `intent`, `framing`, `motion`,
`resilience`, `responsive`) against the final build, after the fix below.

### 1. Panel admission and switching — PASS

Opened `View ▾`, enabled `Agent panel`, and switched Inspector ↔ Agent with the
header control. `Cmd/Ctrl+B` collapsed and reopened the panel, and the View item's
checkmark followed the shortcut both ways. The composer draft survived a
collapse/reopen cycle.

Evidence: `view-toggle/view-menu-agent-item.png`,
`view-toggle/agent-panel-expanded.png`, `automated/binding-desktop.png`,
`automated/binding-reopened.png`.

### 2. Placement by chat, then Undo — PASS

Typed the placement request into the visible composer. The agent authored a cube one
metre to camera-left of the selected character and a second character two metres to
camera-right. Both appeared in the Hierarchy and the Inspector's subject list, and
the harness independently asserted the authored offsets (`actualGapM` 1 and 2, both
grounded at `y = 0`, cube left of the actor, second character right of it) and that
the two commands chained revisions. `Cmd/Ctrl+Z` per authored command restored the
exact prior state.

Evidence: `automated/intent-desktop.png`, `automated/intent-native-undo.png`.

### 3. Framing and camera key by chat, then Undo — PASS

Asked for a medium shot at eye level, front, with a key at the current frame. The
shot gained a camera key at frame 0 and the camera pose changed. `Cmd/Ctrl+Z`
restored both. The two captures differ exactly where it matters: `LOCKED KEYS 1`
before Undo, `FREE KEYS 0` after.

Evidence: `automated/framing-desktop.png`, `automated/framing-native-undo.png`.

### 4. Generate, install, play, then Undo — PASS (fixture generator)

The job card reported the runtime's own states — queued, generating, preparing,
verifying, repairing — including the 25% progress event, then installed. The receipt
read `Installed 2s of motion on char-a — verified over 48 frames`, and the panel
showed the verified label rather than the unverified one. The installed 48-frame
take appeared on the timeline with its three prompt blocks and was played from the
real transport controls. `Cmd/Ctrl+Z` removed it and restored the prior bone pose
exactly (the harness compares every bone's position and quaternion).

Evidence: `automated/motion-installed-desktop.png`, `automated/motion-front.png`,
`automated/motion-side.png`, `automated/motion-shot.png`,
`automated/motion-native-undo.png`.

Reading `motion-native-undo.png`: the green `1 · 1x` Full-Body clip still visible is
the harness's pre-seeded baseline take, which is what Undo is supposed to restore.
The discriminator is the now-empty `Prompts` lane.

### 5. Stop in flight — PASS (after a fix)

Held a generation at the bridge, then clicked the visible Stop control. The panel
reports the outcome explicitly and the scene is untouched:

- the job card reads `Stopped` with an alert dot, and beneath it
  `Not applied — scene unchanged.`;
- the generation tool row settles to `not applied` with an alert dot instead of
  staying open;
- the timeline keeps its empty Full-Body and Prompts lanes and the character keeps
  its rest pose.

The authoritative proof is in `automated/transport.json`: `cancel_motion_install`
answered `status: not_applied`, `code: CANCELLED`, `mutated: false`,
`preserved.authoredState: "unchanged"`, and the follow-up
`reconcile_studio_command` agreed.

Evidence: `aside-cancellation-fixed.png` (computer use),
`automated/resilience-stop.png` (harness).

### 6. Narrow layout — PASS

The harness drove 375, 390, 768, 1040, 1100 and 1600 CSS px with the panel open. At
every width the panel was visible, exactly one Inspector column and one Agent panel
were mounted, `documentElement.scrollWidth` and `body.scrollWidth` stayed within the
viewport, and the composer stayed inside the viewport and accepted typed text.

At the required **390 px** the panel fills the width with its tab strip, empty-state
card, three suggestion chips, composer, both selects, the attach control and an
enabled Send — no horizontal overflow and no clipped panel content.

Evidence: `automated/responsive-390.png`, plus `responsive-375.png`,
`responsive-768.png`, `responsive-1040.png`, `responsive-1100.png`,
`responsive-1600.png`.

One caveat is recorded under known limitations: `responsive-1100.png` shows a broken
Studio **top bar**, unrelated to the Agent panel.

## Capture list

All paths are relative to `.omo/evidence/slice1-verified/` (screenshots are QA
artifacts and are deliberately not committed).

| Capture | Caption |
| --- | --- |
| `aside-cancellation-fixed.png` | Computer use: a stopped generation reads `Stopped` / `Not applied — scene unchanged.`, timeline empty. |
| `view-toggle/view-menu-agent-item.png` | `View ▾` open with the unchecked `Agent panel` item, panel still collapsed. |
| `view-toggle/agent-panel-expanded.png` | Panel expanded into the Inspector column, no extra top-bar button. |
| `automated/binding-desktop.png` | Agent panel open with a typed draft before collapsing. |
| `automated/binding-reopened.png` | Same draft intact after `Cmd/Ctrl+B` collapse and reopen. |
| `automated/intent-desktop.png` | Cube camera-left and a second character camera-right, both authored by chat. |
| `automated/intent-native-undo.png` | Both removed again by native Undo. |
| `automated/framing-desktop.png` | Medium shot keyed at the current frame — `LOCKED KEYS 1`. |
| `automated/framing-native-undo.png` | Camera and key reverted — `FREE KEYS 0`. |
| `automated/motion-installed-desktop.png` | Installed take with the verified-over-48-frames receipt. |
| `automated/motion-front.png` | Installed take at frame 16 from the front. |
| `automated/motion-side.png` | Installed take at frame 32 from the side. |
| `automated/motion-shot.png` | Installed take at frame 47 through the shot camera. |
| `automated/motion-native-undo.png` | Take removed by native Undo; Prompts lane empty again. |
| `automated/resilience-stop.png` | Harness stop-in-flight: scene preserved, nothing applied. |
| `automated/resilience-stale.png` | Target edited mid-generation — `STALE_TARGET`, nothing mutated. |
| `automated/resilience-invalid.png` | Unusable artifact — `VERIFICATION_FAILED`, nothing mutated. |
| `automated/resilience-reconciled.png` | Lost acknowledgement reconciled without a second install. |
| `automated/resilience-select-b.png` | Selection changed mid-job; the admitted target is kept. |
| `automated/resilience-undo-conflict.png` | Out-of-order agent undo refused with `UNDO_CONFLICT`. |
| `automated/resilience-rate-limit.png` | 429 surfaced as the paused card; scene untouched. |
| `automated/responsive-375.png` … `responsive-1600.png` | Panel at 375 / 390 / 768 / 1040 / 1100 / 1600 px. |
| `automated/workflow-dock.png` | The same panel in its Workflow dock, proving one shared component. |

## Fixes made

**Stopping a generation did not say what happened to the scene.** The first
computer-use pass found that after Stop the job card flipped to `Stopped` while the
`Generate motion` tool row stayed open reading `running…`, and nothing told the
author whether the scene had been modified. The runtime already knew the answer —
it had editor-journal proof of `not_applied` — but the panel never showed it.

The fix, in `src/workflow/agent-client.js` and `src/workflow/AgentPanel.jsx`:

- an acknowledged Stop records a structured `outcome` of `not_applied` /
  `mutated: false` on the job, and clears the stale in-flight phase;
- the running generation tool card is settled to a `cancelled` status carrying that
  same outcome, instead of being left spinning;
- `cancelled` renders with the alert tone and reads `not applied`, so a cancelled
  call can never be mistaken for a successful one;
- the job card states `Not applied — scene unchanged.` outright;
- a settled outcome now survives later job frames the way a receipt already did, so
  an event buffered before the abort cannot land afterwards and silently erase the
  panel's "nothing was applied" claim.

Only an acknowledged `transport.stop()` does this. An aborted stream on its own
still proves nothing and still changes no label — that rule was already correct and
is preserved.

`test/verify-agent-panel.mjs` gained a deterministic regression covering all four
(job outcome, tool-card settlement, abort propagation, late-frame survival). It
drives the real chat store against a stub transport and awaits the abort signal —
no sleeps, no polling. Each assertion was confirmed red before its fix and green
after; the late-frame one was re-checked by reverting just that line.

## Verification commands

```sh
npm install
npm --prefix mcp ci
npm install --no-save playwright-core   # the browser harness needs it; no manifest change

node test/verify-agent-panel.mjs
node test/verify-studio-agent-jobs.mjs --case precommit-stop-journal

QA_PROBES=.omo/evidence/slice1-verified/backend-probes.json \
QA_SHOT_DIR=.omo/evidence/slice1-verified/automated \
QA_PORT=5291 CDP_PORT=9492 QA_HEADLESS=1 \
  node test/qa-studio-agent-browser.mjs

QA_URL=http://127.0.0.1:5287/app/ \
QA_SHOT_DIR=.omo/evidence/slice1-verified/view-toggle CDP_PORT=9493 \
  node tools/qa-browser.mjs -- node test/qa-agent-view-toggle-browser.mjs
```

Results: agent panel checks all PASS (including the four new cancellation
assertions); `precommit-stop-journal` PASS; `qa-studio-agent-browser: 6/6 cases
PASS`; `qa-agent-view-toggle-browser: all checks passed`.

`npm test` (build + `tools/run-tests.mjs`) also passes in full: `PASS 193 Node
verification files`, exit 0.

## Known limitations

- **No real motion model.** `/ardy/health` was 503 for this entire run, so semantic
  motion quality, model vision and GPU generation are unverified. Re-run these same
  captures against a healthy bridge before accepting any claim about them.
- **Top bar breaks at 1100 px.** `responsive-1100.png` shows the `Live workspace
  <uuid>` label wrapping to four lines and colliding with `Settings` and the
  Inspector/Agent switch. This is pre-existing Studio chrome — the
  `.live-workspace-handle` span has no CSS rule — not the Agent panel, which lays
  out correctly at that width. Filed as
  [#321](https://github.com/NomaDamas/CozyClay/issues/321) and deliberately not
  fixed here to keep this branch to the Agent slice.
- **The responsive assertions cannot see overlap.** They check scroll width and
  composer bounds, which colliding grid-placed chrome does not violate. That is why
  #321 survived the suite; a fix for it should add an overlap assertion.
- **Job phases still show raw enum tokens.** `resilience-stale.png` reads `Target
  changed` / `stale_target` and `resilience-invalid.png` reads `Failed` / `failed`.
  Pre-existing, cosmetic, and now inconsistent with the cancelled path, which shows
  product copy instead.
- **The Agent panel is English-only.** It contains no `ko()` calls at all, so in
  Korean mode its copy — including the new `Not applied — scene unchanged.` — sits
  beside translated Studio chrome. Pre-existing for the whole panel.
- **No CJK capture of the panel exists.** Panel wrapping with long Korean strings in
  a ~350 px dock is untested; it becomes relevant if the panel is ever localised.
- **An unrelated suite flake was seen once.** An earlier `npm test` run failed
  `test/process/verify-bridge-launch.mjs` on `dev skips occupied main + 1`
  (`60894 !== 60893`), an ephemeral-port race under full-suite load. It passed 3/3
  standalone afterwards and the full suite passed clean on rerun. It shares no code
  with this branch's changes, but it can bite CI.

## Follow-ups

- [#321](https://github.com/NomaDamas/CozyClay/issues/321) — top bar collision at
  1100 px, with an overlap assertion so the suite can catch it.
- [#313](https://github.com/NomaDamas/CozyClay/issues/313) — existing
  `verify-studio-agent-motion` CI flake; untouched by this verification.
- Re-run this document's commands against a working `/ardy/health` to close the
  real-model gap.
- Decide whether the Agent panel should be localised; if so, add a CJK capture to
  this evidence set.
