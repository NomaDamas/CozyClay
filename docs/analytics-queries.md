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

# Motion generation intent

Issue #273 introduces the explicit-request contract dated **September 15, 2026**.
The cut-over is the first deployed build containing #273, not every build with
the same package version or every event received after that date.
`motion:generate_blocked` is deprecated and no longer emitted by these builds:
its historical meaning mixed prompt-block authoring with generation attempts.
Never relabel it as `motion:generate_requested`, add it to a new demand count,
or infer a request from an old uncorrelated `motion:job_*` event.

## Motion event contract

| Event | Exact properties | Trigger |
| --- | --- | --- |
| `motion:backend_state` | `backend`, `host_configured` | Existing session capability baseline; not a request |
| `motion:generate_requested` | `surface`, `input_mode`, `request_id` | One explicit generation request |
| `motion:preflight_blocked` | `reason`, `surface`, `request_id` | Request readiness refused |
| `motion:preflight_passed` | `backend`, `surface`, `request_id` | Readiness accepted, before queue execution |
| `motion:job_started` | `backend`, `input_mode`, `request_id` | Execution starts, not merely queued |
| `motion:job_succeeded` | `backend`, `duration_bucket`, `input_mode`, `request_id` | Generation completes, before delivery |
| `motion:job_failed` | `backend`, `duration_bucket`, `input_mode`, `error_code`, `request_id` | Generation fails or is actually aborted |
| `motion:result_applied` | `request_id`, `backend` | Generated motion is applied to the requesting character |

- `request_id`: 128 secure random bits encoded as 32 lowercase hexadecimal
  characters, fresh per request and held only by that request. No persistence,
  prompt/content hash, installation ID, live command ID, host or credential.
- `surface`: `timeline` (main Generate and its programmatic entry point),
  `line_edit` (explicit line-edit generation), `trail` (trail regeneration),
  `mcp` (the separate server-side `generate_motion` tool).
  It describes the initiating generation path, not the selected character.
- `input_mode`: `prompt`, `pose`, `edit`.
- `backend`: `none`, `local_kimodo`, `hosted`; `host_configured` is a boolean.
  The session baseline retains its existing meaning and is not a preflight.
- `reason`: `unconfigured` (no configured backend is known), `unreachable`
  (backend health cannot be reached/accepted), `unsupported_route` (the
  selected request is outside the advertised route capabilities). Classification
  uses structured state, not host addresses or raw error prose.
- `error_code`: `aborted` (actual `AbortError` or an aborted MCP job/controller), `unsupported_route`
  (a generation route refusal), `generation_failed` (other generation errors),
  `unknown` (otherwise unclassified). Cancellation is
  `motion:job_failed {error_code: "aborted"}`, not an additional event.
- `duration_bucket`: elapsed job execution time, excluding queue time:
  `lt1s`, `1-3s`, `3-10s`, `10-30s`, `gte30s`, using the same `bucketMs`
  boundaries as the export contract.

Prompt-block add/edit, live `set_prompt_blocks`, navigation and automatic
line-preview drafts do not emit explicit demand. Explicit line-edit confirmation
starts its own full-quality request through `runLineEdit`; automatic draft
round trips are not part of this explicit-request cohort.
The main Generate, line-edit and trail entry points own their request through
their shared queue and result delivery. Calls through `window.__cozyclay` use
the same path, including `runArdy` and `trailRegenerate`.

MCP `generate_motion` has a separate server-side execution path. It creates the
same lifecycle before refreshing the selected editor, probes readiness before
the generation POST, and records job success once the returned motion URL is
validated. `motion:result_applied` is emitted only after that editor acknowledges
`load_motion`. A rejected or uncertain installation leaves job success without
application. The server sends only sanitized `motion_telemetry` payloads to the
target workspace; `src/live-control.js` validates the event name and properties,
deduplicates each `(request_id, event)` and uses the browser's existing
analytics/opt-out gate. No second server-side PostHog client is added.

Reusing an existing `motion_url` or issuing `load_motion` directly is
installation, not a fresh generation request. Live `set_prompt_blocks` remains
authoring, not demand. With no connected editor, `generate_motion` retains its
existing refusal and no browser telemetry is available. Disconnected lifecycle
events are omitted, not reconstructed on reconnect; a later acknowledged
application may therefore appear as an orphan outside the request cohort.

There is at most one preflight outcome, one job start, one job terminal outcome
and one result application per request. Duplicate/late callbacks cannot advance
the state again. A decode, delivery or stale-result failure after job success
does not retroactively fail the job or invent an application. Missing result
URLs, removed targets, cancellation and discarded results are not successful
applications. Analytics/clock/randomness failures must not change generation;
without a secure request ID the lifecycle is omitted.

No cancellation is inferred from a closed tab or missing event. Reloads, queue
abandonment, opt-out and delivery loss can leave unresolved requests or orphan
downstream events. An accepted preflight is not evidence that a job started,
and a job success is not evidence that its result reached the scene.

## Seven-day explicit-request funnel

This HogQL query forms **one row per request_id**, then requires each ordered
stage. It cannot count repeated callbacks or duplicate event deliveries as
extra requests. The cohort requires `motion:generate_requested`; historical
ambiguous events and uncorrelated legacy job events are excluded, even if
received after the cut-over. Timestamps may be equal for synchronous stages.

```sql
WITH per_request AS (
    SELECT
        properties.request_id AS request_id,
        minIf(properties.surface, event = 'motion:generate_requested') AS surface,
        minIf(properties.input_mode, event = 'motion:generate_requested') AS input_mode,
        countIf(event = 'motion:generate_requested') AS request_deliveries,
        minIf(timestamp, event = 'motion:generate_requested') AS requested_at,
        max(event = 'motion:preflight_passed') AS passed,
        max(event = 'motion:preflight_blocked') AS blocked,
        minIf(timestamp, event = 'motion:preflight_passed') AS passed_at,
        minIf(timestamp, event = 'motion:preflight_blocked') AS blocked_at,
        max(event = 'motion:job_started') AS job_started,
        minIf(timestamp, event = 'motion:job_started') AS started_at,
        max(event = 'motion:job_succeeded') AS succeeded,
        minIf(timestamp, event = 'motion:job_succeeded') AS succeeded_at,
        max(event = 'motion:job_failed') AS failed,
        minIf(timestamp, event = 'motion:job_failed') AS failed_at,
        max(event = 'motion:job_failed' AND properties.error_code = 'aborted') AS aborted,
        max(event = 'motion:result_applied') AS applied,
        minIf(timestamp, event = 'motion:result_applied') AS applied_at
    FROM events
    WHERE timestamp >= greatest(now() - INTERVAL 7 DAY, toDateTime('2026-09-15 00:00:00'))
      AND timestamp < now()
      AND event IN (
          'motion:generate_requested',
          'motion:preflight_blocked', 'motion:preflight_passed',
          'motion:job_started', 'motion:job_succeeded', 'motion:job_failed',
          'motion:result_applied'
      )
      AND match(toString(properties.request_id), '^[a-f0-9]{32}$')
    GROUP BY request_id
), cohort AS (
    SELECT *,
        passed = 1 AND blocked = 0 AND passed_at >= requested_at AS accepted,
        blocked = 1 AND passed = 0 AND blocked_at >= requested_at AS refused
    FROM per_request
    WHERE request_deliveries > 0
), execution AS (
    SELECT *, accepted AND job_started = 1 AND started_at >= passed_at AS started
    FROM cohort
), outcomes AS (
    SELECT *,
        started AND succeeded = 1 AND failed = 0 AND succeeded_at >= started_at AS generated,
        started AND failed = 1 AND succeeded = 0 AND failed_at >= started_at AS job_failed
    FROM execution
)
SELECT
    surface,
    input_mode,
    count() AS explicit_requests,
    countIf(refused) AS preflight_blocked,
    countIf(accepted) AS preflight_passed,
    countIf(started) AS jobs_started,
    countIf(generated) AS jobs_succeeded,
    countIf(job_failed AND aborted = 0) AS jobs_failed,
    countIf(job_failed AND aborted = 1) AS jobs_cancelled,
    countIf(generated AND applied = 1 AND applied_at >= succeeded_at) AS results_applied,
    countIf(passed = 0 AND blocked = 0) AS unresolved_preflight,
    countIf(accepted AND job_started = 0) AS accepted_not_started,
    countIf(started AND succeeded = 0 AND failed = 0) AS unresolved_jobs,
    countIf(generated AND applied = 0) AS succeeded_without_application,
    countIf((passed = 1 AND blocked = 1) OR (succeeded = 1 AND failed = 1)) AS conflicting_outcomes,
    round(100.0 * countIf(generated AND applied = 1 AND applied_at >= succeeded_at)
        / nullIf(count(), 0), 2) AS request_to_application_pct
FROM outcomes
GROUP BY surface, input_mode
ORDER BY surface, input_mode
```

For a settled cohort, select request starts in a fixed interval and retain
downstream observations through a later observation time. Do not label
`accepted_not_started`, `unresolved_jobs` or `succeeded_without_application`
as failures without separate evidence. Reuse `per_request` to inspect IDs with
`request_deliveries = 0` as orphans, not new demand. Contradictory outcomes and
out-of-order events should be investigated rather than added to conversions.
Apply the eventual explicit internal-QA exclusion from #270 consistently to
all source events; do not infer it from request IDs or user content.

Browser QA uses an isolated profile, mocked health and an in-memory SDK at
the real sanitizer/capture boundary. It sends no production telemetry and
does not prove production ingestion. With no backend the existing UI may
disable Generate; QA reports that limitation and exercises the supported
programmatic Generate path instead of enabling a disabled button.

# Camera tutorial steps and time to first shot

Issue #271 instruments the existing seven-step tutorials, not a new editing
definition. Keep Studio and the hosted landing-page Playground separate.
`feature:used {name: "camera_tutorial"}` remains a legacy feature counter;
do not add it to the attempt count.

## Version 1 event contract

| Event | Exact properties |
| --- | --- |
| `tutorial:started` | `surface`, `tutorial_version`, `start_source` |
| `tutorial:step_entered` | `surface`, `tutorial_version`, `step_kind` |
| `tutorial:step_completed` | `surface`, `tutorial_version`, `step_kind`, `elapsed_bucket` |
| `tutorial:completed` | `surface`, `tutorial_version`, `elapsed_bucket` |
| `tutorial:dismissed` | `surface`, `tutorial_version`, `step_kind` |

- `surface`: `studio` or `playground`. Playground means the actual landing
  host and its embedded editor, not a Workflow embed.
- `tutorial_version`: numeric `1`, never the string `"1"`.
- `start_source`: `query` (Studio's `?tutorial=camera` entry), `settings`
  (Studio's Settings/window-event entry), or `landing` (Playground's Start
  button). Unknown Studio event sources normalize to `settings`.
- `step_kind`: `fly`, `walk`, `dolly`, `orbit`, `shot`, `rail`, `play`.
- `elapsed_bucket`: `bucketMs` values `lt1s` (<1 s), `1-3s` ([1, 3) s),
  `3-10s` ([3, 10) s), `10-30s` ([10, 30) s), `gte30s` (>=30 s).
  Step completion measures from that step's entry; tutorial completion
  measures from attempt start. No raw elapsed duration is sent.

Each explicit start creates a new in-memory attempt, including a restart
while Studio's tutorial is already open. Rerenders and resuming the same
mounted page keep the attempt and its deduplication state. Closing an
unfinished tutorial emits one explicit dismissal at its current step;
closing a completed tutorial does not. Reload starts fresh when the tutorial
is opened again. No attempt identifier or progress is persisted or sent.
Leaving a page, a reload, or losing delivery does not fabricate dismissal.

Completion follows each surface's existing rules. Studio's `play` step
completes when look-through is entered after a rail exists. Playground's
`play` step uses the editor's existing playback signal; a rail stroke can
automatically enter preview and start that playback before a separate Play
click. Neither proves that the viewer watched a whole shot or that an export
succeeded. In this section
**first shot** means this existing `play` milestone, not merely adding a shot.
The two surfaces must not be pooled as if their playback boundaries matched.

Repeated gestures, held keys, rail callbacks and render effects cannot emit
a second completion for a kind in the same attempt. Existing out-of-order
interaction is retained: a kind completed before it becomes the current hint
gets an entry immediately before its completion, so its duration can be
`lt1s`. It does not imply the visitor read that hint. Analytics initialization
may finish after interaction; pending tutorial events retain their order and
client-computed buckets. Opted-out activity is not backfilled.

## Entered, completed, missing completion and elapsed buckets

Run in PostHog SQL/HogQL. Attempt numbers below are **query-local**, inferred
from `tutorial:started` within the SDK's existing identity/session/window
boundaries; they are not an extra collected property. An attempt with no
observed start is excluded instead of joined to a previous visit.

```sql
WITH numbered AS (
    SELECT
        distinct_id,
        properties.$session_id AS session_id,
        properties.$window_id AS window_id,
        properties.surface AS surface,
        properties.tutorial_version AS tutorial_version,
        properties.step_kind AS step_kind,
        properties.elapsed_bucket AS elapsed_bucket,
        event,
        timestamp,
        sum(if(event = 'tutorial:started', 1, 0)) OVER (
            PARTITION BY distinct_id, properties.$session_id,
                properties.$window_id, properties.surface,
                properties.tutorial_version
            ORDER BY timestamp, if(event = 'tutorial:started', 0, 1), uuid
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS attempt_number
    FROM events
    WHERE timestamp >= now() - INTERVAL 7 DAY
      AND timestamp < now()
      AND properties.tutorial_version = 1
      AND properties.surface IN ('studio', 'playground')
      AND notEmpty(properties.$session_id)
      AND notEmpty(properties.$window_id)
      AND event IN (
          'tutorial:started', 'tutorial:step_entered',
          'tutorial:step_completed', 'tutorial:completed',
          'tutorial:dismissed'
      )
), per_step AS (
    SELECT
        distinct_id, session_id, window_id, surface, tutorial_version,
        attempt_number, step_kind,
        max(event = 'tutorial:step_entered') AS entered,
        max(event = 'tutorial:step_completed') AS completed,
        argMinIf(elapsed_bucket, timestamp,
            event = 'tutorial:step_completed') AS completion_bucket
    FROM numbered
    WHERE attempt_number > 0
      AND event IN ('tutorial:step_entered', 'tutorial:step_completed')
    GROUP BY distinct_id, session_id, window_id, surface,
        tutorial_version, attempt_number, step_kind
)
SELECT
    surface, tutorial_version, step_kind,
    countIf(entered = 1) AS entered_attempts,
    countIf(entered = 1 AND completed = 1) AS completed_attempts,
    countIf(entered = 1 AND completed = 0) AS entered_without_completion,
    countIf(entered = 0 AND completed = 1) AS orphan_completions,
    countIf(completed = 1 AND completion_bucket = 'lt1s') AS elapsed_lt1s,
    countIf(completed = 1 AND completion_bucket = '1-3s') AS elapsed_1_3s,
    countIf(completed = 1 AND completion_bucket = '3-10s') AS elapsed_3_10s,
    countIf(completed = 1 AND completion_bucket = '10-30s') AS elapsed_10_30s,
    countIf(completed = 1 AND completion_bucket = 'gte30s') AS elapsed_gte30s
FROM per_step
GROUP BY surface, tutorial_version, step_kind
ORDER BY surface, tutorial_version,
    indexOf(['fly', 'walk', 'dolly', 'orbit', 'shot', 'rail', 'play'], step_kind)
```

`entered_without_completion` is the abandonment diagnostic, not a guaranteed
browser-close count. It includes in-progress attempts, opt-out and lost
telemetry. For settled cohorts, use fixed start bounds ending before the
observation time and retain later completion events through that observation
time. A completion that entered out of order is still a completed step.

Window IDs keep separate tabs apart. Missing SDK IDs, session rotation,
duplicate delivery of a start, or multiple restarts at the same timestamp
limit inferred pairing; report these as telemetry-quality exclusions rather
than inventing a stable user or attempt identifier. Do not replace missing
window IDs with one shared empty bucket. SDK event timestamps order events,
not the bucket boundaries.

## Time to first shot

Use the same `numbered` CTE from the preceding query and replace `per_step`
and its final `SELECT` with the following. This measures observed
start-to-`play` completion per attempt, including out-of-order completion;
attempts that never reach `play` remain in the denominator.

```sql
, per_attempt AS (
    SELECT
        distinct_id, session_id, window_id, surface, tutorial_version,
        attempt_number,
        minIf(timestamp, event = 'tutorial:started') AS started_at,
        countIf(event = 'tutorial:started') AS starts,
        minIf(timestamp, event = 'tutorial:step_completed'
            AND step_kind = 'play') AS first_shot_at,
        countIf(event = 'tutorial:step_completed'
            AND step_kind = 'play') AS first_shots,
        max(event = 'tutorial:completed') AS all_steps_completed,
        argMinIf(elapsed_bucket, timestamp,
            event = 'tutorial:completed') AS total_client_bucket
    FROM numbered
    WHERE attempt_number > 0
    GROUP BY distinct_id, session_id, window_id, surface,
        tutorial_version, attempt_number
), timed AS (
    SELECT *,
        if(first_shots = 0, 'not_reached',
            multiIf(
                dateDiff('millisecond', started_at, first_shot_at) < 1000, 'lt1s',
                dateDiff('millisecond', started_at, first_shot_at) < 3000, '1-3s',
                dateDiff('millisecond', started_at, first_shot_at) < 10000, '3-10s',
                dateDiff('millisecond', started_at, first_shot_at) < 30000, '10-30s',
                'gte30s'
            )) AS observed_time_to_first_shot
    FROM per_attempt
    WHERE starts = 1
)
SELECT
    surface, tutorial_version, observed_time_to_first_shot,
    count() AS attempts,
    countIf(all_steps_completed = 1) AS completed_tutorials,
    groupArrayIf(total_client_bucket,
        all_steps_completed = 1) AS completed_tutorial_client_buckets
FROM timed
GROUP BY surface, tutorial_version, observed_time_to_first_shot
ORDER BY surface, tutorial_version, observed_time_to_first_shot
```

This is timestamp-based observed latency. A delayed SDK initialization can
compress the time between captured events; inspect the client-computed
`tutorial:completed.elapsed_bucket` alongside it. That total bucket measures
the complete attempt even when initialization was late, but equals time to
first shot only when `play` was the final completed step. Do not use
`step_completed(play).elapsed_bucket` as start-to-shot time: it measures only
time spent on the play step. Neither query turns a bucket into a precise
duration or claims live PostHog delivery.

## Relating playback to first edit and export

Use a separate same-session analysis rather than emitting first-edit or
export events from the tutorial:

1. Cohort on `tutorial:started`, `tutorial_version = 1`, with `surface`
   split and `start_source` as the entry breakdown.
2. Identify `tutorial:step_completed {step_kind: "play"}` for the observed
   first-shot milestone above.
3. Join the session's existing `craft:first_edit` (Studio) or
   `playground:first_edit` (Playground), filtered to numeric
   `definition_version = 1`. The first edit may precede playback: Add shot
   or authoring a rail is editing, but looking around and the seeded City
   Block/walk take are not. Do not require playback before the first edit.
4. Count existing `export:attempt_succeeded` after both first edit and the
   play milestone, using the export section's `attempt_id` deduplication.
   Match Studio to export `surface = 'studio'`; any direct embedded export
   has `surface = 'embed'`, not `playground`. Playground's project-download
   button is not a frame/video/keyframe-pack export lifecycle success.
   Do not sum legacy export success events with lifecycle successes.

The following executable query counts **sessions**, not attempts: restarts
within a session share its earliest tutorial start and first play milestone.
First edit must occur after that first start, but may precede playback.
`start_source` is the first tutorial entry in the session. Keep the
attempt-level queries above for restart and step-abandonment analysis.

```sql
WITH tutorial_sessions AS (
    SELECT
        distinct_id,
        properties.$session_id AS session_id,
        properties.surface AS surface,
        properties.tutorial_version AS tutorial_version,
        minIf(timestamp, event = 'tutorial:started') AS started_at,
        argMinIf(properties.start_source, timestamp,
            event = 'tutorial:started') AS start_source,
        minIf(timestamp, event = 'tutorial:step_completed'
            AND properties.step_kind = 'play') AS first_shot_at,
        countIf(event = 'tutorial:step_completed'
            AND properties.step_kind = 'play') AS first_shots
    FROM events
    WHERE timestamp >= now() - INTERVAL 7 DAY
      AND timestamp < now()
      AND properties.tutorial_version = 1
      AND properties.surface IN ('studio', 'playground')
      AND notEmpty(properties.$session_id)
      AND event IN ('tutorial:started', 'tutorial:step_completed')
    GROUP BY distinct_id, session_id, surface, tutorial_version
    HAVING countIf(event = 'tutorial:started') > 0
), edited_sessions AS (
    SELECT
        t.distinct_id, t.session_id, t.surface, t.tutorial_version,
        min(e.timestamp) AS edited_at,
        1 AS has_edit
    FROM tutorial_sessions AS t
    INNER JOIN events AS e
        ON e.distinct_id = t.distinct_id
       AND e.properties.$session_id = t.session_id
    WHERE e.properties.definition_version = 1
      AND ((t.surface = 'studio' AND e.event = 'craft:first_edit')
        OR (t.surface = 'playground' AND e.event = 'playground:first_edit'))
      AND e.timestamp >= t.started_at
      AND e.timestamp < now()
    GROUP BY t.distinct_id, t.session_id, t.surface, t.tutorial_version
), exported_sessions AS (
    SELECT
        t.distinct_id, t.session_id, t.surface, t.tutorial_version,
        uniqExact(e.properties.attempt_id) AS successful_exports
    FROM tutorial_sessions AS t
    INNER JOIN edited_sessions AS d
        ON d.distinct_id = t.distinct_id AND d.session_id = t.session_id
       AND d.surface = t.surface AND d.tutorial_version = t.tutorial_version
    INNER JOIN events AS e
        ON e.distinct_id = t.distinct_id
       AND e.properties.$session_id = t.session_id
    WHERE t.first_shots > 0 AND t.first_shot_at >= t.started_at
      AND e.event = 'export:attempt_succeeded'
      AND notEmpty(e.properties.attempt_id)
      AND ((t.surface = 'studio' AND e.properties.surface = 'studio')
        OR (t.surface = 'playground' AND e.properties.surface = 'embed'))
      AND e.timestamp >= t.first_shot_at
      AND e.timestamp >= d.edited_at
      AND e.timestamp < now()
    GROUP BY t.distinct_id, t.session_id, t.surface, t.tutorial_version
)
SELECT
    t.surface, t.tutorial_version, t.start_source,
    count() AS tutorial_sessions,
    countIf(t.first_shots > 0 AND t.first_shot_at >= t.started_at) AS played_sessions,
    countIf(d.has_edit = 1) AS edited_sessions_v1,
    countIf(d.has_edit = 1 AND t.first_shots > 0
        AND t.first_shot_at >= t.started_at) AS edited_and_played_sessions,
    countIf(x.successful_exports > 0) AS exported_after_edit_and_play_sessions
FROM tutorial_sessions AS t
LEFT JOIN edited_sessions AS d
    ON d.distinct_id = t.distinct_id AND d.session_id = t.session_id
   AND d.surface = t.surface AND d.tutorial_version = t.tutorial_version
LEFT JOIN exported_sessions AS x
    ON x.distinct_id = t.distinct_id AND x.session_id = t.session_id
   AND x.surface = t.surface AND x.tutorial_version = t.tutorial_version
GROUP BY t.surface, t.tutorial_version, t.start_source
ORDER BY t.surface, t.tutorial_version, t.start_source
```

The landing host and its editor iframe have different window IDs, so this
join uses the SDK's existing `distinct_id` and `$session_id`, not the host's
window ID. Same-session association is not proof of causality or a cross-tab
authoring link. A session without the required versioned edit or successful
export stays unmatched; loading a sample never fills the gap. An editor that
already emitted its mount-scoped first edit before the tutorial started is
not a new first-edit conversion here. Do not interpret that exclusion as
evidence that the editor made no later changes.

Apply issue #270's explicit internal-QA exclusion consistently once its
contract is available. Never infer internal traffic from scene names, URLs
or camera gestures. These queries are documented SQL, not results claimed
from a production PostHog run.

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
  `null`, then emits `scene:loaded` with `scene_source` `starter`, `launch`, or
  `tutorial`. The launch effect handles `?scene=...`; `startCameraTutorial`
  opens the bundled City Block through the same path. Thus automatic/sample
  loading can emit `project:opened`; its age falls back to the current time.
  Neither a young nor an old `age_bucket` proves an own-project reopen.
- `openScene` emits `scene:loaded {scene_source: 'local'}` even for a starter
  passed through `applyProject`. Scene selection, creation, duplication and
  replacement can also use it. A starter can produce **two** scene-loaded
  events (`local`, then its starter/launch/tutorial source); do not subtract
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
| Automatic starter/tutorial or hosted sample load; project/scene switch; stored-handle restore with no authored edit | No B first-edit conversion or C return-to-edit; neither `project:opened` nor `scene:loaded` proves own-project reopen. A genuine launch/pageview may still count as A presence. |
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
  `rate_limited`, `tool_failed`, `upstream`, `unknown`. Never raw error prose.
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
can complete by queuing work: its shared `motion:*` events still describe
generation, and application requires a later acknowledged installation.
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

# First-shot play to export attempt cohort comparison

Issue #275 reuses ordinary `export:attempt_started`; there is no handoff-click,
handoff-exposure or tutorial-attributed export event. This read-only HogQL
comparison measures **first observed numeric-v1 tutorial play -> an ordinary
export start within seven elapsed days**, not export success, completed video
viewing, lifetime first shot, or the causal effect of the new prompt. The
existing Studio look-through-after-rail and Playground playback milestones
remain different. No production query, sample size or significance result is
claimed here; production results are **not run / unavailable**, not zero.

## Comparison population and boundaries

- Apply #270's population, identity and time contract above to every source
  event: exclude only raw JSON boolean `internal_qa: true`; include false,
  missing and unexpected marker types. Never infer internal traffic from
  localhost, ports, geography, names or gestures. Numeric version 1 is
  `JSONExtractRaw(..., 'tutorial_version') = '1'`, and the optional first-edit
  check uses the same type-exact rule for `definition_version`.
- Report **Studio / npm-local** and **Playground / hosted** independently.
  Match export surfaces `studio` and `embed`, respectively; exclude Workflow
  and hosted Studio from this comparison. A user is one exact `distinct_id`
  within that population/surface, not a person, tab, session or attempt.
  CLI-state resets, separate devices/state files and hosted browser identities
  remain separate. There is no hosted-to-npm identity bridge, even if someone
  downloads a project and later opens it locally.
- Take each ID/surface's first eligible v1 play over **all retained external
  history before the cutoff**, before filtering to the observation, release
  or before/after windows. A repeated play/restart in the after period cannot
  re-enroll a before-period ID. Record the retained-history floor: truncated
  history and earlier unmarked/undelivered activity prevent lifetime claims.
  This is a cohort of observed players, not all new users or tutorial starters;
  navigation-only users outside it are not evidence of inactivity.
- Replace every illustrative UTC constant below with recorded release and
  observation boundaries. Before/after bounds are Monday 00:00 KST (Sunday
  15:00 UTC), exclusive at the right edge, with equal numbers of complete
  weeks. Runtime #270, tutorial #271, first-edit #269 and export #272 must all
  cover both periods; use the latest applicable schema rollout across these
  two populations. If no comparable pre-handoff telemetry exists, report
  **no measurable before cohort**, not a reconstructed baseline.
- `handoff_rollout_start_utc` is the earliest #275 deployment on either
  surface; `handoff_rollout_end_utc` is the latest completed rollout. Before
  weeks' entire seven-day follow-up must end by the former; after weeks must
  begin at or after the latter. This drops the transition and crossover weeks.
  Require each whole cohort week plus seven days to fit before the fixed
  observation cutoff. This is elapsed-time maturity, not proof of delivery.
  An old npm client is not upgraded by a calendar boundary: inspect version
  coverage and record the actual releases before interpreting calendar eras.

## Ordered user cohort query

The full player denominator retains IDs whose first play lacks usable SDK
context. `linkable_play_users` reports the subset with nonempty session/window
IDs and only one context at that earliest timestamp; ambiguous simultaneous
first plays are excluded from linking, not replaced by a later convenient
play. Studio joins require the same ID, session **and window**, keeping other
tabs out. Playground uses the same exact hosted ID/session but cannot require
the host's window ID on its iframe's edit/export events. Its explicitly named
`same_session_cross_window` result is a session association, potentially across
tabs, **not** a proven host/iframe pair. Do not pool it with Studio or infer
missing IDs. The schema has no parent-window or tutorial-attempt join key.

The primary numerator does not require a first-edit event: it answers play to
start directly. Separate columns show numeric-v1 edit evidence strictly before
play in that same context and conversion among that subset. The edit may
precede tutorial start; a mount emits it only once. Neither missing evidence
nor sample seeding is relabeled as an edit. No tutorial attempt is inferred:
restarts in a session can contribute to the association, and a start may be
missing. Use #271's step/attempt diagnostics for that different denominator.

Repeated start deliveries reduce to the earliest start in retained history
per `(population, distinct_id, attempt_id, export_surface)`. Inconsistent
session/window/kind/format metadata excludes that attempt from linking.
All four ordinary lifecycle kinds are eligible with their declared formats;
there is no special handoff kind. Starts must be strictly later than play and
strictly before play + seven days. Failed, cancelled and unresolved attempts
still count as starts. Terminal-only and legacy-success events do not count.

```sql
WITH
    toDateTime64('2026-07-01 00:00:00', 3, 'UTC') AS observation_start_utc,
    toDateTime64('2026-09-06 15:00:00', 3, 'UTC') AS observation_end_utc,
    toDateTime64('2026-07-01 00:00:00', 3, 'UTC') AS runtime_deployed_utc,
    toDateTime64('2026-07-01 00:00:00', 3, 'UTC') AS tutorial_v1_deployed_utc,
    toDateTime64('2026-07-01 00:00:00', 3, 'UTC') AS edit_v1_deployed_utc,
    toDateTime64('2026-07-01 00:00:00', 3, 'UTC') AS export_deployed_utc,
    toDateTime64('2026-08-20 00:00:00', 3, 'UTC') AS handoff_rollout_start_utc,
    toDateTime64('2026-08-21 00:00:00', 3, 'UTC') AS handoff_rollout_end_utc,
    toDateTime64('2026-08-02 15:00:00', 3, 'UTC') AS before_start_utc,
    toDateTime64('2026-08-09 15:00:00', 3, 'UTC') AS before_end_utc,
    toDateTime64('2026-08-23 15:00:00', 3, 'UTC') AS after_start_utc,
    toDateTime64('2026-08-30 15:00:00', 3, 'UTC') AS after_end_utc,
    external_history AS (
        SELECT distinct_id, timestamp, event, properties,
            if(properties.distribution = 'npm', 'npm_local', 'hosted') AS population
        FROM events
        WHERE timestamp < observation_end_utc
          AND notEmpty(distinct_id)
          AND JSONExtractRaw(properties, 'internal_qa') != 'true'
          AND ((properties.distribution = 'npm' AND properties.origin_kind = 'local')
            OR (properties.distribution = 'hosted' AND properties.origin_kind = 'hosted'))
          AND event IN ('tutorial:step_completed', 'craft:first_edit',
              'playground:first_edit', 'export:attempt_started')
    ), play_events AS (
        SELECT distinct_id, population, timestamp,
            properties.surface AS tutorial_surface,
            properties.$session_id AS session_id,
            properties.$window_id AS window_id
        FROM external_history
        WHERE event = 'tutorial:step_completed' AND properties.step_kind = 'play'
          AND JSONExtractRaw(properties, 'tutorial_version') = '1'
          AND ((population = 'npm_local' AND properties.surface = 'studio')
            OR (population = 'hosted' AND properties.surface = 'playground'))
    ), first_play_history AS (
        SELECT distinct_id, population, tutorial_surface, min(timestamp) AS played_at
        FROM play_events
        GROUP BY distinct_id, population, tutorial_surface
    ), first_plays AS (
        SELECT p.distinct_id, p.population, p.tutorial_surface, p.played_at,
            min(e.session_id) AS session_id, min(e.window_id) AS window_id,
            uniqExact(tuple(e.session_id, e.window_id)) AS first_play_contexts,
            toStartOfWeek(toTimeZone(p.played_at, 'Asia/Seoul'), 1) AS week_start_kst
        FROM first_play_history AS p
        INNER JOIN play_events AS e ON e.distinct_id = p.distinct_id
            AND e.population = p.population AND e.tutorial_surface = p.tutorial_surface
            AND e.timestamp = p.played_at
        GROUP BY p.distinct_id, p.population, p.tutorial_surface, p.played_at
    ), dated AS (
        SELECT *, toDateTime64(toString(week_start_kst), 3, 'Asia/Seoul') AS week_at
        FROM first_plays
    ), cohort AS (
        SELECT *, if(week_at < before_end_utc, 'before', 'after') AS period
        FROM dated
        WHERE week_at >= greatest(observation_start_utc, runtime_deployed_utc,
                tutorial_v1_deployed_utc, edit_v1_deployed_utc, export_deployed_utc)
          AND week_at + INTERVAL 14 DAY <= observation_end_utc
          AND (
              (week_at >= before_start_utc AND week_at + INTERVAL 7 DAY <= before_end_utc
               AND week_at + INTERVAL 14 DAY <= handoff_rollout_start_utc)
              OR (week_at >= after_start_utc AND week_at + INTERVAL 7 DAY <= after_end_utc
                  AND week_at >= handoff_rollout_end_utc)
          )
    ), linkable AS (
        SELECT * FROM cohort
        WHERE first_play_contexts = 1 AND notEmpty(session_id) AND notEmpty(window_id)
    ), edited AS (
        SELECT DISTINCT p.distinct_id, p.population, p.tutorial_surface, p.period
        FROM linkable AS p
        INNER JOIN external_history AS e ON e.distinct_id = p.distinct_id
            AND e.population = p.population AND e.properties.$session_id = p.session_id
        WHERE JSONExtractRaw(e.properties, 'definition_version') = '1'
          AND e.timestamp >= greatest(observation_start_utc, edit_v1_deployed_utc,
                runtime_deployed_utc)
          AND e.timestamp < p.played_at
          AND ((p.tutorial_surface = 'studio' AND e.event = 'craft:first_edit'
                AND e.properties.$window_id = p.window_id)
            OR (p.tutorial_surface = 'playground' AND e.event = 'playground:first_edit'
                AND notEmpty(e.properties.$window_id)))
    ), start_history AS (
        SELECT distinct_id, population, properties.attempt_id AS attempt_id,
            properties.surface AS export_surface, min(timestamp) AS started_at,
            min(properties.$session_id) AS session_id,
            min(properties.$window_id) AS window_id,
            min(properties.export_kind) AS export_kind,
            min(properties.format) AS format,
            uniqExact(tuple(properties.$session_id, properties.$window_id,
                properties.export_kind, properties.format)) AS metadata_variants
        FROM external_history
        WHERE event = 'export:attempt_started'
          AND match(properties.attempt_id, '^[0-9a-f]{32}$')
          AND ((population = 'npm_local' AND properties.surface = 'studio')
            OR (population = 'hosted' AND properties.surface = 'embed'))
        GROUP BY distinct_id, population, properties.attempt_id, properties.surface
    ), starts AS (
        SELECT * FROM start_history
        WHERE metadata_variants = 1 AND notEmpty(session_id) AND notEmpty(window_id)
          AND ((export_kind IN ('video', 'depth_video') AND format = 'mp4')
            OR (export_kind = 'frame' AND format = 'png')
            OR (export_kind = 'keyframe_pack' AND format = 'zip'))
    ), converted AS (
        SELECT DISTINCT p.distinct_id, p.population, p.tutorial_surface, p.period
        FROM linkable AS p
        INNER JOIN starts AS s ON s.distinct_id = p.distinct_id
            AND s.population = p.population AND s.session_id = p.session_id
        WHERE s.started_at > p.played_at
          AND s.started_at < p.played_at + INTERVAL 7 DAY
          AND ((p.tutorial_surface = 'studio' AND s.export_surface = 'studio'
                AND s.window_id = p.window_id)
            OR (p.tutorial_surface = 'playground' AND s.export_surface = 'embed'))
    ), edited_converted AS (
        SELECT c.distinct_id, c.population, c.tutorial_surface, c.period
        FROM converted AS c
        INNER JOIN edited AS d ON d.distinct_id = c.distinct_id
            AND d.population = c.population AND d.tutorial_surface = c.tutorial_surface
            AND d.period = c.period
    ), stages AS (
        SELECT distinct_id, population, tutorial_surface, period, 'play' AS stage FROM cohort
        UNION ALL
        SELECT distinct_id, population, tutorial_surface, period, 'linkable' AS stage FROM linkable
        UNION ALL
        SELECT distinct_id, population, tutorial_surface, period, 'edit_v1' AS stage FROM edited
        UNION ALL
        SELECT distinct_id, population, tutorial_surface, period, 'export_start' AS stage FROM converted
        UNION ALL
        SELECT distinct_id, population, tutorial_surface, period, 'edited_export_start' AS stage FROM edited_converted
    )
SELECT
    population, tutorial_surface, period,
    if(tutorial_surface = 'studio', 'same_session_same_window',
        'same_session_cross_window') AS association_scope,
    if(period = 'before', before_start_utc, after_start_utc) AS cohort_start_utc,
    if(period = 'before', before_end_utc, after_end_utc) AS cohort_end_utc,
    observation_end_utc AS observed_until_utc,
    countIf(stage = 'play') AS first_observed_play_users,
    countIf(stage = 'linkable') AS linkable_play_users,
    countIf(stage = 'play') - countIf(stage = 'linkable') AS unlinked_context_play_users,
    countIf(stage = 'edit_v1') AS observed_edit_v1_before_play_users,
    countIf(stage = 'export_start') AS export_started_after_play_users,
    countIf(stage = 'edited_export_start') AS export_started_after_edit_and_play_users,
    round(100.0 * countIf(stage = 'export_start')
        / nullIf(countIf(stage = 'play'), 0), 2) AS observed_play_to_start_pct,
    round(100.0 * countIf(stage = 'export_start')
        / nullIf(countIf(stage = 'linkable'), 0), 2) AS linkable_play_to_start_pct,
    round(100.0 * countIf(stage = 'edited_export_start')
        / nullIf(countIf(stage = 'edit_v1'), 0), 2) AS edit_evidenced_play_to_start_pct
FROM stages
GROUP BY population, tutorial_surface, period
ORDER BY population, tutorial_surface, period
```

All stage rows are unique ID/population/surface rows, so retries, duplicate
deliveries and several matching exports cannot inflate the sample sizes.
Only `INNER JOIN` and explicit stage unions are used: unmatched ClickHouse
default rows cannot become conversions. There are no unguarded `minIf` dates
or nullable-right-side counts. The full-denominator rate is observed linked
conversion, not an estimate that unlinked users did not export. The
linkable-only rate is coverage-selected; publish both denominators, not just
the more favorable rate. No eligible player row means no denominator; do not
fill absent before/after rows with synthetic zeros. Publish omitted partial,
transition, pre-schema and immature weeks alongside the selected KST weeks.

## Coverage companion and reporting limits

Run this independent coverage query with the same observation constants.
Unlike the funnel, it retains internal-marked, unclassified and malformed
events to reveal exclusions. Use #270 query D as well for legacy/runtime
coverage. Raw JSON values distinguish booleans and numeric versions from
strings or absence. Missing session/window IDs are shown, never synthesized.
Cell-level unique IDs are not additive across events, versions or weeks.

```sql
WITH
    toDateTime64('2026-07-01 00:00:00', 3, 'UTC') AS observation_start_utc,
    toDateTime64('2026-09-06 15:00:00', 3, 'UTC') AS observation_end_utc
SELECT
    toStartOfWeek(toTimeZone(timestamp, 'Asia/Seoul'), 1) AS week_start_kst,
    event,
    JSONExtractRaw(properties, 'distribution') AS distribution_json,
    JSONExtractRaw(properties, 'origin_kind') AS origin_kind_json,
    JSONExtractRaw(properties, 'app_version') AS app_version_json,
    JSONExtractRaw(properties, 'internal_qa') AS qa_marker_json,
    JSONExtractRaw(properties, 'surface') AS surface_json,
    JSONExtractRaw(properties, 'step_kind') AS step_kind_json,
    JSONExtractRaw(properties, 'tutorial_version') AS tutorial_version_json,
    JSONExtractRaw(properties, 'definition_version') AS definition_version_json,
    JSONExtractRaw(properties, 'export_kind') AS export_kind_json,
    JSONExtractRaw(properties, 'format') AS format_json,
    if(notEmpty(distinct_id), 'present', 'missing') AS distinct_id_coverage,
    if(notEmpty(properties.$session_id), 'present', 'missing') AS session_coverage,
    if(notEmpty(properties.$window_id), 'present', 'missing') AS window_coverage,
    if(event = 'export:attempt_started',
        if(match(properties.attempt_id, '^[0-9a-f]{32}$'), 'valid', 'missing_or_invalid'),
        'not_applicable') AS attempt_id_coverage,
    count() AS event_deliveries, uniqExact(distinct_id) AS distinct_ids
FROM events
WHERE timestamp >= observation_start_utc AND timestamp < observation_end_utc
  AND event IN ('tutorial:started', 'tutorial:step_completed',
      'craft:first_edit', 'playground:first_edit', 'export:attempt_started',
      'landing:playground_scene_downloaded')
GROUP BY week_start_kst, event, distribution_json, origin_kind_json,
    app_version_json, qa_marker_json, surface_json, step_kind_json,
    tutorial_version_json, definition_version_json, export_kind_json, format_json,
    distinct_id_coverage, session_coverage, window_coverage, attempt_id_coverage
ORDER BY week_start_kst, event, app_version_json, qa_marker_json
```

- **Project handoff is a separate outcome.** Playground's take-it-with-you
  `.cclayproject` download uses `cozyclay:playground-export` / its result and
  the existing landing event `landing:playground_scene_downloaded`. It is
  **not covered by the export lifecycle**: it has no lifecycle `attempt_id`
  or start, and does not prove local import, video encoding or OS save.
  The exact landing event appears in the coverage query only as a
  supplementary marginal delivery/ID count, never in any conversion stage.
  Its separate `window.posthog` capture must have its own runtime/QA/identity
  coverage checked; missing dimensions do not inherit those of the editor.
  Where hosted video export is unavailable, lifecycle starts do not measure
  the intended project handoff. Report that capability/schema gap rather
  than treating a missing hosted lifecycle numerator as failed handoffs.
- The seven-day horizon is capped by the same observed SDK session (and
  Studio window). A later-session export is outside this metric even within
  seven days. Sessions may span mounts/tabs, and first edits are mount-scoped.
  Duplicate starts, session rotation, equal timestamps, missing context,
  retention, opt-out, DNT, blocking and late SDK capture limit ordered joins.
  A delayed tutorial flush can place play after an actual export or collapse
  timestamps; no client bucket repairs event-time ordering. Entirely unseen
  users and lost events have no estimable denominator here.
- There is no shot/project ID in these events. Even a same-window export
  cannot prove it exported the played shot, preserved its camera/range, or
  came from the contextual prompt rather than the ordinary menu. The query
  does not reproduce UI eligibility for previously exported projects,
  previously completed tutorials or dismissed attempts. User-visible QA
  supplies those behavioral checks, not invented analytics attribution.
- Save query text, project/environment, execution UTC time, repository commit,
  definition `issue275-play-to-start-v1`, actual npm/hosted versions and rollout
  times, retained-history floor, UTC bounds/KST Mondays and Sundays, cutoff,
  result CSVs and any truncation/ingestion lag. For each surface and era report
  every integer sample-size column with its rates and coverage exclusions.
  Preserve fixed-cutoff exports because backfills/deletion can change reruns.
  Compare equal complete mature periods descriptively; traffic mix, rollout
  adoption, small samples and observability can explain a change. This is not
  a randomized A/B test and supplies no significance or causal-lift claim.
