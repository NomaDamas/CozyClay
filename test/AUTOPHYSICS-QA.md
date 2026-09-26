# AutoPhysics review QA

The correction uses **floor-support hypotheses + approximate centroidal
force/moment feasibility + kinematic contact/trajectory cleanup**, not a full
rigid-body simulation. It preserves the supplied hand/finger pose. The sampled support
surface may therefore be a fingertip rather than a flat palm. Body self-collision
cleanup is still a separate explicit tool.

## Repeatable loop

1. Run `npm test` (includes actual FBX repeated-wrist playback regression,
   protected poses, zero strength, contact overrides, and temporal constraints).
2. Run the real-take numerical check for **both** shipped bodies:

   ```sh
   MODEL=y-bot-tpose QA_OUT=/tmp/physics-y node test/qa-physics-review-offline.mjs
   MODEL=x-bot-tpose QA_OUT=/tmp/physics-x node test/qa-physics-review-offline.mjs
   ```

   Set `MOTION=/absolute/path/to/motion.npz` for a different take. The default is
   the local 362-frame GVHMR reference in `tools/ardy/out/extract-fOE1MA/`.
   This private/local fixture is not committed or fetched by the test.

3. Also run `node test/qa-physics-support-regressions.mjs`: both actual FBXs,
   elevated standing/bowing/kneeling poses, and true ballistic tucked flight.
   Static support must improve without flattening flight; protected poses and
   zero strength remain unchanged. No motion/action name is passed to the solver.
   Inspect `metrics.json`, `support.json`, `tracks.json`, and `replay-errors.json`. Fix the cause,
   not the pass thresholds. The command exits non-zero when a surface or temporal
   limit fails. `accepted`/`kinematicAccepted` only mean those kinematic gates;
   `supportVerified` additionally requires no unresolved force/moment frames.
   Re-run both bodies after a solver change.
4. With the local app running on port 5180, run the actual UI workflow:

   ```sh
   QA_URL='http://127.0.0.1:5180/app/?motion=/@fs/Users/yun/CozyClay-main-live/tools/ardy/out/extract-fOE1MA/motion-0.npz' QA_OUT=/tmp/physics-ui-y QA_FULL=1 node tools/qa-browser.mjs -- node test/qa-physics-review-browser.mjs
   ```

   Repeat with `MODEL=x-bot-tpose QA_FULL=images`. Use a different `CDP_PORT`
   when running concurrently. Each run uses a disposable browser profile, not
   the user's saved project. The harness clicks Analyse / Original / Corrected /
   Apply / Cancel, verifies all rendered frames against the measured candidate,
   and tests undo/redo, hand/knee overrides, protected poses, and zero strength.

5. Inspect the actual before/after screenshots, including the metric's worst
   frames. Camera and transform gizmos are hidden for captures using the same
   layer mask as export; bodies, shadows, floor, and poses are never hidden or
   edited. Generate the evidence sheet:

   ```sh
   uv run --no-project --with pillow python test/qa-physics-report.py --captures /tmp/physics-ui-y --output artifacts/auto-physics-qa-2026-09-05/y
   ```

## Gates and meaning

- Actual skinned support surfaces: worst floor penetration ≤ 5 mm.
- Support-controller horizontal drift from the interval anchor: worst ≤ 15 mm.
- Planted support surface above the floor: worst ≤ 25 mm.
- Peak knee angular acceleration and root acceleration: no more than 10% above
  the original take. These are checked in addition to average drift and peak
  angle step; an improved average does not excuse an outlier.
- Preview must not modify source keys. Apply must match preview exactly.
- Protected poses and 0% strength preserve the source; undo/redo preserves
  quaternion bases, translation bases, and motion-relative limb translations.
- Rejected contact spans, infeasible manual constraints, protected penetrations,
  and unknown support are reported, never folded into a blanket success.
- Independent unsupported-body metrics do not require a pre-detected contact.
  Force residual is in estimated body weights; moment residual is in BW·H.
  These are model residuals, not measured ground reaction forces.
- Ballistic CoM motion is preserved, including the apex. A quiet/high body is
  not automatically a jump. Floor hypotheses include hands, knees, trunk,
  pelvis, head, neck, shoulders, elbows, thighs and shins.
- Exact skin sampling deduplicates identical position/influence tuples and
  shares double-precision bone transforms. `verify-physics-surface.mjs` compares
  it to THREE's original skinning on both FBXs and transformed actors.
- UI performance must be timed in the real browser, cold and with options.
  Original measurements are reused only for matching motion, rig transform,
  source keys and sampler schema. Progress updates subscribe only the panel;
  time-budgeted MessageChannel yields do not wait for a paint.
- Whole-clip retries are bounded and only address overshoot/continuity.
  Repeating weaker alignment cannot resolve a protected floating pose; keep
  its warning rather than needlessly recomputing the clip.

Contact and temporal windows are heuristics. Verify a new type of motion with its
own reference and report remaining warnings. Passing this take does not establish
physical correctness for arbitrary jumps, running, contact with props, or flat-palmed
support. Unknown props/external assistance, human joint torque limits, learned
video contact inference and finger flattening are outside this implementation.
The source motion/ground calibration can still be wrong. Show residuals.
