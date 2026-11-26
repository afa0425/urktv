# URKTV importer setup for Windows + NVIDIA GPU (RTX 50 series needs CUDA 12.8 builds of PyTorch).
# Run in PowerShell:  powershell -ExecutionPolicy Bypass -File pipeline\setup_windows.ps1 -Work D:\urktv-work
# NOT TESTED on a real Windows machine yet: run it with Claude connected so problems get fixed on the spot.
param([string]$Work = "$env:USERPROFILE\urktv-work")
$ErrorActionPreference = 'Stop'
function Have($cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

if (-not (Have python)) { winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements }
if (-not (Have ffmpeg)) { winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements }
if (-not (Have git))    { winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements }
Write-Host "If python/ffmpeg/git were just installed, close and reopen PowerShell, then run this again." -ForegroundColor Yellow

New-Item -ItemType Directory -Force -Path "$Work\models", "$Work\code", "$Work\songs" | Out-Null
python -m venv "$Work\venv"
$py = "$Work\venv\Scripts\python.exe"
& $py -m pip install --upgrade pip
# PyTorch with CUDA 12.8 (Blackwell / RTX 5070 Ti)
& $py -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
& $py -m pip install -r "$PSScriptRoot\requirements.txt"
& $py -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"

if (-not (Test-Path "$Work\code\SOME"))  { git clone --depth 1 https://github.com/openvpi/SOME "$Work\code\SOME" }
if (-not (Test-Path "$Work\code\RMVPE")) { git clone --depth 1 https://github.com/yxlllc/RMVPE "$Work\code\RMVPE" }

$T = 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models'
foreach ($f in 'model_bs_roformer_ep_317_sdr_12.9755.ckpt', 'mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt', 'UVR-DeEcho-DeReverb.pth') {
  if (-not (Test-Path "$Work\models\$f")) { Invoke-WebRequest "$T/$f" -OutFile "$Work\models\$f" }
}
if (-not (Test-Path "$Work\models\some")) {
  Invoke-WebRequest 'https://github.com/openvpi/SOME/releases/download/v1.0.0-baseline/0119_continuous128_5spk.zip' -OutFile "$Work\models\some.zip"
  Expand-Archive "$Work\models\some.zip" "$Work\models\some"; Remove-Item "$Work\models\some.zip"
}
if (-not (Test-Path "$Work\models\rmvpe\model.pt")) {
  Invoke-WebRequest 'https://github.com/yxlllc/RMVPE/releases/download/230917/rmvpe.zip' -OutFile "$Work\models\rmvpe.zip"
  Expand-Archive "$Work\models\rmvpe.zip" "$Work\models\rmvpe"; Remove-Item "$Work\models\rmvpe.zip"
}
Write-Host "Ready. Import a song with:" -ForegroundColor Green
Write-Host "  $py pipeline\import_song.py SONG.mp3 --title ... --artist ... --video <YouTube id> --work $Work --site https://urktv.afa0425.workers.dev --i-have-rights"
