# Analytics and privacy

This is the full disclosure behind the short version on [cozyclay.org/privacy](https://cozyclay.org/privacy/). The queries that consume these events are in [`analytics-queries.md`](analytics-queries.md).

## The hosted site

[cozyclay.org](https://cozyclay.org/) collects anonymous usage analytics via [PostHog](https://posthog.com/) (US Cloud). There are no cookies and no session recording, and Do-Not-Track is respected. A random pseudonymous identifier is kept in your browser's localStorage so that returning visits and retention can be counted; it is never linked to an account or project content and is removed by clearing site data or using the opt-out toggle.

## Events collected

| Event | Purpose |
| --- | --- |
| `install:first_launch` | First run of the official npm package |
| `app:session_started` | Start of an official npm package session |
| `app:session_ended` | Session duration, action count and per-group edit gesture counts (`pose`, `camera`, `object`, `shot`, `prompt`), all bucketed; `scenes_touched`, the number of scenes created or loaded, as an exact count capped at 20 (not bucketed); `session_id`, the opaque random session id the PostHog SDK generates, used only to join a session's last events (for example an error right before it ended) |
| `app:friction_summary` | Once per session, next to `app:session_ended`: how much friction the session had, as closed buckets only. `active_time` (the session duration bucket); counts of refusals the Studio gave the user (`refusals_ui`) and the agent (`refusals_agent`), user undos (`undos`), errors (`errors`) and browser long tasks (`long_tasks`), each as `0`, `1`, `2`, `3`, `4-5`, `6-10` or `gte11`; the longest long task (`long_task_max`: `lt50`, `50-150`, `150-500`, `500-2000`, `gte2000` ms); the share of late playback ticks (`late_tick_ratio`: `0`, `lt5`, `5-20`, `20-50`, `gte50` %). `rage_clicks`, `dead_clicks`, `shortcut_ignored`, `search_empty`, `nav_thrash` and `camera_thrash` are reserved and report `0` until their detectors ship. Never which command, control, key or text was involved |
| `studio:refused` | A command the Studio refused, as closed values only: `code` (one of the Studio's fixed error codes, such as `INVALID_ARGUMENT`, `STALE_SCENE` or `TARGET_BUSY`, else `other`), `origin` (`ui` for the user's own control, `agent` for the agent or an MCP client), `phase` (`admission`, refused before any change, or `commit`, refused after it started changing) and `group` (the command's family: `object`, `shot`, `cast`, `scene`, `motion`, `edit`, `task`, `agent` or `other`). At most 3 per `code`, `group` and `origin` per session; the rest are only counted in `app:friction_summary`. A cancel the caller asked for is not a refusal. Never the command's arguments, target or message |
| `edit:undone` | A user undo (agent undos are not counted): `age` (`lt2s`, `2-10s`, `10-60s` or `gte60s` since the undone edit was made, only when the undo was done and its age is known), `kind` (`pose`, `camera`, `object`, `shot`, `prompt`, `agent_turn` for the agent's whole turn, `ik_preview` for an un-applied IK drag, or `other`), `via` (`key`, `menu` or `button`) and `result` (`done`, `noop` when there was nothing to undo, or `refused`). At most 20 per session. Never what was undone |
| `agent:turn_summary` | One per agent turn: `turn_id` (the same random id as `agent:turn_*`); `outcome` (`succeeded`, `failed` or `cancelled`); `wall` (the turn's length) and `first_tool` (time to the first tool call, absent without tools), each `lt10s`, `10-30s`, `30-60s`, `1-2m`, `2-5m` or `gte5m`; counts of tool calls (`tool_calls`), failed tool calls (`tool_failed`), tool calls the Studio refused (`refused`), commands re-sent once after a stale revision or a busy gesture (`stale_retry`) and motion compiles (`drafts`), each as `0`, `1`, `2`, `3`, `4-5`, `6-10` or `gte11`; `refusal_top` (the most frequent refusal code, or `none`); `authored` (true or false: the turn changed the scene); `qa_first` and `qa_last` (`clean` or `problems`, absent without drafts); `qa_trend` (`improved`, `flat`, `worse`, or `na` with fewer than 2 drafts); `stuck` (true or false: the motion compiler's stop rule fired); `cancel_phase` (`before_tool`, `during_tool`, `after_tool` or `na`). No prompt text, tool names, messages or responses |
| `agent:post_turn_edit` | One per agent turn: `turn_id` (the same random id) and the user's own edit gestures in the 120 seconds after the turn ended, closed early when the next turn starts or the page closes. `edited` (true or false); counts per group (`pose`, `camera`, `object`, `shot`, and `prompt_block`, which counts edits to a take's prompt and take fields), each as `0`, `1`, `2`, `3`, `4-5`, `6-10` or `gte11`, where one continuous drag is one gesture; `first_delay` (time to the first edit: `lt10s`, `10-30s`, `30-60s`, `1-2m`, `2-5m` or `gte5m`), only when `edited` is true. Never which object or what changed |
| `feature:used` | One signal per feature per session (`pose_edit` is a real pose change; `pose_save` is saving a pose to the library; `export_storyboard` and `export_render_pass` are counted too) |
| `$pageview` | Funnel and drop-off analysis |
| `scene:created` | Funnel and drop-off analysis; carries `previs_mode` (`storyboard` or `animation`) when the project has a mode |
| `storyboard:panel_created` | A storyboard panel was added; `source` is `agent` or `manual`. No caption, name or id |
| `storyboard:panel_stylized` | A Board panel Stylize finished; `outcome` is `ok` or `error`. No prompt, caption or image |
| `cast:proxy_added` | A capsule figure was added to the scene; `surface` is `assets`, `agent` or `mcp`. No name or position |
| `export:attempt_started`, `export:attempt_succeeded`, `export:attempt_failed`, `export:attempt_cancelled` | One export attempt; `export_kind` is `video`, `depth_video`, `frame`, `keyframe_pack`, `contact_sheet`, `panel_pack`, `animatic`, `animation_project`, `workflow_send`, `storyboard`, `render_pass` or `otio`, plus `format` (`mp4`, `png`, `zip`, `cclayproject` or `otio`), surface, `is_retry`, `retry_of` (the retried attempt's id, only on a retry), `objects` (scene object count bucket: `0`, `1-3`, `4-10`, `gte11`), duration bucket and failure code. Failures and cancellations add `stage` (`preparing`, `encoding`, `finalizing`, `handoff`) and `progress` (`0`, `1-25`, `26-50`, `51-75`, `76-99` percent). Never file names or content |
| `export:saved` | One per saved export file: `method` (`workspace` = written into the export folder you chose, `download` = browser download) and `reason` (`none`; `unsupported` = the browser has no folder access; `no_workspace` = no folder chosen; `permission` = folder access denied; `write_failed` = the folder write failed and the file fell back to a download). Never the file name or path |
| `scene:loaded` | Funnel and drop-off analysis |
| `project:saved` | User-owned project persistence |
| `project:opened` | Return to a saved project (age bucket) |
| `craft:first_action` | Funnel and drop-off analysis |
| `craft:first_edit` | First meaningful Studio edit (`edit_kind`, `definition_version: 1`) |
| `playground:first_edit` | First meaningful Playground edit, separate from the Studio funnel |
| `app:error` | Uncaught errors and unhandled rejections: type label, source, and for the app's own bundle only file name + line/column. Never messages, stacks, URLs, or paths |
| `device:profile` | Once per session: GPU vendor/class, WebGL version, CPU/memory buckets, and a frame-rate bucket. Never the raw renderer string |
| `survey:use_case` | Optional one-time question after a successful export: `use_case` and `team`, closed choices only |
| `export:blocking_frame_succeeded` | Funnel and drop-off analysis |
| `sculpt_run` | One per finished Sculpt mode run: `outcome` (`done`, `cancelled`, `failed`), `rounds` (0-10), `final_iou` (match against the reference image, 0-1 to two decimals; omitted when unscored), `duration_ms` and `had_target` (reworked an existing sculpt). Never the reference image, recipe, part names or sculpt id |
| `activation:completed` | Funnel and drop-off analysis |
| `hosted:composer_viewed`, `hosted:login_started`, `hosted:ticket_created` | Hosted demo funnel |
| `hosted:result_opened`, `hosted:opened_in_studio` | Hosted result funnel |

The app sends only the events in this table: `track()` drops any event name outside its allowlist instead of sending it with empty properties. Geo data comes from ingest-time GeoIP country lookup only — no precise location is collected. Prompt text, asset names, file names, project content, local paths, and any user-entered text are never collected.

The 2.x motion-generation events (`motion:generate_requested`,
`motion:preflight_*`, `motion:job_*`, `motion:result_applied`) and
`sample:played` are no longer collected: they left the allowlist on
October 25, 2026.

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
`global`) and `update_status` (`latest`, `outdated`, or `unknown`, from the
package's own cached update check). Source checkouts are classified as `clone` and remain telemetry-off.
The first npm launch may optionally answer a one-line channel question
(`x`, `hn`, `reddit`, `github`, `site`, `friend`, `other`, or `skip`); `skip` sends no
acquisition value. A copied `npx cozyclay --via site` (or `--via playground`)
command supplies the same one label without the question. Session duration and action counts are buckets, and project
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
restoration, failed/no-op commands, and undo/redo do not qualify. Explicitly recording a camera key or authoring a shot or rail
does qualify; moving a viewing camera alone does not.

The legacy `craft:first_action` / `playground:first_action` streams retain
their existing insertion/camera-key triggers and deduplication unchanged
during migration. Their historical first-launch conversion is not the
percentage of people who edited or used the app. Do not combine those
events with version 1 first-edit events in a conversion numerator.

See [the version-filtered ordered funnel query](analytics-queries.md#first-launch---first-edit---exported-frame)
for a new-install cohort with explicit event ordering and a conversion window.
