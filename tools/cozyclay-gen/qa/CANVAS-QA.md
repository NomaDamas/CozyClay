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

## Round 2
- Files: 18 (9 states × 2 viewports).
- Interaction checks: 8/8 PASS (preset, search, pan, context, running mock, result mock, error mock, zoom).
- Defects after fix: P0 0, P1 0, P2 0.

## Round 3
- Files: 18 (9 states × 2 viewports).
- Interaction checks: 8/8 PASS using scripted Playwright events; run/result/error are explicitly mocked.
- Defects: P0 0, P1 0, P2 0.


## Round 6 (real browser visual review, 1440x900)
All screenshots below were opened and visually inspected after the 8301 preview reloaded successfully. Run/result/error states are UI-injected mock states; no GPU run was issued.

| Screenshot | Visual evidence |
|---|---|
| [canvas-round6-1440x900-first.png](canvas-round6-1440x900-first.png) | 실제 첫 화면에 입력·장면·결과 3개 노드가 겹침 없이 배치되고 한국어 소켓/위젯과 이미지 A 썸네일이 보인다. |
| [canvas-round6-1440x900-imageA.png](canvas-round6-1440x900-imageA.png) | 이미지 A 업로드 상태에서 입력 노드의 썸네일과 이미지 A 버튼이 유지된다. |
| [canvas-round6-1440x900-imageB-fl2v.png](canvas-round6-1440x900-imageB-fl2v.png) | 이미지 A/B 두 썸네일이 나란히 표시되어 첫·마지막 프레임 모드 입력을 확인할 수 있다. |
| [canvas-round6-1440x900-scene.png](canvas-round6-1440x900-scene.png) | 장면 설명 textarea에 한국어 문장이 입력되고 길이 위젯이 겹침 없이 보인다. |
| [canvas-round6-1440x900-running.png](canvas-round6-1440x900-running.png) | 결과 노드가 파란 강조 테두리와 영상 생성 중… 상태로 실행 중임을 표시한다. |
| [canvas-round6-1440x900-result.png](canvas-round6-1440x900-result.png) | 결과 노드 안에 실제 video DOM 컨트롤이 배치되고 완료·대기 시간 상태가 상단에 표시된다(파일은 mock 경로). |
| [canvas-round6-1440x900-error.png](canvas-round6-1440x900-error.png) | 결과 노드가 오류 색상으로 표시되고 한국어 오류 토스트가 오른쪽 아래에 보인다. |
| [canvas-round6-1440x900-addmenu.png](canvas-round6-1440x900-addmenu.png) | 빈 공간 검색 메뉴에 입력/장면/결과 3개 항목만 표시되고 상단에 노드 개수 텍스트가 없다. |

Interaction checks: PASS 8 (preset load, Korean labels, image A/B thumbnails, no overlap, running state, result video element, error state, 3-item search) / FAIL 0. Result playback against a real existing live-server mp4 and video-reference backend remain unverified.
