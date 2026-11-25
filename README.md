# 設計文章閱讀器

依「閱讀目的」整理設計、科技、長文與研究網站的最新文章，點開就在頁面裡讀全文，並套用各來源的風格。純靜態網頁，沒有後端：全文抽取在抓取程式裡做好，存進 `data/feed.json`。

## 在自己電腦上跑

需要 Node.js 18 以上。

```bash
cd design-feed
npm install          # 第一次就好：Readability、jsdom、DOMPurify
npm run build        # 抓最新文章與全文，寫入 data/feed.json
npx serve .          # 或 python3 -m http.server，然後開瀏覽器
```

直接雙擊 index.html 不行，瀏覽器會擋 `fetch('data/feed.json')`，要用本機伺服器開。

執行完會印出「來源報告」：每個 feed ✓ 成功（含找到的 feed 網址）或 ✗ 失敗（原因與保留的舊文章數），以及全文狀態統計。

## 三層篩選

1. **閱讀模式**（頂部泡泡，單選）：Pulse、Practice、Inspiration、Deep Read、Research。設定在 `config/modes.json`（名稱、說明、顏色）。
2. **主題**（泡泡下方 chips，可多選）：Any = 符合任一，All = 全部符合。設定在 `config/topics.json`：先比對 feed 自己的 category，再用關鍵字比對標題和摘要，最後補上 feed 的預設主題。
3. **來源**：點卡片左上角的來源名稱，只看這個來源；chips 列會出現「Source … ×」可清除。

另外 chips 最後的 **Saved** 會顯示所有模式裡收藏的文章。篩選狀態都寫在網址（例如 `#mode=deep&topics=AI&match=all`），重新整理或分享都會保留。收藏存在瀏覽器的 localStorage。

## 來源設定 `config/sources.json`

每個來源有：

- `feeds`：一個或多個抓取單位，各自對應一個 `mode` 和 `defaultTags`。同一來源可以有不同模式的 feed（例如 NN/g 的一般文章 → practice、研究報告 → research）。
  - `discover: true`：feed 網址由程式從首頁（或 `discoverFrom`）的 `<link rel="alternate">` 自動找出並實際讀一次確認，結果存在 `config/discovered.json`。刪掉該檔就會重新找。`pick` 是用來從多個 feed 連結裡挑的關鍵字。
  - `url`：已知的 feed 網址。`scrape`：沒有 feed 時爬列表頁。`custom`：特殊抓法（Google Design 的 JSON API）。
- `itemModeRules`：依文章網址改判模式（網站只有一個 feed 時用）。
- `skin`：閱讀頁的設計 token（字體、強調色、背景、文字色、標題字重、圖片樣式、欄寬）。**目前全是佔位值**，字體只用 Google Fonts。沒設定的欄位用 `defaultSkin`。skin 只影響閱讀頁，卡片列表保持統一。

## 全文抽取

1. feed 自己帶全文（`content:encoded` 或 Atom `content`）就直接用。
2. 沒有就抓原網頁，用 Mozilla Readability 抽出內文。
3. 所有 HTML 都經 DOMPurify 消毒，圖片和連結轉成絕對路徑；頁面顯示前會再消毒一次。
4. 狀態 `extractionStatus`：`full`、`excerpt-only`（內文太短或遇到付費牆）、`failed`（抓得到網頁但抽不出內文）。連不上網站的會留空，下次再試。
5. `data/feed.json` 就是快取，已有全文的文章不會重抓。

抓取限制：同一網站一次只發一個請求、間隔至少 1 秒，User-Agent 會表明是個人 RSS 閱讀器。付費牆內容不處理。

全文只供個人閱讀。若放上 GitHub，repo 請設成 Private；GitHub Pages 的網址是公開的，請改用本機開啟，或用有權限控管的方式發布。

### 公開網站的卡片摘要

GitHub 自動更新時（PUBLIC_SITE=1）不存全文、不翻譯，只替每篇新文章產生卡片用的 2–3 句英文摘要，並標出 3–5 個關鍵字。要開啟這個功能，到 repo 的 Settings > Secrets and variables > Actions 新增 `ANTHROPIC_API_KEY`。沒有設定時，卡片照舊顯示 RSS 自帶的摘要。每次最多處理 40 篇（AI_MAX），做過的不會重做。

## 摘要、重點與中文翻譯

閱讀頁的較長摘要、重點、螢光筆重點句和「EN | 中文」切換有兩種來源：

- **Claude 預覽版**：頁面直接請 Claude 產生，用的是你自己 Claude 帳號的額度，結果存在瀏覽器。
- **自己的電腦或網站**：由 `npm run build` 呼叫 Claude API 產生，存進 `data/feed.json`，所有瀏覽器都看得到。

在自己電腦產生的步驟（Windows PowerShell）：

1. 到 https://console.anthropic.com 建立 API key（需要先設定付款）。
2. 在專案資料夾的 PowerShell 打 `$env:ANTHROPIC_API_KEY="你的 key"`（只在這個視窗有效，不會存進檔案）。
3. `npm.cmd install`（第一次加了 @anthropic-ai/sdk，要重裝一次）。
4. `npm.cmd run build`。

已經做過的文章不會重做。可調整：`$env:AI_MAX="100"`（一次最多幾篇，預設 50，0 為不限）、`$env:AI_MODEL="claude-sonnet-5-5"`（換模型，預設 claude-opus-5-5）、`$env:AI_OFF="1"`（這次不做）。

## 自動更新（GitHub Actions）

`.github/workflows/update-feed.yml` 每 6 小時執行 `npm install` 和 `npm run build`，再 commit `data/feed.json` 和 `config/discovered.json`。也可以在 Actions 分頁手動按 Run workflow。
