# 嗨唱 HiSing

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

## 開發

```bash
npm install
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
