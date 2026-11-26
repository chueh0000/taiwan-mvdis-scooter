# 全臺普通重型機車考照預約地圖（Cloudflare Pages + Functions 即時名額版）

## 專案結構
- `index.html`：前端互動地圖與各站考照時段介面（零建置單檔）。
- `functions/api/quota.js`：Cloudflare Pages Function，提供 `GET /api/quota?date=YYYY-MM-DD&examType=first|retake`，於邊緣端代理查詢監理服務網（`mvdis.gov.tw`）剩餘名額並快取 60 秒。
- `wrangler.toml`：Cloudflare Pages 部署設定。

## 部署方式
1. 解壓縮後執行：
   ```bash
   npx wrangler pages deploy . --project-name=taiwan-mvdis-scooter
   ```
   或將整個資料夾推送至 GitHub 並連結至 Cloudflare Pages（Build command 留空、Build output directory 填 `/`）。
2. 部署完成後，前端在 `*.pages.dev` 網域下會自動呼叫 `/api/quota` 取得即時名額。

## 注意事項
- 監理服務網並未提供官方公開 JSON API，且可能會針對部分雲端機房 IP 或高頻率連線進行限流；`quota.js` 已內建 60 秒邊緣快取與分批查詢。若官方改版 HTML 欄位或站點代碼，請對應更新 `functions/api/quota.js` 內的 `STATION_CODES` 與 `parseMvdisHtml`。
