# Motion bridge support files

The local Studio uses Kimodo for authored motion generation. Video mocap
extraction is a separate path and uses GVHMR as its only backend. The bridge
entry point remains at `tools/ardy/bridge.mjs` for compatibility with the
existing `/ardy/*` browser protocol and stored motion URLs; the name is a
wire-format path, not a selectable backend.

## Local development

```bash
CCLAY_KIMODO_HOST=user@gpu-box npm run dev
```

Install the Kimodo host once with `npm run kimodo:setup`. To run the UI without
any sidecar, use `npm run dev:ui`; the seeded motion and all staging, camera,
IK, and playback features still work.

The bridge accepts `COZYCLAY_BRIDGE_PORT` (or `--port`) and binds loopback
only. Kimodo connection settings are `CCLAY_KIMODO_HOST`,
`CCLAY_KIMODO_REPO`, and `CCLAY_KIMODO_MODEL`.

## Shared utilities

`npz.mjs`, `artifacts.mjs`, `footage.mjs`, `extract.mjs`, and the files under
`src/ardy/` provide the common motion archive, ingest, conversion, IK, and
playback contracts used by both generated and imported takes. They are not an
ARDY runtime installation.

The hosted demo worker still has a separately managed local runner for its
queue jobs; that deployment path is intentionally independent of the local
Studio selector.

## GVHMR extraction (required backend)

`CCLAY_EXTRACT_BACKEND` defaults to `gvhmr`, and GVHMR is the only supported
video mocap backend. The bridge rejects another backend value or a custom
`CCLAY_EXTRACT_CMD` with `extract-backend-unsupported`; the Studio also refuses
to extract until the local GPU bridge reports GVHMR. There is no browser
MediaPipe fallback for video or photo mocap.

GVHMR's subject detector is fixed to the `palette` segmentation path for
CozyClay's coloured mannequin. `CCLAY_EXTRACT_DETECTOR` is retained for
deployment compatibility but cannot switch the detector to YOLO or auto.

With GVHMR enabled, extraction uses one serial SSH worker.
It deploys the repo-owned worker, preparation and trajectory Python modules into a content-addressed
remote `/tmp/cozyclay-gvhmr-worker-*` directory and imports the existing
`~/cclay-ingest/GVHMR/cclay_gvhmr_extract.py`. The original runner and model
checkpoints are not overwritten. The host needs its existing GVHMR venv
(validated with PyTorch 2.3.0+cu121 on an RTX 3070 8 GB).

ViTPose/HMR2 share identical decoded crops. Complete checkpoint coverage is
checked before accepting skipped random initialization; memory mapping falls
back for legacy checkpoint formats. Their models stay on **CPU** between jobs,
moving to CUDA one at a time. The tracker is new for every clip. Precision,
flip testing, batch sizes, camera settings and neural motion prediction
are unchanged by acceleration. The optional trajectory stage below intentionally
changes accepted vertical trajectories. There is no cached motion-result shortcut.

Concurrent extraction returns `extract-worker-busy`. Disconnect, timeout or
bridge shutdown terminates the owned worker; it also exits after ten idle
minutes. Restart the bridge after upgrading upstream code. Checkpoint
size/mtime changes invalidate cached preprocessing models. The final `done`
event includes stage timing, cache hits and PyTorch GPU-memory metrics.
Palette takes also include `performance.segmentation`: detected and missing
frames, dropout gaps, mask coverage quantiles, per-frame coverage, and HSV hue
error (median/P95/max). These values come from the detector's own mask; older
bridges without the instrumentation omit this optional report rather than
reporting a clean zero-valued take.

Rollback: launch the bridge with `CCLAY_GVHMR_WORKER=0` to use the original
GVHMR one-shot command. Other extraction backends and `CCLAY_EXTRACT_CMD` stay
unsupported so a misconfigured bridge fails explicitly.
CPU lifecycle tests run in `npm test`; `test/qa-gvhmr-speed.py` performs real
GPU raw-output/preprocessing equality checks, and `test/qa-gvhmr-bridge.mjs`
compares original/cold/warm HTTP extraction including retargeted NPZ arrays.

## GVHMR delayed-descent recovery

The worker now defaults to observation-anchored vertical recovery for static
camera footage. It requires a confident, large image-space descent, a stable
observed landing, and delayed world-space descent. If the world endpoint never
settles before the clip ends, a persistent observed landing plateau and camera
scale recover its height instead; short or moving landings remain unchanged.
It keeps frame count, timestamps, joint
rotations and XZ travel; it does not classify a particular action such as bowing.
An actual-time, segment-mass COM gravity curve is used only when it agrees with
the observed motion. Disagreement keeps observation-based timing and is reported
as `mode: observed-timing`, not as a physically verified flight.

After retargeting, a root-only safety pass measures both shipped character skins
with Studio's playback transforms and prevents floor penetration throughout a
take with an accepted descent, including initial standing frames. Observation-derived endpoints are calibrated upward
to measured skin clearance before residual floor safety, with the datum change
distributed over the descent; after landing each pose uses its own clearance
instead of retaining an unnecessary constant lift. Elevated landings are not forced down to the floor.
It does not run AutoPhysics or create IK edits.
This is not full human-scene reconstruction: moving cameras and ambiguous
landings are skipped, and existing articulation errors can still cause small
post-landing height variation. Metadata is in `done.performance.trajectory`,
including rejected spans, gravity fit, timing and per-model floor clearance.

Set `CCLAY_GVHMR_TRAJECTORY=0` and restart the bridge for legacy motion with
acceleration retained. `CCLAY_GVHMR_WORKER=0` disables both stages. Previously
extracted takes are not rewritten; re-extract the source to use the improvement.
See `test/GVHMR-TRAJECTORY-QA.md` for actual source/Studio comparisons and limits.
The follow-up failure, fix checklist and actual user-clip QA are recorded in
`test/GVHMR-FOLLOWUP-QA.md`. The Studio extraction receipt now distinguishes
applied recovery from rejected/disabled recovery and reports authored scene Y
offsets. Playback uses elapsed time rather than one frame per delayed timer.
