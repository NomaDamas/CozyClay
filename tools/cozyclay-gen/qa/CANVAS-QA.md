# Canvas QA

QA uses the copied preview proxy on port 8301. `/nodes` and `/preset` are served from this worktree; run states are Playwright route mocks because the live 8288 server has the pre-composite registry and must be redeployed.

| Round | Check | Result | Evidence |
|---|---|---|---|
| 1 | first open, 4-node preset | PASS | canvas-round1-1440x900-first.png |
| 1 | double-click search | PASS | canvas-round1-1440x900-search.png |
| 1 | pan/connection surface | PASS | canvas-round1-1440x900-connect.png |
| 1 | right-click context menu | PASS | canvas-round1-1440x900-context.png |
| 1 | running node mock feedback | PASS (mock) | canvas-round1-1440x900-running.png |
| 1 | result video mock response | PASS (mock) | canvas-round1-1440x900-result.png |
| 1 | error toast mock response | PASS (mock) | canvas-round1-1440x900-error.png |
| 1 | zoom | PASS | canvas-round1-1440x900-zoom.png |

Round 1 defects: P0 0, P1 1 (composite execution unavailable until remote redeploy), P2 1 (only first-round evidence captured before this correction).

Rounds 2–3 are pending and are not claimed as passed. The existing `round2-*`/`round3-*` files predate this implementation and are intentionally not counted.
