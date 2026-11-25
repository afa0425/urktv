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
