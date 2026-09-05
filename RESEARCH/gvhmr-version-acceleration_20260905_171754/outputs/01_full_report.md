# GVHMR 최신 버전 및 가속 구현 조사

## 직접 확인한 버전

서버 `/home/yun/cclay-ingest/GVHMR`의 HEAD, `git ls-remote origin main`, GitHub `commits/main`은 모두 `6ec3ca39336c50492c0fae65fba2fb831fc7d866`이었다. 커밋 날짜는 2026-05-21이며 SimpleVO 병렬화 변경이다. 2026-09-05 조회 시점의 공식 추적 소스는 최신이다. [src_001] [src_002]
현재는 공식 문서에 기재된 `gvhmr_siga24_release.ckpt` 경로를 사용한다. 별도 최신 가중치를 발견했다는 근거는 없지만, 이번에 배포본을 다시 다운로드하여 바이너리 해시까지 대조하지는 않았다. 자체 runner는 공식 코드 외의 추가 파일이고, 모든 의존성 패키지가 최신이라는 뜻도 아니다. [src_001] [src_003]

## 실제로 찾은 구현

| 후보 | 소스에서 확인한 구현 | GVHMR에 적용할 때 구분할 점 |
|---|---|---|
| ryanrudes/gvhmr | 재사용 캐시, 동일 crop 공유, skip-init/mmap, SDPA, BF16 전처리 | 공식 최신판이 아닌 Python 포크. CLI에는 static-camera 이동 경로 변경도 섞여 있다. [src_004] [src_006] [src_018] [src_019] |
| NVIDIA GENMO | 동일 이름의 ViTPose-H/HMR2 체크포인트용 ONNX export, CUDA IOBinding 및 TensorRT 실행 클래스 | 본체는 GEM. export 검사는 임의 입력의 오차를 출력할 뿐 최종 GVHMR 모션 품질 인증이 아니다. 기본 webcam flip 설정도 다르다. [src_007] [src_008] [src_009] |
| 공식 저장소의 convert_to_trt.py | ViTPose Base를 FP16 torch2trt로 내보내는 외부 예제 | 우리가 쓰는 Huge 모델의 active extractor와 연결되어 있지 않다. 전체 C++ 포팅도 아니다. [src_010] [src_011] |
| easy_ViTPose / vitpose_flash | ONNX/Torch-TensorRT export, backbone 컴파일 벤치마크 | 부품 단위이며 모델 변형과 측정 범위가 다르다. 전체 모캡 품질 근거로 확대 해석하지 않는다. [src_014] [src_015] |
| ComfyUI-MotionCapture | ComfyUI attention, 정밀도 선택, 메모리 offload | ONNX/C++ 완성판이 아닌 PyTorch 통합이다. 코드 공유와 모델 가중치 공유는 다르다. [src_016] |

## 품질을 유지하려면

추천: 우선 같은 체크포인트·crop·flip·관절 후처리를 유지하고 준비·로딩·중복 계산을 줄인다. 이어 전처리 backend만 교체하는 A/B 실험을 한다. 자동차 전체를 교체하기보다 같은 엔진의 불필요한 공회전부터 줄이는 접근이다.
포크의 golden 검사는 영상 전처리 대신 합성 입력과 출력 합 비교를 사용한다. CLI의 이동 경로 변경까지 같은 검사로 인증된 것이 아니므로, 포크 통째 교체를 동일 출력이라고 말할 수 없다. [src_005] [src_006]
PyTorch Python도 무거운 수치 연산은 C++에 넘긴다. C++ 언어 전환만으로 속도와 품질 동시 보존을 보장할 수 없으며, 계산 경로와 정밀도 변경은 따로 검증해야 한다. [src_012] [src_013]

## 미확정 / 확인 필요

작성자의 긴 클립 약 3–4배, BF16 전처리 약 4배 향상은 RTX 6000 Ada의 자체 측정이다. 같은 문서에는 정밀도 설정으로 움직임 가속도 오차가 악화되어 되돌린 사례도 있다. 우리 장비의 향상 배수나 동일 품질을 보장하는 수치가 아니다. [src_004]
완성형 GVHMR C++/TensorRT 런타임과 전체 모션 동등성 검증을 함께 갖춘 공개 프로젝트는 조사 범위에서 미확인이다. 비공개·미색인 구현의 부재까지 주장하지 않는다. 검색 범위는 `artifacts/search-scope.md`에 기록했다.
GENMO의 라이선스 이름과 사용 제한은 제품 도입 전에 확인해야 한다. 이번 조사는 기술적 참고 가능성이지 코드 편입 허가가 아니다. [src_017]
실제 적용 전 측정: 최초/반복 추출 시간, GPU 최대 메모리, 관절·root 경로 오차, 접지 밀림, 가속도·jerk, 동일 카메라 영상 비교. 이번에는 설치나 벤치마크를 실행하지 않았다.
