/**
 * ============================================================
 *  82venture · 總表同步與多旅團後端 Apps Script（Code.gs）
 *  版本：v2.0.0
 *
 *  功能：
 *   1. 帳目／財務雙年度資料同步
 *   2. 成員名單與 YMIS 跨系統身份管理
 *   3. 物資清單與公開借用申請（borrow.html）
 *   4. 通告發布與即時報名／出席回覆（notice.html）
 *   5. 成員手機影相記帳／收支申報（entry.html）
 *   6. 會議紀錄與操作審計
 *
 *  快速部署步驟：
 *   1. 建立新的 Google Sheet（例如命名為「82旅 執委會總表」）
 *   2. 點擊「擴充功能」→「Apps Script」
 *   3. 清空預設代碼，貼上本程式碼（Code.gs 全部）
 *   4. 點擊「儲存」，函數選單選「initializeSheets」，點「▶ 執行」完成授權與初始化
 *   5. 執行完成後會顯示 API Key，請複製保存
 *   6. 點擊「部署」→「新增部署作業」→ 齒輪「網頁應用程式」
 *      - 執行身分：我
 *      - 具有存取權的使用者：任何人
 *   7. 複製 Web App URL（/exec 結尾）
 *   8. 將 URL 與 API Key 提交給 Git 負責人／管理員登記於 data/units.json 或 Vercel 環境變數
 * ============================================================
 */

/** 呢份 Script 會用到嘅分頁名稱（同步／查詢時用） */
var SHEET_TABS = ['帳目', '物資', '團員', '收支申報', '通告', '報名', '物資借用', '會議', '設定', '同步紀錄',
  '進度追蹤', '其他獎章', '待批完成', '活動履歷', '待批履歷', '成員名單'];

/** 每個旅團分開一個 Sheet（工作表）定用同一個 Sheet 加「旅團」欄？ */
var MODE = 'per-unit-sheet';   // 'per-unit-sheet' = 每個旅團獨立工作表；'one-sheet' = 全部用同一張

/** 相片上載（可選）：填咗資料夾 ID 就會將成員影嘅單據存去 Drive
 *  Drive 資料夾 → 共用 → 複製資料夾 ID（/folders/ 之後嗰串） */
var DRIVE_FOLDER_ID = '';

/* ============================================================
   初始化與 API KEY 管理
   ============================================================ */

/** 取得或自動產生 API Key */
function getApiKey() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('API_KEY');
  if (!key) {
    key = 'v82_' + Utilities.getUuid().replace(/-/g, '').substring(0, 24);
    props.setProperty('API_KEY', key);
  }
  return key;
}

/** 顯示目前 API Key（在 Apps Script 編輯器執行此函數） */
function showApiKey() {
  var apiKey = getApiKey();
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* headless */ }
  if (ui) {
    ui.alert('執委管理系統 API Key', '你嘅旅團 API Key 為：\n\n' + apiKey + '\n\n請複製並交由 Git/Vercel 管理員作登記。', ui.ButtonSet.OK);
  }
  Logger.log('==============================');
  Logger.log('執委管理系統 API Key: ' + apiKey);
  Logger.log('==============================');
  return apiKey;
}

/** 初始化試算表：建立所有必要分頁、設定棗紅標題列及凍結頂列 */
function initializeSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var brandColor = '#7B2233'; // 82venture 棗紅主色
  var headerColor = '#FFFFFF';

  var sheetConfigs = [
    { name: '帳目', headers: ['旅團', 'id', '日期', '類型', '項目', '金額', '分類', '方式', '負責人', '單據編號', '期別', '備註', '同步時間'] },
    { name: '收支申報', headers: ['旅團', '時間', '日期', '類型', '欄目', '項目', '金額', '付款人', '備註', '相片張數', '相片連結', '紀錄編號'] },
    { name: '物資', headers: ['旅團', 'id', '物資編號', '物資名稱', '分類', '總數量', '單位', '存放位置', '狀態', '備註', '同步時間'] },
    { name: '物資借用', headers: ['旅團', '時間', '申請人', '聯絡電話', '物資編號', '物資名稱', '數量', '借用日', '歸還日', '用途', '狀態', '紀錄編號'] },
    { name: '團員', headers: ['旅團', 'id', 'ymis', 'systemId', '姓名', '英文名', '身份', '生日', '職位', '狀態', '電話', '電郵', '加入日期', '備註', '同步時間'] },
    { name: '通告', headers: ['旅團', 'id', '標題(中)', '標題(英)', '類型', '狀態', '活動日期', '截止日期', '地點', '費用', '發布日期', '同步時間'] },
    { name: '報名', headers: ['旅團', '通告編號', '通告標題', '報名時間', '姓名', '聯絡', '出席與否', '全部欄位(JSON)'] },
    { name: '會議', headers: ['旅團', 'id', '日期', '標題', '地點', '狀態', '備註', '同步時間'] },
    { name: '同步紀錄', headers: ['時間', '旅團', '旅團名稱', '統計內容'] },
    /* ↓↓↓ 同「進度前端」共用嘅分頁（一個後端、兩個前端）：欄位順序唔可以改 ↓↓↓ */
    { name: '進度追蹤', headers: ['YMIS', '項目 ID', '完成日期', '更新時間', '確認者', '備註'] },
    { name: '其他獎章', headers: ['YMIS', '獎章 ID', '獎章名稱', '完成日期', '證書編號', '備註', '更新時間'] },
    { name: '待批完成', headers: ['request_id', 'ymis', 'name', 'item_id', 'item_name', 'requested_date', 'evidence', 'status', 'created_at', 'reviewed_by', 'reviewed_at', 'review_note', 'confirmed_date'] },
    { name: '活動履歷', headers: ['record_id', 'type', 'ymis', 'name', 'date', 'title', 'role', 'hours', 'cert_no', 'detail', 'recorder', 'recorded_at', 'updated_at'] },
    { name: '待批履歷', headers: ['request_id', 'kind', 'target_record_id', 'type', 'ymis', 'name', 'date', 'title', 'role', 'hours', 'cert_no', 'detail', 'status', 'created_at', 'reviewed_by', 'reviewed_at', 'review_note'] },
    { name: '成員名單', headers: ['YMIS', '姓名', '加入日期', '支部', '聯絡'] }
  ];

  sheetConfigs.forEach(function(cfg) {
    var sh = ss.getSheetByName(cfg.name);
    if (!sh) sh = ss.insertSheet(cfg.name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(cfg.headers);
      sh.getRange(1, 1, 1, cfg.headers.length)
        .setFontWeight('bold')
        .setBackground(brandColor)
        .setFontColor(headerColor);
      sh.setFrozenRows(1);
    }
  });

  // 確保取得 API Key
  var apiKey = getApiKey();
  var ui = null;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { /* headless */ }
  if (ui) {
    ui.alert(
      '初始化完成！',
      '執委管理系統 所有分頁已建立成功（包括進度追蹤／其他獎章／活動履歷 —— 同進度前端共用同一個後端）！\n\n' +
      '你嘅 API Key 為：\n' + apiKey + '\n\n' +
      '下一步：\n' +
      '1. 點擊「部署」→「新增部署作業」\n' +
      '2. 選擇「網頁應用程式」（執行身分：我；存取權：任何人）\n' +
      '3. 複製 /exec 網址並連同 API Key 交予 Git 管理員登記。',
      ui.ButtonSet.OK
    );
  }
  Logger.log('82venture initialized successfully. API Key: ' + apiKey);
  return { ok: true, apiKey: apiKey };
}

/* ============================================================
   HTTP 請求處理
   ============================================================ */

/** 收到 POST 時處理 */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var expectedKey = PropertiesService.getScriptProperties().getProperty('API_KEY');
    // 兩個前端都會用同一條 key（大寫 apiKey / 細寫 apikey 都收）
    var key = body.apiKey || body.apikey || '';
    body.apiKey = key;

    // 若伺服器端有設定 API_KEY，且請求有傳入 key，進行核對
    if (expectedKey && key && key !== expectedKey) {
      return json({ ok: false, success: false, error: 'API key 唔正確' });
    }

    /* ---- 進度追蹤（同進度前端共用同一個後端；API Key＝執委身份）---- */
    if (body.action === 'save' || body.action === 'saveOtherBadge') {
      if (!expectedKey || key !== expectedKey) {
        return json({ ok: false, success: false, error: '未授權：API Key 唔正確' });
      }
      if (body.action === 'save') {
        var pr = saveProgress(body.changes || [], body.confirmer || '');
        return json({ ok: pr.success === true, success: pr.success === true, processed: pr.processed || 0, error: pr.error || '' });
      }
      var pbo = saveOtherBadges(body.records || []);
      return json({ ok: pbo.success === true, success: pbo.success === true, processed: pbo.processed || 0, error: pbo.error || '' });
    }

    if (body.action === 'ping') return json({ ok: true, msg: 'pong', unit: body.unit, at: body.at });
    if (body.action === 'noticeSignup') {
      appendSignup(body);
      return json({ ok: true, msg: '已記錄報名' });
    }
    if (body.action === 'claim') {
      var saved = appendClaim(body);
      return json({ ok: true, msg: '已記錄，等批核', photos: saved });
    }
    if (body.action === 'loan') {
      var photos = appendLoan(body);
      return json({ ok: true, msg: '已記錄借用申請，等批核', photos: photos });
    }
    if (body.action === 'sync') {
      var counts = syncAll(body);
      return json({ ok: true, msg: '已寫入總表', counts: counts, unit: body.unit, at: body.at });
    }
    if (body.action === 'status' || body.action === 'test') {
      return json({ ok: true, msg: '82venture 後端正常', spreadsheet: SpreadsheetApp.getActiveSpreadsheet().getName(), tabs: SHEET_TABS, at: new Date() });
    }
    // 兼容：冇 action 但係 82venture 嘅資料（當 sync）
    if (!body.action && body.tables) {
      var c2 = syncAll(body);
      return json({ ok: true, msg: '已寫入總表（無 action，當 sync）', counts: c2, unit: body.unit });
    }
    return json({ ok: false, error: '未知 action：' + body.action, got: Object.keys(body || {}), hint: '支援 action: ping / sync / status / claim / noticeSignup / loan / save / saveOtherBadge' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/** 收到 GET 時處理：?action=load 讀進度（兩個前端用同一份資料） */
function doGet(e) {
  var action = '';
  var supplied = '';
  try {
    action = String((e && e.parameter && e.parameter.action) || '');
    supplied = String((e.parameter && (e.parameter.apikey || e.parameter.apiKey)) || '');
  } catch (err0) { action = ''; }
  if (action === 'load') {
    var expected = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (supplied && expected && supplied !== expected) return json({ success: false, ok: false, error: 'Invalid API Key' });
    var data = loadProgressData();
    data.success = true; data.ok = true;
    return json(data);
  }
  return json({
    ok: true,
    msg: '執委管理系統 後端已啟動',
    spreadsheet: (function () { try { return SpreadsheetApp.getActiveSpreadsheet().getName(); } catch (err) { return '(未綁定試算表)'; } })(),
    tabs: SHEET_TABS,
    api: ['ping', 'status', 'sync', 'claim', 'noticeSignup', 'loan', 'load', 'save', 'saveOtherBadge'],
    usage: 'APP 內「帳號與系統 → 資料管理 → 總表同步」填呢個 /exec 網址即可'
  });
}

/* ============================================================
   主同步核心
   ============================================================ */

function syncAll(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var unit = body.unit || 'UNKNOWN';
  var tables = body.tables || {};
  var schema = body.schema || {};
  var counts = {};

  // 帳目（合併「財務」）
  counts['transactions'] = writeTab(ss, body, '帳目', tables.transactions, schema.transactions, ['date', 'type', 'item', 'amount', 'category', 'method', 'byName', 'ref', 'period', 'note']);
  counts['claims'] = writeTab(ss, body, '收支申報', tables.claims, schema.claims, ['date', 'type', 'item', 'amount', 'category', 'byName', 'status', 'note']);
  counts['invItems'] = writeTab(ss, body, '物資', tables.invItems, schema.invItems, ['code', 'name', 'category', 'total', 'unit', 'location', 'condition', 'note']);
  counts['members'] = writeTab(ss, body, '團員', tables.members, schema.members, ['ymis', 'systemId', 'name', 'eng', 'identity', 'birthday', 'role', 'status', 'phone', 'email', 'join', 'note']);

  // 成員名單（同進度前端共用，兩邊見同一批人）
  counts['memberList'] = writeMemberList(ss, tables.members || []);

  // 通告：一張通告一行
  counts['notices'] = writeTab(ss, body, '通告', tables.notices, schema.notices, ['title.zh', 'title.en', 'type', 'status', 'eventDate', 'deadline', 'venue', 'fee', 'publishAt']);

  // 報名：每一份報名一行（由通告內嘅 signups 攤開）
  counts['signups'] = writeSignups(ss, body, tables.notices || []);

  // 物資借用（借出／歸還紀錄）
  counts['invLoans'] = writeTab(ss, body, '物資借用', tables.invLoans, schema.invLoans, ['borrowerName', 'itemName', 'qty', 'outDate', 'dueDate', 'status', 'note']);

  // 會議
  counts['meetings'] = writeTab(ss, body, '會議', tables.meetings, schema.meetings, ['date', 'title', 'venue', 'status', 'note']);

  // 設定（每次更新，方便你睇邊個旅團幾時同步）
  var log = ss.getSheetByName('同步紀錄') || ss.insertSheet('同步紀錄');
  log.appendRow([new Date(), unit, body.unitName || '', JSON.stringify(counts)]);
  log.getRange(1, 1, 1, 4).setFontWeight('bold');

  return counts;
}

/** 寫入一個工作表（每次同步會重寫該旅團嘅資料，避免重複） */
function writeTab(ss, body, baseName, rows, schema, fallbackKeys) {
  rows = rows || [];
  var keys = (schema && schema.length ? schema.map(function (f) { return f.key; }) : fallbackKeys) || [];
  // 加上未定義但有值嘅欄位
  rows.forEach(function (r) {
    Object.keys(r).forEach(function (k) {
      if (keys.indexOf(k) < 0 && k !== 'id' && k !== 'photos' && k !== 'attachments' && k !== 'signups') keys.push(k);
    });
  });
  var header = ['旅團'].concat(['id']).concat(keys).concat(['同步時間']);
  var data = rows.map(function (r) {
    return [body.unit].concat([r.id || '']).concat(keys.map(function (k) { return cell(getPath(r, k)); }))
      .concat([new Date()]);
  });

  var name = sheetName(baseName, body.unit);
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (data.length) sh.getRange(2, 1, data.length, header.length).setValues(data);
  sh.setFrozenRows(1);
  return rows.length;
}

/** 通告報名（攤開） */
function writeSignups(ss, body, notices) {
  var rows = [];
  notices.forEach(function (n) {
    (n.signups || []).forEach(function (s) {
      var v = s.values || {};
      rows.push([body.unit, n.id, n.title && n.title.zh || '', s.at || '', v.name || '', v.contact || '', attendOf(v), JSON.stringify(v)]);
    });
  });
  var name = sheetName('報名', body.unit);
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  var header = ['旅團', '通告編號', '通告標題', '報名時間', '姓名', '聯絡', '出席與否', '全部欄位(JSON)'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  sh.setFrozenRows(1);
  return rows.length;
}

/* ============================================================
   一個後端、兩個前端：進度追蹤
   ------------------------------------------------------------
   呢個後端同時餵兩個前端：
     ① 執委管理系統（呢邊）   ② 進度追蹤前端（團員／領袖用）
   共用分頁：進度追蹤 / 其他獎章 / 待批完成 / 活動履歷 / 待批履歷 / 成員名單
   讀：GET  ?action=load[&apikey=…]
   寫：POST { action:'save' | 'saveOtherBadge', apikey, changes / records }
   ============================================================ */

function textOf(v) { return String(v === null || v === undefined ? '' : v).trim(); }

function dateOf(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    try { return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd'); } catch (err) { /* 用下面嘅 fallback */ }
    try { return v.toISOString().slice(0, 10); } catch (err2) { return String(v); }
  }
  return textOf(v);
}

/** 成員名單：以「成員名單」為主，補上「團員」分頁（執委系統同步過嚟嘅） */
function progressMembers() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = [];
  var seen = {};
  var mSheet = ss.getSheetByName('成員名單');
  if (mSheet) {
    var m = mSheet.getDataRange().getValues();
    for (var i = 1; i < m.length; i++) {
      var ymis = textOf(m[i][0]);
      if (!ymis || seen[ymis]) continue;
      out.push({ ymis: ymis, name: textOf(m[i][1]) });
      seen[ymis] = true;
    }
  }
  var tSheet = null;
  var all = ss.getSheets();
  for (var k = 0; k < all.length; k++) {
    var nm = all[k].getName();
    if (nm === '團員' || nm.indexOf('團員·') === 0) { tSheet = all[k]; break; }
  }
  if (tSheet) {
    var t = tSheet.getDataRange().getValues();
    for (var j = 1; j < t.length; j++) {
      var y2 = textOf(t[j][2]);
      if (!y2 || seen[y2]) continue;
      out.push({ ymis: y2, name: textOf(t[j][4]) });
      seen[y2] = true;
    }
  }
  return out;
}

/** 讀全部進度資料（同進度前端嘅 /exec?action=load 同一種格式） */
function loadProgressData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var progress = {};
  var flat = {};
  var i, rows;

  var pSheet = ss.getSheetByName('進度追蹤');
  if (pSheet) {
    rows = pSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      var ymis = textOf(rows[i][0]);
      var itemId = textOf(rows[i][1]);
      if (!ymis || !itemId) continue;
      if (!progress[ymis]) { progress[ymis] = {}; flat[ymis] = {}; }
      progress[ymis][itemId] = { date: dateOf(rows[i][2]), confirmer: textOf(rows[i][4]) };
      flat[ymis][itemId] = dateOf(rows[i][2]);
    }
  }

  var other = {};
  var oSheet = ss.getSheetByName('其他獎章');
  if (oSheet) {
    rows = oSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      var oy = textOf(rows[i][0]);
      var ob = textOf(rows[i][1]);
      if (!oy || !ob) continue;
      if (!other[oy]) other[oy] = {};
      other[oy][ob] = { name: textOf(rows[i][2]), date: dateOf(rows[i][3]), cert: textOf(rows[i][4]) };
    }
  }

  var pending = [];
  var prSheet = ss.getSheetByName('待批完成');
  if (prSheet) {
    rows = prSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      if (textOf(rows[i][7]) !== 'pending') continue;
      pending.push({
        request_id: textOf(rows[i][0]), ymis: textOf(rows[i][1]), name: textOf(rows[i][2]),
        item_id: textOf(rows[i][3]), item_name: textOf(rows[i][4]),
        requested_date: dateOf(rows[i][5]), evidence: textOf(rows[i][6]),
        status: 'pending', created_at: dateOf(rows[i][8])
      });
    }
  }

  var logs = [];
  var lSheet = ss.getSheetByName('活動履歷');
  if (lSheet) {
    rows = lSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      if (!textOf(rows[i][0])) continue;
      logs.push({
        record_id: textOf(rows[i][0]), type: textOf(rows[i][1]) || 'activity',
        ymis: textOf(rows[i][2]), name: textOf(rows[i][3]), date: dateOf(rows[i][4]),
        title: textOf(rows[i][5]), role: textOf(rows[i][6]), hours: textOf(rows[i][7]),
        cert_no: textOf(rows[i][8]), detail: textOf(rows[i][9]), recorder: textOf(rows[i][10]),
        recorded_at: textOf(rows[i][11])
      });
    }
  }

  var logRequests = [];
  var lrSheet = ss.getSheetByName('待批履歷');
  if (lrSheet) {
    rows = lrSheet.getDataRange().getValues();
    for (i = 1; i < rows.length; i++) {
      if (!textOf(rows[i][0]) || textOf(rows[i][12]) !== 'pending') continue;
      logRequests.push({
        request_id: textOf(rows[i][0]), kind: textOf(rows[i][1]) || 'new',
        target_record_id: textOf(rows[i][2]), type: textOf(rows[i][3]) || 'activity',
        ymis: textOf(rows[i][4]), name: textOf(rows[i][5]), date: dateOf(rows[i][6]),
        title: textOf(rows[i][7]), role: textOf(rows[i][8]), hours: textOf(rows[i][9]),
        cert_no: textOf(rows[i][10]), detail: textOf(rows[i][11]),
        status: 'pending', created_at: textOf(rows[i][13])
      });
    }
  }

  return {
    members: progressMembers(),
    progress: progress,
    flatProgress: flat,
    pendingRequests: pending,
    otherBadges: other,
    logs: logs,
    logsSupported: !!ss.getSheetByName('活動履歷'),
    logRequests: logRequests,
    logRequestsSupported: !!ss.getSheetByName('待批履歷'),
    at: new Date()
  };
}

/** 勾／取消勾（同進度前端寫入同一個分頁） */
function saveProgress(changes, confirmer) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('進度追蹤');
  if (!sheet) return { success: false, error: '搵唔到「進度追蹤」分頁（請先執行 initializeSheets）' };
  var processed = 0;
  (changes || []).forEach(function (c) {
    var ymis = textOf(c.ymis);
    var itemId = textOf(c.itemId);
    if (!ymis || !itemId) return;
    var rows = sheet.getDataRange().getValues();
    var found = false;
    for (var i = 1; i < rows.length; i++) {
      if (textOf(rows[i][0]) === ymis && textOf(rows[i][1]) === itemId) {
        if (c.uncomplete) {
          sheet.deleteRow(i + 1);
        } else {
          sheet.getRange(i + 1, 3).setValue(c.date || '');
          sheet.getRange(i + 1, 4).setValue(new Date());
          sheet.getRange(i + 1, 5).setValue(confirmer || c.confirmer || '');
          sheet.getRange(i + 1, 6).setValue(c.note || '');
        }
        found = true; processed++; break;
      }
    }
    if (!found && !c.uncomplete) {
      sheet.appendRow([ymis, itemId, c.date || '', new Date(), confirmer || c.confirmer || '', c.note || '']);
      processed++;
    }
  });
  return { success: true, processed: processed };
}

/** 其他獎章（服務／活動／訓練班以外嘅證書紀錄） */
function saveOtherBadges(records) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('其他獎章');
  if (!sheet) return { success: false, error: '搵唔到「其他獎章」分頁（請先執行 initializeSheets）' };
  var processed = 0;
  (records || []).forEach(function (r) {
    var ymis = textOf(r.ymis);
    var badgeId = textOf(r.badgeId || r.id);
    if (!ymis || !badgeId) return;
    var rows = sheet.getDataRange().getValues();
    var found = false;
    for (var i = 1; i < rows.length; i++) {
      if (textOf(rows[i][0]) === ymis && textOf(rows[i][1]) === badgeId) {
        if (r.uncomplete) { sheet.deleteRow(i + 1); }
        else {
          sheet.getRange(i + 1, 3).setValue(textOf(r.name));
          sheet.getRange(i + 1, 4).setValue(r.date || '');
          sheet.getRange(i + 1, 5).setValue(textOf(r.cert));
          sheet.getRange(i + 1, 6).setValue(textOf(r.note));
          sheet.getRange(i + 1, 7).setValue(new Date());
        }
        found = true; processed++; break;
      }
    }
    if (!found && !r.uncomplete) {
      sheet.appendRow([ymis, badgeId, textOf(r.name), r.date || '', textOf(r.cert), textOf(r.note), new Date()]);
      processed++;
    }
  });
  return { success: true, processed: processed };
}

/** 成員名單：由執委系統嘅名冊更新（唔會刪人，進度紀錄照樣對得返） */
function writeMemberList(ss, rows) {
  var sh = ss.getSheetByName('成員名單');
  if (!sh) {
    sh = ss.insertSheet('成員名單');
    sh.appendRow(['YMIS', '姓名', '加入日期', '支部', '聯絡']);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold');
  }
  var existing = {};
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) existing[textOf(data[i][0])] = i + 1;
  var n = 0;
  (rows || []).forEach(function (m) {
    var ymis = textOf(m.ymis);
    if (!ymis) return;
    var row = [ymis, textOf(m.name), textOf(m.join || m.joinDate), textOf(m.role || m.branch), textOf(m.phone || m.email)];
    if (existing[ymis]) sh.getRange(existing[ymis], 1, 1, 5).setValues([row]);
    else { sh.appendRow(row); existing[ymis] = sh.getLastRow(); }
    n++;
  });
  return n;
}

/* ============================================================
   公開頁動作：收支申報／物資借用／通告報名
   ============================================================ */

/** 手機記一筆（成員影相＋選欄目） */
function appendClaim(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var p = body.payload || {};
  var name = sheetName('收支申報', body.unit || 'UNKNOWN');
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(['旅團', '時間', '日期', '類型', '欄目', '項目', '金額', '付款人', '備註', '相片張數', '相片連結', '紀錄編號'])
      .getRange(1, 1, 1, 12).setFontWeight('bold');
  }
  var links = savePhotos(p.photos || [], body.unit || '', p.id || '');
  sh.appendRow([
    body.unit || '', new Date(), p.date || '', p.type === 'income' ? '收入' : '支出',
    p.category || '', p.item || '', Number(p.amount) || 0, p.byName || '', p.note || '',
    (p.photos || []).length, links.join('\n'), p.id || ''
  ]);
  return links.length;
}

/** 將 base64 相片存去 Drive（未設定資料夾就只記數量） */
function savePhotos(photos, unit, id) {
  var out = [];
  if (!DRIVE_FOLDER_ID) return out;
  var folder;
  try { folder = DriveApp.getFolderById(DRIVE_FOLDER_ID); } catch (e) { return out; }
  for (var i = 0; i < photos.length; i++) {
    try {
      var ph = photos[i];
      var b64 = String(ph.dataUrl || '').split(',')[1] || '';
      if (!b64) continue;
      var blob = Utilities.newBlob(Utilities.base64Decode(b64), ph.type || 'image/jpeg', unit + '_' + id + '_' + (i + 1) + '.jpg');
      var f = folder.createFile(blob);
      f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      out.push(f.getUrl());
    } catch (e2) { /* 單張失敗唔好中斷 */ }
  }
  return out;
}

/** 物資借用（成員公開頁 borrow.html） */
function appendLoan(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var p = body.payload || {};
  var name = sheetName('物資借用', body.unit || 'UNKNOWN');
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(['旅團', '時間', '申請人', '聯絡電話', '物資編號', '物資名稱', '數量', '借用日', '歸還日', '用途', '狀態', '紀錄編號'])
      .getRange(1, 1, 1, 12).setFontWeight('bold');
  }
  sh.appendRow([
    body.unit || '', new Date(), p.byName || '', p.contact || '', p.itemCode || '', p.itemName || '',
    Number(p.qty) || 1, p.fromDate || '', p.toDate || '', p.purpose || '', '待批核', p.id || ''
  ]);
  return 0;
}

/** 公開頁即時報名（notice.html） */
function appendSignup(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var p = body.payload || {};
  var v = p.values || {};
  var name = sheetName('報名', body.unit || 'UNKNOWN');
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['旅團', '通告編號', '通告標題', '報名時間', '姓名', '聯絡', '出席與否', '全部欄位(JSON)']).getRange(1, 1, 1, 8).setFontWeight('bold');
  }
  sh.appendRow([body.unit || '', p.noticeId || '', p.noticeTitle || '', p.at || new Date(), v.name || '', v.contact || '', attendOf(v), JSON.stringify(v)]);
}

/* ============================================================
   工具函數
   ============================================================ */

function sheetName(base, unit) {
  if (MODE === 'one-sheet') return base;
  return base + '·' + unit;
}

function getPath(obj, path) {
  if (!path) return '';
  return path.split('.').reduce(function (o, k) { return o == null ? '' : o[k]; }, obj);
}

/** 由報名欄位抽出「出席與否」（欄位 key 通常係 attend / rsvp） */
function attendOf(v) {
  if (!v) return '';
  var keys = ['attend', 'rsvp', 'attendance', '出席', '出席與否'];
  for (var i = 0; i < keys.length; i++) {
    if (v[keys[i]] !== undefined && v[keys[i]] !== null && String(v[keys[i]]) !== '') return String(v[keys[i]]);
  }
  return '';
}

function cell(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.length + ' 項';
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
