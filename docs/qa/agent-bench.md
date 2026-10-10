# Studio Agent bench

`test/qa-agent-bench-browser.mjs` measures how the real-model Studio Agent handles five fixed scene-authoring requests (#714). It runs in one browser session per model, writes one row per model x scenario, and merges the rows into a single JSON file, so later changes can be compared against a stored baseline. It uses a real model and a live scene, so it is not part of the default `node tools/run-tests.mjs` manifest.

## Running it

Start the full dev stack (Vite, the live hub and the `/agent/*` sidecar). The shell must export the provider credentials (for cliproxy: `CLIPROXY_API_KEY` and `CLIPROXY_BASE_URL`):

```sh
COZYCLAY_LIVE_PORT=6014 npm run dev -- --port 5194
```

Check that `GET http://127.0.0.1:5194/agent/providers` reports the provider with `signedIn: true`. Then run one process per model. Each process opens a fresh headless Chrome profile with a project named "QA", so the agent sessions stay separate:

```sh
for model in cliproxy/claude-opus-5-5 cliproxy/claude-sonnet-5-5; do
  COZYCLAY_LIVE_PORT=6014 QA_URL=http://127.0.0.1:5194/app/ CDP_PORT=9314 \
  QA_AGENT_MODEL=$model QA_OUT=/tmp/cozyclay-agent-bench QA_BENCH_LABEL=baseline \
  node tools/qa-browser.mjs -- node test/qa-agent-bench-browser.mjs
done
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `QA_AGENT_MODEL` | `cliproxy/claude-opus-5-5` | Value selected in the Agent pane's Model select |
| `QA_OUT` | `/tmp/cozyclay-agent-bench` | Output directory |
| `QA_BENCH_LABEL` | `baseline` | Report name: writes `$QA_OUT/<label>.json` and `$QA_OUT/<label>/*.png` |
| `QA_BENCH_TURN_TIMEOUT_MS` | `240000` | Per-turn deadline |
| `COZYCLAY_LIVE_PORT` | `5184` | Live hub port, used by the `cclay live` reads |

Each run replaces that model's rows in `<label>.json` and keeps the other models' rows. The process exits 0 even when scenarios fail: a failed row is data. A row is missing only if the process crashed.

## Scenarios

The scenarios run in order in one session. The scene at page load has one character, no objects and no shots. S4 relies on S3 having just run.

| Id | Prompt | Success when |
| --- | --- | --- |
| S1 | 선택된 캐릭터 왼쪽 1.4m에 의자 하나 놔줘 | Object count is exactly one higher, and the new object's XZ distance to the selected character is in [1.0, 2.0] m |
| S2 | 그 캐릭터 주위에 의자 6개를 반경 2m 원형으로 둘러 배치해 | Object count is exactly six higher, every new object is in [1.5, 2.5] m (XZ) from the character, and the minimum pairwise XZ distance among the six is > 0.3 m |
| S3 | 두 캐릭터가 테이블에 마주 앉아 대화하는 장면을 만들어. 캐릭터가 하나면 하나 추가해. 샷은 세 개: 마스터 투샷, A의 OTS, B의 OTS. | At least 2 characters, exactly 3 shots, and an object whose name, `libraryKind` or `renderer` contains "table" (built-in props such as the table carry no `libraryKind`; their kind is the `renderer` id) |
| S4 | 방금 한 거 되돌려 | Compared with the state right after S3: fewer than 3 shots, or fewer objects |
| S5 | 두 캐릭터를 1.2m 간격으로 마주보게 세우고 미디엄 투샷으로 프레임 잡아 | At least 2 characters; the first two in document order are within [1.0, 1.4] m (XZ) and `(rotA - rotB) mod 360` is in [155, 205] degrees; the shot at the current frame (or the first shot) has a camera |

Scene facts are read through `cclay live describe` (positions, `rot`, shots) and `cclay live inspect --scope entities` (object `libraryKind`, set only for library assets) after each turn. The selected character is `activeCharacterId` before the turn.

## Metrics

The harness installs a `fetch` wrapper with `Page.addScriptToEvaluateOnNewDocument` before the Studio loads. That timing matters because the agent client binds `fetch` when it creates its transport. The wrapper clones every response whose URL contains `/agent/turn`, which covers the turn stream and a replay after a dropped stream. It parses the clone's `data: {json}` SSE lines, drops frames whose `eventSeq` it has already seen, and pushes the rest to `window.__benchFrames`, stamped with `receivedAt`.

| Field | Definition |
| --- | --- |
| `toolCalls` | Number of `tool.start` frames |
| `authoredReceipts` | Number of `tool.done` frames with `result.authored === true` (stands in for history entries) |
| `wallMs` | `receivedAt` of the `done` frame minus `Date.now()` taken just before the Enter keydown; `null` if no `done` arrived |
| `overlapWarnings` | Total number of `warnings[]` entries with code `FOOTPRINT_OVERLAP` at any depth of the `tool.done` results |
| `errorCode` | `code` of the first `error` frame, `BENCH_TIMEOUT` when no `done` arrived within the turn deadline (the harness then presses Stop), `BENCH_SETUP` when the page or model could not be prepared, `BENCH_ERROR` for a harness or live-read failure; otherwise `null` |
| `usage` | The `done` frame's `usage` object, or `null` when the sidecar sends none |
| `success` | The scenario assertion above holds and `errorCode` is `null`: a turn that timed out or ended on an `error` frame did not do the work, even if the scene happens to satisfy the assertion (S4 after a failed S3) |
| `reply` | Final assistant text in the pane |
| `measured` | The values the assertion read (counts, distances, yaws, new object rows), plus `turnError: { code, message, status }` from the first `error` frame when there is one |

Each scenario also saves a viewport screenshot to `$QA_OUT/<label>/<model-slug>-S<n>.png`. The slug is the model id with every run of characters outside `[A-Za-z0-9.]` replaced by `-`.

## JSON schema

```jsonc
{
  "label": "baseline",           // QA_BENCH_LABEL
  "commit": "4f93c20",           // git rev-parse --short=7 HEAD of the harness checkout
  "createdAt": "ISO-8601",       // time of the last merge
  "rows": [                      // sorted by model, then scenario
    {
      "model": "cliproxy/claude-opus-5-5",
      "scenario": "S1",          // S1..S5
      "prompt": "...",
      "toolCalls": 0,
      "authoredReceipts": 0,
      "wallMs": 0,               // number | null
      "overlapWarnings": 0,
      "success": false,
      "errorCode": null,         // string | null
      "usage": null,             // object | null
      "reply": "",
      "measured": {},            // scenario-specific, or { "error": "..." }
      "screenshot": "/tmp/cozyclay-agent-bench/baseline/<model-slug>-S1.png"
    }
  ]
}
```
