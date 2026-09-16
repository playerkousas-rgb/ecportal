/* ============================================================
   tables.js — 表格設計 · 插入自己嘅 Google Sheet · 總表同步

   三個概念：
   1) 表格設計：每個資料表（帳目 / 物資 / 團員 / 通告 / 會議）都可以
      改欄位名、加欄位、刪欄位、改類型 —— 好似內建一個 Google Sheet / Excel
   2) 插入自己嘅 Sheet：其他旅團可以貼自己 Sheet 連結，
      系統會讀欄位、同你對應（mapping），再匯入或定期同步
   3) 總表同步：所有內容可以一次過 POST 去你嘅 Apps Script，
      由 Script 寫入後端「總 Sheet」（一張 Sheet 統管整個 Venture）
   ============================================================ */

import { load, commit, collection, add, update, remove, find } from '../lib/store.js';
import { esc, icon, modal, confirmDlg, toast, uid, nf, todayISO, nowStamp, download, copyText } from '../lib/util.js';
import { toCSV, toWord, download as dlFile, stamp } from '../lib/exporter.js';
import { go, parse, setQuery } from '../lib/router.js';
import { can, current } from '../lib/auth.js';
import { profile, settings } from '../lib/model.js';
import { pageHead, tabs, stat, empty, noteBox, kv, storageBar } from './ui.js';

let tab = 'design';
let mapState = null;        // 自己 Sheet 匯入狀態
let mapSource = null;       // 已載入嘅 sheet 資料

/* ============================================================
   預設表格定義（= app 內建欄位；可以改）
   ============================================================ */
export const DEFAULT_TABLES = {
  transactions: {
    label: '帳目（收支）', icon: 'wallet', collection: 'transactions',
    fields: [
      { key: 'date', label: '日期', type: 'date', required: true, core: true, show: true },
      { key: 'type', label: '類型', type: 'select', options: ['income', 'expense'], optionLabels: ['收入', '支出'], required: true, core: true, show: true },
      { key: 'item', label: '項目', type: 'text', required: true, core: true, show: true },
      { key: 'amount', label: '金額', type: 'number', required: true, core: true, show: true },
      { key: 'category', label: '分類', type: 'select', optionsFrom: 'categories', show: true },
      { key: 'method', label: '收付方式', type: 'select', optionsFrom: 'methods', show: true },
      { key: 'byName', label: '經手人', type: 'text', show: true },
      { key: 'ref', label: '單據號碼', type: 'text', show: true },
      { key: 'period', label: '年度', type: 'text', show: false },
      { key: 'note', label: '備註', type: 'textarea', show: false },
      { key: 'photos', label: '單據相片', type: 'photos', show: false }
    ]
  },
  invItems: {
    label: '物資', icon: 'grid', collection: 'invItems',
    fields: [
      { key: 'code', label: '編號', type: 'text', show: true },
      { key: 'name', label: '名稱', type: 'text', required: true, core: true, show: true },
      { key: 'category', label: '分類', type: 'select', optionsFrom: 'invCategories', show: true },
      { key: 'total', label: '總數量', type: 'number', core: true, show: true },
      { key: 'unit', label: '單位', type: 'text', show: true },
      { key: 'location', label: '存放位置', type: 'text', show: true },
      { key: 'condition', label: '狀況', type: 'select', options: ['良好', '可用', '待修', '損壞'], show: false },
      { key: 'note', label: '備註', type: 'textarea', show: false },
      { key: 'photos', label: '相片', type: 'photos', show: false }
    ]
  },
  invLoans: {
    label: '物資借用', icon: 'clock', collection: 'invLoans',
    fields: [
      { key: 'borrowerName', label: '借用人', type: 'text', required: true, core: true, show: true },
      { key: 'itemName', label: '物資', type: 'text', core: true, show: true },
      { key: 'qty', label: '數量', type: 'number', show: true },
      { key: 'outDate', label: '借用日', type: 'date', show: true },
      { key: 'dueDate', label: '應還日', type: 'date', show: true },
      { key: 'status', label: '狀態', type: 'select', options: ['requested', 'approved', 'out', 'returned', 'rejected', 'cancelled'], optionLabels: ['待批核', '已批核', '借出中', '已歸還', '已拒絕', '已取消'], show: true },
      { key: 'note', label: '備註', type: 'textarea', show: false }
    ]
  },
  members: {
    label: '用戶（領袖／執委／團員）', icon: 'users', collection: 'members',
    fields: [
      { key: 'name', label: '姓名', type: 'text', required: true, core: true, show: true },
      { key: 'eng', label: '英文名', type: 'text', show: false },
      { key: 'identity', label: '身份', type: 'select', options: ['leader', 'exco', 'member'], optionLabels: ['領袖', '執委', '團員'], core: true, show: true },
      { key: 'birthday', label: '出生日期', type: 'date', core: true, show: true },
      { key: 'role', label: '職位', type: 'text', show: true },
      { key: 'status', label: '狀態', type: 'select', options: ['active', 'inactive', 'alumni'], optionLabels: ['現役', '休假', '舊團員'], show: true },
      { key: 'phone', label: '電話', type: 'tel', show: false },
      { key: 'email', label: '電郵', type: 'email', show: false },
      { key: 'join', label: '入團年份', type: 'text', show: false },
      { key: 'ymis', label: '會籍編號（YMIS）', type: 'text', show: true },
      { key: 'systemId', label: '系統 ID', type: 'text', show: false },
      { key: 'note', label: '備註', type: 'textarea', show: false }
    ]
  },
  claims: {
    label: '收支申報', icon: 'note', collection: 'claims',
    fields: [
      { key: 'date', label: '日期', type: 'date', show: true },
      { key: 'type', label: '類型', type: 'select', options: ['income', 'expense'], optionLabels: ['收入', '支出'], show: true },
      { key: 'item', label: '項目', type: 'text', required: true, show: true },
      { key: 'amount', label: '金額', type: 'number', required: true, show: true },
      { key: 'category', label: '分類', type: 'select', optionsFrom: 'categories', show: true },
      { key: 'byName', label: '申報人', type: 'text', show: true },
      { key: 'status', label: '狀態', type: 'select', options: ['pending', 'approved', 'rejected'], optionLabels: ['待批核', '已批核', '已拒絕'], show: true },
      { key: 'note', label: '備註', type: 'textarea', show: false },
      { key: 'photos', label: '單據相片', type: 'photos', show: true }
    ]
  },
  notices: {
    label: '通告', icon: 'megaphone', collection: 'notices',
    fields: [
      { key: 'title.zh', label: '標題（中文）', type: 'text', show: true },
      { key: 'title.en', label: 'Title (EN)', type: 'text', show: false },
      { key: 'type', label: '類型', type: 'text', show: true },
      { key: 'eventDate', label: '活動日期', type: 'date', show: true },
      { key: 'deadline', label: '截止日期', type: 'date', show: true },
      { key: 'venue', label: '地點', type: 'text', show: true },
      { key: 'fee', label: '費用', type: 'text', show: true },
      { key: 'status', label: '狀態', type: 'select', options: ['draft', 'published'], optionLabels: ['草稿', '已發布'], show: true },
      { key: 'body.zh', label: '內容', type: 'textarea', show: false }
    ]
  },
  meetings: {
    label: '會議', icon: 'calendar', collection: 'meetings',
    fields: [
      { key: 'date', label: '日期', type: 'date', show: true },
      { key: 'title', label: '主題', type: 'text', show: true },
      { key: 'venue', label: '地點', type: 'text', show: true },
      { key: 'status', label: '狀態', type: 'text', show: true },
      { key: 'note', label: '備註', type: 'textarea', show: false }
    ]
  }
};

const TYPE_LABEL = {
  text: '文字', textarea: '長文字', number: '數字', date: '日期', tel: '電話',
  email: '電郵', select: '下拉選單', photos: '相片', check: '剔選'
};

/* ---------- 取得（已合併自訂）表格定義 ---------- */
export function tableDefs() {
  const custom = load().tableSchema || {};
  const out = {};
  Object.entries(DEFAULT_TABLES).forEach(([k, def]) => {
    out[k] = { ...def, fields: custom[k]?.fields ? JSON.parse(JSON.stringify(custom[k].fields)) : JSON.parse(JSON.stringify(def.fields)) };
    if (custom[k]?.label) out[k].label = custom[k].label;
  });
  // 自訂表格（用戶自己開嘅表）
  Object.entries(custom).forEach(([k, def]) => {
    if (out[k] || !def.custom) return;
    out[k] = { label: def.label || k, icon: 'table', collection: def.collection || k, custom: true, fields: def.fields || [] };
  });
  return out;
}
export function tableDef(key) { return tableDefs()[key]; }

function saveDef(key, fields, label) {
  const db = load();
  db.tableSchema = { ...(db.tableSchema || {}) };
  db.tableSchema[key] = { ...(db.tableSchema[key] || {}), fields, label: label || db.tableSchema[key]?.label };
  commit();
}
function resetDef(key) {
  const db = load();
  if (db.tableSchema?.[key]) { delete db.tableSchema[key]; commit(); }
}

/* ---------- 讀值（支援 title.zh 呢種路徑） ---------- */
export function fieldValue(row, key) {
  if (key.includes('.')) return key.split('.').reduce((o, k) => (o ? o[k] : ''), row);
  return row?.[key];
}
function cellText(row, f) {
  const v = fieldValue(row, f.key);
  if (f.type === 'photos') return (v || []).length ? `${v.length} 張` : '';
  if (Array.isArray(v)) return v.join('、');
  if (f.type === 'select' && f.options && f.optionLabels) {
    const i = f.options.indexOf(v);
    return i >= 0 ? f.optionLabels[i] : (v ?? '');
  }
  if (v === true) return '✓';
  if (v === false) return '';
  return v === undefined || v === null ? '' : String(v);
}

/* ============================================================
   畫面
   ============================================================ */
export function title() { return '表格'; }

export function render(params) {
  const keys = Object.keys(tableDefs());
  if (params.id && keys.includes(params.id)) tab = params.id;
  else if (params.id === 'design' || params.id === 'source' || params.id === 'sync' || params.id === 'data') tab = params.id;
  else if (params.query?.tab) tab = params.query.tab;
  else if (!keys.includes(tab)) tab = keys[0];

  const defs = tableDefs();
  const isTable = keys.includes(tab);

  return `
  ${pageHead({
    title: '表格與同步',
    sub: '好似內建一個 Google Sheet：欄位自己改，亦可以插入其他旅團自己嘅 Sheet，最後經 Apps Script 寫入總表',
    actions: `
      <button class="btn btn-sm" data-act="export-all-csv">${icon('download', 15)} 全部表格 CSV</button>
      ${can('table.sync') ? `<button class="btn btn-sm" data-go="#/tables/sync">${icon('cloud', 15)} 總表同步</button>` : ''}`
  })}

  ${tabs([
    ...keys.map(k => [k, defs[k].label, (load()[defs[k].collection] || []).length]),
    ['source', '插入自己嘅 Sheet'],
    ['sync', '總表同步'],
    ['data', '儲存與備份']
  ], tab)}

  ${isTable ? designView(tab, defs[tab])
    : tab === 'source' ? sourceView()
    : tab === 'sync' ? syncView()
    : dataView()}`;
}

/* ============================================================
   1. 表格設計
   ============================================================ */
function designView(key, def) {
  const edit = can('table.design');
  const db = load();
  const rows = db[def.collection] || [];
  const shown = def.fields.filter(f => f.show !== false);

  return `
  <div class="grid g-2-1">
    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div><div class="card-title">${esc(def.label)} · 欄位</div>
          <div class="card-sub">改欄位名／加欄位／改類型 —— 只影響顯示同輸入方式，資料唔會唔見</div></div>
          ${edit ? `<div class="row gap-6">
            <button class="btn btn-sm" data-act="add-field">${icon('plus', 15)} 加欄位</button>
            <button class="btn btn-sm" data-act="reset-fields">${icon('refresh', 15)} 還原預設</button>
          </div>` : ''}</div>
        <div style="padding:14px 18px" id="field-list">
          ${def.fields.map((f, i) => fieldRow(f, i, edit)).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">預覽（${rows.length} 筆）</div>
          <div class="card-sub">你設定嘅欄位會咁樣顯示</div></div>
          <div class="row gap-6">
            <button class="btn btn-sm" data-act="exp-table-csv">${icon('download', 15)} CSV</button>
            <button class="btn btn-sm" data-act="exp-table-word">${icon('download', 15)} Word</button>
          </div></div>
        ${rows.length ? `<div class="scroll-x"><table class="table table-compact">
          <thead><tr>${shown.map(f => `<th>${esc(f.label)}</th>`).join('')}</tr></thead>
          <tbody>${rows.slice(0, 12).map(r => `<tr>${shown.map(f => `<td class="sm">${esc(cellText(r, f))}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>${rows.length > 12 ? `<div class="hint" style="padding:8px 16px">（只顯示頭 12 筆）</div>` : ''}`
          : empty('table', '未有資料', '呢個表仲未有紀錄')}
      </div>
    </div>

    <div class="col gap-16">
      <div class="card"><div class="card-head"><div class="card-title">點用</div></div>
        <div style="padding:14px 18px" class="sm muted">
          <ul style="padding-left:18px;line-height:1.85">
            <li><b>改名</b>：例如「經手人」改成「負責人」，全 app 顯示都會跟</li>
            <li><b>加欄位</b>：自己開新欄（例：收據編號、小隊）</li>
            <li><b>隱藏</b>：唔用嘅欄位可以收埋，唔會刪資料</li>
            <li><b>還原</b>：隨時可以還原成預設</li>
          </ul>
          ${noteBox('欄位設計會跟旅團儲存（匯出 JSON 備份會一齊帶走）。', 'info')}
        </div>
      </div>
      <div class="card"><div class="card-head"><div class="card-title">其他旅團可以用自己嘅 Sheet</div></div>
        <div style="padding:14px 18px" class="sm muted">
          貼上自己嘅 Google Sheet 連結（要有 <code>gid=</code>，設定為「知道連結嘅人都可以檢視」），
          系統會讀欄位、幫你對應，之後可以隨時再同步。
          <div class="mt-12"><button class="btn btn-sm btn-block" data-go="#/tables/source">${icon('link', 15)} 插入自己嘅 Sheet</button></div>
        </div>
      </div>
    </div>
  </div>`;
}

function fieldRow(f, i, edit) {
  return `<div class="schema-row" data-field="${i}">
    <input class="input" data-k="label" value="${esc(f.label || '')}" placeholder="欄位名稱" ${edit ? '' : 'disabled'} style="padding:7px 10px">
    <select class="select" data-k="type" ${edit ? '' : 'disabled'} style="padding:7px 10px">
      ${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
    </select>
    <div class="row gap-8 wrap">
      <input class="input" data-k="options" value="${esc((f.options || []).join('、'))}" placeholder="選項（用、分隔）"
        ${edit ? '' : 'disabled'} style="padding:7px 10px;${f.type === 'select' ? '' : 'display:none'}">
      <label class="check xs"><input type="checkbox" data-k="required" ${f.required ? 'checked' : ''} ${edit ? '' : 'disabled'}> 必填</label>
      <label class="check xs"><input type="checkbox" data-k="show" ${f.show === false ? '' : 'checked'} ${edit ? '' : 'disabled'}> 顯示</label>
      ${f.core ? '<span class="badge b-grey xs">核心</span>' : ''}
    </div>
    <div class="row gap-4">
      ${edit ? `<button class="btn btn-xs btn-ghost" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-xs btn-ghost" data-down="${i}" ${i === 0 ? 'disabled' : ''}>↓</button>
        ${f.core ? '' : `<button class="btn btn-xs btn-ghost" data-delf="${i}">${icon('trash', 12)}</button>`}` : '<span class="xs faint">唯讀</span>'}
    </div>
  </div>`;
}

/* ============================================================
   2. 插入自己嘅 Sheet
   ============================================================ */
function sourceView() {
  const sources = load().tableSources || [];
  return `
  <div class="note-box mb-16">${icon('link', 15)}<div>
    其他旅團已經有自己嘅 Google Sheet 都唔怕：貼上連結 → 系統讀欄位 → 你話邊欄對應本系統邊個欄位 → 匯入或定時同步。
    <br><span class="xs">Sheet 要設定分享權限：<b>知道連結嘅任何人均可檢視</b>（因為係公開讀取；只會讀，唔會改你嘅表）。</span>
  </div></div>

  <div class="grid g-2-1">
    <div class="card"><div class="card-head"><div><div class="card-title">1. 貼上你嘅 Sheet 連結</div>
      <div class="card-sub">支援 Google Sheet / 任何 CSV 網址</div></div></div>
      <div style="padding:16px 18px">
        <div class="field"><label class="label">Sheet 網址</label>
          <input class="input" id="s-url" placeholder="https://docs.google.com/spreadsheets/d/…/edit?gid=123456#gid=123456"></div>
        <div class="grid g-2 mt-12" style="gap:12px">
          <div class="field"><label class="label">匯入到</label>
            <select class="select" id="s-target">
              ${Object.entries(tableDefs()).map(([k, d]) => `<option value="${k}">${esc(d.label)}</option>`).join('')}
            </select></div>
          <div class="field"><label class="label">工作表（分頁）名稱／gid</label>
            <input class="input" id="s-gid" placeholder="可留空（用連結內嘅 gid）"></div>
        </div>
        <div class="row gap-8 mt-12 wrap">
          <button class="btn btn-primary" data-act="load-sheet">${icon('download', 16)} 讀取欄位</button>
          <button class="btn" data-act="paste-csv">${icon('copy', 16)} 改為貼上 CSV</button>
        </div>
        <div id="sheet-preview" class="mt-16"></div>
      </div>
    </div>

    <div class="col gap-16">
      <div class="card"><div class="card-head"><div class="card-title">已儲存嘅來源</div></div>
        <div style="padding:8px 0">
          ${sources.length ? sources.map((s, i) => `
            <div class="list-item">
              <span class="stat-ic">${icon(s.kind === 'csv' ? 'note' : 'link', 15)}</span>
              <div class="li-main">
                <div class="li-t">${esc(tableDefs()[s.target]?.label || s.target)}</div>
                <div class="li-s" style="word-break:break-all">${esc(s.kind === 'csv' ? '（貼上嘅 CSV）' : (s.url || '').slice(0, 70))}</div>
              </div>
              <div class="row gap-4">
                <button class="btn btn-xs" data-reload="${i}">同步</button>
                <button class="btn btn-xs btn-ghost" data-delsrc="${i}">${icon('trash', 12)}</button>
              </div>
            </div>`).join('') : '<div style="padding:16px" class="sm faint">未加入任何來源</div>'}
        </div>
      </div>
      <div class="card"><div class="card-head"><div class="card-title">對應唔到會點？</div></div>
        <div style="padding:14px 18px" class="sm muted">
          匯入前一定會有<b>對應表</b>同<b>預覽</b>：你話邊欄入邊欄，唔對應就唔會入。
          同名欄位會自動對好（例如「日期」「金額」「項目」「負責人」）。
          <div class="hint mt-8">如果對方嘅表同本系統完全唔同（例如一張「活動報名表」），
            你可以先「加自訂表」再當佢係獨立表格用。</div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   3. 總表同步（Apps Script → 後端總 Sheet）
   ============================================================ */
function shortUrl(u) {
  if (!u) return '';
  return String(u).replace('https://script.google.com/macros/s/', '…/s/').slice(0, 46) + (String(u).length > 60 ? '…' : '');
}
function syncView() {
  const s = load().sync || {};
  const backend = load().backend || null;
  const log = s.log || [];
  return `
  <div class="note-box mb-16">${icon('cloud', 15)}<div>
    目標：<b>一張 Sheet 統管整個 Venture</b>。每個旅團嘅 app 將自己嘅資料 POST 去 Apps Script，
    由 Script 寫入你嘅總 Sheet（每個旅團分開分頁，或者用「旅團」欄分辨）。<br>
    <span class="xs">同一個後端仲會處理 <b>成員手機記帳</b>（entry.html）同 <b>通告報名</b>（notice.html）—— 三條路都入同一張總表。</span>
  </div></div>

  ${backend ? `<div class="card mb-16"><div class="card-head">
    <div><div class="card-title">${icon('check', 15)} 後端已連接${backend.shared ? '（跟 Registry 共用）' : '（本旅團專用）'}</div>
      <div class="card-sub">${esc(backend.name)}${backend.updated ? ` · 更新 ${esc(backend.updated)}` : ''}</div></div>
    <span class="badge b-ok"><span class="dot"></span>已設定 Apps Script</span>
  </div>
  <div style="padding:12px 16px" class="sm muted">
    <div class="kv-row"><span>總表同步</span><code>${esc(shortUrl(backend.gasUrl))}</code></div>
    <div class="kv-row"><span>手機記帳送出</span><code>${esc(shortUrl(load().settings?.publicEntry?.submitUrl || '')) || '（未設定）'}</code></div>
    <div class="kv-row"><span>通告報名送出</span><code>${esc(shortUrl(load().settings?.notice?.submitUrl || '')) || '（未設定）'}</code></div>
  </div></div>` : ''}

  <div class="grid g-2-1">
    <div class="card"><div class="card-head"><div><div class="card-title">同步設定</div>
      <div class="card-sub">Apps Script Web App 網址（部署時設定「任何人」可存取）</div></div></div>
      <div style="padding:16px 18px">
        <div class="field"><label class="label">Apps Script 網址（/exec）</label>
          <input class="input" id="y-url" value="${esc(s.url || '')}" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <div class="grid g-2 mt-12" style="gap:12px">
          <div class="field"><label class="label">旅團編號</label>
            <input class="input" id="y-unit" value="${esc(s.unit || load().unitCode)}"></div>
          <div class="field"><label class="label">API Key（可留空）</label>
            <input class="input" id="y-key" value="${esc(s.apiKey || '')}" placeholder="範本預設 v82-demo-key"></div>
        </div>
        <label class="check mt-12"><input type="checkbox" id="y-auto" ${s.auto ? 'checked' : ''}> 改動後<b>排隊</b>等同步（防呆：唔會即時送出，要撳「立即同步」先寫入總表）</label>
        ${Number(s.pending) ? `<div class="hint" style="color:var(--warn)">有 <b>${Number(s.pending)}</b> 次改動仲未送去總表。</div>` : ''}
        <label class="check mt-6"><input type="checkbox" id="y-share" ${(load().settings?.publicEntry?.submitUrl || load().settings?.notice?.submitUrl) === s.url ? 'checked' : ''}> <b>同一條網址共用</b>畀「手機記帳」同「通告報名」</label>
        <div class="row gap-8 mt-12 wrap">
          <button class="btn btn-primary" data-act="save-sync">${icon('save', 16)} 儲存設定</button>
          <button class="btn" data-act="test-sync">${icon('send', 16)} 測試連線</button>
          <button class="btn" data-act="push-sync">${icon('cloud', 16)} 立即同步全部</button>
        </div>
        <div class="hint mt-8">未設定網址都用得：所有資料仍然喺瀏覽器，可隨時匯出 CSV／JSON 手動上載去總表。</div>
      </div>
    </div>

    <div class="col gap-16">
      <div class="card"><div class="card-head"><div class="card-title">後端 Apps Script 範本</div></div>
        <div style="padding:14px 18px" class="sm muted">
          下載 <code>Code.gs</code> → 喺你嘅試算表「擴充功能 → Apps Script」貼上 → 部署為網頁應用程式（執行身分：我；存取權：任何人）。
          <div class="col gap-6 mt-12">
            <button class="btn btn-sm btn-block" data-act="dl-gas">${icon('download', 15)} 下載 Code.gs（Apps Script）</button>
            <button class="btn btn-sm btn-block" data-act="dl-schema">${icon('download', 15)} 下載欄位對應表（CSV）</button>
            <button class="btn btn-sm btn-block" data-act="copy-guide">${icon('copy', 15)} 複製部署步驟</button>
          </div>
        </div>
      </div>
      <div class="card"><div class="card-head"><div class="card-title">同步紀錄</div></div>
        <div style="padding:14px 18px">
          ${log.length ? `<div class="sync-log">${log.slice(-12).reverse().map(l => `[${esc(l.at)}] ${esc(l.msg)}`).join('<br>')}</div>`
            : '<div class="sm faint">未有同步紀錄</div>'}
        </div>
      </div>
      <div class="card"><div class="card-head"><div class="card-title">資料統計</div></div>
        <div style="padding:14px 18px">
          ${kv(Object.entries(tableDefs()).map(([k, d]) => [d.label, `${(load()[d.collection] || []).length} 筆`]))}
        </div>
      </div>
    </div>
  </div>

  <div class="card mt-16"><div class="card-head"><div><div class="card-title">送出格式（Payload）</div>
    <div class="card-sub">Apps Script 收到嘅 JSON 就係咁樣</div></div></div>
    <div style="padding:14px 18px">
      <pre class="code">${esc(JSON.stringify(payloadSample(), null, 2))}</pre>
    </div>
  </div>`;
}

function payloadSample() {
  const db = load();
  return {
    action: 'sync',
    unit: db.unitCode,
    unitName: db.profile?.name || db.unit?.name || '',
    at: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(tableDefs()).map(([k, d]) => [d.collection, (db[d.collection] || []).length])),
    tables: Object.fromEntries(Object.entries(tableDefs()).map(([k, d]) => [d.collection, (db[d.collection] || []).slice(0, 2)])),
    schema: Object.fromEntries(Object.entries(tableDefs()).map(([k, d]) => [k, d.fields.map(f => f.label)]))
  };
}

/* ============================================================
   4. 儲存與備份
   ============================================================ */
function dataView() {
  return `
  <div class="grid g-2">
    <div class="card"><div class="card-head"><div><div class="card-title">瀏覽器儲存</div>
      <div class="card-sub">相片最佔位；可以喺下面壓縮、清理或匯出</div></div></div>
      <div style="padding:16px 18px">
        ${storageBar(load())}
        <div class="col gap-8 mt-12">
          <button class="btn btn-sm btn-block" data-act="strip-photos">${icon('trash', 15)} 清理已入帳嘅相片（保留記錄）</button>
          <button class="btn btn-sm btn-block" data-go="#/admin/data">${icon('shield', 15)} 去「資料管理」備份／還原</button>
        </div>
      </div>
    </div>
    <div class="card"><div class="card-head"><div><div class="card-title">全部表格（CSV）</div></div></div>
      <div style="padding:16px 18px" class="col gap-6">
        ${Object.entries(tableDefs()).map(([k, d]) => `<button class="btn btn-sm btn-block" data-exp-one="${k}">${icon('download', 15)} ${esc(d.label)}（${(load()[d.collection] || []).length} 筆）</button>`).join('')}
      </div>
    </div>
  </div>`;
}

/* ============================================================
   Sheet 讀取（gviz JSON）
   ============================================================ */
function parseSheetUrl(url) {
  const u = String(url || '').trim();
  const m = u.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) return null;
  const gidMatch = u.match(/[#&?]gid=([0-9]+)/);
  return { id: m[1], gid: gidMatch ? gidMatch[1] : '' };
}

async function fetchSheet(url, gid) {
  const parsed = parseSheetUrl(url);
  if (!parsed) throw new Error('唔似係 Google Sheet 網址');
  const g = gid || parsed.gid;
  const endpoint = `https://docs.google.com/spreadsheets/d/${parsed.id}/gviz/tq?tqx=out:json${g ? `&gid=${g}` : ''}`;
  const r = await fetch(endpoint, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status + '（請確認已設定「知道連結嘅人都可以檢視」）');
  const txt = await r.text();
  return parseGviz(txt);
}

/** 解析 Google 嘅 gviz JSON（包住 /*O_o*\/ … google.visualization.Query.setResponse(...) ） */
export function parseGviz(text) {
  const m = String(text).match(/setResponse\(([\s\S]*)\);?\s*$/);
  const json = JSON.parse(m ? m[1] : text);
  const cols = (json.table?.cols || []).map(c => ({ id: c.id || '', label: c.label || c.id || '', type: c.type || 'string' }));
  const rows = (json.table?.rows || []).map(r => (r.c || []).map(c => {
    if (!c) return '';
    const v = c.f !== undefined && c.f !== null ? c.f : c.v;
    return v === null || v === undefined ? '' : String(v).trim();
  }));
  return { title: json.table?.title || '', cols, rows };
}

/** 自動對應：同名／相似名 */
export function autoMap(cols, fields) {
  const norm = s => String(s || '').toLowerCase().replace(/[\s_\-（）()【】\[\]]/g, '');
  const ALIAS = {
    date: ['日期', 'date', '時間', '日子'],
    type: ['類型', '收入或支出', '收支', 'type'],
    item: ['項目', 'item', '名稱', 'name', '內容', '收入項目', '支出項目'],
    amount: ['金額', 'amount', '收入', '支出', '銀碼', '價錢'],
    category: ['分類', 'category', '類別'],
    method: ['方式', 'method', '付款方式', '收付方式'],
    byName: ['經手人', '負責人', '付款人', '申報人', 'by', '姓名', 'name'],
    ref: ['單據', '單號', 'ref', '收據'],
    note: ['備註', 'note', 'remark', '說明'],
    code: ['編號', 'code'],
    total: ['數量', 'total', '總數'],
    unit: ['單位', 'unit'],
    location: ['位置', 'location', '存放'],
    name: ['姓名', 'name', '名稱'],
    birthday: ['生日', '出生日期', 'birthday', 'birth'],
    phone: ['電話', 'phone', '手機', '聯絡'],
    email: ['電郵', 'email', 'mail'],
    venue: ['地點', 'venue', '位置'],
    fee: ['費用', 'fee', '收費']
  };
  const map = {};
  cols.forEach((c, i) => {
    const labels = [c.label, c.id].map(norm).filter(Boolean);
    let hit = '';
    for (const f of fields) {
      const names = [norm(f.key), norm(f.label), ...(ALIAS[f.key] || []).map(norm)];
      if (labels.some(l => names.includes(l))) { hit = f.key; break; }
    }
    if (!hit) {
      outer: for (const f of fields) {
        const names = [norm(f.key), norm(f.label), ...(ALIAS[f.key] || []).map(norm)];
        for (const l of labels) {
          if (!l) continue;
          if (names.some(n => n && (n.includes(l) || l.includes(n)) && Math.min(n.length, l.length) >= 2)) { hit = f.key; break outer; }
        }
      }
    }
    map[i] = hit || '';
  });
  return map;
}

/* ============================================================
   匯入
   ============================================================ */
export function rowsFromSheet(sheet, map, fields) {
  const out = [];
  sheet.rows.forEach(r => {
    const row = {};
    let any = false;
    Object.entries(map).forEach(([ci, key]) => {
      if (!key) return;
      const f = fields.find(x => x.key === key);
      let v = r[Number(ci)];
      if (v === undefined) return;
      if (f?.type === 'number') { const n = Number(String(v).replace(/[^0-9.\-]/g, '')); v = Number.isFinite(n) ? n : 0; }
      else if (f?.type === 'select' && f.options?.length) {
        const i = (f.optionLabels || []).indexOf(String(v));
        if (i >= 0) v = f.options[i];
      }
      if (v !== '' && v !== null) any = true;
      row[key] = v;
    });
    if (any) out.push(row);
  });
  return out;
}

/* ============================================================
   總表同步：送出
   ============================================================ */
export function buildPayload({ sample = false } = {}) {
  const db = load();
  const defs = tableDefs();
  const tables = {};
  Object.entries(defs).forEach(([k, d]) => {
    const rows = (db[d.collection] || []).map(r => {
      const o = { ...r };
      // 相片唔會送去 Sheet（只記數量）
      if (Array.isArray(o.photos)) { o.photos = o.photos.length; }
      if (Array.isArray(o.attachments)) { o.attachments = o.attachments.length; }
      if (Array.isArray(o.signups)) { o.signups = o.signups.length; }
      return o;
    });
    tables[d.collection] = sample ? rows.slice(0, 3) : rows;
  });
  const s = db.sync || {};
  return {
    action: sample ? 'ping' : 'sync',
    unit: s.unit || db.unitCode,
    unitName: db.profile?.name || db.unit?.name || '',
    apiKey: s.apiKey || '',
    at: new Date().toISOString(),
    schema: Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, d.fields.map(f => ({ key: f.key, label: f.label, type: f.type }))])),
    counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
    tables
  };
}

export async function pushToMaster({ silent = false } = {}) {
  const s = load().sync || {};
  if (!s.url) {
    const db = load();
    db.sync = {
      ...(db.sync || {}),
      log: [...((db.sync || {}).log || []), { at: new Date().toISOString().slice(0, 19).replace('T', ' '), msg: '✗ 未設定 Apps Script 網址（去「總表同步」填 /exec）' }].slice(-40)
    };
    commit();
    if (!silent) toast('未設定 Apps Script 網址', 'err');
    return { ok: false, msg: '未設定網址' };
  }
  const payload = buildPayload();
  const log = (msg) => {
    const db = load();
    db.sync = { ...(db.sync || {}), log: [...((db.sync || {}).log || []), { at: new Date().toISOString().slice(0, 19).replace('T', ' '), msg }].slice(-40), lastAt: new Date().toISOString() };
    commit();
  };
  try {
    const res = await fetch(s.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const txt = (await res.text()).slice(0, 300);
    const ok = res.ok;
    if (ok) { const d = load(); d.sync = { ...(d.sync || {}), pending: 0 }; }
    log(`${ok ? '✓' : '✗'} HTTP ${res.status} · ${payload.counts ? Object.values(payload.counts).reduce((a, b) => a + b, 0) : 0} 筆 · ${txt.replace(/\s+/g, ' ').slice(0, 80)}`);
    if (!silent) toast(ok ? '已同步到總表' : '同步失敗（' + res.status + '）', ok ? 'ok' : 'err');
    return { ok, msg: txt };
  } catch (e) {
    // 跨網域下瀏覽器可能唔畀讀回應（Apps Script 常見）→ 資料其實可能已經寫入
    const uncertain = /Failed to fetch|NetworkError|load failed|network/i.test(e.message || '');
    log(`${uncertain ? '⚠' : '✗'} ${uncertain ? '已送出，但讀唔到伺服器回應（Apps Script 可能已收到）' : e.message} · ${e.message}`);
    if (!silent) toast(uncertain ? '已送出（讀唔到回應，可能已寫入總表；睇同步紀錄）' : '同步失敗：' + e.message, uncertain ? 'warn' : 'err');
    return { ok: false, pending: uncertain, msg: e.message };
  }
}

/* ============================================================
   mount
   ============================================================ */
export function mount(root, params) {
  const key = Object.keys(tableDefs()).includes(params.id) ? params.id : null;

  /* ---- 欄位設計 ---- */
  if (key) {
    const list = root.querySelector('#field-list');
    const def = tableDefs()[key];
    const fields = def.fields;

    const paint = () => { if (list) { list.innerHTML = fields.map((f, i) => fieldRow(f, i, can('table.design'))).join(''); bind(); } };

    const bind = () => {
      if (!list) return;
      list.querySelectorAll('[data-field]').forEach(row => {
        const i = Number(row.dataset.field);
        row.querySelectorAll('[data-k]').forEach(el => el.addEventListener('change', () => {
          const k = el.dataset.k;
          if (k === 'required') fields[i].required = el.checked;
          else if (k === 'show') fields[i].show = el.checked;
          else if (k === 'options') fields[i].options = String(el.value).split(/[、,，]/).map(x => x.trim()).filter(Boolean);
          else fields[i][k] = el.value;
          saveDef(key, fields);
          paint();
        }));
      });
      list.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => {
        const i = Number(b.dataset.up); [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]]; saveDef(key, fields); paint();
      }));
      list.querySelectorAll('[data-down]').forEach(b => b.addEventListener('click', () => {
        const i = Number(b.dataset.down); [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]]; saveDef(key, fields); paint();
      }));
      list.querySelectorAll('[data-delf]').forEach(b => b.addEventListener('click', () => {
        const f = fields[Number(b.dataset.delf)];
        confirmDlg({ title: '刪除欄位', danger: true, okText: '確定刪除', message: `刪除「${esc(f.label)}」？（已存在嘅資料唔會刪，只係唔再顯示）` })
          .then(ok => { if (!ok) return; fields.splice(Number(b.dataset.delf), 1); saveDef(key, fields); paint(); });
      }));
    };
    paint();

    root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'add-field') {
        const r = await modal({
          title: '加欄位',
          body: `<div class="grid g-2" style="gap:12px">
            <div class="field"><label class="label">欄位名稱</label><input class="input" id="nf-label" placeholder="例：小隊 / 收據編號"></div>
            <div class="field"><label class="label">類型</label><select class="select" id="nf-type">
              ${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></div>
            <div class="field" style="grid-column:1/-1"><label class="label">選項（下拉用，用、分隔）</label>
              <input class="input" id="nf-options" placeholder="例：甲小隊、乙小隊"></div>
          </div>`,
          actions: [{ label: '取消', class: 'btn', value: null },
            { label: '加入', class: 'btn-primary', onClick: el => ({
              label: el.querySelector('#nf-label').value.trim(),
              type: el.querySelector('#nf-type').value,
              options: el.querySelector('#nf-options').value.split(/[、,，]/).map(x => x.trim()).filter(Boolean)
            }) }]
        });
        if (!r || !r.label) return;
        const k = 'x' + Math.random().toString(36).slice(2, 7);
        fields.push({ key: k, label: r.label, type: r.type, options: r.options, show: true });
        saveDef(key, fields); paint(); toast('已加欄位', 'ok');
      }
      if (act === 'reset-fields') {
        if (!(await confirmDlg({ title: '還原預設欄位', danger: true, okText: '確定還原', message: '會還原成系統預設欄位（資料唔會刪）。' }))) return;
        resetDef(key); refresh();
      }
      if (act === 'exp-table-csv') {
        const shown = fields.filter(f => f.show !== false);
        toCSV({
          filename: `${def.label}_${stamp()}.csv`, headers: shown.map(f => f.label),
          rows: (load()[def.collection] || []).map(r => shown.map(f => cellText(r, f)))
        });
        toast('已匯出 CSV', 'ok');
      }
      if (act === 'exp-table-word') {
        const shown = fields.filter(f => f.show !== false);
        const rows = (load()[def.collection] || []).map(r => `<tr>${shown.map(f => `<td>${esc(cellText(r, f))}</td>`).join('')}</tr>`).join('');
        toWord({
          filename: `${def.label}_${stamp()}.doc`, title: def.label, org: profile().name,
          bodyHtml: `<div class="doc-head"><div class="doc-title">${esc(def.label)}</div>
            <div class="doc-sub">${esc(profile().name || '')} · ${esc(todayISO())}</div></div>
            <table><thead><tr>${shown.map(f => `<th>${esc(f.label)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`
        });
        toast('已輸出 Word', 'ok');
      }
      if (act === 'export-all-csv') {
        const defs = tableDefs();
        Object.entries(defs).forEach(([k, d], i) => setTimeout(() => {
          const shown = d.fields.filter(f => f.show !== false);
          toCSV({
            filename: `${d.label}_${stamp()}.csv`, headers: shown.map(f => f.label),
            rows: (load()[d.collection] || []).map(r => shown.map(f => cellText(r, f)))
          });
        }, i * 400));
        toast('正在逐個匯出（瀏覽器會逐個下載）', 'ok');
      }
    }));
  }

  /* ---- 插入自己嘅 Sheet ---- */
  if (params.id === 'source') {
    const preview = root.querySelector('#sheet-preview');

    const showMapping = (sheet) => {
      const target = root.querySelector('#s-target').value;
      const fields = tableDefs()[target].fields;
      const map = autoMap(sheet.cols, fields);
      mapState = { sheet, target, fields, map };
      preview.innerHTML = `
        <div class="note-box info mb-12">${icon('check', 15)}<div>讀到 <b>${sheet.rows.length}</b> 筆、${sheet.cols.length} 欄${sheet.title ? `（工作表：${esc(sheet.title)}）` : ''}。
          下面係自動對應，可以自己改。</div></div>
        <div class="card"><div class="card-head"><div><div class="card-title">欄位對應 → ${esc(tableDefs()[target].label)}</div>
          <div class="card-sub">左邊係你 Sheet 嘅欄，右邊揀本系統嘅欄位</div></div></div>
          <div style="padding:12px 16px">
            ${sheet.cols.map((c, i) => `
              <div class="map-row">
                <div class="sm"><b>${esc(c.label || c.id || `第 ${i + 1} 欄`)}</b>
                  <span class="xs faint">（例：${esc((sheet.rows[0]?.[i] || '').slice(0, 24))}）</span></div>
                <select class="select" data-map="${i}" style="padding:7px 10px">
                  <option value="">— 唔匯入 —</option>
                  ${fields.map(f => `<option value="${esc(f.key)}" ${map[i] === f.key ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
                </select>
              </div>`).join('')}
          </div>
          <div style="padding:0 16px 16px">
            <div class="scroll-x"><table class="table table-compact">
              <thead><tr>${sheet.cols.slice(0, 8).map(c => `<th>${esc(c.label || c.id)}</th>`).join('')}</tr></thead>
              <tbody>${sheet.rows.slice(0, 5).map(r => `<tr>${sheet.cols.slice(0, 8).map((c, i) => `<td class="sm">${esc(String(r[i] ?? '').slice(0, 20))}</td>`).join('')}</tr>`).join('')}</tbody>
            </table></div>
            <div class="row gap-8 mt-12 wrap">
              <button class="btn btn-primary" data-act="do-import">${icon('upload', 16)} 匯入到「${esc(tableDefs()[target].label)}」</button>
              <button class="btn" data-act="save-source">${icon('save', 16)} 儲存做同步來源</button>
              <label class="check"><input type="checkbox" id="s-clear" ${['transactions', 'invItems'].includes(target) ? 'checked' : ''}> 匯入前清空該表（避免重複）</label>
            </div>
          </div>
        </div>`;
      bindImport();
    };

    const bindImport = () => {
      preview.querySelectorAll('[data-map]').forEach(sel => sel.addEventListener('change', () => {
        mapState.map[Number(sel.dataset.map)] = sel.value;
      }));
      preview.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
        const act = b.dataset.act;
        const rows = rowsFromSheet(mapState.sheet, mapState.map, mapState.fields);
        if (!rows.length) { toast('冇任何對應到嘅資料', 'err'); return; }
        if (act === 'do-import') {
          const clear = root.querySelector('#s-clear')?.checked;
          if (!(await confirmDlg({
            title: '匯入資料', danger: clear, okText: '確定匯入',
            message: `會匯入 <b>${rows.length}</b> 筆到「${esc(tableDefs()[mapState.target].label)}」${clear ? '，並且<b>先清空該表</b>' : '（附加，唔會刪原有資料）'}。`
          }))) return;
          const col = tableDefs()[mapState.target].collection;
          if (clear) {
            const db = load();
            db[col] = [];
            commit();
          }
          let n = 0;
          rows.forEach(r => {
            const idKey = mapState.target === 'members' ? 'm' : mapState.target === 'invItems' ? 'g' : 'r';
            add(col, { id: uid(idKey), importedAt: nowStamp(), ...r });
            n++;
          });
          toast(`已匯入 ${n} 筆`, 'ok');
          refresh();
        }
        if (act === 'save-source') {
          const db = load();
          db.tableSources = [...(db.tableSources || []), {
            id: uid('src'), kind: 'sheet', url: root.querySelector('#s-url').value.trim(),
            gid: root.querySelector('#s-gid').value.trim(), target: mapState.target,
            map: mapState.map, at: nowStamp()
          }];
          commit(); toast('已儲存來源（可以隨時再同步）', 'ok'); refresh();
        }
      }));
    };

    root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'load-sheet') {
        const url = root.querySelector('#s-url').value.trim();
        if (!url) { toast('請貼上 Sheet 網址', 'err'); return; }
        preview.innerHTML = '<div class="sm faint">讀取中…</div>';
        try {
          const sheet = await fetchSheet(url, root.querySelector('#s-gid').value.trim());
          if (!sheet.cols.length) throw new Error('讀唔到欄位（可能分頁唔存在或者未開放檢視）');
          showMapping(sheet);
        } catch (e) {
          preview.innerHTML = `<div class="note-box danger">${icon('alert', 15)}<div>讀取失敗：${esc(e.message)}
            <br><span class="xs">請設定 Sheet 分享權限為「知道連結嘅任何人均可檢視」，或者改用「貼上 CSV」。</span></div></div>`;
        }
      }
      if (act === 'paste-csv') {
        const r = await modal({
          title: '貼上 CSV / 表格', wide: true,
          body: `<div class="field"><label class="label">由 Google Sheet 複製（Tab 分隔都得）</label>
            <textarea class="textarea" id="pc-text" style="min-height:170px;font-family:var(--mono);font-size:12.5px"></textarea></div>`,
          actions: [{ label: '取消', class: 'btn', value: null },
            { label: '讀取', class: 'btn-primary', onClick: el => el.querySelector('#pc-text').value }]
        });
        if (!r || !r.trim()) return;
        const { splitCsv } = await import('./finance.js');
        const isTab = (r.split('\n')[0] || '').includes('\t');
        const table = isTab ? r.split(/\r?\n/).filter(l => l.trim()).map(l => l.split('\t')) : splitCsv(r);
        const head = table[0];
        const sheet = {
          title: '（貼上）',
          cols: head.map((h, i) => ({ id: 'c' + i, label: String(h).trim() || `第 ${i + 1} 欄`, type: 'string' })),
          rows: table.slice(1).map(r => head.map((_, i) => String(r[i] ?? '').trim()))
        };
        showMapping(sheet);
      }
    }));

    root.querySelectorAll('[data-reload]').forEach(b => b.addEventListener('click', async () => {
      const src = (load().tableSources || [])[Number(b.dataset.reload)];
      if (!src) return;
      if (src.kind !== 'sheet') { toast('貼上嘅來源要重新貼一次', 'warn'); return; }
      try {
        const sheet = await fetchSheet(src.url, src.gid);
        mapState = { sheet, target: src.target, fields: tableDefs()[src.target].fields, map: src.map || autoMap(sheet.cols, tableDefs()[src.target].fields) };
        showMapping(sheet);
        toast('已重新讀取，可以再匯入', 'ok');
      } catch (e) { toast('讀取失敗：' + e.message, 'err'); }
    }));
    root.querySelectorAll('[data-delsrc]').forEach(b => b.addEventListener('click', () => {
      const db = load();
      db.tableSources = (db.tableSources || []).filter((_, i) => i !== Number(b.dataset.delsrc));
      commit(); toast('已移除來源', 'ok'); refresh();
    }));
  }

  /* ---- 總表同步 ---- */
  if (params.id === 'sync') {
    root.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'save-sync') {
        const db = load();
        const url = root.querySelector('#y-url').value.trim();
        db.sync = {
          ...(db.sync || {}),
          url,
          unit: root.querySelector('#y-unit').value.trim() || db.unitCode,
          apiKey: root.querySelector('#y-key').value.trim(),
          auto: root.querySelector('#y-auto').checked
        };
        const share = root.querySelector('#y-share')?.checked;
        if (share && url) {
          db.settings = { ...(db.settings || {}) };
          db.settings.notice = { ...(db.settings.notice || {}), submitUrl: url };
          db.settings.publicEntry = { ...(db.settings.publicEntry || {}), submitUrl: url };
          db.backend = { ...(db.backend || {}), gasUrl: url, apiKey: db.sync.apiKey };
        }
        commit();
        toast(share && url ? '已儲存，手機記帳／通告報名一齊用同一條網址' : '已儲存同步設定', 'ok');
        refresh();
      }
      if (act === 'test-sync') {
        const db = load();
        db.sync = { ...(db.sync || {}), url: root.querySelector('#y-url').value.trim(), unit: root.querySelector('#y-unit').value.trim(), apiKey: root.querySelector('#y-key').value.trim() };
        commit();
        const res = await pushToMaster({ silent: true });
        toast(res.ok ? '連線成功（已送 ping + 少量樣本）' : '連線失敗：' + res.msg, res.ok ? 'ok' : 'err');
        refresh();
      }
      if (act === 'push-sync') {
        if (!(await confirmDlg({ title: '立即同步', okText: '開始同步', message: '會將全部表格資料送去你嘅 Apps Script（寫入總 Sheet）。' }))) return;
        pushToMaster(); refresh();
      }
      if (act === 'dl-gas') {
        const { gasTemplate } = await import('../lib/gastemplate.js');
        download('Code.gs', gasTemplate(), 'text/plain;charset=utf-8');
        toast('已下載 Code.gs', 'ok');
      }
      if (act === 'dl-schema') {
        const defs = tableDefs();
        toCSV({
          filename: `欄位對應表_${stamp()}.csv`, headers: ['表格', '欄位 key', '顯示名', '類型'],
          rows: Object.entries(defs).flatMap(([k, d]) => d.fields.map(f => [d.label, f.key, f.label, TYPE_LABEL[f.type] || f.type]))
        });
        toast('已下載欄位對應表', 'ok');
      }
      if (act === 'copy-guide') {
        const txt = `【總表同步設定】\n1. 開你嘅 Google Sheet → 擴充功能 → Apps Script\n2. 貼上下載嘅 Code.gs（或 app 內「下載 Code.gs」）\n3. 部署 → 新增部署作業 → 類型：網頁應用程式\n4. 執行身分：我；具有存取權的使用者：任何人\n5. 複製 /exec 網址，貼返「表格 → 總表同步 → Apps Script 網址」\n6. 按「測試連線」，成功就可以「立即同步全部」\n第 7 步（可選）：設定 API Key 加強保護。`;
        if (await copyText(txt)) toast('已複製部署步驟', 'ok');
      }
    }));
  }

  /* ---- 儲存與備份 ---- */
  if (params.id === 'data') {
    root.querySelectorAll('[data-exp-one]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.expOne;
      const d = tableDefs()[k];
      const shown = d.fields.filter(f => f.show !== false);
      toCSV({
        filename: `${d.label}_${stamp()}.csv`, headers: shown.map(f => f.label),
        rows: (load()[d.collection] || []).map(r => shown.map(f => cellText(r, f)))
      });
      toast('已匯出', 'ok');
    }));
    root.querySelectorAll('[data-act="strip-photos"]').forEach(b => b.addEventListener('click', async () => {
      if (!(await confirmDlg({ title: '清理相片', danger: true, okText: '確定清理',
        message: '會移除<b>已入帳</b>嘅帳目相片（保留文字記錄同「有單據」標記）。未批核嘅申報相片唔會清。' }))) return;
      const db = load();
      let n = 0;
      (db.transactions || []).forEach(t => { if ((t.photos || []).length) { n += t.photos.length; t.photos = []; t.receipt = true; } });
      commit();
      toast(`已清理 ${n} 張相片`, 'ok'); refresh();
    }));
  }
}

export function refresh() {
  window.dispatchEvent(new CustomEvent('v82:refresh'));
}
