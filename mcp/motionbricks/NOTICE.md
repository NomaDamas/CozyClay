# MotionBricks model notice

Licensed by NVIDIA Corporation under the NVIDIA Open Model Agreement.

`model.mjs` downloads the MotionBricks SOMA ONNX model (`mmm_v6_soma_fp16.onnx`, SHA-256
`6c9f78e2…`) from https://github.com/NVlabs/motionbricks on first use. The model is not part of
this repository. Its terms: https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-agreement/

The encode/decode code in `src/motion3/bricks/model-io.js` ports the upstream kernels, which are
Apache-2.0. No upstream sample motion (BVH) is used or shipped.
