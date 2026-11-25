# URKTV

在瀏覽器裡跟著 YouTube 伴唱影片唱歌，即時顯示音準軌道並評分。
純前端、免登入、免伺服器；麥克風聲音只在使用者的裝置上分析，不錄音、不上傳。

## 功能

- **貼上 YouTube 連結就開唱**：影片用 YouTube 官方嵌入播放器播放。
- **即時音準軌道**：麥克風音高偵測（McLeod Pitch Method），捲動式軌道顯示目標音符與你的歌聲。
- **兩種評分**
  - 旋律評分：匯入歌曲的 UltraStar 歌譜（`.txt`），逐音符比對，不分八度，支援黃金音符、升降 Key、三種難度。
  - 自由評分：沒有歌譜時，依音準穩定度、長音、投入程度與音域估算（不比對原曲旋律）。
- **歌詞**：UltraStar 歌譜逐字變色；也可匯入 `.lrc` 只顯示歌詞。
- **點歌佇列**、**演唱紀錄與個人最佳**、分數趨勢圖。
- **30 秒開嗓練習**：內建原創音階練習，不需要影片或歌譜就能試評分。
- 站內搜尋（選用）：在「設定」填入自己的 YouTube Data API 金鑰後可用。
- 繁體中文／English，桌機與手機版面。

## 唱自己的歌：瀏覽器內 AI 去人聲

使用者把自己的音檔（MP3、M4A、WAV、影片檔）丟進「匯入」頁，全部在他的裝置上處理，檔案不上傳：

1. **分離人聲**：開源 UVR MDX-Net 模型（ONNX），用 ONNX Runtime Web 執行；有 WebGPU 用顯示卡，沒有就用多執行緒 CPU。
2. **算出旋律**：從分離出的原唱人聲追蹤音高，切成評分用的音符（灰條）。
3. **存在瀏覽器**：伴奏與原唱存在 IndexedDB，可在「我的歌」裡唱。
4. **唱歌時**：原唱音量 0–100% 可調；升降 Key（不變速，伴奏、導唱、評分音符一起移）；可匯出 UltraStar 歌譜。

| 選項 | 模型 | 效果 |
| --- | --- | --- |
| 去除全部人聲 | UVR-MDX-NET-Inst_HQ_3 | 伴奏最乾淨 |
| 只去主唱、保留和聲 | UVR_MDXNET_KARA_2 | 像 KTV 伴唱帶，保留和聲 |

實測（4 核 CPU、無顯示卡、WASM 4 執行緒）：2 分 13 秒的歌分離約 4.5 分鐘（約 0.5 倍即時）。有 WebGPU 的電腦應會快很多，尚未實測。

### 部署注意

- 匯入頁 `import.html` 需要跨來源隔離（COOP/COEP 標頭）才能用多執行緒；`public/_headers` 已為 Cloudflare Pages / Netlify 設定好。主頁面不隔離，否則 YouTube 播放器會被擋。
- 模型每個 50–67MB，超過 Cloudflare Pages 的單檔上限（25MB）。請放到允許大檔與 CORS 的儲存空間（例如 Cloudflare R2），並在建置時設定 `VITE_MODEL_BASE=https://你的網址/models/`。
- 本機開發先執行 `npm run models` 下載模型到 `public/models/`。
- UVR 模型的授權條款上線前需確認。

## 開發

```bash
npm install
npm run models   # 下載 AI 去人聲模型（約 120MB，只需一次）
npm run dev      # http://localhost:5173
npm test         # 單元測試（音高偵測、歌譜解析、評分、連結解析）
npm run build    # 輸出到 dist/
```

## 部署

`dist/` 是純靜態檔案，可放到任何靜態主機（Cloudflare Pages、GitHub Pages、Netlify、Vercel…）。
**必須使用 HTTPS**，否則瀏覽器不允許使用麥克風。

## 程式結構

| 路徑 | 內容 |
| --- | --- |
| `src/audio/pitch.ts` | 音高偵測（純函式） |
| `src/audio/mic.ts` | 麥克風擷取與平滑 |
| `src/core/chart.ts` | UltraStar / LRC 歌譜解析 |
| `src/core/score.ts` | 旋律評分與自由評分 |
| `src/core/transport.ts` | YouTube 播放器與內建練習的合成器 |
| `src/core/store.ts` | localStorage 資料（設定、佇列、紀錄、歌譜） |
| `src/ui/` | 舞台、音準軌道繪製、各頁面 |

## 注意

- 歌譜檔由使用者自行提供；本專案不內建任何歌曲、歌詞或影片清單。
- 建議戴耳機演唱，避免伴奏被麥克風收進去影響評分。
- 使用 YouTube 嵌入播放器須遵守 YouTube 服務條款（不可下載影片、不可遮蓋播放器）。
