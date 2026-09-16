# 🗺️ 82venture 旅團部署指南 · 多旅團架構與進度追蹤整合

> 10 分鐘完成部署。本系統（82venture / ecportal）為深資童軍團**執委管理系統**，並與**深資童軍進度追蹤 (vsbadge)** 深度聯邦整合。

---

## 🌟 系統架構概念

### 1. 雙系統聯邦運作 (Hub & Progress Tracker)
* **主系統 (82venture · 執委管理系統)**：
  - 執委會日常行政：會議紀錄、物資借用及庫存（自動扣除）、團章中英對照、活動通告與即時出席回覆（`notice.html`）、成員手機影相快速記帳（`entry.html`）、雙財政年度（AGM 旅年度 ＋ 4/1–3/31 童軍年度）。
  - 各旅團進度入口：點擊「進度」模組自動以 Portal 信任模式單一登入帶入身份至 `vsbadge`。
* **進度系統 (vsbadge · 深資童軍進度追蹤)**：
  - 專注深資童軍各階段獎章、活動段章、專科章及訓練班紀錄與審批。

### 2. 多旅團獨立後端與「雙試算表隔離」原則 (重要原則)
* **每個旅團嚴格維持 2 張獨立 Google Sheet**：
  - **試算表 ①（執委管理系統專屬）**：儲存帳目、收支申報、物資庫存、物資借用、團員名冊、通告發布、報名出席、會議紀錄。
  - **試算表 ②（進度追蹤系統 VSBADGE 專屬）**：儲存深資童軍進度、各階段獎章審批、活動段章履歷、專科章。
  - **❌ 嚴禁合併為單一 Sheet**：
    - **權限與私隱隔離**：執委管理系統涉及全團銀行結餘、單據與內部行政會議；進度系統涉及個別團員考核與領袖審批。分開確保各持所需權限，避免權限外洩。
    - **架構獨立升級**：兩套系統的 Apps Script 腳本與資料結構各自迭代，分開後任一系統升級均不影響另一方運作。
    - **Apps Script 效能**：避免單一試算表過大觸發 Google 執行逾時（Quota Limit）。
* **不能在登入後才下載 GS**：
  在多旅團架構下，新旅團尚未開戶，不可能亦不需要先登入。
  因此 **`Code.gs` 可在首頁／旅團選擇閘／登入頁面免登入直接下載**。
* **流程順序**：
  1. 旅團負責人先下載 `Code.gs`
  2. 在 Google Sheets 建立試算表並部署 Apps Script Web App
  3. 取得 `/exec` URL 及 API Key
  4. 提交給管理員登記進 `data/units.json` 或 Vercel 環境變數
  5. 重新部署後，旅團正式上線！

---

## 🔧 部署五部曲 (所有旅團共通，10 分鐘)

### 第 1 步：下載後端程式碼 (App 內免登入)
- 訪問系統網址（`https://82venture.vercel.app/` 或本地環境）
- 於首頁旅團選擇閘直接點擊 **「⬇️ 下載 Code.gs」** 或 **「📋 複製原始碼」**（全於 App 介面完成，毋須登入，亦毋須進入 Git）

### 第 2 步：建立 Google Sheet
1. 開啟 [Google Sheets](https://sheets.google.com) → 建立新試算表（例如命名為「第82旅 執委會總表」）
2. 點擊上方選單 **「擴充功能」→「Apps Script」**

### 第 3 步：貼上代碼並初始化
1. 清空預設代碼，貼上 `Code.gs` 全部內容
2. 點擊 💾 儲存
3. 函數下拉選單選擇 **`initializeSheets`** → 點擊 **▶ 執行**
4. 依照 Google 提示完成授權（進階 → 前往 → 允許）
5. 系統會自動建立 9 個棗紅主題工作表：
   - `帳目`（收支明細、付款方式、單據編號）
   - `收支申報`（手機 `entry.html` 影相記帳待批資料）
   - `物資`（器材清單、數量、存放位置）
   - `物資借用`（公開頁 `borrow.html` 借用申請）
   - `團員`（YMIS、姓名、身份、生日、職位）
   - `通告`（通告內容、發布狀態、費用、活動日期）
   - `報名`（公開頁 `notice.html` 即時報名與出席回覆）
   - `會議`（會議紀錄、決議）
   - `同步紀錄`（每次總表同步時間與統計）
6. 彈窗會顯示專屬 **API Key**（格式如 `v82_xxxxxxxxxxxxxxxx`）→ **複製保存**（日後可執行 `showApiKey` 再次查看）

### 第 4 步：部署為網頁應用程式 (Web App)
1. 點擊右上角 **「部署」→「新增部署作業」**
2. 點擊齒輪圖示，選擇 **「網頁應用程式」**
3. 設定：
   - 描述：`82venture 82旅`
   - 執行身分：**我**
   - 具有存取權的使用者：**任何人**（Anyone）
4. 點擊「部署」→ 複製 **網頁應用程式網址**（`https://script.google.com/macros/s/…/exec`）

### 第 5 步：登記至系統 (於 App 內送出或交由管理員登記)

於首頁旅團選擇閘點擊 **「新旅團申請接入」** 直接填寫送出，或將以下資料交由系統管理員：

| 欄位 | 範例 | 說明 |
|---|---|---|
| **旅團編號** | `0082` | 4 位數字或自訂編號 |
| **旅團名稱** | 第八十二旅深資童軍團 | 旅團完整中文名稱 |
| **Apps Script URL** | `https://script.google.com/macros/s/…/exec` | 剛部署的 Web App URL |
| **API Key** | `v82_xxxxxxxxxxxxxxxx` | 執行 initializeSheets 獲得的密鑰 |
| **聯絡人** | `scouter@example.hk` | 旅團負責領袖聯絡 |

---

## 🛠️ 管理員登記指南 (Git / Vercel 維護者)

### 方式 A：登記於 Git（`data/units.json`）
在 `data/units.json` 的 `units` 下加入該旅團：
```jsonc
"0082": {
  "code": "0082",
  "name": "第八十二旅深資童軍團",
  "nameEn": "82nd Hong Kong Group Venture Scout Unit",
  "short": "82venture",
  "dataPath": "data/units/0082/",
  "backend": {
    "gasUrl": "https://script.google.com/macros/s/AKfyc.../exec",
    "apiKey": "v82_xxxxxxxxxxxxxxxx"
  },
  "progress": {
    "name": "深資童軍進度及行政平台 (VSBADGE)",
    "url": "https://vsbadge.vercel.app/",
    "mode": "portal",
    "portal": {
      "unitParam": "0082",
      "role": "exec_committee",
      "ymis": "",
      "extraParams": "embed=1"
    }
  }
}
```
並建立 `data/units/<編號>/` 資料夾（複製範本並填入初始 `unit.json`, `members.json`, `constitution.json`, `finance.json`, `inventory.json`）。

### 方式 B：使用 Vercel 環境變數（免改 Git 即可熱更新後端）
在 Vercel 專案 Settings → Environment Variables 加入：
- `TROOP_0082_BACKEND` = `https://script.google.com/macros/s/…/exec`
- `TROOP_0082_APIKEY` = `v82_xxxxxxxxxxxxxxxx`

---

## 🔗 與「深資童軍進度追蹤 (VSBADGE)」無縫聯接

當成員／領袖在 82venture 點選 **「進度」** 模組時：
1. 系統自動組合 Portal SSO 驗證連結：
   ```
   https://vsbadge.vercel.app/?u=0082&role=exec_committee&ymis=PORTAL-0082-EXCO&name=執行委員會&from=portal&src=https://82venture.vercel.app&embed=1
   ```
2. **VSBADGE 端伺服器驗證**：
   - VSBADGE 伺服器端的 `/api/portal` 會核對進入來源網址（`src` 及瀏覽器 `Referer`）是否符合該旅團登記的 `portalOrigin`。
   - 驗證成功後，領袖／執委即以 `exec_committee` 身分免密碼直接登入，享有完整的獎章考核、批核及審批權限！

### 進度系統 (VSBADGE) 端的對應登記
在 VSBADGE 的 `data/troops.json`（或 VSBADGE 的 Vercel env `PORTAL_DEFAULT_ORIGIN`）：
```json
"0082": {
  "name": "第 82 旅",
  "en": "82nd Group",
  "backend": "https://script.google.com/macros/s/.../exec",
  "portalOrigin": "https://82venture.vercel.app",
  "portalRoles": ["exec_committee", "branch_leader", "group_leader"]
}
```

---

## 📊 活動通告出席與進度系統活動履歷 (VSBADGE Activity Log) 聯動評估與整合方案

### 1. 核心需求背景
深資童軍在進度追蹤系統（VSBADGE）中需要累積活動紀錄（如團集會、露營營夜數、遠足歷程、服務時數等）以符合深資童軍獎章（VCS / VAA / DofA）的要求。而在執委管理系統中，通告（Notices）已經完整記錄了活動日期、地點、類別及團員出席回覆（RSVP）。

### 2. 整合與橋接設計（已內建）
在「通告詳情」中，系統已實作 **活動履歷橋接器 (VSBADGE Activity Bridge)**：
1. **自動配對 YMIS**：系統自動將出席名單透過名冊比對出 10 位數字的童軍會籍編號（YMIS），名冊以外回覆則自動標記。
2. **一鍵匯出 VSBADGE 標準格式**：
   - **`匯出活動履歷（VSBADGE CSV）`**：符合進度系統活動履歷格式的 CSV 檔案，可直接匯入進度系統。
   - **`匯出活動履歷（JSON）`**：結構化 Payload，包含旅團編號、活動標題、類別標籤、日期、地點及出席成員列表。
3. **無縫交接**：執委於執委管理系統完成點名後，點擊「匯出活動履歷」即可將出席數據帶到進度系統，供支部領袖進行獎章考核勾選。

### 3. 複雜度與可用性評估 (Evaluation)

| 評估維度 | 評估結論 | 說明 |
|---|---|---|
| **系統複雜度 (Complexity)** | **極低 (Very Low)** | 採用 Loose Coupling（鬆散耦合）架構，透過標準資料交換協定（JSON / CSV / SSO Payload），毋須在底層強行合併 Google Sheets 或跨庫關聯。 |
| **維護性 (Maintainability)** | **極佳 (Excellent)** | 兩邊系統的資料庫與後端各自獨立演進，任何一方更新欄位均不影響另一方，完全避免權限或 Schema 衝突。 |
| **使用者操作體驗 (Usability)** | **極高 (High)** | 執委毋須重複鍵入活動資料與出席名冊，一鍵即可完成資料轉換；配合 Portal SSO，領袖一鍵切換即可審批。 |
| **資料安全性 (Security)** | **100% 隔離** | 財務與內部行政資料留在執委管理系統，進度考核資料留在進度系統，各司其職。 |

---

## 👤 首次使用與登入

### 預設管理帳戶
- **領袖**：帳號 `leader` / 密碼 `8202`
- **執委**：帳號 `exco` / 密碼 `8203`
- **維護超管**：隱藏帳號（不顯示於名單）

首次登入後請前往 **「帳號與系統 → 帳戶」**：
1. 更改領袖與執委密碼
2. 為每位執委開立專屬個人帳號
3. 提示會在完成密碼變更後自動消失

---

## 📱 公開功能連結（成員免登入使用）

| 網址 | 功能說明 |
|---|---|
| `/?u=0082` | 執委會管理後台（領袖／執委登入） |
| `/entry.html?u=0082` | 成員手機拍照快速記帳與報銷申報 |
| `/borrow.html?u=0082` | 成員物資借用線上申請 |
| `/notice.html?u=0082&n=<通告編號>` | 活動通告查閱與 RSVP 出席回覆 |
| `/constitution.html?u=0082` | 旅團團章中英對照公開查閱頁面 |

---
COPYRIGHT 2026 82venture & Scout System
