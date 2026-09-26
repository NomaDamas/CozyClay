# Project authoring and geometry export contract

This proposal groups the shared-scene authoring work in #15 with the depth/normal
export work in #21. Both features need the same thing: a durable, machine-readable
project contract instead of transient browser state or UI screenshots.

## One project source of truth

The project service owns a `snapshot + ordered operation log`. The local Studio
uses the same command/reducer through a local adapter, so solo mode and shared mode
cannot drift into different semantics.

- Every committed operation has a server-assigned sequence, actor id, and unique
  `opId`; `opId` is the idempotency key.
- A transaction is the unit of undo (for example, one drag may contain several
  field operations). Undo appends a conditional inverse; it never rewinds history.
- Preconditions (`baseSeq` and expected field writer) determine `applied`, `partial`,
  `superseded`, or `rejected`. A partial undo must leave another actor's newer
  fields untouched and report which fields were skipped.
- Camera keys, shots, waypoints, poses, cast placement, prompt blocks, and IK edits
  must use the same vocabulary as object edits. `activeSceneId` remains local
  presence, not shared document state.

## Deterministic shot package

An export reads the committed project projection at a named shot and writes one
portable package. The plate, depth, and normal passes use the same camera, frame
range, resolution, and editor-layer mask (no grid, gizmos, or cage).

```text
shot-package/
  plate.(png|mp4)
  depth.(png|mp4)
  normal.(png|mp4)
  stills/                 # existing generation-form stills
  prompt.txt
  metadata.json           # camera, lens/sensor, fps, range, blocking, encodings
  comfyui-workflow.json   # depth-conditioned graph; checkpoint is a placeholder
```

Depth encoding (near/far and linear vs reciprocal) is explicit in `metadata.json`;
the consumer never has to guess. Video passes are frame-reproducible and are added
after the single-frame path is stable.

## Acceptance criteria

1. Two online actors can edit one scene; each actor's undo affects only fields whose
   last writer is that actor, with partial results reported deterministically.
2. Reconnecting with `Last-Event-ID` catches up without duplicate operations; replay
   of a log produces the same projection and shot package byte-for-byte for a fixed
   renderer build.
3. A shot export contains plate/depth/normal plus prompt, metadata, and workflow;
   all passes match camera and frame settings, and no editor overlays are present.
4. A package can be consumed without reading Studio UI state. Missing/unsupported
   pass encodings fail loudly in metadata validation.
5. Existing solo projects continue to open through the local adapter; no MCP-only
   schema is introduced.

## Delivery order and non-goals

Implement the operation vocabulary/reducer first, then the authenticated project
service and SSE/POST transport. Add the single-frame export package next; add
video passes and MCP tools only after replay and export determinism are covered.

Offline log merge, segmentation/matte passes, generation execution, and replacing
the Studio UI are out of scope for this contract.
