# Export attempt lifecycle

Issue #272 adds an attempt cohort, not a second source of export success counts.
The initiating surface owns the attempt until pipeline completion or download
handoff. A handoff does not prove that the operating system saved the file.

## Event contract

| Event | Properties |
| --- | --- |
| `export:attempt_started` | `attempt_id`, `export_kind`, `format`, `surface`, `is_retry`, `retry_of` (retries only), `objects` |
| `export:attempt_succeeded` | Started properties plus `duration_bucket` |
| `export:attempt_failed` | Started properties plus `duration_bucket`, `failure_code`, `stage`, `progress` |
| `export:attempt_cancelled` | Started properties plus `duration_bucket`, `failure_code=aborted`, `stage`, `progress` |
| `export:saved` | `method`, `reason` (one per saved file; not part of an attempt) |

- `attempt_id`: fresh random 32-character lowercase hexadecimal value, held only
  by that attempt. It is not persisted or derived from an installation, filename,
  URL, path, prompt, scene content or message/request identifier.
- `export_kind`: `video`, `depth_video`, `frame`, `keyframe_pack`, `contact_sheet`,
  `panel_pack`, `animatic`, `animation_project`, `workflow_send`, `storyboard`,
  `render_pass`, `otio`. `contact_sheet` through `workflow_send` arrived with
  storyboard projects (#653); older data only holds the first four.
  `storyboard` (storyboard PNG), `render_pass` (depth + normal PNGs) and `otio`
  (OpenTimelineIO timeline) arrived with the analytics hygiene release; before
  it those exports emitted no attempt at all, so their earlier rows are
  **unknown, not 0**.
- `format`: `mp4` for video/depth video, `png` for frames, storyboards and render
  passes, `zip` for packs, `cclayproject` for an animation project file, `otio`
  for an OpenTimelineIO file.
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
- `is_retry`: boolean, `true` when the attempt retries an earlier attempt.
  `retry_of`: that earlier attempt's 32-hex `attempt_id`, present only when
  `is_retry` is `true`. Join it to `attempt_id` to follow a retry chain.
- `objects`: scene object count bucket at start: `0`, `1-3`, `4-10`, `gte11`.
- `stage` (failed/cancelled only): where the export stopped: `preparing`,
  `encoding`, `finalizing`, `handoff`.
- `progress` (failed/cancelled only): percent complete when it stopped, as a
  bucket: `0`, `1-25`, `26-50`, `51-75`, `76-99`.

Terminal events copy the start properties, so `is_retry`, `retry_of` and
`objects` are on every `export:attempt_*` event of an attempt.

`export:saved` reports how each exported file reached disk, one event per saved
file, without a file name or path:

- `method`: `workspace` (written into the user-chosen export folder) or
  `download` (browser download).
- `reason`: `none`; `unsupported` (the browser has no folder API);
  `no_workspace` (no folder chosen); `permission` (folder permission denied);
  `write_failed` (the folder write failed and the file fell back to download).

It is not an attempt outcome: do not count it as a success or join it into the
lifecycle numerator. A multi-file export emits several.

`track()` drops any event name outside the allowlist (`EVENT_PROPERTIES` in
`src/analytics.js`). Before the analytics hygiene release, unknown names were
sent with empty properties; such rows hold no data and can be ignored.

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
      AND JSONExtractRaw(properties, 'internal_qa') != 'true'
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

The query applies the explicitly marked internal-QA exclusion from issue #270
to every source event. Do not infer QA traffic
from names, paths, browser strings or these ephemeral attempt IDs. Source
development and the browser QA script do not send production telemetry.

# First-edit funnel

## First launch -> first edit -> exported frame

This PostHog SQL/HogQL query measures official npm installations, not editor
sessions. It deduplicates the session-scoped `craft:first_edit` event by
`distinct_id` and accepts only numeric `definition_version = 1`.
`playground:first_edit` and the legacy `*:first_action` events are excluded.

Set `cohort_start` to the actual version 1 rollout timestamp in UTC before
running the query. The timestamp below is an example, not a claimed release
time. Only complete seven-day cohorts enter the denominator. Each later
step must occur strictly after the preceding step and within seven days of
the first launch. Counts are unique installations; no install is counted
twice because it edited in several tabs or sessions.

```sql
WITH
    toDateTime('2026-09-15 00:00:00') AS cohort_start,
    launches AS (
        SELECT distinct_id, min(timestamp) AS launched_at
        FROM events
        WHERE event = 'install:first_launch'
          AND properties.distribution = 'npm'
          AND properties.origin_kind = 'local'
          AND JSONExtractRaw(properties, 'internal_qa') != 'true'
        GROUP BY distinct_id
        HAVING launched_at >= cohort_start
           AND launched_at < now() - INTERVAL 7 DAY
    ),
    edits AS (
        SELECT l.distinct_id, min(e.timestamp) AS edited_at
        FROM launches AS l
        INNER JOIN events AS e ON e.distinct_id = l.distinct_id
        WHERE e.event = 'craft:first_edit'
          AND e.properties.definition_version = 1
          AND e.properties.distribution = 'npm'
          AND e.properties.origin_kind = 'local'
          AND JSONExtractRaw(e.properties, 'internal_qa') != 'true'
          AND e.timestamp > l.launched_at
          AND e.timestamp < l.launched_at + INTERVAL 7 DAY
        GROUP BY l.distinct_id
    ),
    exports AS (
        SELECT l.distinct_id, min(e.timestamp) AS exported_at
        FROM launches AS l
        INNER JOIN edits AS d ON d.distinct_id = l.distinct_id
        INNER JOIN events AS e ON e.distinct_id = l.distinct_id
        WHERE e.event = 'export:blocking_frame_succeeded'
          AND e.properties.distribution = 'npm'
          AND e.properties.origin_kind = 'local'
          AND JSONExtractRaw(e.properties, 'internal_qa') != 'true'
          AND e.timestamp > d.edited_at
          AND e.timestamp < l.launched_at + INTERVAL 7 DAY
        GROUP BY l.distinct_id
    )
SELECT
    (SELECT count() FROM launches) AS first_launches,
    (SELECT count() FROM edits) AS first_edits_v1,
    (SELECT count() FROM exports) AS exported_after_edit_v1
```

The last step intentionally uses the existing successful-frame event; it
does not infer export success from an attempt or from activation. Compare
`first_edits_v1 / first_launches` only when the denominator is nonzero.
This is a first-week activation cohort, not lifetime adoption or a
measurement of all camera use. Older installations without a new
`install:first_launch` are deliberately outside this query.

For Playground analysis, start a separate ordered funnel at
`playground:opened`, then `playground:first_edit` filtered to
`definition_version = 1`, with PostHog's same-session restriction.
Do not use npm first launches as the denominator for hosted Playground
activity. The application's first-edit boundary is an App mount, whereas
PostHog's native session boundary may span multiple mounts.

# Motion generation intent (removed)

The 2.x motion-generation funnel (`motion:generate_requested`,
`motion:preflight_*`, `motion:job_*`, `motion:result_applied`), the
`fal_motion_open` feature name and `sample:played` have no emitter in 3.0.
They left the allowlist on 2026-10-25, so builds from that release can never
send them. Historical rows stay in PostHog; their funnel queries were removed
with the events. Do not join old `motion:*` rows into new 3.0 metrics.

# External cohort baseline (issue #270)

This section is the definitive **external-cohort baseline** for #270. The #272
export contract and #269 first-edit/frame example above remain historical
references; use the fixed-boundary queries below, not their rolling `now()`
windows, for this baseline. These are read-only HogQL `SELECT` queries for
PostHog SQL insights. They do not change dashboards, settings, people or events.
No production PostHog query was executed to establish this document.

## Population, identity and time contract

- Exclude an **event** only when `properties.internal_qa` is JSON boolean
  `true`. Explicit boolean `false` and absent markers stay included, including
  localhost traffic. This is not a retrospective person-level blacklist:
  unmarked events before a user enables the marker remain eligible. Unexpected
  marker types stay included and are visible in query D; string `"true"` is not
  the declared boolean marker. Runtime #270 declares boolean `internal_qa` on
  every regular event and session-end beacon, defaulting to `false`. CLI
  `internalQa` is enabled only by explicit true state. Hosted
  `/app/?internal_qa=1` or `0` persists `cozyclay.internalQa` for that origin;
  npm ignores this URL control. None of these controls overrides consent,
  opt-out, DNT or build/distribution policy.
- All queries use `JSONExtractRaw(properties, 'internal_qa') != 'true'` for that
  type-exact exclusion. JSON extraction returns the unquoted token `true` for
  boolean true, `false` for false, and an empty string for an absent key.
  Likewise, `JSONExtractRaw(properties, 'definition_version') = '1'` means
  **numeric** `definition_version = 1`; the string `"1"` has raw JSON `"1"`
  and is not accepted. Do not replace this with a string-property comparison,
  `toInt`, or another coercion that turns malformed string versions into v1.
- External local app means declared `distribution = 'npm'` **and**
  `origin_kind = 'local'`. Hosted means declared `distribution = 'hosted'`
  **and** `origin_kind = 'hosted'`. Missing or contradictory classifications
  are coverage gaps, not inferred local or hosted users. `install_kind` and
  `app_version` are coverage dimensions, not identity keys or exclusion rules.
  Never infer internal status from hostname, country, port or `clone`.
- A "user" here is one exact event `distinct_id`, not a person. The CLI's
  `takeRuntimeTelemetryConfig` already persists a random `installationId` in
  the CLI state file; npm's memory-only PostHog SDK is bootstrapped with that
  ID and `isIdentifiedID: false`. This predates #270; #270 verifies and locks
  that identity contract rather than inventing a second ID. Normal restarts
  and different ports sharing that state file therefore deduplicate by
  `DISTINCT distinct_id`. Do not
  concatenate a port/session into the key, use person IDs, call `identify`, or
  merge unrelated IDs using browser, device, IP, geography or other inference.
  Separate state files/devices and hosted browser IDs stay separate. Clearing
  state resets identity. CLI telemetry off clears the ID but retains the
  first-launch receipt: re-enabling creates a new ID **without** another
  `install:first_launch`. That ID can enter A/C but lacks B's denominator.
  State-file copying is unsupported, not cross-device matching; shared/copied
  state cannot distinguish different humans.
- Every block is independently runnable. **Edit its UTC constants before use**;
  the dates below are illustrative, not actual deployment dates or baseline
  results. `observation_start_utc` is the available observation lower bound;
  `observation_end_utc` is the fixed exclusive event-time cutoff, never `now()`.
  `runtime_deployed_utc` is the applicable #270 marker/schema release boundary;
  `edit_v1_deployed_utc` and `export_deployed_utc` are the #269/#272 contract
  rollout boundaries. Where hosted/npm rollouts differ, use the latest
  applicable boundary across the populations reported in that run and record
  both releases. This deliberately chooses a common fully deployed window.
  A rollout timestamp does not upgrade events from older clients; query D must
  accompany rates.
- `cohort_start_utc` and `cohort_end_utc` bound **whole cohort weeks**. Set them
  to Monday 00:00 KST (Sunday 15:00 UTC), with an exclusive end. KST is
  `Asia/Seoul`, UTC+09:00, with no daylight-saving changes. The queries derive
  Monday using `toStartOfWeek(toTimeZone(timestamp, 'Asia/Seoul'), 1)` and
  convert that date to an explicit KST midnight instant. They require the
  entire week to fall after observation/deployment starts and before the
  observation cutoff; a midweek deployment never contributes a partial week.
  `week_start_kst` is Monday; the included Sunday is six calendar days later.
- All event windows are `[start, end)`. Funnel steps use strictly increasing
  timestamps; equal timestamps cannot establish order and do not convert.
  Query B observes each launch for seven elapsed days and excludes whole
  launch weeks until every member's seven-day horizon is observable. Query C
  excludes a cohort until the **whole next KST week** is observable. An absent
  row is no eligible cohort, not zero conversion; a zero denominator yields
  SQL `NULL`, not 0%. No `LEFT JOIN`/nullable right-side counts are used: HogQL's
  ClickHouse joins may supply default zero/empty values for unmatched rows.

## Why sample loading is not own-project retention

The actual call paths do not provide an own-project-reopen event contract:

- `src/App.jsx::applyProject` calls `openScene` and unconditionally emits
  `project:opened {age_bucket}`. `openProject` (file picker),
  `openProjectByHandle` (recents/folder), and `restoreStoredProject` (automatic
  stored-handle restore when permission is granted, or an explicit restore
  offer) all call it. A file open is not proof of ownership or of a prior save
  by this anonymous ID; no project identifier links those events.
- `openStarterScene` **also** calls `applyProject`, replacing `savedAt` with
  `null`, then emits `scene:loaded` with `scene_source` `starter` or `launch`
  (`tutorial` on events from before the camera tutorial was removed). The
  launch effect handles `?scene=...`. Thus automatic/sample
  loading can emit `project:opened`; its age falls back to the current time.
  Neither a young nor an old `age_bucket` proves an own-project reopen.
- `openScene` emits `scene:loaded {scene_source: 'local'}` even for a starter
  passed through `applyProject`. Scene selection, creation, duplication and
  replacement can also use it. A starter can produce **two** scene-loaded
  events (`local`, then its starter or launch source); do not subtract
  or pair them by loose timestamps to infer ownership.
- Hosted Playground startup is different: `src/main.jsx::boot` fetches and
  stashes its bundled preset before mounting; `src/app-stage.jsx::loadSceneStartup`
  consumes it without reading saved local scenes and without `applyProject`.
  Its automatic initial preset is not a project reopen. Normal cached scene
  startup likewise need not emit `project:opened`.
- `src/semantic-edit.js::createFirstEditTracker` emits numeric version 1 once
  per App mount per surface, only for a successful authored before/after
  change. Passive load, restore, seeding, navigation, no-ops and history replay
  are excluded. Scene/project switches do not reset the tracker.

Accordingly, C measures **return to an observed v1 edit**, not own-project
reopen. A continuously mounted editor that already emitted its first edit can
edit on another day/week without a new event: these edit-based counts are a
lower-bound proxy for all editing, not comprehensive edit-day telemetry.
An own-project-reopen retention metric is unavailable from the current schema.

## A. Weekly external local-app vs hosted users and 2+-active-day users

An active day is a KST day containing `app:session_started` for npm/local or
`$pageview` for hosted. This is an observed launch/visit day, **not an edit day**.
It deliberately excludes session-end beacons (a midnight unload alone must not
create a second active day), automatic scene events and passive background
signals. Hosted pageviews include instrumented hosted surfaces, not just
Playground; do not describe them as installations or Playground editors.

For each population/week, `active_users` is the denominator: distinct IDs with
at least one active day. `two_plus_active_day_users / active_users` is the
2+-day rate. Multiple sessions/ports on one day are still one day, and one ID
is still one user. Populations are reported separately, never identity-merged.

```sql
WITH
    toDateTime64('2026-08-01 00:00:00', 3, 'UTC') AS observation_start_utc,
    toDateTime64('2026-09-13 15:00:00', 3, 'UTC') AS observation_end_utc,
    toDateTime64('2026-08-01 00:00:00', 3, 'UTC') AS runtime_deployed_utc,
    toDateTime64('2026-08-02 15:00:00', 3, 'UTC') AS cohort_start_utc,
    toDateTime64('2026-09-13 15:00:00', 3, 'UTC') AS cohort_end_utc,
    activity AS (
        SELECT
            distinct_id,
            if(properties.distribution = 'npm', 'local_app', 'hosted') AS population,
            toStartOfDay(timestamp, 'Asia/Seoul') AS active_day_kst,
            toStartOfWeek(toTimeZone(timestamp, 'Asia/Seoul'), 1) AS week_start_kst
        FROM events
        WHERE timestamp >= observation_start_utc
          AND timestamp < observation_end_utc
          AND JSONExtractRaw(properties, 'internal_qa') != 'true'
          AND (
              (event = 'app:session_started'
               AND properties.distribution = 'npm' AND properties.origin_kind = 'local')
              OR (event = '$pageview'
                  AND properties.distribution = 'hosted' AND properties.origin_kind = 'hosted')
          )
    ), dated AS (
        SELECT *, toDateTime64(toString(week_start_kst), 3, 'Asia/Seoul') AS week_at
        FROM activity
    ), per_user_week AS (
        SELECT d.population, d.week_start_kst, d.distinct_id,
               uniqExact(d.active_day_kst) AS active_days
        FROM dated AS d
        WHERE d.week_at >= observation_start_utc
          AND d.week_at >= runtime_deployed_utc
          AND d.week_at >= cohort_start_utc
          AND d.week_at + INTERVAL 7 DAY <= cohort_end_utc
          AND d.week_at + INTERVAL 7 DAY <= observation_end_utc
        GROUP BY d.population, d.week_start_kst, d.distinct_id
    )
SELECT
    population, week_start_kst,
    count() AS active_users,
    countIf(active_days >= 2) AS two_plus_active_day_users,
    round(100.0 * countIf(active_days >= 2) / nullIf(count(), 0), 2) AS two_day_rate_pct
FROM per_user_week
GROUP BY population, week_start_kst
ORDER BY week_start_kst, population
```

## B. First launch -> first edit v1 -> successful video within seven days

The denominator is npm/local distinct IDs whose **earliest observed eligible
`install:first_launch` in all retained history** belongs to a mature cohort
week. The history minimum is taken **before** cohort/rollout filtering, so an
old installation with a later duplicated first-launch event cannot become a
new installation. Retention truncation can hide an earlier launch: record the
retained-history floor in the baseline and label this "first observed launch",
not lifetime first install. Users without a first-launch event are not silently
added from their first edit or first session.

The ordered steps are launch < numeric-v1 `craft:first_edit` < video attempt
start < successful terminal, all later steps before launch + 7 days. Starts
and terminals match exact `(distinct_id, attempt_id, surface)`, and both sides
require `export_kind = 'video'` and `format = 'mp4'`. Repeated deliveries reduce
to their earliest timestamp in retained history, before ordering is checked.
A terminal with no matching start, a success before its start, and an attempt
with any failed/cancelled terminal through the observation cutoff do not count
as success. `success_deliveries > 0` guards `minIf`'s default timestamp.

This is a **user conversion funnel**, not the #272 attempt-level reliability
rate. Success means pipeline completion/download handoff, not an OS save.
`depth_video`, frames, packs, their internal clips, and all legacy export
successes are excluded. Nothing unions `export:video_succeeded` or
`export:blocking_frame_succeeded` into the numerator.

```sql
WITH
    toDateTime64('2026-08-01 00:00:00', 3, 'UTC') AS observation_start_utc,
    toDateTime64('2026-09-13 15:00:00', 3, 'UTC') AS observation_end_utc,
    toDateTime64('2026-08-01 00:00:00', 3, 'UTC') AS runtime_deployed_utc,
    toDateTime64('2026-08-01 00:00:00', 3, 'UTC') AS edit_v1_deployed_utc,
    toDateTime64('2026-08-01 00:00:00', 3, 'UTC') AS export_deployed_utc,
    toDateTime64('2026-08-02 15:00:00', 3, 'UTC') AS cohort_start_utc,
    toDateTime64('2026-09-13 15:00:00', 3, 'UTC') AS cohort_end_utc,
    local_history AS (
        SELECT distinct_id, timestamp, event, properties
        FROM events
        WHERE timestamp < observation_end_utc
          AND properties.distribution = 'npm'
          AND properties.origin_kind = 'local'
          AND JSONExtractRaw(properties, 'internal_qa') != 'true'
          AND event IN (
              'install:first_launch', 'craft:first_edit',
              'export:attempt_started', 'export:attempt_succeeded',
              'export:attempt_failed', 'export:attempt_cancelled'
          )
    ), first_launch_history AS (
        SELECT distinct_id, min(timestamp) AS launched_at
        FROM local_history
        WHERE event = 'install:first_launch'
        GROUP BY distinct_id
    ), launch_weeks AS (
        SELECT *, toStartOfWeek(toTimeZone(launched_at, 'Asia/Seoul'), 1) AS week_start_kst
        FROM first_launch_history
    ), dated_launches AS (
        SELECT *, toDateTime64(toString(week_start_kst), 3, 'Asia/Seoul') AS week_at
        FROM launch_weeks
    ), launches AS (
        SELECT distinct_id, launched_at, week_start_kst
        FROM dated_launches
        WHERE week_at >= observation_start_utc
          AND week_at >= runtime_deployed_utc
          AND week_at >= edit_v1_deployed_utc
          AND week_at >= export_deployed_utc
          AND week_at >= cohort_start_utc
          AND week_at + INTERVAL 7 DAY <= cohort_end_utc
          AND week_at + INTERVAL 14 DAY <= observation_end_utc
    ), edits AS (
        SELECT l.distinct_id, l.launched_at, l.week_start_kst,
               min(e.timestamp) AS edited_at
        FROM launches AS l
        INNER JOIN local_history AS e ON e.distinct_id = l.distinct_id
        WHERE e.event = 'craft:first_edit'
          AND JSONExtractRaw(e.properties, 'definition_version') = '1'
          AND e.timestamp > l.launched_at
          AND e.timestamp < l.launched_at + INTERVAL 7 DAY
        GROUP BY l.distinct_id, l.launched_at, l.week_start_kst
    ), starts AS (
        SELECT distinct_id, properties.attempt_id AS attempt_id,
               properties.surface AS surface, min(timestamp) AS started_at
        FROM local_history
        WHERE event = 'export:attempt_started'
          AND properties.export_kind = 'video' AND properties.format = 'mp4'
          AND match(properties.attempt_id, '^[0-9a-f]{32}$')
          AND properties.surface IN ('studio', 'workflow', 'embed')
        GROUP BY distinct_id, properties.attempt_id, properties.surface
    ), terminals AS (
        SELECT distinct_id, properties.attempt_id AS attempt_id,
               properties.surface AS surface,
               minIf(timestamp, event = 'export:attempt_succeeded') AS succeeded_at,
               countIf(event = 'export:attempt_succeeded') AS success_deliveries,
               countIf(event IN ('export:attempt_failed', 'export:attempt_cancelled')) AS other_terminals
        FROM local_history
        WHERE event IN ('export:attempt_succeeded', 'export:attempt_failed', 'export:attempt_cancelled')
          AND properties.export_kind = 'video' AND properties.format = 'mp4'
          AND match(properties.attempt_id, '^[0-9a-f]{32}$')
          AND properties.surface IN ('studio', 'workflow', 'embed')
        GROUP BY distinct_id, properties.attempt_id, properties.surface
    ), after_edit_starts AS (
        SELECT d.distinct_id, d.week_start_kst, d.launched_at,
               s.attempt_id, s.surface, s.started_at
        FROM edits AS d
        INNER JOIN starts AS s ON s.distinct_id = d.distinct_id
        WHERE s.started_at > d.edited_at
          AND s.started_at < d.launched_at + INTERVAL 7 DAY
    ), video_users AS (
        SELECT DISTINCT s.distinct_id, s.week_start_kst
        FROM after_edit_starts AS s
        INNER JOIN terminals AS t ON t.distinct_id = s.distinct_id
            AND t.attempt_id = s.attempt_id AND t.surface = s.surface
        WHERE t.success_deliveries > 0 AND t.other_terminals = 0
          AND t.succeeded_at > s.started_at
          AND t.succeeded_at < s.launched_at + INTERVAL 7 DAY
    ), stage_users AS (
        SELECT distinct_id, week_start_kst, 'launch' AS stage FROM launches
        UNION ALL
        SELECT distinct_id, week_start_kst, 'edit_v1' AS stage FROM edits
        UNION ALL
        SELECT DISTINCT distinct_id, week_start_kst, 'video_start' AS stage FROM after_edit_starts
        UNION ALL
        SELECT distinct_id, week_start_kst, 'video_success' AS stage FROM video_users
    )
SELECT
    week_start_kst,
    countIf(stage = 'launch') AS first_launch_users,
    countIf(stage = 'edit_v1') AS first_edit_v1_users,
    countIf(stage = 'video_start') AS video_started_after_edit_users,
    countIf(stage = 'video_success') AS video_succeeded_after_edit_users,
    round(100.0 * countIf(stage = 'edit_v1')
        / nullIf(countIf(stage = 'launch'), 0), 2) AS launch_to_edit_pct,
    round(100.0 * countIf(stage = 'video_success')
        / nullIf(countIf(stage = 'launch'), 0), 2) AS launch_to_video_pct,
    round(100.0 * countIf(stage = 'video_success')
        / nullIf(countIf(stage = 'edit_v1'), 0), 2) AS edit_to_video_pct,
    round(100.0 * countIf(stage = 'video_success')
        / nullIf(countIf(stage = 'video_start'), 0), 2) AS started_user_to_video_pct
FROM stage_users
GROUP BY week_start_kst
ORDER BY week_start_kst
```

Hosted has no npm `install:first_launch` contract: B has **no hosted denominator
or hosted launch-conversion estimate**. A provides hosted visit users; D reports
`playground:opened`, `playground:first_edit` and hosted `craft:first_edit`
separately with definition coverage. Those marginal counts are not an ordered
hosted conversion rate. Playground and Studio first edits must never be pooled
into B. An attempt started before the first edit remains outside B even when
its success is after the edit; an unedited sample export does not activate it.
Unresolved/failed attempts remain in the started-user denominator; repeated
attempts by one ID do not inflate any user stage.

## C. Next-week return to an observed edit v1

For each complete week W and surface/population, the denominator is distinct
IDs with at least one numeric-v1 first-edit event in W, whether new or existing.
The numerator is those same IDs with such an event in the immediately following
KST week W+1. W+2 alone is not a next-week return. The whole interval
`[W, W + 14 days)` must be observable after the relevant rollouts. Right-edge
immature cohorts are **omitted from both numerator and denominator**, not
reported as nonreturners. A user can enter several weekly cohorts; do not sum
weekly denominators and call the sum unique people.

Local Studio, hosted Studio and hosted Playground are separate rows. Matching
requires the same population/surface and exact ID; there is no hosted-to-local
or Playground-to-Studio identity bridge. Week ordering makes the return
strictly later than the cohort edit. The metric remains mount-limited as
explained above, even when the same person keeps editing a sample.

```sql
WITH
    toDateTime64('2026-08-01 00:00:00', 3, 'UTC') AS observation_start_utc,
    toDateTime64('2026-09-13 15:00:00', 3, 'UTC') AS observation_end_utc,
    toDateTime64('2026-08-01 00:00:00', 3, 'UTC') AS runtime_deployed_utc,
    toDateTime64('2026-08-01 00:00:00', 3, 'UTC') AS edit_v1_deployed_utc,
    toDateTime64('2026-08-02 15:00:00', 3, 'UTC') AS cohort_start_utc,
    toDateTime64('2026-09-13 15:00:00', 3, 'UTC') AS cohort_end_utc,
    edit_events AS (
        SELECT distinct_id,
            if(properties.distribution = 'npm', 'local_studio',
                if(event = 'craft:first_edit', 'hosted_studio', 'hosted_playground')) AS population,
            toStartOfWeek(toTimeZone(timestamp, 'Asia/Seoul'), 1) AS week_start_kst
        FROM events
        WHERE timestamp >= observation_start_utc
          AND timestamp < observation_end_utc
          AND JSONExtractRaw(properties, 'internal_qa') != 'true'
          AND JSONExtractRaw(properties, 'definition_version') = '1'
          AND (
              (event = 'craft:first_edit' AND properties.distribution = 'npm'
               AND properties.origin_kind = 'local')
              OR (event IN ('craft:first_edit', 'playground:first_edit')
                  AND properties.distribution = 'hosted' AND properties.origin_kind = 'hosted')
          )
    ), edit_weeks AS (
        SELECT DISTINCT population, distinct_id, week_start_kst,
            toDateTime64(toString(week_start_kst), 3, 'Asia/Seoul') AS week_at
        FROM edit_events
    ), cohort AS (
        SELECT * FROM edit_weeks
        WHERE week_at >= observation_start_utc
          AND week_at >= runtime_deployed_utc
          AND week_at >= edit_v1_deployed_utc
          AND week_at >= cohort_start_utc
          AND week_at + INTERVAL 7 DAY <= cohort_end_utc
          AND week_at + INTERVAL 14 DAY <= observation_end_utc
    ), returners AS (
        SELECT DISTINCT c.population, c.distinct_id, c.week_start_kst
        FROM cohort AS c
        INNER JOIN edit_weeks AS n ON n.distinct_id = c.distinct_id
            AND n.population = c.population
        WHERE n.week_at = c.week_at + INTERVAL 7 DAY
    ), stages AS (
        SELECT population, distinct_id, week_start_kst, 'cohort' AS stage FROM cohort
        UNION ALL
        SELECT population, distinct_id, week_start_kst, 'return' AS stage FROM returners
    )
SELECT
    population, week_start_kst,
    countIf(stage = 'cohort') AS eligible_edit_v1_users,
    countIf(stage = 'return') AS next_week_edit_v1_users,
    round(100.0 * countIf(stage = 'return')
        / nullIf(countIf(stage = 'cohort'), 0), 2) AS next_week_return_to_edit_pct
FROM stages
GROUP BY population, week_start_kst
ORDER BY week_start_kst, population
```

## D. Coverage, explicit exclusions and definition/deployment versions

Run D over the **same observation bounds**, including partial/deployment weeks
and immature weeks: it diagnoses coverage, not conversion. Unlike A-C it keeps
internal-marked rows to show their excluded sample size;
`qa_marker_json = 'true'` identifies the excluded rows. Empty raw JSON means
that the key is missing; `null` is explicit JSON null; quoted `"1"` is a string
version and unquoted `1` is numeric v1. Raw values are
kept separate so an alias or cast cannot merge missing/invalid/versioned data.
`event_deliveries` includes repeated deliveries, whereas `distinct_ids` is exact
within the displayed cell. **Do not sum cell-level distinct counts** to obtain
a cross-version/week/event user count; A-C perform their own deduplication.

```sql
WITH
    toDateTime64('2026-08-01 00:00:00', 3, 'UTC') AS observation_start_utc,
    toDateTime64('2026-09-13 15:00:00', 3, 'UTC') AS observation_end_utc,
    toDateTime64('2026-08-01 00:00:00', 3, 'UTC') AS runtime_deployed_utc,
    toDateTime64('2026-08-01 00:00:00', 3, 'UTC') AS edit_v1_deployed_utc,
    toDateTime64('2026-08-01 00:00:00', 3, 'UTC') AS export_deployed_utc,
    coverage_events AS (
        SELECT distinct_id, event,
            toStartOfWeek(toTimeZone(timestamp, 'Asia/Seoul'), 1) AS week_start_kst,
            if(timestamp < runtime_deployed_utc, 'pre_runtime', 'post_runtime') AS runtime_era,
            if(timestamp < edit_v1_deployed_utc, 'pre_edit_v1', 'post_edit_v1') AS edit_era,
            if(timestamp < export_deployed_utc, 'pre_export', 'post_export') AS export_era,
            JSONExtractRaw(properties, 'distribution') AS distribution_json,
            JSONExtractRaw(properties, 'origin_kind') AS origin_kind_json,
            JSONExtractRaw(properties, 'install_kind') AS install_kind_json,
            JSONExtractRaw(properties, 'app_version') AS app_version_json,
            JSONExtractRaw(properties, 'internal_qa') AS qa_marker_json,
            JSONExtractRaw(properties, 'definition_version') AS definition_version_json,
            JSONExtractRaw(properties, 'export_kind') AS export_kind_json,
            JSONExtractRaw(properties, 'format') AS format_json,
            JSONExtractRaw(properties, 'surface') AS surface_json,
            if(match(properties.attempt_id, '^[0-9a-f]{32}$'), 'valid', 'missing_or_invalid') AS attempt_id_coverage
        FROM events
        WHERE timestamp >= observation_start_utc
          AND timestamp < observation_end_utc
          AND event IN (
              '$pageview', 'app:session_started', 'app:session_ended', 'install:first_launch',
              'project:opened', 'scene:loaded', 'playground:opened',
              'craft:first_edit', 'playground:first_edit',
              'craft:first_action', 'playground:first_action',
              'export:attempt_started', 'export:attempt_succeeded',
              'export:attempt_failed', 'export:attempt_cancelled',
              'export:video_succeeded', 'export:blocking_frame_succeeded', 'export:keyframe_pack'
          )
    )
SELECT
    c.week_start_kst, c.event, c.runtime_era, c.edit_era, c.export_era,
    c.distribution_json, c.origin_kind_json, c.install_kind_json, c.app_version_json,
    c.qa_marker_json, c.definition_version_json, c.export_kind_json,
    c.format_json, c.surface_json, c.attempt_id_coverage,
    count() AS event_deliveries, uniqExact(c.distinct_id) AS distinct_ids
FROM coverage_events AS c
GROUP BY
    c.week_start_kst, c.event, c.runtime_era, c.edit_era, c.export_era,
    c.distribution_json, c.origin_kind_json, c.install_kind_json, c.app_version_json,
    c.qa_marker_json, c.definition_version_json, c.export_kind_json,
    c.format_json, c.surface_json, c.attempt_id_coverage
ORDER BY c.week_start_kst, c.event, c.app_version_json, c.qa_marker_json
```

Inspect these gaps before comparing weeks:

- Runtime dimensions on regular events vs `app:session_ended`; older beacons
  may lack `distribution`/`app_version`. Missing `install_kind` is expected for
  hosted, but a local schema gap. A does not use beacons to repair missing starts.
- Numeric v1 vs missing, quoted-string or other versions on **each** first-edit
  surface. Definition absence on a pageview/export is expected, not a failed
  first-edit contract. Never substitute legacy first-action events for edits.
- Lifecycle presence by `app_version`, kind, format, surface and valid attempt
  ID. Legacy-only success coverage is missing lifecycle coverage, not extra
  success. Missing terminals, mismatched IDs/metadata and terminal conflicts
  need separate delivery investigation using #272's diagnostic approach with
  the same external filter and fixed bounds; B's funnel alone is not a count
  of all orphan/conflicting attempts.
- Absent QA markers are **included**, but their historical internal-vs-external
  composition is unknowable. A missing marker is not proof of an external human.
  Hosted `$pageview`, `playground:opened`, hosted Studio edits and Playground
  edits have different scopes; native PostHog sessions and App mounts differ.
- First-launch marking occurs when the CLI serves the first app HTML; delivery
  can still be blocked or the tab closed before capture. Older IDs, opt-out,
  DNT, SDK initialization races and lost events can make first-launch or edit
  coverage incomplete. The marker never enables disabled telemetry. Entirely
  unobserved users cannot be estimated from these queries.

## Rerunnable baseline procedure

1. Record the PostHog project/environment and execution UTC timestamp, query
   definition `issue270-cohorts-v1`, and the repository commit containing this
   document. Record exact observation/cohort bounds in UTC **and** their KST
   dates. The illustrative observation cutoff is `2026-09-13 15:00:00 UTC` =
   `2026-09-14 00:00:00 KST`; it is not a measured baseline.
2. Replace every block's constants with the same actual observation boundaries
   and the applicable deployment timestamps. Record npm/hosted release versions,
   deployment commit SHAs and rollout times for runtime #270, first edit #269
   (numeric definition 1), and export lifecycle #272 (event contract, no invented
   `definition_version` on export events). Query B begins after **all three**
   boundaries; A after runtime; C after runtime and first edit. Record the data
   retention/history floor because B scans first launches and attempt history
   before `observation_start_utc`. Do not bound that history scan to the cohort
   for speed: doing so relabels old users/attempts as new.
3. Run D read-only and retain its result with A-C. Report included false/missing
   marker deliveries and distinct-ID cells separately from excluded boolean-true
   cells, runtime dimension gaps, observed `app_version` values, first-edit
   version coverage, and lifecycle/legacy-only coverage. Distinguish "not
   applicable", "no eligible denominator", "not instrumented/not observed" and
   an observed zero. If a metric lacks coverage, publish that gap rather than a
   synthetic rate. Release timestamps alone do not demonstrate client coverage.
4. Run A, B and C unchanged except for the documented constants. Preserve SQL
   text and result CSVs in the analysis record (not new production dashboards).
   For **every reported rate**, publish its integer numerator and denominator,
   KST cohort Monday/Sunday, observation cutoff, definition and deployment
   versions. A: active IDs and 2+-day IDs; B: launch, edit, after-edit-start and
   after-edit-success IDs; C: eligible edit IDs and next-week edit IDs. Report
   hosted coverage separately; no hosted install denominator exists. List weeks
   omitted for deployment/partial observation or immature conversion/retention.
5. State whether queries were actually executed, the sample sizes returned, and
   any query/result limit or truncation. This change supplies definitions only:
   **production baseline dates, deployment versions and sample sizes are not
   measured here**. Use `not run`/`unavailable`, never fabricated zeros. No
   production credentials or dashboard mutation is necessary to review the SQL.
6. Re-run the saved SQL at the same event-time cutoff to reproduce the analysis;
   record ingestion lag/backfills, retention deletion and changed source data
   that can alter results despite fixed event-time boundaries. Freeze exported
   results for exact historical comparisons; the event store is not an immutable
   snapshot. Compare equivalent complete, mature weeks only, and carry small
   sample sizes and coverage caveats into any product decision.

## Representative fixture expectations (not production results)

These scenarios specify query behavior for the executable fixture owned by the
analytics change; this document does not claim that prose is an executed test.

| Scenario | Expected result |
| --- | --- |
| Boolean `internal_qa: true` on otherwise qualifying local or hosted events | Excluded from every A-C step; visible as excluded coverage in D. |
| Boolean false or missing marker on `http://localhost:5250` / `127.0.0.1` events with npm/local dimensions | Included; hostname, country, clone label and port cannot turn them into internal traffic. |
| One stable ID on two ports, with repeated deliveries and several sessions on one KST day | One A user and one active day; each B stage counts the ID at most once. A second observed active day makes exactly one 2+-day user. |
| Two unrelated IDs with identical browser/device/IP characteristics | Two users, no identity merge. A hosted ID is not joined to a local ID. |
| `2026-08-02 14:59:59 UTC` then `2026-08-02 15:00:00 UTC` | Sunday Aug 2 KST then Monday Aug 3 KST: different weeks/days. The latter starts the example cohort. An event exactly at the observation cutoff is excluded. |
| A rollout midweek, or an observation cutoff midweek | The partial week is coverage-only, not an A-C cohort. |
| With the example cutoff, an edit in the KST week beginning Sep 7 | Its Sep 14-20 return week is unobserved, so no C denominator. The Aug 31 cohort is mature; an edit during Sep 7-13 is its next-week return. Sep 7 launch weeks are also immature in B. |
| An old launch before the cohort plus a duplicate launch inside it | Not a new B user; the history minimum remains before the cohort. |
| CLI telemetry off, then on, after a recorded first launch | New anonymous ID can count in A/C, but the retained receipt prevents another `install:first_launch`; it is absent from B's launch denominator. |
| A numeric-v1 edit before launch, followed by a numeric-v1 edit after launch | B selects the first **eligible after-launch** edit. A prelaunch-only edit cannot convert. String `"1"`, missing version, v2 and legacy first actions never count as v1. |
| Success without a start, equal/reversed timestamps, wrong ID/surface/kind/format, or legacy-only video success | No B video conversion. A start before edit stays outside the funnel even if success follows edit. |
| One paired video attempt after edit succeeds, alongside duplicate deliveries/another successful attempt | One video-success user, not multiple successes. A failed/cancelled terminal on the same matched attempt makes that attempt ineligible; another clean ordered attempt may still convert the user. |
| A failed, cancelled or unresolved video attempt after edit, with no clean success | In B's started-user denominator, not its successful-user numerator. |
| Automatic starter or hosted sample load; project/scene switch; stored-handle restore with no authored edit | No B first-edit conversion or C return-to-edit; neither `project:opened` nor `scene:loaded` proves own-project reopen. A genuine launch/pageview may still count as A presence. |
| A cohort edit, followed only by a sample reload next week and an actual edit in W+2 | Not a next-week return. Only a numeric-v1 edit from the same exact ID and surface in W+1 qualifies. |
| Continued editing across midnight/week boundaries without a fresh App mount | May produce no new first-edit event: explicitly documented edit-retention coverage limit, not inferred nonuse. |

# Workflow, Agent and MCP execution outcomes

Issue #274 separates requested execution, control-plane completion and observed
application. The cut-over is the first deployed build containing this contract.
Historical `feature:used(mcp_connected)` is a connection signal, not work.

## Execution event contract

| Event | Exact properties |
| --- | --- |
| `workflow:run_requested` | `surface`, `run_id`, `node_count_bucket` |
| `workflow:run_succeeded` | `run_id`, `duration_bucket` |
| `workflow:run_failed`, `workflow:run_cancelled` | `run_id`, `duration_bucket`, `failure_code` |
| `workflow:result_applied` | `run_id` |
| `agent:turn_requested` | `surface`, `turn_id` |
| `agent:tool_executed` | `turn_id`, `tool_category`, `outcome`, `duration_bucket` |
| `agent:turn_succeeded` | `turn_id`, `duration_bucket` |
| `agent:turn_failed`, `agent:turn_cancelled` | `turn_id`, `duration_bucket`, `failure_code` |
| `agent:result_applied` | `turn_id` |
| `mcp:tool_requested` | `request_id`, `tool_category` |
| `mcp:tool_executed` | `request_id`, `tool_category`, `outcome`, `duration_bucket` |
| `mcp:result_applied` | `request_id` |

- IDs are fresh 128-bit secure random values, encoded as 32 lowercase hex
  characters. They are held only for the execution, never persisted in scene,
  graph history or localStorage, and never derived from content or installation,
  session, model call, task or live command IDs. Missing randomness omits telemetry.
- Workflow `surface`: `workflow`. Agent `surface`: `studio` or `workflow`.
- `node_count_bucket`: `0`, `1-3`, `4-10`, `gte11`, for the evaluated graph.
- `duration_bucket`: `lt1s`, `1-3s`, `3-10s`, `10-30s`, `gte30s`, using the
  existing `bucketMs` boundaries. Runs/turns measure from request, tools from
  execution start. No raw duration reaches analytics.
- Workflow `failure_code`: `aborted`, `capture_failed`, `generation_failed`,
  `unknown` (including missing node input). Agent: `aborted`, `auth`,
  `rate_limited`, `tool_failed`, `upstream`, `key_refused`, `stale_scene`,
  `capability_missing`, `busy`, `invalid_request`, `unknown`. Never raw error
  prose.
- New Agent codes, split out of `upstream` and `auth` in the analytics hygiene
  release (split by `app_version`; older rows keep the coarse code):
  - `key_refused`: the model provider rejected the key or credentials
    (provider `unauthorized`, including a message-only 401/403).
  - `auth` now means only the local sidecar: no sign-in (`AUTH_REQUIRED`) or a
    refused session, or a bare 401/403 without a code.
  - `stale_scene`: `STALE_SCENE`, `STALE_TARGET` or `STALE_ENVIRONMENT` (the
    scene changed underneath the turn).
  - `capability_missing`: `CAPABILITY_MISSING` (Studio runtime absent, live hub
    port in use) or `LIVE_HUB_UNAVAILABLE` (no connected editor).
  - `busy`: a turn is already running, or `TARGET_BUSY`, `SCOPE_BUSY`,
    `TARGET_NOT_READY`.
  - `invalid_request`: `INVALID_*`, HTTP 400, or another 4xx refusal such as
    409 `AMBIGUOUS_TARGET`.
  - `upstream` keeps provider overload, 5xx, network and unclassified errors.
  Source tables: `src/workflow/agent-failure-codes.js` and
  `bin/agent/agent-failure-codes.mjs` (kept identical by
  `test/verify-agent-execution.mjs`).
- Agent `tool_category`: `workflow_read`, `workflow_write`, `workflow_run`,
  `frame_capture`, `image_generate`, `scene_write`, `other`.
- MCP `tool_category`: `read`, `camera`, `scene_write`, `prompt_authoring`,
  `frame_capture`, `motion_generate`, `motion_apply`, `project_io`, `other`.
- Agent tool `outcome`: `succeeded`, `failed`, `cancelled`. MCP also permits
  `uncertain` when editor acknowledgement/verification cannot establish an
  outcome. Uncertainty is not an ordinary failure or confirmed application.

The Run button, node run callbacks and Agent canvas run share the Workflow
runner. Scene-only capture uses its own single-node run. Captured frames and
generated images/videos written to canvas nodes emit at most one
`workflow:result_applied` per run. Empty or text-only evaluation does not claim
image/video application. Passive Motion Input document synchronization is not
proof that a Studio decoder applied motion. A partial output can be applied
before a later node fails. Overlapping runs do not cancel earlier work; only an
actual abort is classified as cancellation. No new cancel UI is added.

Agent requests are owned by the browser turn boundary so HTTP refusal and an
explicit Stop are observable. A stream ending without a confirmed terminal is
not success. Model retries within the same turn keep that turn; a user retry
starts a new ID. Applied output needs an acknowledged editor change, not a
successful read, focus or text response. Several applied tools contribute at
most one application per turn.
The current Agent application receipt covers inserted canvas/reference nodes and
new connections. Summarized update/removal responses and potentially stale
`run_workflow` outputs do not establish a new application; those paths remain
unobserved by the Agent application counter. Workflow's own output receipt is
separate and must not be copied into the Agent count.

MCP reports only into the selected connected editor through sanitized live
frames; the browser revalidates, deduplicates and calls the existing analytics
and opt-out gate. There is no server analytics client. Memory-only sessions,
ambiguous/stale workspace routing and disconnected stages are unobserved, not
zero use. Reconnecting never replays execution telemetry. `generate_motion`
can complete by queuing work; application requires a later acknowledged
installation.
Same-value mutations and rolled-back batches do not count as applied. A
partially applied failed batch can have a failed execution and an application.
State comparisons stay inside the local hub; if a handler has no prior
description, one best-effort baseline read supplies no-op evidence. A missing
baseline omits application instead of blocking the real mutation.

Semantic edit, export and motion lifecycle hooks remain the owners of those
signals. Execution adapters never emit parallel first-edit, export or generation
events. One Agent turn can call a Workflow run: those are nested execution units,
not two independent user intentions. Do not sum channels or add their applied
observations to first-edit/export/motion counts.

## Seven-day requested, completed and applied execution by channel

This HogQL query creates one row per channel and correlation ID, deduplicates
stage deliveries and requires ordered stages. Applications are independent of
completion: a failed run may have partial output. A channel without an observed
request has no demand denominator.

```sql
WITH stages AS (
    SELECT
        multiIf(startsWith(event, 'workflow:'), 'workflow',
            startsWith(event, 'agent:'), 'agent', 'mcp') AS channel,
        multiIf(startsWith(event, 'workflow:'), toString(properties.run_id),
            startsWith(event, 'agent:'), toString(properties.turn_id),
            toString(properties.request_id)) AS execution_id,
        timestamp,
        event IN ('workflow:run_requested', 'agent:turn_requested',
            'mcp:tool_requested') AS requested,
        event IN ('workflow:run_succeeded', 'agent:turn_succeeded')
            OR (event = 'mcp:tool_executed' AND properties.outcome = 'succeeded') AS succeeded,
        event IN ('workflow:run_failed', 'agent:turn_failed')
            OR (event = 'mcp:tool_executed' AND properties.outcome = 'failed') AS failed,
        event IN ('workflow:run_cancelled', 'agent:turn_cancelled')
            OR (event = 'mcp:tool_executed' AND properties.outcome = 'cancelled') AS cancelled,
        event = 'mcp:tool_executed' AND properties.outcome = 'uncertain' AS uncertain,
        event IN ('workflow:result_applied', 'agent:result_applied',
            'mcp:result_applied') AS applied
    FROM events
    WHERE timestamp >= now() - INTERVAL 7 DAY AND timestamp < now()
      AND JSONExtractRaw(properties, 'internal_qa') != 'true'
      AND event IN (
          'workflow:run_requested', 'workflow:run_succeeded',
          'workflow:run_failed', 'workflow:run_cancelled', 'workflow:result_applied',
          'agent:turn_requested', 'agent:turn_succeeded',
          'agent:turn_failed', 'agent:turn_cancelled', 'agent:result_applied',
          'mcp:tool_requested', 'mcp:tool_executed', 'mcp:result_applied'
      )
), per_execution AS (
    SELECT channel, execution_id,
        countIf(requested) AS requests,
        minIf(timestamp, requested) AS requested_at,
        max(succeeded) AS succeeded, max(failed) AS failed,
        max(cancelled) AS cancelled, max(uncertain) AS uncertain,
        minIf(timestamp, succeeded OR failed OR cancelled OR uncertain) AS terminal_at,
        max(applied) AS applied, minIf(timestamp, applied) AS applied_at
    FROM stages
    WHERE match(execution_id, '^[a-f0-9]{32}$')
    GROUP BY channel, execution_id
), outcomes AS (
    SELECT *, succeeded + failed + cancelled + uncertain AS terminal_kinds
    FROM per_execution
)
SELECT channel,
    countIf(requests > 0) AS attempted_executions,
    countIf(requests > 0 AND terminal_kinds = 1 AND terminal_at >= requested_at) AS completed_executions,
    countIf(requests > 0 AND terminal_kinds = 0) AS unresolved_executions,
    countIf(requests > 0 AND terminal_kinds = 1 AND succeeded = 1 AND terminal_at >= requested_at) AS succeeded_executions,
    countIf(requests > 0 AND terminal_kinds = 1 AND failed = 1 AND terminal_at >= requested_at) AS failed_executions,
    countIf(requests > 0 AND terminal_kinds = 1 AND cancelled = 1 AND terminal_at >= requested_at) AS cancelled_executions,
    countIf(requests > 0 AND terminal_kinds = 1 AND uncertain = 1 AND terminal_at >= requested_at) AS uncertain_executions,
    countIf(requests > 0 AND applied = 1 AND applied_at >= requested_at) AS executions_with_applied_output,
    countIf(requests > 0 AND succeeded = 1 AND terminal_kinds = 1 AND applied = 0) AS succeeded_without_observed_application,
    countIf(requests = 0) AS orphan_executions,
    countIf(terminal_kinds > 1) AS conflicting_outcomes,
    countIf(requests > 0 AND ((terminal_kinds > 0 AND terminal_at < requested_at)
        OR (applied = 1 AND applied_at < requested_at))) AS out_of_order
FROM outcomes
GROUP BY channel
ORDER BY channel
```

Use a fixed request interval ending before observation time for settled cohorts,
retaining subsequent stages through that observation time. Missing terminals or
applications include opt-out, interruption, tab closure and unsupported
observation paths, never an inferred failed mutation. Orphans can have starts
before the query window. Conflicting and out-of-order groups are telemetry-quality
diagnostics, not additional successes.

For Agent tool reliability, group `agent:tool_executed` by `tool_category` and
`outcome`, counting event UUIDs rather than distinct turn IDs: one turn may
execute several tools in the same category. Browser wire deduplication suppresses
repeat frames without collapsing separate tool invocations. Tool counts are not
Agent turn demand. For MCP category reliability, include requested `tool_category`
in `per_execution`; retain the request-ID cohort so missing terminal frames are
not silently excluded from the denominator.

This query applies #270's type-exact internal-QA exclusion to every source event.
Do not infer traffic or channel use from prompts, responses, arguments, labels,
paths or graph contents. Browser QA intercepts the SDK locally; these are
documented HogQL queries, not claimed live PostHog results.

# Builder telemetry (issue #466)

Seven questions a CozyClay builder asks every week, and the event that answers
each one. Weeks are Monday to Sunday in Asia/Seoul; PostHog stores UTC, so bound
with `toDateTime('…', 'Asia/Seoul')`. Split `distribution` (npm vs hosted) in
every table, and exclude `internal_qa = true` with `JSONExtractRaw(properties, 'internal_qa') != 'true'`. Only versions that ship this
contract report it: before that release the new events are **unknown, not 0**.

| Question | Event |
| --- | --- |
| Do people use bone-level pose control? | `feature:used` `name = 'pose_edit'` (a real pose change) and `app:session_ended.pose_edit_bucket` |
| Where does it break? | `app:error` (type, source, bundle file + line/column) |
| Can their machine run it? | `device:profile` (GPU vendor/class, WebGL, CPU/memory, frame-rate bucket) |
| Where did the install come from? | `install:first_launch.heard_from` (`site`, `playground` from `--via`) |
| What are they making, with whom? | `survey:use_case` (`use_case`, `team`) |
| Are they on the newest release? | `update_status` on every npm event |

## Definition changes

- `feature:used name = 'pose_edit'` meant **a pose saved to the library** before
  this release. From this release it means a real pose change through the
  semantic boundary, and library saves are `pose_save`. Split by `app_version`;
  never add the two eras together.
- `action_count_bucket` no longer counts passive signals (`motion:backend_state`,
  `app:error`, `device:profile`). Earlier npm sessions always counted at least
  one action from `motion:backend_state`, so their `1-3` bucket includes
  sessions with no user action.
- Edit gestures: repeated edits of the same group less than one second apart
  (a bone drag, a gizmo move) count once.

## Pose editing vs everything else (per session)

`app:session_ended` is a beacon without `$host`; split with `distribution`.

```sql
SELECT
    properties.distribution AS distribution,
    count() AS sessions,
    countIf(properties.pose_edit_bucket != '0') AS pose_sessions,
    countIf(properties.camera_edit_bucket != '0') AS camera_sessions,
    countIf(properties.object_edit_bucket != '0') AS object_sessions,
    countIf(properties.shot_edit_bucket != '0') AS shot_sessions,
    countIf(properties.pose_edit_bucket IN ('4-10', 'gte11')) AS heavy_pose_sessions
FROM events
WHERE event = 'app:session_ended'
  AND properties.pose_edit_bucket IS NOT NULL
  AND JSONExtractRaw(properties, 'internal_qa') != 'true'
  AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY distribution
```

## Top errors

`error_file`/`error_line`/`error_col` point into the release's minified bundle;
map them with a sourcemap build of the same `app_version`.

```sql
SELECT
    properties.app_version AS version,
    properties.error_type AS type,
    properties.error_source AS source,
    properties.error_file AS file,
    properties.error_line AS line,
    properties.error_col AS col,
    count() AS events,
    uniq(distinct_id) AS people
FROM events
WHERE event = 'app:error'
  AND JSONExtractRaw(properties, 'internal_qa') != 'true'
  AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY version, type, source, file, line, col
ORDER BY people DESC, events DESC
LIMIT 20
```

## Machines

```sql
SELECT
    properties.distribution AS distribution,
    properties.gpu_vendor AS gpu,
    properties.gpu_class AS class,
    properties.frame_rate_bucket AS fps,
    uniq(distinct_id) AS people
FROM events
WHERE event = 'device:profile'
  AND JSONExtractRaw(properties, 'internal_qa') != 'true'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY distribution, gpu, class, fps
ORDER BY people DESC
```

## Install source, use case and update status

```sql
-- Install source: blank means the prompt was skipped and no --via was given.
SELECT coalesce(properties.heard_from, '(blank)') AS source, uniq(distinct_id) AS installs
FROM events
WHERE event = 'install:first_launch' AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY source ORDER BY installs DESC;

-- Use case x team, answered after a successful export.
SELECT properties.use_case AS use_case, properties.team AS team, uniq(distinct_id) AS people
FROM events
WHERE event = 'survey:use_case' AND JSONExtractRaw(properties, 'internal_qa') != 'true'
GROUP BY use_case, team ORDER BY people DESC;

-- Share of npm users on the newest release in the last 7 days.
SELECT properties.update_status AS status, properties.app_version AS version, uniq(distinct_id) AS people
FROM events
WHERE event = 'app:session_started' AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY status, version ORDER BY people DESC;
```

# Session friction summary

`app:friction_summary` is one passive event per session, sent by the same
end-of-session beacon as `app:session_ended` and validated by the same
sanitizer (`src/analytics-friction.js`, `src/analytics.js`). It never moves
`action_count_bucket`. Builds before this release have no row: the summary is
**unknown, not 0**. Exclude `internal_qa = true` with
`JSONExtractRaw(properties, 'internal_qa') != 'true'`.

## Event contract

| Property | Values | Source |
| --- | --- | --- |
| `active_time` | `lt1m`, `1-5m`, `5-15m`, `15-30m`, `gte30m` | The session duration bucket, identical to `app:session_ended.duration_bucket` |
| `refusals_ui`, `refusals_agent` | count bucket | Every refused command-bus run, by origin (`ui`, everything else). A cancel the caller asked for (`CANCELLED`) is not counted |
| `undos` | count bucket | Successful `edit.undo` runs from the UI. Agent undos and no-op undos are not counted |
| `errors` | count bucket | Every reported window error and unhandled rejection, including repeats that `app:error`'s 10-signature dedupe does not send |
| `long_tasks`, `long_task_max` | count bucket; `lt50`, `50-150`, `150-500`, `500-2000`, `gte2000` ms | `PerformanceObserver` `longtask` entries. Where the browser does not report long tasks (feature-detected), the values stay `0` / `lt50`: **unsupported, not smooth** |
| `late_tick_ratio` | `0`, `lt5`, `5-20`, `20-50`, `gte50` % | Reserved for the playback detector; `0` until it ships |
| `rage_clicks`, `dead_clicks`, `shortcut_ignored`, `search_empty`, `nav_thrash`, `camera_thrash` | count bucket | Reserved; `0` until their detectors ship |

Count bucket: `0`, `1`, `2`, `3`, `4-5`, `6-10`, `gte11`. A detector with
its own event emits it only up to that event's per-session cap and then only
counts here, so `app:friction_summary` is the uncapped total.

Unload delivery is best effort: a crashed or killed tab sends neither end
event. Compare summaries with `app:session_ended` from the same build, not
with every `app:session_started`.

## 5.10 Session friction by active time (7 days)

```sql
SELECT
    properties.active_time AS active_time,
    count() AS sessions,
    countIf(properties.refusals_ui != '0') AS with_ui_refusal,
    countIf(properties.refusals_agent != '0') AS with_agent_refusal,
    countIf(properties.undos != '0') AS with_undo,
    countIf(properties.errors != '0') AS with_error,
    countIf(properties.long_tasks != '0') AS with_long_task,
    countIf(properties.long_task_max IN ('500-2000', 'gte2000')) AS with_task_over_500ms
FROM events
WHERE event = 'app:friction_summary'
  AND JSONExtractRaw(properties, 'internal_qa') != 'true'
  AND timestamp >= now() - INTERVAL 7 DAY
GROUP BY active_time
ORDER BY indexOf(['lt1m', '1-5m', '5-15m', '15-30m', 'gte30m'], active_time)
```

Read counts beside each share: at about 120 sessions in 90 days a row can
hold a handful of sessions. A bucket is a range, so sum sessions, never the
bucket labels.

# Storyboard and capsule-figure events (issue #653)

Counts only. None of these events carries a caption, a panel or character name,
an id, a prompt, an image or a position (`DENIED_PROPERTY_KEYS` and the closed
value sets in `sanitizeProps` drop anything else).

## Event contract

| Event | Properties | Meaning |
| --- | --- | --- |
| `scene:created` | `scene_source`, `previs_mode` | `previs_mode` is `storyboard` or `animation`; absent on events from before modes existed |
| `storyboard:panel_created` | `source` | `agent` (Studio Agent, MCP or any non-UI command) or `manual` (Board `+ Panel`, timeline add in a storyboard project) |
| `storyboard:panel_stylized` | `outcome` | `ok` (the stylized picture is stored on the panel) or `error` (renderer not ready, entitlement or network refusal, storage failure) |
| `cast:proxy_added` | `surface` | `assets` (Capsule figure tile), `agent` (Studio Agent or another non-UI command) or `mcp` (`add_character` live tool) |

## Panels per source and stylize success rate (7 days)

Events carrying the explicit `internal_qa` boolean marker are excluded the same
way the external cohort queries do.

```sql
SELECT
    event,
    coalesce(nullIf(properties.source, ''), properties.outcome) AS value,
    count() AS events,
    count(DISTINCT distinct_id) AS users
FROM events
WHERE event IN ('storyboard:panel_created', 'storyboard:panel_stylized')
  AND timestamp >= now() - INTERVAL 7 DAY
  AND JSONExtractRaw(properties, 'internal_qa') != 'true'
GROUP BY event, value
ORDER BY event, value
```

## Capsule figures by surface, and new projects by mode (7 days)

```sql
SELECT
    event,
    if(event = 'cast:proxy_added', properties.surface, properties.previs_mode) AS value,
    count() AS events
FROM events
WHERE event IN ('cast:proxy_added', 'scene:created')
  AND timestamp >= now() - INTERVAL 7 DAY
  AND JSONExtractRaw(properties, 'internal_qa') != 'true'
GROUP BY event, value
ORDER BY event, value
```

An empty `value` on `scene:created` is a scene made before project modes
existed (builds older than the Storyboard/Animation release). Undo and redo never emit a second event.
