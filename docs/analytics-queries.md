# Export attempt lifecycle

Issue #272 adds an attempt cohort, not a second source of export success counts.
The initiating surface owns the attempt until pipeline completion or download
handoff. A handoff does not prove that the operating system saved the file.

## Event contract

| Event | Properties |
| --- | --- |
| `export:attempt_started` | `attempt_id`, `export_kind`, `format`, `surface` |
| `export:attempt_succeeded` | Started properties plus `duration_bucket` |
| `export:attempt_failed` | Started properties plus `duration_bucket`, `failure_code` |
| `export:attempt_cancelled` | Started properties plus `duration_bucket`, `failure_code=aborted` |

- `attempt_id`: fresh random 32-character lowercase hexadecimal value, held only
  by that attempt. It is not persisted or derived from an installation, filename,
  URL, path, prompt, scene content or message/request identifier.
- `export_kind`: `video`, `depth_video`, `frame`, `keyframe_pack`.
- `format`: `mp4` for video/depth video, `png` for frames, `zip` for packs.
- `surface`: `studio`, `workflow`, `embed`; this identifies the initiator, not
  the renderer. Workflow owns its iframe request through its own download
  handoff. The iframe's pack and nested MP4 do not emit separate attempts.
  A direct embed pack request is owned by `embed`.
- `duration_bucket`: elapsed time from start, using `bucketMs`: `lt1s` (<1 s),
  `1-3s` ([1, 3) s), `3-10s` ([3, 10) s), `10-30s` ([10, 30) s),
  `gte30s` (>=30 s). Terminal events only.
- `failure_code`: `unsupported_codec` (WebCodecs/H.264 unavailable),
  `encode_failed` (encoder or MP4 mux failure), `render_failed` (capture/renderer
  failure), `aborted` (actual abort), `unknown` (otherwise unclassified, including
  a Workflow response timeout). Raw error messages are never analytics values.
  Codes survive the iframe boundary independently of the user-facing message.

One frame download click is one attempt, including both A/B frames and an
optional palette sidecar. One "all shots" pack click is one attempt; if a later
shot fails after an earlier handoff, the attempt fails. Internal clip encoding
is never a video attempt. The video stop action aborts the existing attempt,
not a new attempt. There is no synthetic cancellation for page closure, a
response timeout or a missing event. Exports without an abort path do not invent
a cancel action.

Each attempt emits at most one terminal event. Analytics is best effort: SDK,
clock or randomness failure cannot stop the export. Reloads, tab closure,
opt-out, blocked delivery or process termination can leave unresolved starts or
orphan terminals. No recovery event is invented. QA helpers that invoke a
top-level export use pipeline completion; the raw `__exportOffscreen` test seam
is an internal encoder probe, not a user attempt.

### Compatibility mapping

Existing events retain their original trigger and properties:

| Legacy event | Lifecycle mapping |
| --- | --- |
| `export:video_succeeded {format: "mp4"}` | Successful top-level Studio video path (or the same path invoked in an embed); not depth video or a pack's internal clip |
| `export:blocking_frame_succeeded {format: "png"}` | One successful frame download click, including A/B |
| `export:keyframe_pack {entries, source: "workflow"}` | Successful Workflow pack download; `entries` is a nonnegative numeric file count |

These are compatibility signals, **not additional attempts or successes**.
Use only `export:attempt_*` for new reliability queries. Do not sum or union
legacy successes into the lifecycle numerator. Existing `feature:used` behavior
is unchanged.

## Seven-day attempt rate and success rate

Run this HogQL query in PostHog SQL insights. It groups by the initiating
`export_kind` and `surface`, deduplicates repeated deliveries by attempt ID,
and reports unresolved and contradictory outcomes separately.

`attempts_per_day` measures attempt frequency, while `success_rate_pct` measures
successful attempts / all started attempts. They answer different questions;
neither alone measures whether a visitor discovered the Export menu.

```sql
WITH per_attempt AS (
    SELECT
        properties.attempt_id AS attempt_id,
        any(properties.export_kind) AS export_kind,
        any(properties.surface) AS surface,
        minIf(timestamp, event = 'export:attempt_started') AS started_at,
        countIf(event = 'export:attempt_started') AS start_deliveries,
        max(event = 'export:attempt_succeeded') AS succeeded,
        max(event = 'export:attempt_failed') AS failed,
        max(event = 'export:attempt_cancelled') AS cancelled
    FROM events
    WHERE timestamp >= now() - INTERVAL 7 DAY
      AND timestamp < now()
      AND event IN (
          'export:attempt_started', 'export:attempt_succeeded',
          'export:attempt_failed', 'export:attempt_cancelled'
      )
      AND notEmpty(properties.attempt_id)
    GROUP BY attempt_id
), cohort AS (
    SELECT *, succeeded + failed + cancelled AS terminal_kinds
    FROM per_attempt
    WHERE start_deliveries > 0
      AND started_at >= now() - INTERVAL 7 DAY
)
SELECT
    export_kind,
    surface,
    count() AS attempts,
    round(count() / 7.0, 2) AS attempts_per_day,
    countIf(terminal_kinds = 1 AND succeeded = 1) AS successes,
    countIf(terminal_kinds = 1 AND failed = 1) AS failures,
    countIf(terminal_kinds = 1 AND cancelled = 1) AS cancellations,
    countIf(terminal_kinds = 0) AS unresolved,
    countIf(terminal_kinds > 1) AS conflicting_outcomes,
    round(100.0 * countIf(terminal_kinds = 1 AND succeeded = 1)
        / count(), 2) AS success_rate_pct,
    round(100.0 * countIf(terminal_kinds = 1 AND succeeded = 1)
        / nullIf(countIf(terminal_kinds = 1), 0), 2) AS resolved_success_rate_pct
FROM cohort
GROUP BY export_kind, surface
ORDER BY export_kind, surface
```

The seven-day cohort includes in-flight attempts at its right edge. Inspect
`unresolved` alongside the rate; it is not an inferred failure count. To compare
settled cohorts, replace the cohort's start bounds with a fixed interval ending
before the observation time, retain terminal events through the observation
time, and divide `attempts_per_day` by that interval's length. The resolved-only
rate is diagnostic and can be biased by missing terminal delivery.

For delivery diagnostics, reuse `per_attempt` and count groups with
`start_deliveries = 0`: these are orphan terminal IDs in the observation window,
not additional attempts. A start before the window can explain an orphan.
`conflicting_outcomes` should remain zero and indicates instrumentation or
ingestion trouble if it does not.

Apply the explicitly marked internal-QA exclusion from issue #270 consistently
to the source events when that contract is available. Do not infer QA traffic
from names, paths, browser strings or these ephemeral attempt IDs. Source
development and the browser QA script do not send production telemetry.
