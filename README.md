# 全臺普通重型機車考照預約地圖（Cloudflare Workers + Static Assets 即時名額版）

## 專案結構
- `index.html`：前端互動地圖與各站考照時段介面（零建置單檔）。
- `functions/api/quota.js`：Cloudflare Worker / Pages Function，提供 `GET /api/quota?start=YYYY-MM-DD&end=YYYY-MM-DD&examType=first|retake`，於邊緣端代理查詢監理服務網（`mvdis.gov.tw`）剩餘名額並快取 120 秒。
- `wrangler.toml`：Cloudflare Workers（含 Static Assets）部署設定。
- `.assetsignore`：排除非靜態資源檔案，僅將 `index.html` 作為靜態資源發布。

## 部署方式
1. 透過 Wrangler CLI 或 Cloudflare Workers Builds 部署：
   ```bash
   npx wrangler deploy
   ```
   若使用 Cloudflare Dashboard 連結 GitHub 儲存庫（Workers & Pages → Create → Workers）：
   - **Build command**：留空
   - **Deploy command**：`npx wrangler deploy`
2. 部署完成後，前端在 `*.workers.dev`（或 `*.pages.dev`）網域下會自動呼叫 `/api/quota` 取得即時名額。

## 注意事項
- 監理服務網並未提供官方公開 JSON API，且可能會針對部分雲端機房 IP 或高頻率連線進行限流；`quota.js` 已內建 60 秒邊緣快取與分批查詢。若官方改版 HTML 欄位或站點代碼，請對應更新 `functions/api/quota.js` 內的 `STATION_CODES` 與 `parseMvdisHtml`。
