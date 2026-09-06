# CozyClay live-control protocol v1

The MCP JSON-RPC endpoint deliberately negotiates only protocol version
`2025-11-25`. Older and draft tracks are rejected during `initialize`.

One WebSocket, JSON text frames. The **MCP server hosts** the socket
(`ws://127.0.0.1:5184/live`); the **editor is the client** and reconnects
every 3 s while the page is open. Either side may be absent: the editor works
exactly as before when nothing is listening, and the MCP server falls back to
its in-memory scene when no editor is connected.

## Frames

editor -> server, once after connect:

    { "type": "hello", "role": "editor", "version": 1 }

server -> editor, once after `hello`:

    { "type": "workspace", "handle": "<opaque workspace handle>" }

The handle is newly issued for this socket connection. The editor surfaces it to
its operator. A disconnect invalidates it; a reconnect receives a fresh handle.
The editor also sends its stable per-tab `workspaceId` in `hello`; it is not an
MCP tool argument and lets the hub route retained terminal motion outcomes to
the same editor after that fresh handle is issued.

server -> editor, one per command:

    { "type": "cmd", "id": "<opaque string>", "name": "<command>", "args": { ... } }

server -> editor, for an MCP-owned motion job state or terminal outcome (and again
on reconnect while retained). A completed event follows the editor's successful
`load_motion` acknowledgement:

    { "type": "event", "name": "motion_job", "payload": { "taskId", "status", "createdAt", "lastUpdatedAt", "ttlMs", "pollIntervalMs", "outcome?" } }

editor -> server, to cancel its own active job before editor delivery:

    { "type": "event", "name": "motion_job_cancel", "payload": { "taskId": "<opaque task id>" } }

editor -> server, one per command, echoing `id`:

    { "type": "result", "id": "<same id>", "ok": true,  "value": { ... } }
    { "type": "result", "id": "<same id>", "ok": false, "error": "<human message>" }

Unknown `name` MUST answer `ok:false`, never silence. The server times a
command out after 5 s and treats it as failed, except `load_motion`, which
retains its dedicated 30 s editor decode and installation bound. Measurement
justifies the existing headroom: 12 real editor installs of one 94,672-byte
ARDY NPZ had nearest-rank p50 29.96 ms, p95 547.29 ms, and p99 547.29 ms;
30 s remains appropriate for materially larger cold-cache production takes. A timeout or disconnect during
a mutation is ambiguous: it may already have applied, so callers MUST NOT retry
blindly and should `describe` before recovering.

## Motion jobs

`generate_motion` returns immediately with exactly `{ taskId, status, createdAt,
lastUpdatedAt, ttlMs, pollIntervalMs }`; `pollIntervalMs` is `0` because the
model never polls it. The MCP server retains terminal outcomes for `ttlMs`
(currently 10 minutes) and pushes `motion_job` to the matching stable workspace
on completion, failure, cancellation, or reconnect. For a completed job, the
server first installs the take through the request/response `load_motion`
command, then publishes the terminal lifecycle event. The event never installs
the take a second time. A retained outcome that passes its TTL is explicitly
expired and is never replayed.

If the editor explicitly rejects `load_motion`, the job transitions to `failed`
and publishes that terminal event. If the socket disconnects or times out while
installation is in flight, the job also fails but is not retried: the mutation
may already have applied, so retrying could install the same take twice.

Cancellation is cooperative at the bridge HTTP stream: `motion_job_cancel`
aborts that request. The ARDY bridge detects the disconnected stream and kills
its request-owned child process groups. A cancelled job is terminal and is never
sent to editor installation. There are no `tasks/*` tools or start/status/list
polling tools in the MCP surface.

## Commands (v1)

All coordinates are metres, rotations are degrees of yaw, ids are the ids the
scene document already uses.

| name | args | value | notes |
| --- | --- | --- | --- |
| `ping` | `{}` | `{ "pong": true }` | liveness |
| `describe` | `{}` | `{ document, sceneName, camera, stage, timeline, activeCharacterId, characters, objects }` | read the full live scene document plus active-scene convenience fields; the full `document` prevents one workspace's inactive scenes from leaking into another workspace's scene operations; `activeCharacterId` pins asynchronous work to the character selected when it started |
| `capture_frame` | `{}` | `{ width: 640, height: 360, mimeType: "image/png", encoding: "base64", byteSize, data, assertions: { renderable, blackFrame, nonBlackPixels, behindCameraPlane, fartherAlongCameraForward, distanceToFloor, occludedBy, visiblePixelCount, characters } }` | leaves the authored document untouched, but is classified open-world/non-idempotent because an oversized PNG creates a mode-0600 managed temporary artifact. Character visibility and occlusion are computed from mounted engine geometry with bounded ray samples. Missing camera, black frame and compressed payloads above 1 MB fail explicitly. Inline responses honor `max_inline_bytes`; managed artifacts are capped at 20 and expire after 10 minutes. |
| `capture_framing_png` | `{}` | `{ dataUrl, width: 1920, height: 1080, frame, shotId }` | full-resolution PNG (data URL) of the CURRENT shot camera framing at the current timeline frame, rendered through the same park-and-restore shot pipeline the editor's own exports use; `width`/`height` follow the shot aspect preset (1920x1080 at 16:9) and `shotId` names the shot under the playhead. The viewport and the authored document are untouched (idempotent read), and the editor's 640x360 `capture_frame` contract is unchanged. Fails while no shot camera is mounted (e.g. a cast model is still downloading). |
| `set_camera` | `{ x?, y?, z?, focalMm?, lookAtX?, lookAtY?, lookAtZ? }` | `{ camera }` | omitted fields keep their value; the **viewport must visibly move**. The `lookAt*` triple is additive to v1 and must arrive complete or not at all: given it, the editor aims the shot camera at that world point and records the resulting orientation as the camera's own (so the framing it commits is the one it just applied); without it the orientation is untouched, so an editor that ignores the fields degrades to the pre-aim behaviour instead of failing. `frame_shot` always sends the framing pivot, because the shot vocabulary (`deriveShot`, `captureFraming`) measures the shot as if the lens points at that pivot — a placed-but-unaimed camera reports a framing it is not holding. |
| `add_character` | `{ subject, x?, z?, rot?, model? }` | `{ id }` | `model` is one of the stable character model ids |
| `update_character` | `{ ref, x?, y?, z?, rot?, subject?, hidden? }` | `{ id }` | `ref` = id, letter (`"A"`) or 1-based slot |
| `remove_character` | `{ ref }` | `{ id }` | must refuse to empty the cast |
| `place_object` | `{ kind, x?, z?, y?, rot?, name?, parent? }` | `{ id }` | `kind` from OBJECT_LIBRARY; optional `name` labels the object and optional `parent` attaches it under another object |
| `import_asset` | `{ name, mimeType, dataUrl, placeAs }` | `{ assetId, objectId }` | decode `dataUrl` (PNG, WebP, JPEG or GIF; `mimeType` optional when the data URL carries it), store the bytes in the content-addressed asset store under `assetId`, and stand the picture up through the Studio's own import pipeline. `placeAs: "cutout"` is a 1.8 m standee 2.6 m in front of the shot camera; `placeAs: "backdrop"` is the same card as a 5 m background plate 12 m down the shot camera's view ray, turned to face the lens. Exactly ONE undo entry: a single Ctrl+Z removes the placed object (the asset bytes stay, being content-addressed). This deliberately does NOT reuse the Workflow-tab scene sync, which writes the document without touching undo. |
| `update_object` | `{ id, x?, y?, z?, rot?, rotX?, rotZ?, scale?, scaleX?, scaleY?, scaleZ?, color?, name? }` | `{ id }` | `scale` sets all three axes; per-axis values override it; `name` renames the object |
| `remove_object` | `{ id }` | `{ id }` | |
| `group_objects` | `{ parent, children }` | `{ parent, children }` | attach every child under parent |
| `ungroup_objects` | `{ children }` | `{ children }` | detach every child |
| `apply_batch` | `{ ops, atomic?: false, stopOnError?: true, label?: "MCP batch" }` | `{ label, applied: number[], failed: [{ index, error }], rolledBack }` | executes at most 100 object mutations as one undo entry. `atomic` and `stopOnError` are independent; atomic failure restores the pre-batch objects and creates no undo entry. Nested batches are rejected. v1 rejects character mutations because cast history is a separate store. |
| `set_prompt_blocks` | `{ blocks: [{ startFrame, endFrame, text }] }` | `{ blocks }` | replace the active character's authored prompt clips after validating each frame range and text |
| `load_motion` | `{ url, prompt?, blocks?, drop? }` | `{ loaded, url, blocks }` | install an ARDY motion on the selected character. It has the dedicated 30-second editor-processing timeout; motion-job completion carries the character id captured when generation started |
| `load_scenes` | `{ document }` | `{ sceneName, activeSceneId, scenes: [{ id, name }] }` | replace the whole scene document (same shape `serializeSceneDocument` emits); the response attests the full scene list and active scene for `add_scene` and `switch_scene` parity |

## Hard rules for the editor side

- Every mutation MUST go through the same React state paths the UI itself
  uses (the setters/reducers the gizmo, inspector and panels call). Mutating
  three.js objects directly is forbidden: anything outside React state is
  overwritten on the next render.
- Every mutation MUST land in undo history exactly like the equivalent UI
  action would, or be explicitly documented as not undoable.
- The socket client MUST be a no-op in production builds unless explicitly
  enabled; in dev it may always try. A failed connection must never surface
  an error to the user - silence and retry.

## Workspace routing

The hub allows multiple editor instances at once; it never displaces an existing
editor for a newer connection. `live_status` lists every current workspace
handle. Every MCP tool that reads or mutates a live editor accepts `workspace_handle`.
When exactly one editor is connected, omitting it selects that editor. With two
or more editors, omitting it fails before dispatch and enumerates every candidate
handle. An unknown or disconnected handle fails as unknown or stale and is never
routed to another editor. The hub owns this resolution rule for every transport;
there is no last-active, heartbeat, focus, or recency fallback.

## Hard rules for the server side

- When an editor is connected, live-capable tools forward to the workspace
  selected by the rules above and answer from that workspace's `describe`; when
  none is connected they fall back to the in-memory scene exactly as today.
- `add_scene` and `switch_scene` forward the complete scene document through
  `load_scenes` and verify it through `describe` before reporting success. They
  never succeed while the MCP server and selected editor have different scene
  lists. Without an editor they retain the in-memory fallback.
- A live mutation may only target the explicitly selected workspace, except for
  the exactly-one-editor auto-selection case. Ambiguity is an error, never a
guess.

Browser editor connections are accepted only from loopback HTTP origins, and a
stable workspace id may have only one live socket. Native loopback clients have
no Origin header and remain part of the trusted-local MCP boundary.
- Any bounded MCP read reports `total`, `returned`, `truncated`, and a
  `revision`. Omitted entries must be reachable by an explicit selector or
  cursor; `describe_scene` uses `character_cursor` and `object_cursor`.
