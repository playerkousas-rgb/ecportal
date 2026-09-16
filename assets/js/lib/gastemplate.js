/* ============================================================
   gastemplate.js — 產生 Apps Script (Code.gs) 範本
   用嚟將各旅團 82venture app 嘅資料寫入「後端總 Sheet」
   （一張 Sheet 統管整個 Venture）。
   ============================================================ */

export const SHEET_TABS = ['帳目', '物資', '團員', '收支申報', '通告', '報名', '物資借用', '會議', '設定'];

export function gasTemplate() {
  return `/**
 * ============================================================
 *  82venture · 總表同步 Apps Script（Code.gs）
 *  用法：
 *   1. 開你嘅總 Sheet → 擴充功能 → Apps Script
 *   2. 貼上呢份程式碼（全部取代）
 *   3. 部署 → 新增部署作業 → 類型「網頁應用程式」
 *      執行身分：我　／　具有存取權的使用者：任何人
 *   4. 複製 /exec 網址，貼返 app 內「表格與同步 → 總表同步」
 * ============================================================
 */

/** 簡單保護：設定咗就會檢查 apiKey（可留空 = 唔檢查） */
var API_KEY = 'v82-demo-key';

/** 呢份 Script 會用到嘅分頁名稱（同步／查詢時用） */
var SHEET_TABS = ['帳目', '物資', '團員', '收支申報', '通告', '報名', '物資借用', '會議', '設定'];

/** 每個旅團分開一個 Sheet（工作表）定用同一個 Sheet 加「旅團」欄？ */
var MODE = 'per-unit-sheet';   // 'per-unit-sheet' = 每個旅團獨立工作表；'one-sheet' = 全部用同一張

/** 相片上載（可選）：填咗資料夾 ID 就會將成員影嘅單據存去 Drive
 *  Drive 資料夾 → 共用 → 複製資料夾 ID（/folders/ 之後嗰串） */
var DRIVE_FOLDER_ID = '';

/** 收到 POST 時處理 */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (API_KEY && body.apiKey && body.apiKey !== API_KEY) {
      return json({ ok: false, error: 'API key 唔正確' });
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
    return json({ ok: false, error: '未知 action：' + body.action, got: Object.keys(body || {}), hint: '82venture 支援 action: ping / sync / status / claim / noticeSignup' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  return json({
    ok: true, msg: '82venture 後端已啟動',
    spreadsheet: (function () { try { return SpreadsheetApp.getActiveSpreadsheet().getName(); } catch (err) { return '(未綁定試算表)'; } })(),
    tabs: SHEET_TABS,
    api: ['ping', 'status', 'sync', 'claim', 'noticeSignup'],
    usage: 'APP 內「表格與同步 → 總表同步」填呢個 /exec 網址即可'
  });
}

/* ---------------- 主同步 ---------------- */
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

/* ---------------- 手機記一筆（成員影相＋選欄目） ---------------- */
function appendClaim(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var p = body.payload || {};
  var name = sheetName('待批申報', body.unit || 'UNKNOWN');
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
    (p.photos || []).length, links.join('\\n'), p.id || ''
  ]);
  // 順手寫落「帳目（待批）」總表，方便司庫一眼睇
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

/* ---------------- 物資借用（成員公開頁 borrow.html） ---------------- */
function appendLoan(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var p = body.payload || {};
  var name = sheetName('物資借用', body.unit || 'UNKNOWN');
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(['旅團', '時間', '申請人', '聯絡', '物資編號', '物資', '數量', '借用日', '歸還日', '用途', '狀態', '紀錄編號'])
      .getRange(1, 1, 1, 12).setFontWeight('bold');
  }
  sh.appendRow([
    body.unit || '', new Date(), p.byName || '', p.contact || '', p.itemCode || '', p.itemName || '',
    Number(p.qty) || 1, p.fromDate || '', p.toDate || '', p.purpose || '', '待批核', p.id || ''
  ]);
  return 0;
}

/* ---------------- 公開頁即時報名 ---------------- */
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

/* ---------------- 工具 ---------------- */
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
`;
}

export function gasGuide() {
  return [
    '1. 開你嘅總 Sheet → 擴充功能 → Apps Script',
    '2. 貼上 Code.gs（app 內「表格與同步 → 總表同步 → 下載 Code.gs」）',
    '3. 部署 → 新增部署作業 → 類型：網頁應用程式',
    '4. 執行身分：我　／　具有存取權的使用者：任何人',
    '5. 複製 /exec 網址，貼返 app 嘅「總表同步」',
    '6. 按「測試連線」，成功就可以「立即同步全部」'
  ].join('\n');
}
