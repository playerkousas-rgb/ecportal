# 管理員手冊：每個旅團申請接入時要 SET 乜

最後核實：**2026-09-16**（進度系統改咗「直接接駁」——旅團自己填 VSBADGE `/exec` ＋ API Key，
管理員唔再需要設 `portalOrigin`）。欄位名全部由 code 核對過（`assets/js/lib/units.js`、
`assets/js/lib/store.js`、`api/_registry.js`、`api/progress.js`）。

---

## 0. 旅團嗰邊做完乜先會送申請過嚟

旅團喺旅團選擇畫面撳「**新旅團申請接入**」之前，要先起好自己嘅後端：

1. 「帳號與系統 → 資料管理 → 總表同步」下載 `Code.gs`（或者喺首頁旅團選擇畫面直接「下載 Code.gs」）
2. 建新 Google Sheet → 擴充功能 → Apps Script → 貼上 `Code.gs`
3. 執行 `initializeSheets`，複製 **API Key**
4. 部署做**網頁應用程式**（執行身分：我；存取權：任何人），複製 **`/exec` 網址**

送出嚟嘅 payload（`assets/js/lib/onboard.js`）：

```jsonc
{
  "troopId":  "0100",
  "troopName": "第一百旅深資童軍團",
  "scriptUrl": "https://script.google.com/macros/s/AKfyc…/exec",   // ← 佢嘅後端
  "apiKey":    "…",
  "appType":   "82venture",          // vsbadge 嗰邊送嘅係 "vsbadge"
  "mainSystemUrl": "https://…",      // ← 畀你核對／記錄，唔再係 portalOrigin（見下）
  "contact":   "…",
  "note":      "…",
  "at":        "2026-09-15T…"
}
```

收件匣設定喺 `data/units.json` → **`admin.submitUrl`**
（而家指向 VSBADGE 個中央管理員收件匣，即佢 `api/proxy.js` 嘅 `SCOUT_ADMIN_API`，
兩邊共用，用 `appType` 分辨。**如果你嘅 admin GAS 有按 `appType` 過濾，記得加 `'82venture'`**）。

---

## 1. 執委管理系統呢邊要 SET 嘅嘢

### 1a. `data/units.json` → `units.<旅團編號>`

```jsonc
"0100": {
  "code": "0100",
  "name": "第一百旅深資童軍團",
  "nameEn": "100th HK Group Venture Scout Unit",
  "short": "100venture",
  "section": "深資童軍",
  "region": "港島地域",
  "sponsor": "…",
  "address": "…",
  "dataPath": "data/units/0100/",          // ← 必須，決定去邊度讀資料

  "backend": {                              // ← 佢自己嘅後端（申請入面嘅 scriptUrl / apiKey）
    "gasUrl": "https://script.google.com/macros/s/AKfyc…/exec",
    "apiKey": "…"
  },
  "notice": {
    "submitUrl": "https://script.google.com/macros/s/AKfyc…/exec"   // 通常同 gasUrl 一樣
  },
  "theme": { "brand700": "#7B2233", "brand800": "#5E1826", "brand900": "#4A111C",
             "brand600": "#93293D", "brand50": "#FBF1F3", "brand100": "#F2DCE1" }
}
```

**讀邊個欄位（`lib/units.js`）**：

| 欄位 | 用途 |
| --- | --- |
| `units.<id>.dataPath` | `dataPathOf()` —— 去邊度讀 `unit.json` / `members.json` 等 |
| `units.<id>.backend.gasUrl` | `backendOf()` —— 總表同步、手機記帳、通告報名、物資借用全部 POST 去呢度 |
| `units.<id>.backend.apiKey` | `backendOf()` —— 隨 payload 送去 |
| `units.<id>.notice.submitUrl` | 公開通告頁報名（冇填就用 `backend.gasUrl`） |
| `backend`（頂層） | **fallback**：旅團未填自己嘅 `backend` 時先用呢個（`backendOf()` 回傳 `shared: true`） |
| `defaultUnit` | 冇帶 `?u=` 時預設揀邊個旅團 |
| `admin.submitUrl` | 新旅團申請送去邊 |

> ⚠️ **每個旅團應該填自己嘅 `backend.gasUrl`**。頂層 `backend` 只係未有自己後端時嘅臨時 fallback／示範用。

### 1b. `data/units/<旅團編號>/` 資料夾

```
unit.json           ← 旅團資料 + settings + progress（**profile 由呢度讀**）
members.json        ← 名冊（含 ymis / email / birthday）
constitution.json   ← 團章（中英）
finance.json        ← 帳目 / 團費 / 申報 / 預算
inventory.json      ← 物資 / 借用
meetings.json       ← 會議（可選）
```

### 1c. `unit.json` 入面嘅進度系統設定（2026-09-16 起：直接接駁）

**注意：`progress` 係由 `unit.json` 讀（`db.profile`），唔係 `units.json`。**
`units.json` 嗰份只係做記錄／種子。

新做法**唔使管理員代設**：旅團登入之後去「進度 → 設定」填自己嘅 VSBADGE `/exec` 網址同 API Key，
儲存喺 `profile.progress.backend`（會跟 JSON 備份走，唔會出現在網址）。

```jsonc
"progress": {
  "name": "深資童軍進度及行政平台 (VSBADGE)",
  "url": "https://vsbadge.vercel.app/",   // ← 對方**前端**（只係做舊入口連結／揀考核項目定義）
  "backend": {
    "backend": "https://script.google.com/macros/s/…/exec",  // 旅團自己嘅 VSBADGE 後端
    "apiKey": "…",                                            // API Key＝執委身份
    "front": "https://vsbadge.vercel.app/",
    "unit": "0100"
  }
}
```

> 唔想旅團自己填？管理員可以用 Vercel env（伺服器端，優先於前端）：
> `TROOP_<id>_PROGRESSBACKEND` / `TROOP_<id>_PROGRESSAPIKEY` / `TROOP_<id>_PROGRESSFRONT`。

---

## 2. VSBADGE 嗰邊要 SET 嘅嘢

### 2a. `data/troops.json`

```jsonc
"0100": {
  "name": "第 100 旅",
  "en": "100th Group",
  "backend": "https://script.google.com/macros/s/AKfyc…/exec"   // ← 旅團自己嘅 VSBADGE 後端
}
```

> `portalOrigin` / `portalRoles` **唔再需要**（2026-09-16 起改用直接接駁＋API Key）。
> 舊嘅 portal 入口仍然行得通：想用嘅話先照
> [`PROGRESS_PORTAL_HANDOFF.md`](PROGRESS_PORTAL_HANDOFF.md) 設定，否則直接開連結會出 `referer_mismatch`。

### 2b. 或者用環境變數（優先於檔案）

`api/_registry.js` 會讀三種寫法（`id` 原樣 / 大階 / 去前導零）：

```
TROOP_0100_BACKEND      ← 推薦
TROOP_0100_APIKEY
TROOP_100_BACKEND       ← 去前導零版本，都會讀到
TROOP_100_APIKEY
```

其他相關 env：

| 環境變數 | 用途 | 預設 |
| --- | --- | --- |
| `SCOUT_ADMIN_API` | 中央管理員收件匣（新旅團申請） | 已內建一條 |
| `VSBADGE_PROXY_TIMEOUT_MS` | proxy 上游逾時 | `45000` |
| `VSBADGE_PROXY_TEST` | 設 `1` 先允許 `localhost` mock GAS（只限本機測試） | 未設 |

> VSBADGE v3.1 已經支援 `portalOrigin` / `portalRoles` 驗證（`api/portal.js`），
> 但我哋**主要做法**已經改為直接接駁（API Key），所以呢啲欄位只係舊入口先要。
> 詳情同實測記錄見 [`PROGRESS_PORTAL_HANDOFF.md`](PROGRESS_PORTAL_HANDOFF.md)。

---

## 3. 每次收到申請嘅 checklist

```
□ 執委管理系統  data/units.json      加 units.<id>（code / name / dataPath / backend.gasUrl / backend.apiKey / notice.submitUrl / theme）
□ 執委管理系統  data/units/<id>/     建資料夾（unit.json / members.json / constitution.json / finance.json / inventory.json）
□ 執委管理系統  unit.json            填 progress.url（對方前端，揀考核項目定義用）
□ VSBADGE    data/troops.json     加 <id>（name / backend / apikey）
              或者 env            TROOP_<id>_BACKEND / TROOP_<id>_APIKEY
□ （可選）進度用 env 代替旅團自填：TROOP_<id>_PROGRESSBACKEND / TROOP_<id>_PROGRESSAPIKEY / TROOP_<id>_PROGRESSFRONT
□ 兩邊都 deploy 一次
□ 通知旅團：登入 → 「進度 → 設定」填自己嘅 VSBADGE /exec + API Key → 撳「測試連線」
        → 見到團員同進度就成功（之後可以直接勾進度）
□ 實測：執委管理系統揀該旅團 → 登入 → 「帳號與系統 → 資料管理 → 總表同步」→ 應該寫入佢自己嘅 Sheet
```

呢個 checklist 喺 app 入面都會自動列出（送出申請之後嘅確認對話框，
`onboard.js` → `adminChecklist()`），方便旅團自己跟進。

---

## 4. 身份欄位（兩邊對人用）

| 82venture `members.json` | VSBADGE | 邊個用 |
| --- | --- | --- |
| `ymis`（10 位數字） | YMIS | **團員／執委** |
| `email` | Email | **領袖** |
| `systemId`（自動產生 `旅團編號-用戶id`） | — | 本系統 fallback，對方認唔到 |

對方登入頁寫住：「成員：YMIS 10位數字 + 密碼；領袖：Email + 密碼」。
所以**唔好**要求領袖填 YMIS。用戶頁會顯示覆蓋率同「未對得上」名單。
