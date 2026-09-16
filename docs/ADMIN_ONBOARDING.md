# 管理員手冊：每個旅團申請接入時要 SET 乜

最後核實：**2026-09-16**（團長更正設計：**一個後端、兩個前端** —— 進度資料就喺旅團自己嘅後端
（Google Sheet ＋ Apps Script）；執委管理系統同進度前端讀寫同一份，所以管理員**唔需要**設 `portalOrigin` 之類）。
欄位名全部由 code 核對過（`assets/js/lib/units.js`、`assets/js/lib/store.js`、`api/_registry.js`、`api/progress.js`）。

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
  "appType":   "82venture",          // 用嚟分辨係邊個系統送出嘅申請
  "mainSystemUrl": "https://…",      // ← 畀你核對／記錄，唔再係 portalOrigin（見下）
  "contact":   "…",
  "note":      "…",
  "at":        "2026-09-15T…"
}
```

收件匣設定喺 `data/units.json` → **`admin.submitUrl`**
（`api/proxy.js` 嘅 `SCOUT_ADMIN_API`，共用收件匣，用 `appType` 分辨。**如果你嘅 admin GAS 有按 `appType` 過濾，記得加 `'82venture'`**）。

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

### 1c. `unit.json` 入面嘅進度設定（2026-09-16：一個後端、兩個前端）

**注意：`progress` 係由 `unit.json` 讀（`db.profile`），唔係 `units.json`。**
`units.json` 嗰份只係做記錄／種子。

新做法**通常唔使填任何嘢**：執委管理系統會自動用返 `data/units.json` 登記嘅 `backend.gasUrl` / `backend.apiKey`
（即係同一個後端）；要覆蓋先喺「進度 → 設定」填，儲存喺 `profile.progress.backend`（跟 JSON 備份走，唔會出現在網址）。
執委系統**唔會連去任何其他系統** —— 只係讀／寫後端（`?action=load` / `action=save`）。

```jsonc
"progress": {
  "name": "進度追蹤（同一個後端）",
  "backend": {
    "backend": "https://script.google.com/macros/s/…/exec",  // 留空＝用 units.json 登記嘅旅團後端
    "apiKey": "…",                                            // API Key＝執委身份
    "catalogUrl": "",                                          // 留空＝用內建 data/progress/items.json
    "unit": "0100"
  }
}
```

> **API Key 由旅團自己填**（前端「進度 → 設定」，存在旅團自己嘅資料）：主系統由管理員保護（登入／權限），
> 但「經主系統去旅團自己後端」嘅連線係旅團自己嘅事 —— 唔使管理員逐團設定，否則會做到死。
> 伺服器端 env `TROOP_<id>_PROGRESSBACKEND` / `_PROGRESSAPIKEY` / `_PROGRESSCATALOG` 只係部署者自用嘅可選覆蓋。

---

## 2. 另一半（進度前端）

**唔使管理員做任何嘢。** 一個後端、兩個前端：進度資料就喺上面 `backend.gasUrl` 指向嘅同一支 Apps Script，
執委系統同進度前端讀寫同一份。所以：

* 唔使設 `portalOrigin` / `portalRoles`（舊 portal 設計已停用，見 [`archive/PROGRESS_PORTAL_HANDOFF.md`](archive/PROGRESS_PORTAL_HANDOFF.md)）
* 唔使另一張試算表 —— `initializeSheets` 已經建好 `進度追蹤`／`其他獎章`／`待批完成`／`活動履歷`／`待批履歷`／`成員名單`
* API Key：**唔使管理員做嘢** —— 通知旅團登入後去「進度 → 設定」自己填 `/exec` ＋ API Key（想收埋條 Key 先自己用 env 覆蓋）

---

## 3. 每次收到申請嘅 checklist

```
□ 執委管理系統  data/units.json      加 units.<id>（code / name / dataPath / backend.gasUrl / backend.apiKey / notice.submitUrl / theme）
□ 執委管理系統  data/units/<id>/     建資料夾（unit.json / members.json / constitution.json / finance.json / inventory.json）
□ 執委管理系統  unit.json            （可選）填 progress.backend（後端 /exec ＋ API Key 覆蓋用；唔填就用 units.json 登記嗰個）
□ 執委管理系統  後端 Code.gs    用最新範本（npm run build:gas → apps-script/Code.gs）；
                                 執行 initializeSheets 會建「進度追蹤／其他獎章／活動履歷／成員名單」等分頁
□ 通知旅團：登入後去「進度 → 設定」自己填 /exec ＋ API Key（管理員唔使逐團設定；env 只係可選覆蓋）
□ Deploy 一次（同一個 /exec 服務兩個前端）
□ 實測：執委管理系統揀該旅團 → 登入 → 「進度」→ 見到團員同進度（讀後端）
        → 「勾選進度」勾一項 → 去 Google Sheet「進度追蹤」分頁應該見到新一行
        → 「審批中心」睇到團員申報 → 撳「批准」→ 「進度追蹤」分頁多一行（或者更新咗完成日期）
□ 實測：執委管理系統 → 「帳號與系統 → 資料管理 → 總表同步」→ 應該寫入佢自己嘅 Sheet
```

呢個 checklist 喺 app 入面都會自動列出（送出申請之後嘅確認對話框，
`onboard.js` → `adminChecklist()`），方便旅團自己跟進。

---

## 4. 身份欄位（兩邊對人用）

| 執委系統 `members.json` | 進度（同一個後端） | 邊個用 |
| --- | --- | --- |
| `ymis`（10 位數字） | YMIS | **團員／執委** |
| `email` | Email | **領袖** |
| `systemId`（自動產生 `旅團編號-用戶id`） | — | 本系統 fallback，對方認唔到 |

對方登入頁寫住：「成員：YMIS 10位數字 + 密碼；領袖：Email + 密碼」。
所以**唔好**要求領袖填 YMIS。用戶頁會顯示覆蓋率同「未對得上」名單。
