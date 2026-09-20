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

One process owns the hub; everything else just connects to it:

1. **Start the Studio** — `npm run dev` from the checkout, or `cclay` from
   the installed package. The dev runner and the launcher already host the
   live hub through their agent sidecar, so this one process is both the
   Studio *and* the hub owner. Set `COZYCLAY_LIVE_PORT` so the hub is *yours*,
   not somebody else's on the default 5184; the hub publishes its address and
   token in a mode-0600 endpoint file under your config home, which is how
   `cclay live` finds it:

   ```sh
   COZYCLAY_LIVE_PORT=5629 npm run dev -- --port 5209   # source checkout, hub owner "dev-full"
   cclay                                                # installed package, hub owner "cozyclay"
   ```

2. **Open a browser tab** at the Studio URL (`http://127.0.0.1:5209/app/`).
   A headless Chromium with remote debugging is fine — the editor is the page,
   not the window.

3. **Gate on an editor** with `status --wait` (below).

The rule is **one hub owner per port, never both**: if you also start
`node mcp/server.mjs` (or `cclay mcp`) on the same `COZYCLAY_LIVE_PORT`, the
second binder silently loses the port — the Studio's sidecar is then left
without its hub, so the Agent panel is dead while `cclay live` still answers
through the MCP-owned one. Run the MCP server as the hub owner *only* for
MCP-client sessions, and then do not start `npm run dev` / `cclay` on the
same port.

Then wait until an editor is actually attached, which is what `--wait` is
for. Without an editor every mutation verb fails `NO_EDITOR`, so a script
should always begin with this gate:

```sh
cclay live status --wait
```
```json
{"server":{"port":5629,"owner":"dev-full","pid":95307},"editors":[{"handle":"8306b693-6d28-4391-a37d-9a90bdf61fa4","project":"QA","scene":"SCENE 01","cast":1,"embed":false,"connectedAt":1789548461809,"lastSeenMs":44,"inFlight":0}],"selected":"8306b693-6d28-4391-a37d-9a90bdf61fa4"}
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
  `arrange-characters`, `patch`, `frame-shot`, `operate`, `undo`). The receipt is the
  ground truth of what changed: affected ids, revision before/after, undo
  entry, warnings.
- **capture / verify** — `capture --framing` writes the PNG of the shot
  camera; `verify --receipt … --visual frame` writes the receipt's evidence
  image. Read them as images — that is your only honest visual check.
- **undo** — `undo --receipt <id>` restores the document through the editor's
  own native history, exactly one entry, when you got the framing wrong.

Mutations are *admitted*: the CLI reads the scene context first and sends the
document identity and the expected scene revision with the command — no
per-entity tokens, because that revision already bumps on every authored
change. If anything moved under you — the operator dragged a gizmo, another
edit landed — the editor refuses with `STALE_SCENE` / `TARGET_BUSY` instead
of guessing. The response to a refusal is always `inspect` again and re-issue,
never a blind retry.

## Worked session (a): place a prop and frame it

The default scene has one character and nothing else. Read the entities to get
ids and the layout:

```sh
cclay live inspect --scope entities
```
```json
{"context":{"schema":"studio-context-v1","host":{…},"revision":{"scene":3,"physics":3,"view":1},"units":{"distance":"m","angle":"deg","up":"+Y","yawZero":"+Z","yawPositiveToward":"+X","fps":24,"rangeEnd":"exclusive"},"scene":{"name":"SCENE 01","aspect":"16:9","floorY":0,"frameCount":432,"objectCount":0,"characterCount":1},"selection":{"kind":"character","id":"char-a","hierarchyId":"characterA"},"activeCharacterId":"char-a","view":{…},"shot":null,"camera":{…},"entities":[{"id":"char-a","kind":"character","token":"target-2","name":"a young woman in a tan coat",…}],"entityPage":{…},"shots":[],…,"recentReceipts":[…],"jobs":[],"capabilities":{…}},"entities":[{"id":"char-a","kind":"character","name":"a young woman in a tan coat","token":"target-2"}],"total":1,"nextCursor":null}
```

Place a chair next to her — `relativeTo` positions it in the subject's own
basis, and `support: "floor"` stands it on the ground, so you never have to
compute a `y`:

```sh
cclay live arrange-objects --op '{"op":"create","source":{"kind":"chair"},"name":"Side chair","position":{"relativeTo":"char-a","basis":"subject","side":"left","gapM":1.4,"support":"floor"}}'
```
```json
{"ok":true,"commandId":"5aaf07d8-5b11-4cbc-8c7b-a23d6901cb7e","receiptId":"receipt-mu3uybgp-2","host":{…},"status":"applied","authored":true,"revision":{"before":3,"after":4},"affectedIds":["chair"],"delta":[{"id":"chair","after":{"position":{"x":2.0380938133472153,"y":0,"z":0},"yawDeg":0,"rotationDeg":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1},"name":"Side chair","color":"#b9855d","renderer":"chair","parentId":null}}],"checks":{"coverage":"same-frame-world-AABB-proxies","relationSatisfied":true,"overlapIds":[],"actualGapM":1.4000000000000001,"requestedGapM":1.4,"maximumFootprintOverlapM":0,"basis":"subject","support":"floor","baseY":0},"undo":{"historyEntryId":"376e2467-5660-40ac-ad11-4e8821021066","entries":1,"canUndoDirect":true},"warnings":[],"detailCursor":"5aaf07d8-5b11-4cbc-8c7b-a23d6901cb7e"}
```

The receipt is the verification contract: the gap asked for (1.4 m) and the
gap measured (`actualGapM`) match, nothing overlaps, and one undo entry exists.
`verify` re-runs that evidence and adds a picture of the current state:

```sh
cclay live verify --receipt receipt-mu3uybgp-2 --checks placement --visual frame --out /tmp/329-doc/shots/f-a-place-check.png
```
```json
{"receiptId":"receipt-mu3uybgp-2","revision":4,"checks":{"coverage":"same-frame-world-AABB-proxies","relationSatisfied":true,"overlapIds":[],"actualGapM":1.4000000000000001,"requestedGapM":1.4,"maximumFootprintOverlapM":0,"basis":"subject","support":"floor","baseY":0},"verification":null,"semanticStatus":"unavailable","visualRefs":[{"imageId":"ffdcee4e-bf4b-432c-82be-8b7b92c419b3"}],"unsupportedChecks":[],"visual":[{"imageId":"ffdcee4e-bf4b-432c-82be-8b7b92c419b3","path":"/tmp/329-doc/shots/f-a-place-check.png","width":1920,"height":1080,"bytes":684177}]}
```

Now frame the shot — camera vocabulary, not coordinates. This scene has no
shots yet, so the first `frame-shot` creates one spanning the timeline:

```sh
cclay live frame-shot --subject char-a --size "wide shot" --view front --level hip
```
```json
{"ok":true,"commandId":"c836cddc-9861-4ec0-87e3-fec764666ed7","receiptId":"receipt-mu3uybub-4","host":{…},"status":"applied","authored":true,"revision":{"before":4,"after":5},"affectedIds":["shot-mu3uybub-3"],"delta":[{"id":"shot-mu3uybub-3","after":{"range":{"startFrame":0,"endFrameExclusive":432},"camera":{"position":{"x":-0.011522021105043662,"y":1.0621432515131122,"z":5.077024270710456},"lookAt":{…},"focalMm":24.44391231902759,"sensorId":"fullFrame","slate":"wide shot"},"subjectIds":["char-a"],"shotId":"shot-mu3uybub-3"}}],"checks":{"coverage":"same-frame-subject-bounds-projection","clipped":false,"behindCamera":false,"screenFraction":0.44729099405708983,"derivedSize":"wide shot"},"undo":{"historyEntryId":"be5d9c6f-0bb7-4e5c-be4d-3b1fe7dc887c","entries":1,"canUndoDirect":true},"warnings":[{"code":"OCCLUSION_UNMEASURED"}],"detailCursor":"c836cddc-9861-4ec0-87e3-fec764666ed7"}
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
{"context":{"schema":"studio-context-v1","host":{"surface":"studio","workspaceId":"8306b693-…","documentEpoch":"9110399f-…","sceneId":"scene-mu3uy6d6-1","sceneEpoch":"69c39cf9-…","workspaceHandle":"8306b693-…"},"revision":{"scene":5,"physics":4,"view":3},"units":{…},"scene":{"name":"SCENE 01","aspect":"16:9","floorY":0,"frameCount":432,"objectCount":1,"characterCount":1},"selection":{"kind":"character","id":"char-a","hierarchyId":"characterA"},"activeCharacterId":"char-a","view":{…},"shot":{"id":"shot-mu3uybub-3","name":"Shot 1","range":{"startFrame":0,"endFrameExclusive":432},"mode":"keys"},"camera":{…},"entities":[{"id":"char-a","kind":"character","token":"target-2",…},{"id":"chair","kind":"object","token":"target-5",…}],"entityPage":{"returned":2,"total":2,"truncated":false,"nextCursor":null},"shots":[{"id":"shot-mu3uybub-3","name":"Shot 1","range":{"startFrame":0,"endFrameExclusive":432},"keyCount":0}],"shotsTruncated":false,"assets":[],"recentReceipts":[{"id":"receipt-mu3uybub-4","summary":"applied","canUndoDirect":true},{"id":"receipt-mu3uybgp-2","summary":"applied","canUndoDirect":false},…],"jobs":[],"capabilities":{…}},"entities":[{"id":"char-a","kind":"character","name":"a young woman in a tan coat","token":"target-2"},{"id":"chair","kind":"object","name":"Side chair","token":"target-5"}],"total":2,"nextCursor":null}
```

Build the envelope from that context — the four host identity fields and the
scene revision you saw. Mint your own `commandId`; the editor journals it,
which is what makes the command reconcilable later:

```sh
cclay live inspect --scope shot > /tmp/329-doc/f-b-inspect.json
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
};
require("node:fs").writeFileSync("/tmp/329-doc/f-b-envelope.json", JSON.stringify(envelope));
'
```

Send it as one raw command:

```sh
cclay live cmd frame_shot --args "$(cat /tmp/329-doc/f-b-envelope.json)"
```
```json
{"ok":true,"commandId":"e94748b1-5df7-4859-a1f3-baf9cb20067a","receiptId":"receipt-mu3uyc8d-6","host":{…},"status":"applied","authored":true,"revision":{"before":5,"after":6},"affectedIds":["shot-mu3uybub-3","camera-key-mu3uyc8d-5"],"delta":[{"id":"shot-mu3uybub-3","after":{"range":{"startFrame":0,"endFrameExclusive":432},"camera":{"position":{"x":-0.011522021105043662,"y":1.5894328518973564,"z":2.109947017309772},"lookAt":{…},"focalMm":24.44391231902759,"sensorId":"fullFrame","slate":"medium shot"},"subjectIds":["char-a"],"shotId":"shot-mu3uybub-3"}},{"id":"camera-key-mu3uyc8d-5","after":{…,"keyId":"camera-key-mu3uyc8d-5","frame":0,…}}],"checks":{"coverage":"same-frame-subject-bounds-projection","clipped":true,"behindCamera":false,"screenFraction":1.1027891282716213,"derivedSize":"medium shot"},"undo":{"historyEntryId":"47bcf6d7-2a8e-44bb-b40e-25a3180e7d57","entries":1,"canUndoDirect":true},"warnings":[{"code":"OCCLUSION_UNMEASURED"}],"detailCursor":"e94748b1-5df7-4859-a1f3-baf9cb20067a"}
```

Two affected ids this time: the shot *and* the new camera key
(`camera-key-mu3uyc8d-5`). The camera rose from y 1.06 to y 1.59 — eye level
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
cclay live undo --receipt receipt-mu3uyc8d-6
```
```json
{"ok":true,"commandId":"0de3e0ee-b32b-41ef-84e9-d4000813036e","receiptId":"e7ab0f0e-b86f-4d89-8ab5-6e4765c3b26f","host":{…},"status":"undone","authored":true,"revision":{"before":6,"after":7},"affectedIds":["shot-mu3uybub-3","camera-key-mu3uyc8d-5"],"delta":[{"id":"shot-mu3uybub-3","after":{"token":"target-8"}},{"id":"camera-key-mu3uyc8d-5","after":{"token":"removed-9"}}],"checks":{"coverage":"native-history-restoration"},"undo":{"historyEntryId":"47bcf6d7-2a8e-44bb-b40e-25a3180e7d57","entries":1,"canUndoDirect":false},"warnings":[],"undoneReceiptId":"receipt-mu3uyc8d-6","restoredTargets":[{…,"targetId":"shot-mu3uybub-3","token":"target-8"},{…,"targetId":"camera-key-mu3uyc8d-5","token":"removed-9"}]}
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
{"ok":false,"error":{"code":"UNCERTAIN_APPLY","message":"Live editor timed out running arrange_objects. The mutation may have been applied. Do not retry it; describe the scene before choosing a recovery action.","recovery":{"action":"reconcile","hint":"Do not retry the mutation; describe the scene first and choose a recovery action from what it reports."},"details":{"commandId":"951b6678-2a44-45fd-8783-36c94dc0ccdc","reconcile":{"status":"applied","receipt":{"ok":true,"commandId":"951b6678-2a44-45fd-8783-36c94dc0ccdc","receiptId":"receipt-mu3vbw54-3","host":{…},"status":"applied","authored":true,"revision":{"before":4,"after":5},"affectedIds":["chair"],"delta":[{…,"name":"Stand-in chair",…}],"checks":{…},"undo":{…},"warnings":[],"detailCursor":"951b6678-2a44-45fd-8783-36c94dc0ccdc"}}}}}
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
COZYCLAY_LIVE_PORT=5629 npm run dev -- --port 5209 &   # hub restart
cclay live status --wait
```
```json
{"server":{"port":5629,"owner":"dev-full","pid":4315},"editors":[{"handle":"a881c22c-233b-4953-81ab-84fd0ab6a5b1","project":"QA","scene":"SCENE 01","cast":1,"embed":false,"connectedAt":1789549104568,"lastSeenMs":1,"inFlight":0}],"selected":"a881c22c-233b-4953-81ab-84fd0ab6a5b1"}
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
{"status":"unknown"}
```

`unknown` here is honest, and it is the answer to expect in this setup: the
journal lives *in the editor page*, and killing the dev runner took the web
server with it, so the tab reloaded and the journal went with it (the timeout
case above reconciles `applied` because there the page never reloaded).
`reconcile` answers `applied`, `not_applied` or `unknown`; `unknown` and
`not_applied` both mean the same next step — a fresh `inspect`, then choose:

```sh
cclay live inspect --scope selection
```
```json
{"context":{"schema":"studio-context-v1","host":{…},"revision":{"scene":3,"physics":3,"view":1},"units":{…},"scene":{"name":"SCENE 01","aspect":"16:9","floorY":0,"frameCount":432,"objectCount":1,"characterCount":1},"selection":{…},"activeCharacterId":"char-a","view":{…},"shot":null,"camera":{…},"entities":[{…},{"id":"chair","kind":"object","token":"target-1","name":"Stand-in chair",…}],"entityPage":{…},"shots":[],…,"recentReceipts":[…],"jobs":[],"capabilities":{…}},"entities":[{"id":"char-a","kind":"character","name":"a young woman in a tan coat","token":"target-3"},{"id":"chair","kind":"object","name":"Stand-in chair","token":"target-1"}],"total":2,"nextCursor":null}
```

The reload reopened the same project and the chair is still there, renamed
`Stand-in chair` — the timeout edit above had landed. Whatever the killed
command did, the state you just read is the truth now, so close the loop on
it: issue a fresh admitted command built from that inspect's revision (here a
new colour; if it had re-issued the identical colour, the editor would have
answered `noop` — also fine, just nothing to undo):

```sh
node -e '
const c = require("/tmp/329-doc/f-c-inspect2.json").context;
const host = (({workspaceId, documentEpoch, sceneId, sceneEpoch}) => ({workspaceId, documentEpoch, sceneId, sceneEpoch}))(c.host);
const envelope = {
  name: "arrange_objects",
  args: { ops: [{ op: "update", id: "chair", color: "#3d5a80" }] },
  commandId: crypto.randomUUID(),
  host,
  expectedRevision: c.revision.scene,
};
require("node:fs").writeFileSync("/tmp/329-doc/f-c-envelope2.json", JSON.stringify(envelope));
'
cclay live cmd arrange_objects --args "$(cat /tmp/329-doc/f-c-envelope2.json)"
```
```json
{"ok":true,"commandId":"53f3bb46-b939-4d57-811d-04701ba0bebf","receiptId":"receipt-mu3vc2ed-2","host":{…},"status":"applied","authored":true,"revision":{"before":3,"after":4},"affectedIds":["chair"],"delta":[{"id":"chair","after":{"position":{"x":2.0380938133472153,"y":0,"z":0},"yawDeg":0,"rotationDeg":{"x":0,"y":0,"z":0},"scale":{"x":1,"y":1,"z":1},"name":"Stand-in chair","color":"#3d5a80","renderer":"chair","parentId":null}}],"checks":{"coverage":"same-frame-world-AABB-proxies","overlapIds":[],"maximumFootprintOverlapM":0},"undo":{"historyEntryId":"7ada6c36-2b26-460d-874f-c70ef47a698c","entries":1,"canUndoDirect":true},"warnings":[],"detailCursor":"53f3bb46-b939-4d57-811d-04701ba0bebf"}
```

`status: "applied"` with a receipt, rev 3→4 — the loop is closed on live
state, never on a guess about what the dead hub saw.

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
| `patch --target <kind>[:<id>] --set '<json>'` | set declared authored fields by path on one `character` / `object` / `shot` / `stage` target; `inspect --scope catalogue` lists the patchable paths | yes |
| `frame-shot --subject <id> --size … --view … --level … [--side] [--focal]` or `--exact px,py,pz,lx,ly,lz,focal` | move the shot camera by film vocabulary or to an exact pose; `keyAtFrame` (via `cmd`) also authors a camera key | yes |
| `operate [--select object:<id>] [--frame N] [--mode scene\|camera\|motion] [--play\|--pause]` | transient editor state — selection, playhead, mode; nothing authored | yes (transient) |
| `verify --receipt <id> --checks placement,framing [--visual frame --out check.png]` | re-run a receipt's evidence, optionally writing its visual proof | no |
| `undo --receipt <id>` | restore the document through the editor's native history, one entry | yes |
| `cmd <name> --args '<json>'` | any live-protocol command, raw (no admission, no auto-receipt) | per command |
| `tool <name> --args '<json>'` | any registry tool the hub serves, e.g. `describe_shot` | no |

`patch` carries one target kind per command — its commit domain — because one
receipt is one revision step and one undo entry; a `character` patch and a
`stage` patch are two commands. `--target` is `kind` (`stage`, or `shot` for
the current shot) or `kind:id` (`character:char-a`, `object:chair`,
`shot:shot-1`). `--set` is a JSON object keyed by the element path inside that
kind, e.g. `{"keyLight.intensity": 2.4}` for `stage.keyLight.intensity`. A
value the editor's own persistence normalizer refuses to keep is reported, not
assumed: the receipt's `ops[]` names it in `droppedPaths` and the receipt
status becomes `partial`. A value outside a path's declared range never
reaches the normalizer at all — the command is refused with
`INVALID_ARGUMENT` before admission.

```sh
cclay live inspect --scope catalogue | jq '.patchable.stage'
```
```json
[{"path":"stage.keyLight.x","type":"number","min":-30,"max":30},{"path":"stage.keyLight.y","type":"number","min":0.5,"max":30},{"path":"stage.keyLight.z","type":"number","min":-30,"max":30},{"path":"stage.keyLight.intensity","type":"number","min":0,"max":4},{"path":"stage.keyLight.warmth","type":"number","min":0,"max":1},…]
```
A vec3 path, e.g. `object.scale`, carries `min`/`max` as `{x,y,z}` objects —
one limit per axis — instead of a single number.

```sh
cclay live patch --target stage --set '{"keyLight.intensity":2.4,"keyLight.warmth":0.2}'
```
```json
{"ok":true,"commandId":"0f0f6f3e-…","receiptId":"receipt-mu9p1c2-7","host":{…},"status":"applied","authored":true,"revision":{"before":6,"after":7},"affectedIds":["scene-mu3uy6d6-1"],"delta":[{"id":"scene-mu3uy6d6-1","after":{"patched":[{"path":"stage.keyLight.intensity","number":2.4},{"path":"stage.keyLight.warmth","number":0.2}]}}],"checks":{"coverage":"declared-element-readback"},"undo":{"historyEntryId":"8f2c…","entries":1,"canUndoDirect":true},"warnings":[],"ops":[{"index":0,"status":"applied"}],"detailCursor":"0f0f6f3e-…"}
```

That one receipt is one Cmd+Z in the editor: `undo --receipt receipt-mu9p1c2-7`
and the key light goes back exactly where it was.

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

## Models and providers

The other prompt surface, the Agent panel (Studio and Workflow), runs on the
pi agent harness and can talk to five providers. A model id on the wire is
`provider/model`, so `openai-codex/gpt-6-astra` and `anthropic/claude-fable-5`
name two different models without ambiguity. A bare id with no slash still
works and means `openai-codex/<id>`, which is why older saved model choices
keep resolving.

| provider id | shows up as | how it authenticates |
| --- | --- | --- |
| `openai-codex` | ChatGPT (OpenAI Codex) | your ChatGPT sign-in, unchanged |
| `anthropic` | Anthropic | API key, `ANTHROPIC_API_KEY` |
| `openai` | OpenAI | API key, `OPENAI_API_KEY` |
| `google` | Google Gemini | API key, `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| `openrouter` | OpenRouter | API key, `OPENROUTER_API_KEY` |

ChatGPT sign-in did not change: the panel still runs the Codex OAuth flow,
the token still lives in `~/.config/cozyclay/codex-auth.json`, and it is still
the only provider you sign in to rather than paste a key for. There are no
OAuth flows for the other four.

### Where the keys live

An API-key provider is read from its environment variable first, and from
`~/.config/cozyclay/providers.json` second. That file is written atomically at
mode 0600 and is a flat map of provider id to key:

```json
{"anthropic":"sk-ant-…","openrouter":"sk-or-…"}
```

The environment variable wins when both are set, so a key exported in the
shell that started the Studio temporarily overrides the saved one without
touching the file. `COZYCLAY_CONFIG_DIR` moves the whole config home,
`providers.json` and `codex-auth.json` together, which is what the tests use.

Three routes manage the file. They sit behind the same origin guard as the
rest of `/agent/*`: a browser request must carry an `Origin` of the Studio's
own loopback address, and a header-less `curl` is accepted for `GET` only, so
the writing calls need the header spelled out.

```sh
curl -s http://127.0.0.1:5180/agent/providers
curl -s -X PUT http://127.0.0.1:5180/agent/providers/anthropic \
  -H 'origin: http://127.0.0.1:5180' -H 'content-type: application/json' \
  -d '{"key":"sk-ant-…"}'
curl -s -X DELETE http://127.0.0.1:5180/agent/providers/anthropic \
  -H 'origin: http://127.0.0.1:5180'
```
```json
{"providers":[{"id":"openai-codex","label":"ChatGPT (OpenAI Codex)","authSource":"chatgpt","signedIn":true},{"id":"anthropic","label":"Anthropic","authSource":"file","signedIn":true},{"id":"openai","label":"OpenAI","authSource":null,"signedIn":false},…]}
```

`GET /agent/providers` never echoes key material: `authSource` tells you where
a key came from (`chatgpt`, `env`, `file`) and that is all. `PUT` on
`/agent/providers/openai-codex` is refused with 400 and a message naming the
ChatGPT sign-in, because that provider has no key to store.

`GET /agent/models` is the catalogue the panel's dropdown reads: every
provider with its sign-in state, each model key-addressed as `provider/id`,
and the reasoning-effort levels that model actually supports. A provider you
have no key for is still listed, its models with it and `signedIn: false`, so
the panel can show what a key would buy you.

The model is picked per turn, so one session can start on ChatGPT and
continue on Anthropic without losing its history.

## Steering a running turn

On the Workflow canvas you can add to a turn while it is still running,
instead of stopping it and starting over:

```sh
curl -s -X POST http://127.0.0.1:5180/agent/turn/<turnId>/steer \
  -H 'origin: http://127.0.0.1:5180' -H 'content-type: application/json' \
  -d '{"text":"make it a profile instead"}'
```
```json
{"ok":true,"queued":true}
```

`<turnId>` is the id the Workflow client minted for the running turn.
`attachments` is accepted too, the same short list of `{dataUrl}` images the
composer sends. `queued: true` is literal: the harness takes one steer at a
time and hands the text to the model at the next step of the same turn, so a
tool call already in flight finishes first and nothing is cancelled.

Studio turns are not steerable in this version. Their envelopes are frozen,
so the route answers 409 `STEER_UNSUPPORTED` for a Studio turn id. The other
refusals: 404 when no Workflow turn carries that id, 409 `NO_ACTIVE_TURN`
when the turn has already ended, 400 when the text is missing or empty or an
attachment is not an inline data URL.

## Sessions

Conversations live in `~/.config/cozyclay/agent-sessions/`
(`COZYCLAY_AGENT_SESSIONS_DIR` overrides the directory), one
`<sessionId>.jsonl` transcript plus a `<sessionId>.meta.json` index entry per
session, both mode 0600. `GET /agent/sessions` lists the 50 most recent,
`GET /agent/sessions/<id>` returns one as a transcript.

The transcript is the v2 format: a header line, then one message per line.

```json
{"format":"cozyclay-agent-v2","version":2,"sessionId":"wf-3a91"}
{"kind":"message","message":{"role":"user","content":[{"type":"text","text":"Give me a wide two-shot"}]}}
```

The stored messages are the harness's own messages, written back verbatim,
including the provider-opaque reasoning fields an assistant message carries.
That is what lets a resumed session continue on the same provider instead of
replaying a lossy summary. Inline images over 2 MiB are dropped on write and
the text around them is kept. Nothing compacts or summarises a transcript
behind your back.

Sessions saved before this version have no v2 header, and they are ignored,
not migrated. The files stay on disk untouched; `list` skips them, a direct
read answers 404, and the sidecar logs `[agent] skipping legacy session <id>`
once per session per process. If you want one of those conversations back,
read the old file yourself: nothing in the Studio will convert it.

## Limits

Motion generation is not on the CLI yet: `generate_motion` and the motion
install verbs are served by the MCP server's own runtime, not the live hub
(deferred to part E of this plan). Until then, an editor connected to the hub
refuses those commands with `CAPABILITY_MISSING`, and motion work stays on
the surfaces that own it — the Studio's motion panels, or a prompt-driven
session through the Agent panel (**View ▾ → Panels → Agent panel**), which
remains available and works the same scene.
