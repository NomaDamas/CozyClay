# CozyClay 노드 UI 명세

사용자는 프롬프트, 길이, 이미지 A/B, 참고 영상, 결과 창만 본다. 나머지는 mocap 고정 튜닝으로 숨긴다.

"The node UI must be EASY. A prompt box, a duration control, image inputs (image A, image B, a reference video), and a result window. That is all. Everything else is tuned by us for mocap and stays out of the user's way."

Default canvas = exactly 3 nodes, no others visible:
1. 입력 (category input)
   - 이미지 A (required): upload/pick, thumbnail in node.
   - 이미지 B (optional): upload/pick, thumbnail. When present, generation uses first/last-frame mode (A=first, B=last); when absent, Ref2VA with A as the reference.
   - 참고 영상 (optional): upload of an mp4/mov. The server does not support a video reference yet: accept the upload, store it, and show the thumbnail of its first frame; pass its path to the run as ref_video so the backend can start using it later. Mark it "실험 중" in the node.
2. 장면 (category prompt)
   - 장면 설명, 길이 (초), BYOK rewrite after run.
3. 결과 (category output)
   - Result node runs the mocap tuned pipeline; fixed aspect 16:9, random seed, steps 4, SLA on, 0.4 MP, audio off.

All other nodes are advanced and only served from /graph?mode=advanced.
