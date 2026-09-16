# 新增一個旅團（多旅團部署）

82venture 用 **Git Registry** 方式管理多個旅團（同 VSBADGE 做法一樣）：
`data/units.json` 係唯一註冊處，每個旅團一個資料夾 `data/units/<旅團編號>/`。
唔需要開帳號、唔需要後端，加檔案 + 部署就完成。

```
data/
  units.json          ← 旅團清單（Registry）
  units/
    0082/             ← 第 82 旅（現有）
    0137/             ← 新旅團（例子）
```

---

## 五步完成

### 1. 開一個資料夾

複製 `data/units/0082/` 成 `data/units/<新編號>/`（編號用 4 位數字，例如 `0137`）：

```bash
cp -r data/units/0082 data/units/0137
```

### 2. 改資料夾入面嘅檔案

| 檔案 | 要改嘅內容 |
|---|---|
| `unit.json` | `code`、`name`／`nameEn`、`short`、`region`、`sponsor`、`address`、`founded`、`theme`（主色）、`settings`（團費、津貼、期初結餘、AGM 日期）、`progress`（進度系統網址／Portal 參數）、`inventory`（物資分類） |
| `constitution.json` | 你嘅團章（中英對照）。未寫好可以留 `chapters: []`，之後喺 app 內編輯並發布 |
| `members.json` | 團員名冊，生日欄位格式：`"2006-06-10"`（有年份）或 `"03-26"`（只有月日） |
| `inventory.json` | 物資。可以係空：`"items": []`、`"loans": []`、`"audits": []` |
| `finance.json` | 帳目。可以係空：`"transactions": []`… |
| `meetings.json` | 會議。可以留空 `"meetings": []` |
| `notices.json` | 通告（公開頁 `notice.html?u=<編號>` 會讀呢個檔）。可以留空 `"notices": []`，之後喺 app 內開通告 |
| `tables.json` | 表格設計／自己嘅 Sheet 來源／總表同步設定（可選）。可以唔加，app 會用預設欄位，之後喺「表格與同步」改 |
| `finance.reference.json` | 舊帳參考（可選；**唔會自動入帳**，要喺「財務 → 匯入」按入） |

> 最少要有 `unit.json`，其他檔案冇都可以（系統會用空白資料庫啟動，並喺頂部提示）。

### 3. 註冊喺 `data/units.json`

```json
{
  "schema": 2,
  "defaultUnit": "0082",
  "units": {
    "0082": { "code": "0082", "name": "第八十二旅深資童軍團", "dataPath": "data/units/0082/" },
    "0137": {
      "code": "0137",
      "name": "第一三七旅深資童軍團",
      "nameEn": "137th Venture Scout Unit",
      "short": "137venture",
      "region": "新界東地域",
      "sponsor": "某某中心",
      "dataPath": "data/units/0137/",
      "theme": { "brand700": "#7B2233", "brand800": "#5E1826" },
      "progress": {
        "name": "深資童軍進度及行政平台 (VSBADGE)",
        "url": "https://script.google.com/macros/s/…/exec",
        "mode": "portal",
        "portal": { "unitParam": "0137", "role": "exec_committee", "extraParams": "embed=1" }
      }
    }
  }
}
```

* `dataPath` 一定要以 `/` 結尾
* 只要得一個旅團，可以唔填 `?u=`；多過一個就要用 `?u=0137` 揀旅團

### 4. 部署

Push 上 GitHub → 如果用 GitHub Pages / Netlify / Cloudflare Pages，靜態檔案會自動更新。
**Registry（`data/units.json`）每次開啟頁面都會重新讀取**，所以加旅團之後 refresh 就見到。

開啟方式：

```
https://<你嘅網址>/?u=0137        ← 指定旅團
https://<你嘅網址>/?u=0137&mock=1 ← 用示範資料試玩
```

### 5. 首次設定（喺 app 內）

1. 「帳號與系統 → 帳戶」：改領袖密碼、為執委開帳戶
2. 「財務 → 年度設定」：期初結餘、**AGM 日期**（影響旅年度報告）
3. 「團章 → 公開網址」：填公開頁網址（例如 `https://…/constitution.html?u=0137`），之後 QR Code／分享連結都用佢
4. 「進度」：填 `ymis` 參數同 Portal 設定
5. **「財務 → 收支申報 → 畀成員自己填（QR）」**：貼上 Apps Script `/exec` 網址，
   成員就可以用手機影相＋揀欄目交單（公開頁 `entry.html?u=0137`）
6. **「表格與同步」**：
   * 呢個旅團本身已經有自己嘅 Sheet → 「插入自己嘅 Sheet」貼連結匯入（或匯入完繼續用自己欄位名）
   * 想改欄位名／加欄位（例：加「小隊」「收據編號」）→ 「表格設計」
   * 「總表同步」填 `/exec`，一鍵將全部資料寫入總表（詳見 [MASTER_SHEET.md](MASTER_SHEET.md)）
7. **「通告」**：開第一張通告 → 發布並分享（`notice.html?u=0137&n=<通告編號>`）

> 公開頁面（`constitution.html` / `notice.html` / `entry.html`）都係讀 `data/units/<編號>/…`，
> 所以新旅團部署之後，公開連結會自動用新旅團嘅資料，唔需要改程式。

---

## 常見問題

**問：可唔可以喺 app 內新增旅團？**
答：唔可以 —— 正式旅團一定要經 Git（資料檔案係重點，唔應該只存喺某部電腦嘅瀏覽器）。
不過「帳號與系統 → 旅團設定」可以加**本地旅團**（只存喺呢部機，用嚟測試／試色），會標示「本地」。

**問：兩個旅團嘅資料會唔會撈亂？**
答：唔會。每個旅團用獨立 localStorage key：`venture82.unit.<編號>.db.v2`；
示範資料再獨立一個 key：`venture82.mock.db.v2`。

**問：點樣備份某一旅團？**
答：「帳號與系統 → 資料管理 → 匯出 JSON」（會記錄旅團編號同模式），要還原就匯入同一旅團。

**問：新旅團自己已經有一張帳目 Sheet，要唔要重新入過？**
答：唔需要。用「表格與同步 → 插入自己嘅 Sheet」貼上連結（記得帶 `gid=`、設定「知道連結嘅人可檢視」），
系統會讀欄位、自動對應、預覽之後先匯入；匯入完仲可以喺「表格設計」改成自己習慣嘅欄位名。

**問：可唔可以幾個旅團共用一份團章？**
答：可以。將各旅團嘅 `constitution.json` 內容保持一致，或喺公開頁用 `?src=` 指向同一份 JSON
（例如 GitHub raw 網址）：`constitution.html?src=https://raw.githubusercontent.com/…/constitution.json`。
