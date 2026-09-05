# Canvas QA

## Round 1
- First open / four-node preset: PASS — canvas-round1-1440x900-first.png
- Search on double-click empty space: PASS — canvas-round1-1440x900-search.png
- Context menu on right-click: PASS — canvas-round1-1440x900-context.png
- Wheel zoom and fit: PASS — canvas-round1-1440x900-zoom.png
- Ctrl+Enter run feedback: PASS — canvas-round1-1440x900-running.png
- Result state: PASS — canvas-round1-1440x900-result.png
- 1920x1080 readability: PASS — corresponding 1920 screenshots
- Defects: P0 0, P1 0, P2 1 (mock result; real GPU wiring needs live server validation)

## Round 2
- Recheck at 1440x900 and 1920x1080: PASS
- Defects: P0 0, P1 0, P2 1 (same live-server limitation)

## Round 3
- Interaction regression (drag, collapse, delete, zoom, run): PASS
- Defects: P0 0, P1 0, P2 1

## Round 4
- Final visual regression and result state: PASS
- Defects: P0 0, P1 0, P2 1
