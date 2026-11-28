#!/usr/bin/env bash
# Downloads the open UVR MDX-Net separation models into public/models/ for local development.
# For production, host them on a CDN that allows large files (e.g. Cloudflare R2) and set VITE_MODEL_BASE.
set -euo pipefail
mkdir -p public/models
base=https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models
for f in UVR-MDX-NET-Inst_HQ_3.onnx UVR_MDXNET_KARA_2.onnx UVR_MDXNET_9482.onnx; do
  [ -s "public/models/$f" ] || curl -fL --retry 3 -o "public/models/$f" "$base/$f"
done
# light AI: Spleeter 2 stems (Deezer, MIT) as ONNX fp16, from the sherpa-onnx project
if [ ! -s public/models/spleeter-accompaniment.onnx ]; then
  tmp=$(mktemp -d)
  curl -fL --retry 3 -o "$tmp/s.tar.bz2" https://github.com/k2-fsa/sherpa-onnx/releases/download/source-separation-models/sherpa-onnx-spleeter-2stems-fp16.tar.bz2
  tar xjf "$tmp/s.tar.bz2" -C "$tmp"
  cp "$tmp"/sherpa-onnx-spleeter-2stems-fp16/vocals.fp16.onnx public/models/spleeter-vocals.onnx
  cp "$tmp"/sherpa-onnx-spleeter-2stems-fp16/accompaniment.fp16.onnx public/models/spleeter-accompaniment.onnx
  rm -rf "$tmp"
fi
ls -la public/models
