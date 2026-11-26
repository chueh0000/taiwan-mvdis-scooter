# 全臺普通重型機車考照預約地圖 (Taiwan MVDIS Scooter Exam Map)

整合交通部公路局各區監理所站（含本島與金門、連江、澎湖離島共 31 站）的普通重型機車考照預約資訊，透過 **Cloudflare Workers + Static Assets** 即時串接監理服務網（`mvdis.gov.tw`），提供互動式縣市地圖與未來 30 日可預約區間的每日剩餘名額查詢。

- **線上預覽**：https://taiwan-mvdis-scooter.b10902076.workers.dev
- **資料來源**：[監理服務網 - 考照預約報名](https://www.mvdis.gov.tw/m3-emv-trn/exm/locations)

---

## 功能特色

- **全區間即時名額查詢**：單次載入即彙整全臺 31 個監理站於可預約區間（前 3 日至前 30 日）內的每日上／下午剩餘名額、總餘額與最快可預約日期。
- **初考／重考智慧分類**：自動解析各監理站場次說明，區分「初考領（需參加 2 小時道安講習）」、「重考／吊註銷／持輕機晉級（免講習）」與「合併開放場次」。
- **雙模式互動地圖**：
  - **縣市輪廓地圖（D3 + TopoJSON）**：以顏色與圓點數字即時呈現各縣市剩餘名額狀態（充足、緊張、額滿、無場次），離島採用獨立放大虛線框方便點擊篩選。
  - **方格地圖（Tile Map）**：適合行動裝置快速點選各縣市。
- **多維度快速篩選**：支援依查詢區間（全部 30 日／近 7 日／近 14 日／單日指定）、報考身分別、上／下午時段、星期、區域與「僅顯示尚有名額」進行即時過濾。
- **零建置單檔前端**：前端完全封裝於單一 `index.html`，無需打包步驟；本機離線開啟時自動退回示範名額預覽模式。

---

## 專案結構

```text
.
├── index.html              # 前端互動地圖、篩選器與各站考照時段介面（零建置單檔）
├── functions/
│   └── api/
│       └── quota.js        # Cloudflare Worker / Pages Function 邊緣端名額查詢代理
├── wrangler.toml           # Cloudflare Workers + Static Assets 部署設定
├── .assetsignore           # 限制僅將 index.html 作為公開靜態資源發布
└── README.md               # 專案說明文件
```

---

## API 介面說明

### `GET /api/quota`

於 Cloudflare Edge 代理向監理服務網分批發送 POST 查詢各站 `#trnTable` 場次表，解析後回傳標準化 JSON，並於邊緣端快取 **120 秒**（`Cache-Control: public, max-age=120`）。

#### Query Parameters

| 參數 | 格式／選項 | 預設值 | 說明 |
| :--- | :--- | :--- | :--- |
| `start` | `YYYY-MM-DD` | 臺灣時間今日 `+3` 日 | 查詢起始日期 |
| `end` | `YYYY-MM-DD` | 臺灣時間今日 `+30` 日 | 查詢結束日期 |
| `examType` | `first` \| `retake` | `first` | `first` 為初考領；`retake` 為重考／免講習／輕機晉級 |

#### 回應範例

```json
{
  "start": "2026-11-29",
  "end": "2026-12-26",
  "examType": "first",
  "updatedAt": "23:10:00",
  "stations": {
    "penghu": {
      "dates": [
        {
          "date": "2026-12-01",
          "weekday": 2,
          "am": 3,
          "pm": null,
          "total": 3,
          "combined": false
        }
      ]
    }
  }
}
```

---

## 本機開發與部署

### 1. 本機開發預覽

使用 Wrangler 啟動本機 Workers + Static Assets 測試伺服器：

```bash
npx wrangler dev
```

### 2. 部署至 Cloudflare Workers

#### 方式 A：連結 GitHub 自動部署（Cloudflare Workers Builds）
1. 登入 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Workers** → 連結本 GitHub 儲存庫。
2. Build 設定：
   - **Build command**：*(留空)*
   - **Deploy command**：`npx wrangler deploy`
3. 每次推送至 `main` 分支即會自動上傳 `index.html` 靜態資源並更新 Worker。

#### 方式 B：透過 Wrangler CLI 手動部署

```bash
npx wrangler deploy
```

---

## 注意事項

- 監理服務網並未提供官方公開 JSON API，本專案透過 `functions/api/quota.js` 解析官方預約頁面之 `#trnTable` HTML 表格，並以每批 6 站加上 120 秒 Edge Cache 降低對上游伺服器的請求頻率。
- 若監理服務網調整站點代碼（`dmvNoLv1` / `dmvNo`）或場次說明文字格式，請對應更新 `functions/api/quota.js` 中的 `STATION_CODES`、`classifySessionDesc` 與 `parseMvdisFullRangeHtml`。
- 實際可預約名額仍以點選「線上預約」進入監理服務網系統當下為準。
