# CozyClay Studio Design Contract

## 0. Research Log

- Existing product surface: preserved the current dark Unity-like editor,
  compact timeline controls, violet camera identity, and bilingual labels.
- Interaction reference: the destructive action uses the existing immediate
  editor-button mechanism; no modal or animation is introduced because rail
  geometry is reversible by drawing it again and the state change is local.
- No new dependency, font, layout primitive, or motion token is required.

## 1. Direction

CozyClay is a dense production tool, not a dashboard. Controls stay compact,
technical, and close to the timeline state they change.

## 2. Color

- Editor surface: existing `#201c28` and `#2b2731`.
- Camera/rail identity: existing violet family (`#7258a0`, `#a78bfa`).
- Destructive action: existing product red `#e5484d`, used only for removal.

## 3. Type and Spacing

- Inherit the existing editor font and 10–11 px control scale.
- Use the existing 4 px-based compact spacing and 28 px camera-tool height.

## 4. Motion and Interaction

- Camera toolbar actions respond immediately.
- Crane editing exposes explicit Add point and Remove point actions beside the
  selected point height and count. Add point fills the largest un-authored
  interval and selects the new mark; Remove point is enabled only for a
  selected interior mark. The scene double-click/Delete gestures remain
  accelerators, never the only discoverable route.
- When a Shot uses Rail + Crane, its lower key strip represents crane progress:
  clicking the strip authors a crane point at that rail position, and the
  matching purple/amber marker stays synchronized with the scene handle.
- Binary camera actions state themselves in text (`Follow On` / `Follow Off`)
  and expose `aria-pressed`; Follow sits directly beside `Draw rail` and uses
  the existing violet Camera Block active state.
- Active drawing state continues to use the existing filled violet state.
- Destructive rail deletion uses a red hover/focus cue and an explicit text
  label; no icon-only or right-click-only deletion.
- Keyboard focus must remain visible.
- Full-Body editing is direct and frame-addressed: `Cut` splits at the
  playhead, while each resulting green segment owns a compact speed selector.
  Speed changes redraw the segment width immediately; there is no decorative
  transition because the new duration is the information.
- Full-Body speed runs from `0.1×` to `4.0×` in `0.1×` steps. The current
  segment is identified by the playhead and receives the brighter green
  selected state. Its slider and numeric stepper stay in the fixed timeline
  header instead of inside the segment, so a one-frame segment remains
  editable. Outer trim handles continue to own only the complete take's
  in/out points.

## 5. Reusable Primitives

- `.tl-camera-tool`: compact camera-toolbar action.
- `.tl-camera-tool.active`: active/engaged action.
- `.tl-camera-tool.danger`: destructive camera-toolbar action.
- `.tl-camera-metric`: read-only measured camera value.
- `.tl-motion-clip`: one cut Full-Body segment.
- `.tl-motion-clip.selected`: segment currently under the playhead.
- `.tl-motion-speed-editor`: fixed header slider + numeric stepper for the
  Full-Body segment under the playhead.
- `.tl-crane-editor`: card-local time/height graph; the whole graph is a
  click target for insertion, points have enlarged pointer targets, and
  vertical drags edit height without moving the Shot block.
- `.motion-readiness`: compact, text-labelled generation status beside the
  existing generation controls. It distinguishes checking, ready, not configured,
  unavailable, and unsupported request routes without gating authoring.
  It inherits `--fg`, `--muted`, `--cyan`, `--panel`, `--line2`, `--radius`,
  the 11 px inspector type scale, and 4/8 px spacing. State is never colour-only.
- `.motion-setup`: an explicitly opened region in the existing Settings popover,
  not a modal or another topbar control. Setup documentation opens separately;
  Retry only probes health. Both preserve the scene and prompt blocks.
  The popover scrolls within the viewport, commands wrap, and controls remain
  reachable at 390 px. Status updates use polite announcements, visible keyboard
  focus, and immediate state changes without decorative animation.
