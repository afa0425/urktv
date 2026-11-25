# 歌曲極致拆解流程

一首歌進來，六層處理，輸出伴奏、主唱、和聲、乾淨主唱，以及評分用的灰條和唱法分析（`song.json`）。

| 層 | 模型 | 產出 |
| --- | --- | --- |
| 1 人聲／伴奏 | BS-RoFormer ep317（SDR 12.98） | `instrumental.wav`、`vocals.wav` |
| 2 主唱／和聲 | Mel-RoFormer Karaoke（aufr33、viperx） | `lead.wav`、`backing.wav` |
| 3 去殘響 | UVR DeEcho-DeReverb | `lead_dry.wav` |
| 4 音高曲線 | RMVPE | 每 10 毫秒的原唱音高 |
| 5 音符 | SOME（歌聲轉音符，音高含小數） | 灰條，一字一格 |
| 6 唱法分析 | 自寫 | 滑音、尾音下滑、長音、抖音、換氣、樂句、最高音、調性、音域、速度、拍點 |

## 使用

```bash
pip install -r pipeline/requirements.txt
bash pipeline/setup.sh ~/hising-work          # 下載程式和模型（約 2.6GB）
python pipeline/decompose.py song.mp3 --out out/ \
  --models ~/hising-work/models --some ~/hising-work/code/SOME --rmvpe ~/hising-work/code/RMVPE
python pipeline/report.py out/ report.png       # 畫出拆解結果
```

每層的結果會存起來，重跑時已完成的層會跳過。

## 速度（實測，4 核 CPU、無顯示卡）

| 層 | 30 秒片段 |
| --- | --- |
| 1 BS-RoFormer | 484 秒 |
| 2 Karaoke | 238 秒 |
| 3 去殘響 | 33 秒 |
| 4–6 | 16 秒 |

CPU 約為歌曲長度的 25 倍，正式營運要用有顯示卡的伺服器；顯示卡上的速度尚未實測。

## 授權

SOME 為 MIT 授權。UVR 系列模型、RMVPE 權重的授權條款尚未確認，商用前要查清楚。
