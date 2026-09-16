# Driving the Studio from a terminal

This guide is for a terminal agent — any coding-agent session that has to
manage the CozyClay Studio without a human at the screen. Everything the
Studio can do through its panels has a terminal surface through `cclay live`:
read the scene, place and move things, frame and key shots, verify the result
with a picture, and undo. The CLI is JSON in, JSON out, one object per
invocation, with stable error codes — built so a program, not a person, is the
primary reader.

The one rule that differs from browsing: **visual checks are `capture` PNGs
read as images — never screenshot the browser.** `cclay live capture` renders
the shot camera through the same pipeline the editor's own exports use, at
full resolution, and writes it to a path you name. Screenshotting the browser
gives you the UI chrome, the wrong viewport, and a stale frame; capture gives
you the shot.

## Setup

Three things must be running, in this order:

1. **The live hub** — any process hosting `ws://127.0.0.1:<port>/live`. From a
   source checkout that is the MCP server; from the installed package it is
   `cclay mcp`. The hub publishes its address and token in a mode-0600 endpoint
   file under your config home, which is how `cclay live` finds it:

   ```sh
   COZYCLAY_LIVE_PORT=5629 node mcp/server.mjs   # source checkout (cd mcp && npm install first)
   cclay mcp                                     # installed package, default port 5184
   ```

2. **The Studio** — `npm run dev` from the checkout, or `cclay`. It must be
   started with the same `COZYCLAY_LIVE_PORT` so the page connects to *your*
   hub, not somebody else's on the default 5184:

   ```sh
   COZYCLAY_LIVE_PORT=5629 npm run dev -- --port 5209
   ```

3. **A browser tab** open at the Studio URL (`http://127.0.0.1:5209/app/`).
   A headless Chromium with remote debugging is fine — the editor is the page,
   not the window.

Then wait until an editor is actually attached, which is what `--wait` is
for. Without an editor every mutation verb fails `NO_EDITOR`, so a script
should always begin with this gate:

```sh
cclay live status --wait
```
```json
{"server":{"port":5629,"owner":"mcp","pid":71700},"editors":[{"handle":"880f6a61-4263-49f8-b17d-cb7d6c54d280","project":"Untitled","scene":"SCENE 01","cast":1,"embed":false,"connectedAt":1789546094406,"lastSeenMs":2039,"inFlight":0}],"selected":"880f6a61-4263-49f8-b17d-cb7d6c54d280"}
```

The `handle` is the tab's stable identity: it survives reloads and hub
restarts, and it is what `--workspace` takes. Note the exit code —
`status --wait` exits 0 only once a selectable editor exists.

## The loop

Every session is the same shape:

```text
status → inspect → act (a receipt verb) → capture / verify → undo
```

- **status** — which hub, which editors, which one is selected.
- **inspect** — the scene context: ids, entity tokens, the current shot,
  revisions. Never act on remembered state; read it first.
- **act** — a verb that produces a *receipt* (`arrange-objects`,
  `arrange-characters`, `frame-shot`, `operate`, `undo`). The receipt is the
  ground truth of what changed: affected ids, revision before/after, undo
  entry, warnings.
- **capture / verify** — `capture --framing` writes the PNG of the shot
  camera; `verify --receipt … --visual frame` writes the receipt's evidence
  image. Read them as images — that is your only honest visual check.
- **undo** — `undo --receipt <id>` restores the document through the editor's
  own native history, exactly one entry, when you got the framing wrong.

Mutations are *admitted*: the CLI reads the scene context first and sends the
document identity, expected revision and entity tokens with the command. If
anything moved under you — the operator dragged a gizmo, another edit landed —
the editor refuses with `STALE_SCENE` / `STALE_TARGET` / `TARGET_BUSY` instead
of guessing. The response to a refusal is always `inspect` again and re-issue,
never a blind retry.

## Worked session (a): place a prop and frame it

The default scene has one character and nothing else. Read the entities to get
ids and the layout:

```sh
cclay live inspect --scope entities
```
```json
{"context":{"schema":"studio-context-v1","host":{…},"revision":{"scene":0,"physics":0,"view":0},"units":{"distance":"m","angle":"deg","up":"+Y","yawZero":"+Z","yawPositiveToward":"+X","fps":24,"rangeEnd":"exclusive"},"scene":{"name":"SCENE 01","aspect":"16:9","floorY":0,"frameCount":432,"objectCount":0,"characterCount":1},"selection":{"kind":"character","id":"char-a","hierarchyId":"characterA"},"activeCharacterId":"char-a","view":{…},"shot":{…},"camera":{…},"entities":[{"id":"char-a","kind":"character","token":"target-1","name":"a young woman in a tan coat",…}],"entityPage":{…},"shots":[…],"recentReceipts":[],"jobs":[],"capabilities":{…}},"entities":[{"id":"char-a","kind":"character","name":"a young woman in a tan coat","token":"target-1"}],"total":1,"nextCursor":null}
```

Place a chair next to her — `relativeTo` positions it in the subject's own
basis, and `support: "floor"` stands it on the ground, so you never have to
compute a `y`:

```sh
cclay live arrange-objects --op '{"op":"create","source":{"kind":"chair"},"name":"Side chair","position":{"relativeTo":"char-a","basis":"subject","side":"left","gapM":1.4,"support":"floor"}}'
```
```json
{"ok":true,"commandId":"0ca48a94-d269-4c39-8fb9-fec803ff9060","receiptId":"receipt-mu3tekny-1","host":{…},"status":"applied","authored":true,"revision":{"before":0,"after":1},"affectedIds":["chair"],"delta":[{"id":"chair","after":{"position":{"x":2.0380938133472153,"y":0,"z":0},"yawDeg":0,"rotationDeg":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1},"name":"Side chair","color":"#b9855d","renderer":"chair","parentId":null}}],"checks":{"coverage":"same-frame-world-AABB-proxies","relationSatisfied":true,"overlapIds":[],"actualGapM":1.4000000000000001,"requestedGapM":1.4,"maximumFootprintOverlapM":0,"basis":"subject","support":"floor","baseY":0},"undo":{"historyEntryId":"b6f16f0e-f592-436a-974d-0fff54fa7803","entries":1,"canUndoDirect":true},"warnings":[],"detailCursor":"0ca48a94-d269-4c39-8fb9-fec803ff9060"}
```

The receipt is the verification contract: the gap asked for (1.4 m) and the
gap measured (`actualGapM`) match, nothing overlaps, and one undo entry exists.
`verify` re-runs that evidence and adds a picture of the current state:

```sh
cclay live verify --receipt receipt-mu3tekny-1 --checks placement --visual frame --out /tmp/329-doc/shots/f-a-place-check.png
```
```json
{"receiptId":"receipt-mu3tekny-1","revision":1,"checks":{"coverage":"same-frame-world-AABB-proxies","relationSatisfied":true,"overlapIds":[],"actualGapM":1.4000000000000001,"requestedGapM":1.4,"maximumFootprintOverlapM":0,"basis":"subject","support":"floor","baseY":0},"verification":null,"semanticStatus":"unavailable","visualRefs":[{"imageId":"b4e00048-242d-4af4-8594-220e766202e1"}],"unsupportedChecks":[],"visual":[{"imageId":"b4e00048-242d-4af4-8594-220e766202e1","path":"/tmp/329-doc/shots/f-a-place-check.png","width":1920,"height":1080,"bytes":684177}]}
```

Now frame the shot — camera vocabulary, not coordinates. This scene has no
shots yet, so the first `frame-shot` creates one spanning the timeline:

```sh
cclay live frame-shot --subject char-a --size "wide shot" --view front --level hip
```
```json
{"ok":true,"commandId":"440213de-2b48-4c2d-9231-7034e120531e","receiptId":"receipt-mu3tel0s-2","host":{…},"status":"applied","authored":true,"revision":{"before":1,"after":2},"affectedIds":["shot-mu3t98t8-2"],"delta":[{"id":"shot-mu3t98t8-2","after":{"range":{"startFrame":0,"endFrameExclusive":432},"camera":{"position":{"x":-0.011522021105043662,"y":1.0621432515131122,"z":5.077024270710456},"lookAt":{…},"focalMm":24.44391231902759,"sensorId":"fullFrame","slate":"wide shot"},"subjectIds":["char-a"],"shotId":"shot-mu3t98t8-2"}}],"checks":{"coverage":"same-frame-subject-bounds-projection","clipped":false,"behindCamera":false,"screenFraction":0.44729099405708983,"derivedSize":"wide shot"},"undo":{"historyEntryId":"e4c60fec-4dc2-458b-9516-953328c28e67","entries":1,"canUndoDirect":true},"warnings":[{"code":"OCCLUSION_UNMEASURED"}],"detailCursor":"440213de-2b48-4c2d-9231-7034e120531e"}
```

`derivedSize` is what the lens actually produced, measured by projection:
"wide shot" requested, "wide shot" derived, `clipped: false`. Then look at it:

```sh
cclay live capture --framing --out /tmp/329-doc/shots/f-a-wide-hip.png
```
```json
{"path":"/tmp/329-doc/shots/f-a-wide-hip.png","width":1920,"height":1080,"bytes":344608}
```

Reading that PNG as an image shows the character standing center-frame, head
to feet unclipped, the chair fully visible beside her, camera at hip height —
the framing the receipt promised. Session (a) is done; the prop stays in the
scene.

## Worked session (b): reframe at eye level, key it, undo

Continuing in the same scene. `frame-shot` moved the camera but committed no
key — the shot's `keyCount` is still 0, so the framing is not yet *authored at
a frame*. Keying needs the `keyAtFrame` argument, which the `frame-shot` verb
does not surface; this is what the `cmd` escape hatch is for. Any
live-protocol command can be sent raw, but the admitted commands expect the
full admission envelope — which you build from one `inspect`:

```sh
cclay live inspect --scope shot
```
```json
{"context":{"schema":"studio-context-v1","host":{"surface":"studio","workspaceId":"880f6a61-…-cb7d6c54d280","documentEpoch":"c93ec820-…-bb0959c1f337","sceneId":"scene-mu3t3dzd-1","sceneEpoch":"bde4a40b-…-bc4b81b96b2b","workspaceHandle":"880f6a61-…-cb7d6c54d280"},"revision":{"scene":2,"physics":1,"view":2},"units":{…},"scene":{"name":"SCENE 01","aspect":"16:9","floorY":0,"frameCount":432,"objectCount":1,"characterCount":1},"selection":{"kind":"character","id":"char-a","hierarchyId":"characterA"},"activeCharacterId":"char-a","view":{…},"shot":{"id":"shot-mu3t98t8-2","name":"Shot 1","range":{"startFrame":0,"endFrameExclusive":432},"mode":"keys"},"camera":{…},"entities":[{"id":"char-a","kind":"character","token":"target-1",…},{"id":"chair","kind":"object","token":"target-3",…}],"entityPage":{"returned":2,"total":2,"truncated":false,"nextCursor":null},"shots":[{"id":"shot-mu3t98t8-2","name":"Shot 1","range":{"startFrame":0,"endFrameExclusive":432},"keyCount":0}],"shotsTruncated":false,"assets":[],"recentReceipts":[{"id":"receipt-mu3tel0s-2","summary":"applied","canUndoDirect":true},{"id":"receipt-mu3tekny-1","summary":"applied","canUndoDirect":false}],"jobs":[],"capabilities":{…}},"entities":[{"id":"char-a","kind":"character","name":"a young woman in a tan coat","token":"target-1"},{"id":"chair","kind":"object","name":"Side chair","token":"target-3"}],"total":2,"nextCursor":null}
```

Build the envelope from that context — the four host identity fields, the
scene revision you saw, and a target guard (host + `targetId` + `token`) for
every entity the command may touch. Mint your own `commandId`; the editor
journals it, which is what makes the command reconcilable later:

```sh
node -e '
const c = require("/tmp/329-doc/f-b-inspect.json").context;
const host = (({workspaceId, documentEpoch, sceneId, sceneEpoch}) => ({workspaceId, documentEpoch, sceneId, sceneEpoch}))(c.host);
const envelope = {
  name: "frame_shot",
  args: {
    subjectIds: ["char-a"],
    shotId: c.shot.id,
    keyAtFrame: 0,
    framing: { intent: { size: "medium shot", view: "front", level: "eye", side: "left" } },
  },
  commandId: crypto.randomUUID(),
  host,
  expectedRevision: c.revision.scene,
  expectedTargets: c.entities.map((e) => ({ ...host, targetId: e.id, token: e.token })),
};
require("node:fs").writeFileSync("/tmp/329-doc/f-b-envelope.json", JSON.stringify(envelope));
'
```

Send it as one raw command:

```sh
cclay live cmd frame_shot --args "$(cat /tmp/329-doc/f-b-envelope.json)"
```
```json
{"ok":true,"commandId":"d996bf1c-6b3e-4b97-857e-4526c8e5634c","receiptId":"receipt-mu3telek-4","host":{…},"status":"applied","authored":true,"revision":{"before":2,"after":3},"affectedIds":["shot-mu3t98t8-2","camera-key-mu3telek-3"],"delta":[{"id":"shot-mu3t98t8-2","after":{"range":{"startFrame":0,"endFrameExclusive":432},"camera":{"position":{"x":-0.011522021105043662,"y":1.5894328518973564,"z":2.109947017309772},"lookAt":{…},"focalMm":24.44391231902759,"sensorId":"fullFrame","slate":"medium shot"},"subjectIds":["char-a"],"shotId":"shot-mu3t98t8-2"}},{"id":"camera-key-mu3telek-3","after":{…,"keyId":"camera-key-mu3telek-3","frame":0,…}}],"checks":{"coverage":"same-frame-subject-bounds-projection","clipped":true,"behindCamera":false,"screenFraction":1.1027891282716213,"derivedSize":"medium shot"},"undo":{"historyEntryId":"fa3ea27b-5a89-4e33-b110-b21206932243","entries":1,"canUndoDirect":true},"warnings":[{"code":"OCCLUSION_UNMEASURED"}],"detailCursor":"d996bf1c-6b3e-4b97-857e-4526c8e5634c"}
```

Two affected ids this time: the shot *and* the new camera key
(`camera-key-mu3telek-3`). The camera rose from y 1.06 to y 1.59 — eye level
for this character — and the derived size tightened to "medium shot"
(`clipped: true` honestly reports the feet crossing the bottom edge; a medium
shot on a 24 mm lens does crop). Look at it:

```sh
cclay live capture --framing --out /tmp/329-doc/shots/f-b-eye-keyed.png
```
```json
{"path":"/tmp/329-doc/shots/f-b-eye-keyed.png","width":1920,"height":1080,"bytes":588902}
```

The PNG reads as the medium shot at eye level the receipt described. If the
operator dislikes it, the receipt's undo entry takes the whole thing —
reframe *and* key — back in one command:

```sh
cclay live undo --receipt receipt-mu3telek-4
```
```json
{"ok":true,"commandId":"4196c12d-9ed3-4e08-951f-f7d4c8cd9728","receiptId":"310e72d4-a561-4123-b7bd-f276bad0cb30","host":{…},"status":"undone","authored":true,"revision":{"before":3,"after":4},"affectedIds":["shot-mu3t98t8-2","camera-key-mu3telek-3"],"delta":[{"id":"shot-mu3t98t8-2","after":{"token":"target-5"}},{"id":"camera-key-mu3telek-3","after":{"token":"removed-6"}}],"checks":{"coverage":"native-history-restoration"},"undo":{"historyEntryId":"fa3ea27b-5a89-4e33-b110-b21206932243","entries":1,"canUndoDirect":false},"warnings":[],"undoneReceiptId":"receipt-mu3telek-4","restoredTargets":[{…,"targetId":"shot-mu3t98t8-2","token":"target-5"},{…,"targetId":"camera-key-mu3telek-3","token":"removed-6"}]}
```

`status: "undone"` with `undoneReceiptId` naming the reframe, and
`restoredTargets` handing back fresh tokens for the next command — the removed
key even gets a retired-identity token so a follow-up cannot address it by
stale id.

## Worked session (c): recover from UNCERTAIN_APPLY

A mutation that loses its answer is the one failure you must never retry
blindly: it may already be applied, and a retry would apply it twice. The
protocol's answer is reconcile, and the CLI wires it in two ways.

**A timeout is an uncertain apply.** Give a mutation a `--timeout` the editor
cannot meet and the hub answers `UNCERTAIN_APPLY` — the CLI then reconciles
against the editor's journal *itself* and attaches the result:

```sh
cclay live arrange-objects --timeout 200 --op '{"op":"update","id":"chair","name":"Stand-in chair"}'; echo "exit=$?"
```
```text
exit=5
```
```json
{"ok":false,"error":{"code":"UNCERTAIN_APPLY","message":"Live editor timed out running arrange_objects. The mutation may have been applied. Do not retry it; describe the scene before choosing a recovery action.","recovery":{"action":"reconcile","hint":"Do not retry the mutation; describe the scene first and choose a recovery action from what it reports."},"details":{"commandId":"7de7907b-304f-4a92-b035-4e15444295cd","reconcile":{"status":"applied","receipt":{"ok":true,"commandId":"7de7907b-304f-4a92-b035-4e15444295cd","receiptId":"receipt-mu3thvme-10","host":{…},"status":"applied","authored":true,"revision":{"before":8,"after":9},"affectedIds":["chair"],"delta":[{…,"name":"Stand-in chair",…}],"checks":{…},"undo":{…},"warnings":[],"detailCursor":"7de7907b-304f-4a92-b035-4e15444295cd"}}}}}
```

`error.details.reconcile.status: "applied"` settles it: the edit landed, the
answer was merely late. There is nothing to redo — the receipt is right there,
undoable like any other.

**A hub that dies mid-command is the same uncertainty without the courtesy of
an error code.** The CLI only learns the socket is gone, and says so:

```sh
cclay live cmd arrange_objects --args "$(cat /tmp/329-doc/f-c-envelope.json)" &
CLI_PID=$!
sleep 0.15 && kill -9 "$(lsof -tiTCP:5629 -sTCP:LISTEN)"   # kill the hub mid-command
wait $CLI_PID; echo "exit=$?"
```
```text
exit=3
```
```json
{"ok":false,"error":{"code":"NO_SERVER","message":"Nothing answered a live controller on ws://127.0.0.1:5629/live.","recovery":{"action":"start","hint":"run `npm run dev` or `cclay`"}}}
```

Exit 3 means no hub — but the command you minted a `commandId` for may have
reached the editor before the hub died. Bring the hub back (same port, new
process), and gate on the editor reconnecting — the tab retries on its own
backoff, `--wait` catches it:

```sh
COZYCLAY_LIVE_PORT=5629 node mcp/server.mjs &      # hub restart
cclay live status --wait
```
```json
{"server":{"port":5629,"owner":"mcp","pid":71700},"editors":[{"handle":"880f6a61-4263-49f8-b17d-cb7d6c54d280","project":"Untitled","scene":"SCENE 01","cast":1,"embed":false,"connectedAt":1789546094406,"lastSeenMs":3832,"inFlight":0}],"selected":"880f6a61-4263-49f8-b17d-cb7d6c54d280"}
```

Same handle, new server pid — the editor's identity survived the restart. Now
ask the editor's journal what happened to that commandId:

```sh
cclay live cmd reconcile_studio_command --args "$(node -e '
const e = require("/tmp/329-doc/f-c-envelope.json");
console.log(JSON.stringify({ commandId: e.commandId, host: e.host }));
')"
```
```json
{"status":"applied","receipt":{"ok":true,"commandId":"2a7eda44-7aae-4f0b-b004-a45832447da8","receiptId":"receipt-mu3tj9mg-12","host":{…},"status":"applied","authored":true,"revision":{"before":9,"after":10},"affectedIds":["chair"],"delta":[{"id":"chair","after":{…,"color":"#7a4a2b",…}}],"checks":{"coverage":"same-frame-world-AABB-proxies","overlapIds":[],"maximumFootprintOverlapM":0},"undo":{"historyEntryId":"655fb9ad-bb98-4ce2-8824-e04ba709eea7","entries":1,"canUndoDirect":true},"warnings":[],"detailCursor":"2a7eda44-7aae-4f0b-b004-a45832447da8"}}
```

`"status":"applied"` — the colour change went through before the hub died.
`reconcile` answers `applied`, `not_applied` or `unknown`; only `not_applied`
makes a re-issue correct, and only after a fresh `inspect` (the revision moved
either way). Here the edit stands, so either keep it or undo it by receipt:

```sh
cclay live undo --receipt receipt-mu3tj9mg-12
```
```json
{"ok":true,"commandId":"e628e2f7-5afb-420f-9e35-aa9848a01889","receiptId":"6bae7c59-ad0e-4a97-83d6-8b9d2c003ca2","host":{…},"status":"undone","authored":true,"revision":{"before":10,"after":11},"affectedIds":["chair"],"delta":[{"id":"chair","after":{"token":"target-9"}}],"checks":{"coverage":"native-history-restoration"},"undo":{"historyEntryId":"655fb9ad-bb98-4ce2-8824-e04ba709eea7","entries":1,"canUndoDirect":false},"warnings":[],"undoneReceiptId":"receipt-mu3tj9mg-12","restoredTargets":[{…,"targetId":"chair","token":"target-9"}]}
```

The editor's journal is what makes this safe: because every admitted command
is journaled under its `commandId` *on the editor*, the truth about a mutation
outlives the hub that relayed it.

## Reference

### Verbs

| verb | what it does | receipt? |
| --- | --- | --- |
| `status [--wait]` | the hub, its editors, and the selected one; `--wait` blocks until a selectable editor connects | no |
| `describe` | the full live scene document (scenes, objects, characters, camera, timeline) | no |
| `inspect --scope selection\|scene\|entities\|shot\|motion\|catalogue` `[--ids a,b]` `[--query text]` | the scene context: identity, revisions, entity tokens, shots, receipts — the source for admission envelopes | no |
| `capture --out frame.png [--framing]` | the editor's 640×360 viewport PNG, or with `--framing` the full-resolution shot-camera PNG | no |
| `arrange-objects --op '<json>'` \| `-f ops.json` | create / update / remove / group / ungroup set pieces, up to 100 ops, with relative placement and collision policy | yes |
| `arrange-characters --op '<json>'` \| `-f ops.json` | create / update / remove cast, up to 8 ops | yes |
| `frame-shot --subject <id> --size … --view … --level … [--side] [--focal]` or `--exact px,py,pz,lx,ly,lz,focal` | move the shot camera by film vocabulary or to an exact pose; `keyAtFrame` (via `cmd`) also authors a camera key | yes |
| `operate [--select object:<id>] [--frame N] [--mode scene\|camera\|motion] [--play\|--pause]` | transient editor state — selection, playhead, mode; nothing authored | yes (transient) |
| `verify --receipt <id> --checks placement,framing [--visual frame --out check.png]` | re-run a receipt's evidence, optionally writing its visual proof | no |
| `undo --receipt <id>` | restore the document through the editor's native history, one entry | yes |
| `cmd <name> --args '<json>'` | any live-protocol command, raw (no admission, no auto-receipt) | per command |
| `tool <name> --args '<json>'` | any registry tool the hub serves, e.g. `describe_shot` | no |

The op JSON for `arrange-*` is one operation, an array of them, or
`{"ops":[…], "collisionPolicy":"report"|"avoid"}`. Placement is `world`
coordinates or `relativeTo` an entity with `basis` (`world` / `subject` /
`shot_camera`), `side` and `gapM`; `support` stands things on the floor or on
an object. Sizes: extreme close-up … extreme wide shot. Views: front, front
three-quarter, profile, rear three-quarter, back. Levels: ground, low, hip,
eye, high, overhead. Sides: left, right.

### Global flags

| flag | meaning |
| --- | --- |
| `--workspace <handle\|project>` | which editor tab a command reaches |
| `--timeout <ms>` | bound for one command round trip (max 300 000) |
| `--pretty` | indent the JSON object |
| `--live-port <port>` | hub port; else `COZYCLAY_LIVE_PORT`, else 5184 |

`stdout` is exactly one JSON object per invocation; progress goes to `stderr`,
so piping through `jq` is always safe.

### Exit codes

| code | meaning | next step |
| --- | --- | --- |
| 0 | ok | — |
| 1 | editor or receipt error | read the message; the receipt in `error.details.receipt` is the evidence |
| 2 | usage error | `cclay live --help` |
| 3 | no hub (`NO_SERVER`) | start the hub, then `status --wait` |
| 4 | workspace problem (`NO_EDITOR`, `AMBIGUOUS_WORKSPACE`, `STALE_HANDLE`) | open a tab / name one with `--workspace` |
| 5 | `TIMEOUT` or `UNCERTAIN_APPLY` | do not retry; reconcile or re-inspect |
| 6 | `STALE_SCENE`, `STALE_TARGET`, `TARGET_BUSY` | `inspect` again and re-issue |

### The two-editor rule

With exactly one editor connected, commands route to it automatically. With
two or more, the hub refuses to guess: every verb fails `AMBIGUOUS_WORKSPACE`
listing the candidate handles until you pass `--workspace <handle>` (a project
name works too, if it names exactly one tab). A handle from before a reload
still names the same tab — but while that tab is away it fails `STALE_HANDLE`
and is never silently rerouted to a different editor. `status` never fails on
ambiguity; it just reports `selected: null`.

### Timeouts

- Default editor command bound: 5 s (30 s for motion installs). `--timeout`
  overrides it per command, capped at 300 s.
- The CLI additionally abandons a request that gets no *hub* answer at all
  (default ceiling 330 s).
- `status --wait` gives up after 30 s unless `--timeout` says otherwise.
- A timeout on a **mutation** is an uncertain apply — see session (c).

### Units

Metres (`x` right, `z` toward the default camera, `y` up), degrees of yaw,
frames at 24 fps, frame ranges end-exclusive. Ids are the ids the scene
document uses — take them from `inspect`, never from memory.

## Limits

Motion generation is not on the CLI yet: `generate_motion` and the motion
install verbs are served by the MCP server's own runtime, not the live hub
(deferred to part E of this plan). Until then, an editor connected to the hub
refuses those commands with `CAPABILITY_MISSING`, and motion work stays on
the surfaces that own it — the Studio's motion panels, or a prompt-driven
session through the Agent panel (**View ▾ → Panels → Agent panel**), which
remains available and works the same scene.
