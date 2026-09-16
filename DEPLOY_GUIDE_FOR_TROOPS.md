# 🗺️ 82venture 旅團部署指南 · 多旅團架構與進度追蹤整合

> 10 分鐘完成部署。本系統（82venture / ecportal）為深資童軍團執委會主系統平台，並與**深資童軍進度追蹤 (vsbadge)** 深度聯邦整合。

---

## 🌟 系統架構概念

### 1. 雙系統聯邦運作 (Hub & Progress Tracker)
* **主系統 (82venture / ecportal)**：
  - 執委會日常行政：會議紀錄、物資借用及庫存（自動扣除）、團章中英對照、活動通告與即時出席回覆（`notice.html`）、成員手機影相快速記帳（`entry.html`）、雙財政年度（AGM 旅年度 ＋ 4/1–3/31 童軍年度）。
  - 各旅團進度入口：點擊「進度」模組自動以 Portal 信任模式單一登入帶入身份至 `vsbadge`。
* **進度系統 (vsbadge)**：
  - 專注深資童軍各階段獎章、活動段章、專科章及訓練班紀錄與審批。

### 2. 多旅團獨立後端與事前登記機制 (重要原則)
* **不能在登入後才下載 GS**：
  在多旅團架構下，新旅團尚未開戶，不可能亦不需要先登入。
  因此 **`Code.gs` 可在首頁／旅團選擇畫面／登入頁面免登入直接下載**。
* **流程順序**：
  1. 旅團負責人先下載 `Code.gs`
  2. 在 Google Sheets 建立試算表並部署 Apps Script Web App
  3. 取得 `/exec` URL 及 API Key
  4. 提交給 Git 負責人登記進 `data/units.json` 或 Vercel 環境變數
  5. 重新部署後，旅團正式上線！

---

## 🔧 部署五部曲 (所有旅團共通，10 分鐘)

### 第 1 步：下載後端程式碼 (免登入)
- 訪問 `https://82venture.vercel.app/`（或本地系統首頁）
- 於旅團選擇閘直接點擊 **「⬇️ 下載 Code.gs」**（亦可在 repository 的 `apps-script/Code.gs` 獲取）

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

### 第 5 步：登記至 Git 與 Vercel

將以下資料提交給 Git 負責人／管理員（或於旅團選擇閘按「新旅團申請接入」自動送出）：

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
