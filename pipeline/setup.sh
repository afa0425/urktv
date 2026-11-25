#!/usr/bin/env bash
# Fetches the code and model weights the decomposition pipeline needs (~2.6 GB of models).
# usage: bash pipeline/setup.sh WORK_DIR
set -euo pipefail
W=${1:?usage: setup.sh WORK_DIR}
mkdir -p "$W/models" "$W/code"
cd "$W"
[ -d code/SOME ] || GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/openvpi/SOME code/SOME
[ -d code/RMVPE ] || GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/yxlllc/RMVPE code/RMVPE
T=https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models
for f in model_bs_roformer_ep_317_sdr_12.9755.ckpt mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt UVR-DeEcho-DeReverb.pth; do
  [ -s "models/$f" ] || curl -fL --retry 3 -o "models/$f" "$T/$f"
done
if [ ! -d models/some ]; then
  curl -fL --retry 3 -o models/some.zip https://github.com/openvpi/SOME/releases/download/v1.0.0-baseline/0119_continuous128_5spk.zip
  mkdir -p models/some && (cd models/some && unzip -oq ../some.zip) && rm models/some.zip
fi
if [ ! -f models/rmvpe/model.pt ]; then
  curl -fL --retry 3 -o models/rmvpe.zip https://github.com/yxlllc/RMVPE/releases/download/230917/rmvpe.zip
  mkdir -p models/rmvpe && (cd models/rmvpe && unzip -oq ../rmvpe.zip) && rm models/rmvpe.zip
fi
echo "ready. run:"
echo "  python pipeline/decompose.py SONG --out OUT --models $W/models --some $W/code/SOME --rmvpe $W/code/RMVPE"
