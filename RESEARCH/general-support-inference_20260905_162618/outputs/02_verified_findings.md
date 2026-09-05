# 검증된 핵심 명제

아래는 주장 원장의 검증 통과 항목과 직접 근거다. 교차출처·반증 검색을 통과했다는 뜻이며, 제안한 새 AutoPhysics를 구현·시험했다는 뜻이 아니다.

## clm_001

기하학적 접촉 또는 정지 확률은 하중을 지탱한다는 증거와 다르며, 영상 접촉은 지지 후보로 사용해야 한다.

[src_005: Shashank Tripathi et al., 2023, 3.1; 4.1; 5.3](https://openaccess.thecvf.com/content/ICCV2023/papers/Tripathi_DECO_Dense_Estimation_of_3D_Human-Scene_Contact_In_The_Wild_ICCV_2023_paper.pdf) · [src_001: Russ Tedrake, MIT, 2024, Robots with massless legs; ZMP; Centroidal dynamics](https://underactuated.mit.edu/humanoids.html) · [src_014: Soshi Shimada et al., 2020, Abstract; paper 4.2-4.3](https://vcai.mpi-inf.mpg.de/projects/PhysCap/)

반증 점검: DECO의 DAMON 지지 종류와 실제 출력 비교: 데이터 주석의 지지 구분과 달리 모델 출력은 이진 접촉이며 힘은 아니다. MIT 외력 방정식은 별도 힘 제약을 요구한다.

## clm_002

후보 지지는 전신의 필요한 외력과 모멘트를 비접착성 단방향 접촉 및 마찰 제약 안에서 설명해야 하며, 무게중심 역학 검사는 관절 수준 실현 가능성의 충분조건은 아니다.

[src_001: Russ Tedrake, MIT, 2024, Robots with massless legs; ZMP; Centroidal dynamics](https://underactuated.mit.edu/humanoids.html) · [src_002: Stephane Caron, Quang-Cuong Pham, Yoshihiko Nakamura, 2015, II.A; III equations 4-7; Introduction](https://roboticsproceedings.org/rss11/p28.pdf) · [src_003: Michael Posa, MIT, 2017-06, 3.2.4 pp32-33; 4.1 pp43-46](https://groups.csail.mit.edu/robotics-center/public_papers/Posa17a.pdf)

반증 점검: Caron의 sufficiently large torque limits 가정과 MIT centroidal dynamics의 limb/actuator 제약 누락을 확인했다. 작은 힘 문제의 통과를 완전한 인체 역학 인증으로 확대하지 않는다.

## clm_003

접촉 위치와 순서는 몸의 궤적과 함께 추정할 수 있지만, 후보 표면·장면·물리 가정이 필요하며 고정된 뜬 자세에서 힘만 풀어서는 접촉이 생성되지 않는다.

[src_003: Michael Posa, MIT, 2017-06, 3.2.4 pp32-33; 4.1 pp43-46](https://groups.csail.mit.edu/robotics-center/public_papers/Posa17a.pdf) · [src_004: Igor Mordatch, Emanuel Todorov, Zoran Popovic, 2012, 1.1; 4.4; 6; Appendix A](https://www.roboti.us/lab/papers/MordatchSIGGRAPH12.pdf)

반증 점검: Posa의 gap-force complementarity와 CIO의 predefined patches 및 continuation을 확인했다. 초기 완화에서 생기는 원거리 힘을 최종 유효 접촉으로 인정할 수 없으며, 비선형 탐색은 전역해 보장이 아니다.

## clm_004

다중 접촉에서 정확한 하중 분담은 운동학만으로 유일하게 결정되지 않으며, 힘 배분 정규화나 학습 prior는 측정된 정답이 아니다.

[src_013: Urbano Lugris, Manuel Perez-Soto, Florian Michaud, Javier Cuadrado, 2023-10-06, 2.3.2 Ground-reaction forces and torques](https://link.springer.com/article/10.1007/s11044-023-09938-0) · [src_001: Russ Tedrake, MIT, 2024, Robots with massless legs; ZMP; Centroidal dynamics](https://underactuated.mit.edu/humanoids.html) · [src_012: Cuong Le, Urs Waldmann, Bastian Wandt, Marten Wadenback, 2026-06, 3.2-3.3; 5 Limitations](https://arxiv.org/html/2606.08133v1)

반증 점검: 단일 접촉 반력과 다중 접촉 비결정성을 구분했다. GraCE도 반대 방향 힘의 상쇄와 정지 중 의도적 힘의 모호성을 명시한다. 전체 외력의 추정 가능성과 각 접촉 하중의 식별을 혼동하지 않는다.

## clm_005

실제 비행과 지지 상태를 구분하려면 시간 구간의 무게중심 가속도와 각운동량을 보아야 하며, 정지 속도나 정적 지지 다각형만으로 일반 동작을 판정할 수 없다.

[src_001: Russ Tedrake, MIT, 2024, Robots with massless legs; ZMP; Centroidal dynamics](https://underactuated.mit.edu/humanoids.html) · [src_002: Stephane Caron, Quang-Cuong Pham, Yoshihiko Nakamura, 2015, II.A; III equations 4-7; Introduction](https://roboticsproceedings.org/rss11/p28.pdf)

반증 점검: 점프 정점은 속도 0이지만 중력 가속도가 남는 반례를 Newton-Euler 식으로 점검했다. RSS의 비준정적 동작과 ZMP의 공면/마찰 제약 한계를 확인했다. 외부 보조력과 충격 구간은 별도 모델을 요구한다.

## clm_006

영상·시간·장면 증거는 접촉 후보 선택에 유용하지만 가림, 드문 자세, 잘못된 바닥 또는 몸 위치에서는 모호한 해가 남으므로 물리적으로 가능한 해를 실제 의도와 동일시할 수 없다.

[src_006: Davis Rempe et al., 2021, Paper 3-4; Appendix A.1 and B.2](https://geometry.stanford.edu/projects/humor/) · [src_005: Shashank Tripathi et al., 2023, 3.1; 4.1; 5.3](https://openaccess.thecvf.com/content/ICCV2023/papers/Tripathi_DECO_Dense_Estimation_of_3D_Human-Scene_Contact_In_The_Wild_ICCV_2023_paper.pdf) · [src_010: Zihan Wang et al., 2025-12, 3.3; Appendix C-E](https://arxiv.org/html/2512.14696v1)

반증 점검: HuMoR Appendix A.1의 누운 자세와 정적 앉기 실패, DECO의 pose-only 오탐, CRISP의 near-contact와 drift 한계를 확인했다. 정확한 장면과 충분한 움직임이 있으면 개선되지만 보편적 보장은 아니다.

## clm_007

자세 일치 오차만 줄여서는 물리적 지지를 검증할 수 없으며, 설명되지 않는 root 외력을 허용하면 불가능한 궤적을 가릴 수 있다.

[src_007: Erik Gartner, Mykhaylo Andriluka, Erwin Coumans, Cristian Sminchisescu, 2022, Method; Table4; section5](https://openaccess.thecvf.com/content/CVPR2022/papers/Gartner_Differentiable_Dynamics_for_Articulated_3D_Human_Motion_Reconstruction_CVPR_2022_paper.pdf) · [src_001: Russ Tedrake, MIT, 2024, Robots with massless legs; ZMP; Centroidal dynamics](https://underactuated.mit.edu/humanoids.html) · [src_014: Soshi Shimada et al., 2020, Abstract; paper 4.2-4.3](https://vcai.mpi-inf.mpg.de/projects/PhysCap/)

반증 점검: DiffPhy Table4의 residual-force 자세 오차 개선과 PhysCap의 잔여 외력 사용을 비교했다. 잔여 외력은 모델 오차 보조항으로 유용할 수 있으나 실제 접촉력으로 보고해서는 안 된다.

## clm_008

접촉 후보를 만드는 단계와 실제 힘·마찰을 검증하는 단계는 구분해야 하며, 전체 렌더링 메시를 반복 검사하는 것이 지지력 계산의 필수 조건은 아니다.

[src_002: Stephane Caron, Quang-Cuong Pham, Yoshihiko Nakamura, 2015, II.A; III equations 4-7; Introduction](https://roboticsproceedings.org/rss11/p28.pdf) · [src_014: Soshi Shimada et al., 2020, Abstract; paper 4.2-4.3](https://vcai.mpi-inf.mpg.de/projects/PhysCap/) · [src_015: Soshi Shimada et al., 2022-04-20, stage2.py; stage3.py; Utils/util_opt.py 149-288; README](https://github.com/soshishimada/PhysCap_demo_release/tree/3750e49c655244b53aa9bc663c48783daca73db9)

반증 점검: RSS 표면 wrench 표현과 PhysCap 공개 force QP를 확인했다. 적은 접촉 패치 표현은 가능하지만 패치 근사가 최종 표면 관통 검사를 대체하거나 CozyClay 속도 개선치를 증명하지는 않는다.
