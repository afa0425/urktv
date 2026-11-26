# 直接部署到 Cloudflare（KV + Worker）

不經過 GitHub Actions、也不用 Cloudflare 的資產上傳通道：網站檔案寫進一個 KV 命名空間，
再部署 `worker.js` 這支小程式把檔案送給瀏覽器。只需要一把有 Workers 編輯權限的 API 金鑰。

```bash
npm run build                       # 產生 dist/（public/catalog 裡的歌會一起打包）
rm -rf /tmp/site && cp -r dist /tmp/site && rm -rf /tmp/site/models   # 模型檔超過 KV 單筆 25MB 上限
python3 deploy/deploy.py <帳戶ID> /tmp/site urktv
```

網址：`https://urktv.<你的 workers 子網域>.workers.dev/`

`deploy.py` 用 `Authorization: Bearer proxy-injected` 呼叫 API：在 Claude 的雲端環境裡，
真正的金鑰由環境的網路代理帶入；在自己電腦上跑，請把那個值換成你的金鑰（例如從環境變數讀）。

## 共享歌庫（`/api/`）

網站本身不附帶歌；歌單和每首歌的灰條、歌詞時間都存在共享歌庫（KV 命名空間 `urktv-songs`），
**只收灰條和歌詞，拒收任何音檔**。

| 路徑 | 做什麼 |
| --- | --- |
| `GET /api/songs` | 歌單 |
| `GET /api/songs/<slug>` | 一首歌的灰條、歌詞、音高曲線 |
| `POST /api/songs` | 上傳（匯入工具用；要 `rights: true`，帶音檔一律拒收） |
| `POST /api/report` | 回報問題 |
| `DELETE /api/songs/<slug>` | 下架（要 `x-admin-key`，版權申訴用） |

上傳：`URKTV_PASS=<網站密碼> python pipeline/upload.py <拆解結果資料夾> --slug ... --title ... --video <YouTube ID> --site <網址> --i-have-rights`

設定管理金鑰：`python3 deploy/deploy.py <帳戶ID> <網站資料夾> urktv --worker-only --admin-key=<金鑰>`
