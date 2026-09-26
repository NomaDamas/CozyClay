# CozyClay 작업 규칙

## 브랜치

- `main`이 유일한 trunk. `dev`는 쓰지 않는다 (main과 동일하게 유지).
- 모든 작업은 GitHub 이슈에서 시작한다. 이슈 없으면 먼저 만든다.
- 브랜치 이름: `fix/issue-<n>`, `feat/issue-<n>`, `chore/<주제>`.
- 워커는 `main`에 직접 커밋하지 않는다. 자기 브랜치에서 `main`으로 PR만 연다.
- 머지는 컨트롤 세션(사람 또는 Claude)이 순서대로 한다. 병렬은 작업에만, 통합은 직렬.
- 충돌이 나면 워커가 자기 브랜치에서 `git rebase origin/main` 한다.

## 워크트리

- 본체: `~/CozyClay` (항상 `main`, 여기서 작업하지 않는다).
- 워커: `~/CozyClay-wt/<이슈번호>`. `cozy-worker <이슈번호>` 가 워크트리 생성 + Codex 실행까지 한다.
- 동시에 최대 3개. 끝나면 `git worktree remove`.
- 같은 파일을 건드리는 이슈 두 개를 동시에 돌리지 않는다.
- vite 포트는 워크트리마다 다르게 (5180 본체, 5181~ 워커).

## 역할

- **Claude (Fable)**: 이슈 쪼개기, 워커에게 지시, PR 리뷰·검증, 머지. 오래 걸리는 구현은 하지 않는다.
- **Codex (gpt-6-astra)**: 구현, 브라우저·에디터 실사용 QA (computer use), 반복 수정 루프.
- 컨트롤 세션이 바쁘면 컨트롤이 아니다. 긴 작업은 새 세션으로 뺀다.

## PR 기준

- 한 PR = 한 이슈. 제목에 `(#n)`.
- `node tools/run-tests.mjs` 통과.
- UI 변경은 브라우저 QA 증거(스크린샷 또는 QA 스크립트 결과)를 PR 본문에 남긴다.
- 리뷰어(Claude)는 코드 diff + 테스트 + QA 증거를 보고 머지한다.

## 하지 말 것

- `.omo/`, 스크래치 파일, 실험용 npz를 커밋하지 않는다.
- 별도 클론을 만들지 않는다. 항상 워크트리.
- 커밋 메시지에 도구 서명을 넣지 않는다.

## 실행 정보 (워커용)

- 테스트 전체: `npm test` (build 포함). 목록: `npm run test:manifest`. 단일: `node test/verify-<이름>.mjs`.
- 개발 서버: `npm run dev -- --port <포트>` (본체 5180, 워커는 5180 + 이슈번호).
- 라이브 허브를 쓰는 작업이면 워커는 `COZYCLAY_LIVE_PORT=<5300+이슈번호>` 를 허브와 개발 서버 양쪽에 붙인다 (예: 이슈 329 → 5629). 기본 5184 허브를 여러 워크트리가 공유하지 않도록 한다.
- 브라우저 QA: `tools/qa-browser.mjs` (`QA_URL`, `CDP_PORT` 환경변수로 대상 지정).
- 컴퓨터 사용 QA: 에디터를 실제로 열고 클릭해서 확인. 스크린샷을 PR 본문에 첨부.
- PR 열기: `gh pr create --base main --title "<type>: <요약> (#n)"`.
- main/dev로 push·commit·checkout은 훅이 막는다. 막히면 브랜치를 확인하라.
