#!/usr/bin/env bash
# Downloads the open UVR MDX-Net separation models into public/models/ for local development.
# For production, host them on a CDN that allows large files (e.g. Cloudflare R2) and set VITE_MODEL_BASE.
set -euo pipefail
mkdir -p public/models
base=https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models
for f in UVR-MDX-NET-Inst_HQ_3.onnx UVR_MDXNET_KARA_2.onnx; do
  [ -s "public/models/$f" ] || curl -fL --retry 3 -o "public/models/$f" "$base/$f"
done
ls -la public/models
