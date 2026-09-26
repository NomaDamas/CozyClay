# GVHMR 낙하 지연 개선 QA — 2026-09-05

결론: 동일한 나무 낙하 영상에서 공중에 남아 천천히 내려오는 현상이 크게 줄었다. 완벽한 물리 복원은 아니다.
원본 영상의 하강·착지 관측으로 지연된 높이 경로만 복구한다. 관절 회전·수평 이동·프레임 수는 유지한다.
비유하면 영상 전체를 빨리 감는 것이 아니라, 배우보다 늦게 내려오던 캐릭터의 높이를 같은 시점에 맞춘 것이다.

| 실제 측정 | 기존 | 개선 후 |
|---|---:|---:|
| 영상의 하강 90% 시점 대비 지연 | 44프레임 / 1.83초 | 1프레임 빠름 / 0.042초 |
| 정규화한 하강 타이밍 오차(RMSE) | 0.347 | 0.029 |
| F300–348 높이 변동 범위 | 82.7cm | 12.6cm |
| 보정 구간 최저 표면 높이, x-bot / y-bot | −10.7 / −12.0cm | +2.31 / +0.20cm |

- 타이밍 오차는 원본 2D 골반 이동과 출력 높이 진행률 비교이며, 실제 3D 위치 정확도나 전체 영상 성공률이 아니다.
- AutoPhysics OFF / IK 키 0개로 두 캐릭터 × 전후 × 전체 362프레임 = 1,448개 Studio 실제 포즈를 검사했다. 런타임 오류 0개.
- 재생 버튼으로 전후 낙하 구간의 진행도 확인했다. 자동화 환경의 벽시계 재생 속도는 실시간 FPS 보장 근거로 사용하지 않았다.
- 관절 회전·XZ·뼈 길이 변화 0. 걷기/절하기 2개 회귀 영상의 원본 SMPL 9개 배열은 기존 출력과 완전히 같다.
- 수치 테스트 12개, Node 검증 파일 115개, 리타게팅 테스트 5개, 빌드 통과. 새 HTTP 업로드 결과도 검토한 NPZ와 완전히 일치했다.
- 새 단계 추가 비용 1.0–1.2초(높이 복구 약 0.014초 + 두 캐릭터 바닥 검사 0.99–1.15초). 실제 로컬 서버 재업로드 총 49.55초, 검토한 NPZ와 완전히 동일.
- 이 영상은 COM 중력 곡선이 관측과 맞지 않아 `observed-timing`으로 처리했다. `gravityApplied:false`를 그대로 기록한다.
- 남은 한계: 착지 후 12.6cm 높이 출렁임, 기존 관절 자세 오차, 보정 시작 전의 기존 바닥 관통. 이동 카메라·애매한 착지는 건너뛴다.
- QA 당시 로컬 `feat/gvhmr-mocap`에 적용. 원본 GVHMR runner/checkpoint와 AutoPhysics 로직은 이 낙하 보정 작업에서 변경하지 않았다. 원본 영상·이미지·모션 증거는 로컬에만 보관하며 Git에 포함하지 않는다.
- 재검증: `python test/verify-gvhmr-trajectory.py`(NumPy 환경), `npm test`, `node --test test/smpl-cskel27.test.mjs`.
- 실제 영상 루프: `qa-gvhmr-trajectory.py` → `qa-gvhmr-trajectory-retarget.mjs` → `QA_ALL_FRAMES=1 node test/qa-gvhmr-trajectory-browser.mjs` → 수치/이미지 비교 → `qa-gvhmr-trajectory-http.mjs`로 전체 경로 재확인.
- 로컬 원본·전후 NPZ·전체 프레임 측정·추출 로그: [증거 폴더](../.omo/evidence/gvhmr-trajectory-20260905/), [전후 이미지](../.omo/evidence/gvhmr-trajectory-20260905/comparison.png), [타이밍 그래프](../.omo/evidence/gvhmr-trajectory-20260905/timing.png).
- 기존 추출물은 자동 변경하지 않는다. 영상을 다시 추출해야 적용된다. 복귀는 `CCLAY_GVHMR_TRAJECTORY=0`으로 bridge 재시작(가속 유지).
