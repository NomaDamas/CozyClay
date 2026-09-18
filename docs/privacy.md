# Analytics and privacy

This is the full disclosure behind the short version on [cozyclay.org/privacy](https://cozyclay.org/privacy/). The queries that consume these events are in [`analytics-queries.md`](analytics-queries.md).

## The hosted site

[cozyclay.org](https://cozyclay.org/) collects anonymous usage analytics via [PostHog](https://posthog.com/) (US Cloud). There are no cookies and no session recording, and Do-Not-Track is respected. A random pseudonymous identifier is kept in your browser's localStorage so that returning visits and retention can be counted; it is never linked to an account or project content and is removed by clearing site data or using the opt-out toggle.

## Events collected

| Event | Purpose |
| --- | --- |
| `install:first_launch` | First run of the official npm package |
| `app:session_started` | Start of an official npm package session |
| `app:session_ended` | Session duration, action count, and scenes touched (bucketed) |
| `feature:used` | One signal per feature per session |
| `$pageview` | Funnel and drop-off analysis |
| `scene:created` | Funnel and drop-off analysis |
| `scene:loaded` | Funnel and drop-off analysis |
| `project:saved` | User-owned project persistence |
| `project:opened` | Return to a saved project (age bucket) |
| `craft:first_action` | Funnel and drop-off analysis |
| `craft:first_edit` | First meaningful Studio edit (`edit_kind`, `definition_version: 1`) |
| `playground:first_edit` | First meaningful Playground edit, separate from the Studio funnel |
| `motion:backend_state` | Motion capability at session start (`none`, `local_kimodo`, or `hosted`) |
| `motion:generate_requested` | Explicit Generate request, never prompt-block authoring |
| `motion:preflight_blocked`, `motion:preflight_passed` | Request readiness outcome before execution |
| `motion:job_started` | Correlated generation execution starts |
| `motion:job_succeeded`, `motion:job_failed` | Generation result, with normalized failure/cancellation codes |
| `motion:result_applied` | Generated result applied to its requesting character, separately from job success |
| `export:blocking_frame_succeeded` | Funnel and drop-off analysis |
| `activation:completed` | Funnel and drop-off analysis |
| `hosted:composer_viewed`, `hosted:login_started`, `hosted:ticket_created` | Hosted demo funnel |
| `hosted:result_opened`, `hosted:opened_in_studio` | Hosted result funnel |

Geo data comes from ingest-time GeoIP country lookup only — no precise location is collected. Prompt text, asset names, file names, project content, local paths, and any user-entered text are never collected.

Motion requests use one ephemeral random `request_id` across intent, preflight,
job outcome and application. The September 15, 2026 issue #273 contract stops
emitting the ambiguous `motion:generate_blocked`; old data is not relabeled or
included in the new demand metric. The exact properties, entry-point mapping
and deduplicated funnel query are in
[`analytics-queries.md`](analytics-queries.md#motion-event-contract).
Browser regression QA:
`QA_URL=http://127.0.0.1:5254/app/ CDP_PORT=9493 node tools/qa-browser.mjs -- node test/qa-motion-intent-browser.mjs`.

## The npm package

The official npm package also measures anonymous first launches, sessions, and
the same in-app funnel on its `127.0.0.1` studio. It stores one random
installation identifier in `~/.config/cozyclay/state.json` so returning use can
be counted across normal CLI restarts, ports and browser storage resets
(`$XDG_CONFIG_HOME/cozyclay/state.json` when configured). The browser SDK uses
memory-only storage bootstrapped from that identifier; it does not generate a
new install identity on each launch. Different state files get independent
random IDs, with no fingerprinting, account linking or cross-device matching.
Do not copy this state file between users. Source checkouts, forks,
development servers, CI, and tests do not send analytics. Official npm
artifacts carry a signature checked by the launcher, so copying or repackaging
the source does not enable telemetry.

Every regular event and the session-end beacon use the same `distribution`
(`npm` or `hosted`), `app_version` (when available),
`origin_kind` (`local` or `hosted`), a coarse
operating-system label, and (for npm sessions) `install_kind` (`npx` or
`global`). Source checkouts are classified as `clone` and remain telemetry-off.
The first npm launch may optionally answer a one-line channel question
(`x`, `hn`, `reddit`, `github`, `friend`, `other`, or `skip`); `skip` sends no
acquisition value. Session duration and action counts are buckets, and project
events never include names, paths, prompts, or timestamps.

## Controls

The npm package prints this disclosure once on first launch. Control it at any
time:

```bash
cclay telemetry status
cclay telemetry off
cclay telemetry on
```

`COZYCLAY_TELEMETRY=0` and `DO_NOT_TRACK=1` disable collection for a launch.
The in-app toggle under **Settings ▾ → Privacy** changes the same npm-package
setting and removes its anonymous installation identifier. Hosted-site visitors can opt out with that
toggle, browser Do-Not-Track, or a content blocker.
Disabling npm telemetry deletes the stored ID; enabling it later creates an
unlinked new ID. The old first-launch receipt is retained, so re-enabling
does not manufacture another new-install event. Environment overrides only
suspend collection and do not erase the stored ID. Neither opt-out path sends
a session-end beacon after collection has been disabled.

PostHog's free plan retains events for 1 year.

## Explicit internal / QA traffic

Internal marking is opt-in and independent of telemetry consent:

```bash
cclay telemetry internal on
cclay telemetry internal off
```

The CLI stores the boolean `internalQa` in the same state file and applies it
on the next launch/reload. On the hosted Studio or Playground, open
`https://cozyclay.org/app/?internal_qa=1` to mark that browser, or use
`?internal_qa=0` to clear the marker. Only an explicit single `1` or `0` is
accepted; the choice persists in `cozyclay.internalQa` localStorage for that
origin. The URL parameter is read by the app, not by a second landing snippet.
The npm app ignores this parameter and uses the CLI choice.

All app captures, including `$pageview` and the end beacon, carry boolean
`internal_qa` (`false` by default). Queries exclude only explicitly marked
events. Localhost, ports, country and source checkout do not identify internal
people; unmarked official local-app traffic stays in the external cohort.
Marking never enables collection on a disabled build, unapproved origin,
source checkout, CI, Do-Not-Track or opted-out session. Existing open tabs must
be reloaded after CLI changes. Historical unmarked QA cannot be inferred or
retroactively removed.

See [the external cohort queries and baseline procedure](analytics-queries.md#population-identity-and-time-contract)
for complete KST weeks, distinct-ID denominators, retention maturity and
coverage limits.

## First-edit definition (version 1)

`craft:first_edit` and `playground:first_edit` carry only `edit_kind` and the
numeric `definition_version: 1`. The closed edit-kind set is `pose_edit`,
`object_insert`, `cutout_insert`, `object_transform`, `shot_add`, `shot_edit`,
`camera_key_record`, `rail_edit`, `prompt_block_add`, and `prompt_block_edit`.
An event requires an actual, successful authoring change through the shared
semantic hook, whether the change came from the UI, `window.__cozyclay`, or
MCP live control. Prompt text and scene values are never event properties.

Deduplication is **per editor session (one App mount), not per install**.
Repeated pointer callbacks, React effects, later edits, undo, and redo cannot
emit another first edit in that mount. A reload or a fresh editor mount starts
a new boundary. Studio and Playground use separate event names and never
contribute to each other's first-edit funnel.

Camera navigation (including look-through fly, orbit, and wheel dolly),
playback/scrubbing, passive scene or project loading, initialization,
restoration, tutorial auto-seeding, failed/no-op commands, and undo/redo do
not qualify. Explicitly recording a camera key or authoring a shot or rail
does qualify; moving a viewing camera alone does not.

The legacy `craft:first_action` / `playground:first_action` streams retain
their existing insertion/camera-key triggers and deduplication unchanged
during migration. Their historical first-launch conversion is not the
percentage of people who edited or used the app. Do not combine those
events with version 1 first-edit events in a conversion numerator.

See [the version-filtered ordered funnel query](analytics-queries.md#first-launch---first-edit---exported-frame)
for a new-install cohort with explicit event ordering and a conversion window.
