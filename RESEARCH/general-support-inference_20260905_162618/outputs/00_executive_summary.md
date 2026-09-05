# 지지 추론 조사 요약

**판단 방법은 ‘영상·기하로 후보 제안 → 필요한 힘과 회전을 만족하는 후보 검사 → 접촉과 몸 궤적 공동 보정’이다.** 가까운 관절을 바닥에 붙이는 것과 다르다. 실제 접촉력은 닿은 곳에서만 생겨야 하고, 마찰·밀기 방향에 맞아야 한다. (Caron 등, 2015, §II–III; Posa, 2017, §3.2.4/§4.1.) [src_002](https://roboticsproceedings.org/rss11/p28.pdf) [src_003](https://groups.csail.mit.edu/robotics-center/public_papers/Posa17a.pdf)

무게중심 가속도는 필요한 힘의 합을 알려줄 뿐, 어느 손·무릎이 얼마나 버티는지 유일하게 알려주지는 않는다. 접촉 후보에는 원본 영상, 환경 표면, 시간적 움직임이 필요하다. (Lugrís 등, 2023, §2.3.2; Tripathi 등, DECO, 2023, §3–4.) [src_013](https://link.springer.com/article/10.1007/s11044-023-09938-0) [src_005](https://arxiv.org/html/2309.15273v1)

책상 다리 후보를 찾은 다음, 그 다리들이 상판의 무게와 기울어짐을 실제로 버틸 수 있는지 계산하는 것과 같다. 숨은 받침이 있을 수 있으므로 설명이 안 되는 경우를 무조건 바닥에 붙이지 않는다.

제안하는 우리 구조는 전신의 소수 접촉 패치와 시간 구간의 여러 높이/자세/접촉 후보를 비교하고, 힘·모멘트 잔차가 낮으면서 원본 변경이 작은 것을 보정하는 방식이다. 공중 비행 후보도 유지한다. 힘만 고정 자세에서 풀어서는 떠 있는 몸을 내려놓을 수 없으므로 기하와 접촉을 함께 바꿔야 한다. 이는 미구현 설계안이다.

연구에서 확인한 것은 범용 접촉/물리 최적화의 원리와 한계다. HuMoR와 DECO는 후보 추정 참고, DiffPhy와 CIO는 전신 물리/공동 추정 참고다. 최신 CRISP·UniCon3R·GraCE도 장면·가림·힘 식별 한계를 없애지 않았다. [src_006](https://geometry.stanford.edu/projects/humor/) [src_007](https://gartner.io/diffphy/) [src_004](https://www.roboti.us/lab/papers/MordatchSIGGRAPH12.pdf) [src_010](https://arxiv.org/html/2512.14696v1) [src_011](https://arxiv.org/html/2604.19923v1) [src_012](https://arxiv.org/html/2606.08133v1)

로컬에서 확인한 별도 관찰: 현재 float 지표는 검출된 접촉 구간에만 적용되어 접촉을 놓치면 떠 있음도 누락한다. GVHMR 정지 확률을 담는 upstream 계약과 달리 최종 변환·로딩 경로는 해당 정보를 전달하지 않는다. 이 둘은 [진단 기록](../artifacts/local_observations.md)에 범위를 명시했다.

## 미확정 / 확인 필요

새 방식의 제품 성능·실제 영상 개선은 아직 시험하지 않았다. 모델 설치와 제품 코드 변경은 하지 않았다. 자동 수정 전에 실제 점프 오접지, 희귀 접촉, 높이 오차, 가림을 포함한 비교가 필요하다.

[상세 보고서](01_full_report.md) · [근거 목록](../sources/bibliography.md)
