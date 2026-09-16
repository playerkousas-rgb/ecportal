/* ============================================================
   store.js — 資料層（多旅團 · 真實／示範完全分離）

   命名空間（key）：
     真實旅團   venture82.unit.<旅團編號>.db.v2
     示範資料   venture82.mock.db.v2          ← 同真實資料完全隔離，唔會互相污染
     旅團清單   venture82.units.cache.v2 / venture82.units.local.v2
     登入狀態   venture82.session.v2
     目前模式   venture82.mode.v2

   真實資料由 data/units/<編號>/*.json 首次載入時種入本機，
   之後所有改動都寫入上面嘅獨立 key，唔會再寫返 data/ 檔案。
   ============================================================ */

import { todayISO, nowStamp } from './dates.js';
import {
  registry, unitEntry, backendOf, dataPathOf, fetchUnitData, fetchMockData, defaultUnitCode, localUnits
} from './units.js';
import { scoutFYLabel } from './fiscal.js';

export const SCHEMA = 2;

const K = {
  session: 'venture82.session.v2',
  mode: 'venture82.mode.v2',
  unit: 'venture82.currentUnit.v2'
};
export const dbKey = (mode, code) => mode === 'mock' ? `venture82.mock.db.v${SCHEMA}` : `venture82.unit.${code}.db.v${SCHEMA}`;

/* ---------------- 預設帳戶 ----------------
   超管係隱藏帳戶（見 auth.js），唔會出現在呢個名單，亦唔會匯出。 */
export const SEED_ACCOUNTS = [
  {
    id: 'acc_leader', role: 'leader', username: 'leader', name: '團領袖', title: '領袖',
    pw: { algo: 'sha256', salt: 'v82:leader:leader', hash: '1bee77ce443f65f937002876e9b00d2ef2fb5c6fe25fa148c3a32ecebfcad385' },
    pwUpdatedAt: '2026-09-14', seeded: true, defaultPw: true
  },
  {
    id: 'acc_exco', role: 'exco', username: 'exco', name: '執行委員會', title: '執委會',
    pw: { algo: 'sha256', salt: 'v82:exco:exco', hash: 'e70573909c932516077cd2b339499e2d93b0232cf15f518b370403b65b800a32' },
    pwUpdatedAt: '2026-09-14', seeded: true, defaultPw: true
  }
];

export const SEED_ACCOUNTS_MOCK = [
  { id: 'mock_leader', role: 'leader', username: 'demo-leader', name: '示範領袖', title: '團領袖', pw: null, demo: true },
  { id: 'mock_exco', role: 'exco', username: 'demo-exco', name: '示範執委', title: '文書', pw: null, demo: true }
];

/* ---------------- 狀態 ---------------- */
const state = {
  mode: 'real',
  unitCode: null,
  db: null,
  seedSource: '',
  seedFailed: false,
  ready: false
};
let memoryStore = {};   // localStorage 不可用時嘅後備

/* ---------------- storage 包裝 ---------------- */
function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return memoryStore[key] ?? null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, val); } catch { memoryStore[key] = val; }
}
function lsDel(key) {
  try { localStorage.removeItem(key); } catch { delete memoryStore[key]; }
}

/* ---------------- 升級：用戶身份（領袖 / 執委 / 團員） ----------------
   舊資料庫嘅團員紀錄冇 identity 欄。呢度由職位／標籤推算一次，
   之後喺「用戶」頁可以隨時改。回傳 true = 有改動（要 persist）。 */
const IDENTITY_KEYS = ['leader', 'exco', 'member'];
export function migrateIdentities(db) {
  if (!db || !Array.isArray(db.members)) return false;
  let changed = false;
  db.members.forEach(m => {
    if (IDENTITY_KEYS.includes(m.identity)) return;
    const t = `${m.role || ''} ${(m.tags || []).join(' ')}`.toLowerCase();
    m.identity = /(團長|領袖|leader|scouter)/.test(t) ? 'leader'
      : /(執委|執行委員會|exco|committee|主席|司庫|文書)/.test(t) ? 'exco'
        : 'member';
    changed = true;
  });
  return changed;
}

/**
 * 期初結餘遷移：舊版本得一個**全域** settings.openingBalance，
 * 但期初結餘其實係**逐年**嘅 —— 8,803.28 係 2025-26 嘅期初，
 * 唔係 2026-27 嘅期初（2026-27 嘅期初應該係 2025-26 嘅期末 7,846.64）。
 *
 * 如果舊嘅全域數字啱好等於舊帳參考嘅「上年度結餘」，即係用錯咗年度，
 * 呢度會搬返佢去對應年度，並把期末結轉去下一個年度。
 * @returns {boolean} 有冇改動
 */
export function migrateOpeningBalances(db) {
  if (!db || !db.settings) return false;
  const s = db.settings;
  const legacy = Number(s.openingBalance || 0);
  if (!legacy) return false;
  if (s.openingBalances && Object.keys(s.openingBalances).length) return false;  // 已經逐年設定過
  const ref = db.reference || {};
  const refOpen = Number(ref.openingBalance || 0);
  if (!refOpen || Math.abs(refOpen - legacy) > 0.005) return false;               // 唔係同一個數 → 唔亂搬
  const dates = (ref.transactions || []).map(t => String(t.date || '').slice(0, 10)).filter(Boolean).sort();
  if (!dates.length) return false;
  const startMonth = Number(s.scoutFYStartMonth || 4);
  const year = scoutFYLabel(dates[dates.length - 1], startMonth);                 // 由帳目日期推年度
  const y = Number(year.split('-')[0]) + 1;
  const nextYear = `${y}-${String(y + 1).slice(-2)}`;
  const inc = (ref.transactions || []).filter(t => t.type === 'income').reduce((a, t) => a + Number(t.amount || 0), 0);
  const exp = (ref.transactions || []).filter(t => t.type === 'expense').reduce((a, t) => a + Number(t.amount || 0), 0);
  const closing = Math.round((ref.check?.closing ?? (refOpen + inc - exp)) * 100) / 100;
  s.openingBalances = { [year]: refOpen, [nextYear]: closing };
  s.openingBalance = 0;                                                            // 全域欄位還原做「第一筆帳目之前嘅底數」
  s.openingMigratedFrom = { at: nowStamp(), year, nextYear, amount: refOpen, closing };
  return true;
}

/* ---------------- 跨系統身份（federation L1） ----------------
   進度追蹤（VSBADGE）係獨立系統。兩邊要對得上同一個人，就要一個共同 key：
     ymis      會籍編號／YMIS —— **權威** key（人手填，同對面系統一樣）
     systemId  本系統派嘅穩定 ID —— 冇 YMIS 時嘅 fallback（一旦產生就唔會再改）
   冇呢兩個 key，任何同步都只可以靠姓名配對（會撞名、會漏）。 */

/**
 * 產生穩定嘅系統 ID。
 * **必須係確定性嘅** —— 如果用隨機值，每部裝置都會產生唔同嘅 ID，
 * 咁呢個 key 就永遠對唔上，做唔到跨系統配對。所以用「旅團編號-用戶 id」推斷；
 * 兩樣都冇先至退返去隨機（只適用於即時新增、仲未同步嘅紀錄）。
 */
export function newSystemId(unitCode = state.unitCode, memberId = '') {
  if (unitCode && memberId) return `${unitCode}-${memberId}`;
  const c = globalThis.crypto;
  if (c?.randomUUID) return String(c.randomUUID());
  const r = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${Date.now().toString(16)}-${r()}-${r()}-${r()}`;
}

/**
 * 為所有用戶補上 systemId / ymis（已有就唔會改）。
 * @returns {boolean} 有冇改動
 */
export function migrateMemberKeys(db) {
  if (!db || !Array.isArray(db.members)) return false;
  let changed = false;
  db.members.forEach(m => {
    if (!m.systemId) { m.systemId = newSystemId(db.unitCode, m.id); changed = true; }
    if (m.ymis === undefined) { m.ymis = ''; changed = true; }
  });
  return changed;
}

/* ---------------- 種子資料 ---------------- */
function blankDb(mode, code, entry = {}) {
  return {
    schema: SCHEMA,
    kind: mode,
    unitCode: code,
    unit: { code, name: entry.name || code, nameEn: entry.nameEn || '', short: entry.short || code, theme: entry.theme || {} },
    settings: {
      currency: 'HK$', feePerYear: 360, feePeriodLabel: '', subsidyPercent: 30, subsidyCap: 70,
      openingBalance: 0, openingBalanceDate: todayISO().slice(0, 4) + '-04-01',
      scoutFYStartMonth: 4, scoutFYStartDay: 1,
      agmDates: [{ year: new Date().getFullYear(), date: '', note: '未設定' }],
      publicBaseUrl: ''
    },
    accounts: mode === 'mock' ? SEED_ACCOUNTS_MOCK : SEED_ACCOUNTS,
    constitution: { version: '0.1', status: 'draft', title: { zh: '團章', en: 'Constitution' }, preamble: { zh: '', en: '' }, chapters: [], appendices: [], history: [] },
    members: [], meetings: [], notices: [],
    tableSchema: {}, tableSources: [], sync: null, backend: null,
    transactions: [], claims: [], fees: [], budgets: [],
    categories: {
      income: ['團費', '活動費', '資助', '捐款', '售賣物品', '利息', '其他收入'],
      expense: ['場地', '活動', '物資', '文書', '交通', '膳食', '訓練', '服務', '雜項']
    },
    methods: ['現金', '轉數快 FPS', '銀行轉賬', '自動扣賬', '支票', 'PayMe', '其他'],
    invItems: [], invLoans: [], invAudits: [], invNextCode: 'G-001',
    auditLog: [],
    meta: { createdAt: nowStamp(), updatedAt: nowStamp(), seedSource: mode === 'mock' ? 'data/mock/' : (entry.local ? '（本地旅團：空白資料）' : (dataPathOf(code) || '')), real: mode === 'real' }
  };
}

async function buildSeed(mode, code) {
  const entry = unitEntry(code) || {};
  const db = blankDb(mode, code, entry);
  const pick = (mode === 'mock') ? fetchMockData : ((f) => fetchUnitData(code, f));

  const [unit, cons, members, finance, inventory, meetings, finRef, notices, tables] = await Promise.all([
    pick('unit.json'), pick('constitution.json'), pick('members.json'),
    pick('finance.json'), pick('inventory.json'), pick('meetings.json'),
    pick('finance.reference.json'), pick('notices.json'), pick('tables.json')
  ]);
  const got = [unit, cons, members, finance, inventory, meetings, finRef, notices, tables].filter(Boolean).length;
  if (!got) { db.meta.seedFailed = true; return db; }

  if (unit) {
    db.unit = { ...db.unit, ...unit };
    if (unit.settings) db.settings = { ...db.settings, ...unit.settings };
    db.profile = { ...(unit || {}) };
  } else { db.profile = db.unit; }
  if (cons && Array.isArray(cons.chapters)) db.constitution = cons;
  if (members && Array.isArray(members.members)) db.members = members.members;
  if (finance) {
    db.transactions = finance.transactions || [];
    db.claims = finance.claims || [];
    db.fees = finance.fees || [];
    db.budgets = finance.budgets || [];
    if (finance.categories) db.categories = finance.categories;
    if (finance.methods) db.methods = finance.methods;
  }
  /* 參考資料（舊帳）只放入 db.reference，永遠唔會自動寫入 db.transactions */
  const refSrc = (finRef && Array.isArray(finRef.transactions)) ? finRef
               : (finance && finance.reference ? finance : null);
  if (refSrc) {
    db.reference = {
      openingBalance: Number(refSrc.openingBalance || finance?.openingBalance || 0),
      source: refSrc.source || finance?.source || '',
      sheetLabel: refSrc.sheetLabel || '',
      columns: refSrc.sheetColumns || '',
      check: refSrc.check || null,
      feeRecords: refSrc.feeRecords || [],
      note: refSrc.noteBalance || refSrc._comment || '',
      transactions: refSrc.transactions || []
    };
  }
  if (inventory) {
    db.invItems = inventory.items || [];
    db.invLoans = inventory.loans || [];
    db.invAudits = inventory.audits || [];
    db.invNextCode = inventory.nextCode || 'G-001';
  }
  if (meetings && Array.isArray(meetings.meetings)) db.meetings = meetings.meetings;
  if (notices && Array.isArray(notices.notices)) db.notices = notices.notices;
  if (tables) {
    if (tables.schemaDefs) db.tableSchema = tables.schemaDefs;
    if (tables.sources) db.tableSources = tables.sources;
    if (tables.sync) db.sync = tables.sync;
  }
  seedBackend(db, mode, code);
  return db;
}

/* ---------------- 後端（Apps Script 總表）：所有流出資料都用同一條 /exec ----------------
   優先次序：unit.json settings.sync / tables.json → 旅團 registry backend → Registry 共用 backend */
function seedBackend(db, mode, code) {
  if (mode === 'mock') return;                     // 示範資料永遠唔會送出街
  const be = backendOf(code);
  const s = db.settings || {};
  const unitSync = s.sync || {};
  const url = unitSync.url || be?.gasUrl || '';
  if (!url) return;
  db.backend = {
    gasUrl: url,
    apiKey: unitSync.apiKey !== undefined ? unitSync.apiKey : (be?.apiKey || ''),
    name: be?.name || '總表（Apps Script）',
    shared: !unitSync.url,
    noticeSubmitUrl: s.notice?.submitUrl || be?.noticeSubmitUrl || url,
    updated: be?.updated || ''
  };
  db.sync = { ...(db.sync || {}), url: db.sync?.url || url, unit: db.sync?.unit || unitSync.unit || code, apiKey: db.sync?.apiKey ?? (unitSync.apiKey ?? ''), log: db.sync?.log || [] };
  db.settings = { ...s };
  db.settings.notice = { ...(s.notice || {}), submitUrl: s.notice?.submitUrl || url };
  db.settings.publicEntry = { ...(s.publicEntry || {}), submitUrl: s.publicEntry?.submitUrl || url };
  db.settings.publicBorrow = { ...(s.publicBorrow || {}), submitUrl: s.publicBorrow?.submitUrl || url };
}

/* ---------------- 初始化 ---------------- */
export async function init(opts = {}) {
  state.mode = opts.mode || lsGet(K.mode) || 'real';
  const url = new URLSearchParams(location.search);
  if (url.get('mock') === '1') state.mode = 'mock';
  const code = opts.unit || url.get('u') || lsGet(K.unit) || defaultUnitCode();
  state.unitCode = code;

  const key = dbKey(state.mode, code);
  const raw = lsGet(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schema === SCHEMA) {
        state.db = parsed;
        state.seedSource = parsed.meta?.seedSource || '';
      }
    } catch (e) { console.warn('DB 解析失敗，重新種入種子資料', e); }
  }
  if (!state.db) {
    state.db = await buildSeed(state.mode, code);
    state.seedFailed = !!state.db.meta?.seedFailed;
    state.seedSource = state.db.meta?.seedSource || '';
    persist();
  }
  // 帳戶名單升級（例如加入新欄位）
  if (!Array.isArray(state.db.accounts) || !state.db.accounts.length) {
    state.db.accounts = state.mode === 'mock' ? SEED_ACCOUNTS_MOCK : SEED_ACCOUNTS;
    persist();
  }
  // 用戶名冊升級：舊資料冇「身份」欄 → 由職位／標籤推算（領袖 / 執委 / 團員）
  if (migrateIdentities(state.db)) persist();
  // 跨系統身份 key（進度追蹤等外部系統要靠呢個對人）
  if (migrateMemberKeys(state.db)) persist();
  // 期初結餘：舊嘅全域數字如果係上年度嘅期初，自動搬返去對應年度（見 migrateOpeningBalances）
  if (migrateOpeningBalances(state.db)) persist();
  // 後端設定升級：舊資料庫（未有 sync 設定）自動補上 Registry / unit.json 嘅 Apps Script 網址
  if (state.mode === 'real') {
    const before = JSON.stringify([state.db.sync?.url || '', state.db.settings?.notice?.submitUrl || '', state.db.settings?.publicEntry?.submitUrl || '', state.db.settings?.publicBorrow?.submitUrl || '']);
    if (state.db.sync?.url !== undefined || !state.db.backend) seedBackend(state.db, state.mode, code);
    const after = JSON.stringify([state.db.sync?.url || '', state.db.settings?.notice?.submitUrl || '', state.db.settings?.publicEntry?.submitUrl || '', state.db.settings?.publicBorrow?.submitUrl || '']);
    if (before !== after) persist();
  }
  lsSet(K.unit, code);
  lsSet(K.mode, state.mode);
  state.ready = true;
  return state.db;
}

export function ready() { return state.ready; }
export function isMock() { return state.mode === 'mock'; }
export function currentMode() { return state.mode; }
export function currentUnit() { return state.unitCode; }
export function unitProfile() { return load().profile || load().unit; }
export function seedInfo() { return { source: state.seedSource || load()?.meta?.seedSource || '', failed: state.seedFailed, real: !isMock() }; }

export function setMode(mode) { lsSet(K.mode, mode); }
export function setUnitCode(code) { lsSet(K.unit, code); }

/** 切換旅團（重載頁面，確保所有模組用新資料） */
export function switchUnit(code) {
  lsSet(K.unit, code);
  const u = new URL(location.href);
  u.searchParams.set('u', code);
  u.hash = '#/dashboard';
  location.href = u.toString();
}
export function enterMock() {
  const u = new URL(location.href);
  u.searchParams.set('mock', '1');
  u.hash = '';
  location.href = u.toString();
}
export function exitMock() {
  const u = new URL(location.href);
  u.searchParams.delete('mock');
  u.hash = '#/dashboard';
  location.href = u.toString();
}

/* ---------------- 讀寫 ---------------- */
export function load() {
  if (!state.db) throw new Error('資料庫未初始化（要先 await init()）');
  return state.db;
}
export function tryLoad() { return state.db; }

function persist() {
  if (!state.db) return;
  state.db.meta = state.db.meta || {};
  state.db.meta.updatedAt = nowStamp();
  lsSet(dbKey(state.mode, state.unitCode), JSON.stringify(state.db));
  /* 防呆：改動只會「排隊」等送去總表，永遠唔會即時自動送出。
     要去「表格與同步 → 總表同步 → 立即同步」先真正寫入 Apps Script。 */
  if (state.db.sync && state.db.sync.auto) {
    state.db.sync.pending = Number(state.db.sync.pending || 0) + 1;
  }
}

export function commit() { persist(); return state.db; }
export const save = commit;

export function collection(name) {
  const db = load();
  if (!Array.isArray(db[name])) db[name] = [];
  return db[name];
}
export function find(name, id) { return collection(name).find(x => x.id === id) || null; }
export function add(name, obj) {
  const id = obj.id || (name.slice(0, 2) + '_' + Math.random().toString(36).slice(2, 8));
  const rec = { ...obj, id };
  collection(name).push(rec);
  persist();
  return rec;
}
export function update(name, id, patch) {
  const rec = find(name, id);
  if (!rec) return null;
  Object.assign(rec, patch, { id });
  persist();
  return rec;
}
export function remove(name, id) {
  const list = collection(name);
  const i = list.findIndex(x => x.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  persist();
  return true;
}
export function setSetting(patch) {
  const db = load();
  db.settings = { ...db.settings, ...patch };
  persist();
  return db.settings;
}
export function setUnitProfile(patch) {
  const db = load();
  db.unit = { ...db.unit, ...patch };
  persist();
  return db.unit;
}

/* ---------------- 稽核紀錄 ---------------- */
export function audit(action, detail = '', who = null) {
  const db = load();
  db.auditLog = db.auditLog || [];
  db.auditLog.unshift({ id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), at: nowStamp(), action, detail, by: who || '' });
  if (db.auditLog.length > 400) db.auditLog.length = 400;
  persist();
}

/* ---------------- 備份 / 還原 / 重設 ---------------- */
export function exportAll({ includeMock = false } = {}) {
  const db = load();
  if (isMock() && !includeMock) {
    // 示範資料要另外匯出，唔可以當成真資料備份
    return JSON.stringify({ ...db, _exportedFrom: 'mock' }, null, 2);
  }
  return JSON.stringify({ ...db, _exportedFrom: isMock() ? 'mock' : 'real', _exportedAt: nowStamp() }, null, 2);
}

export function importAll(jsonText, { allowMockIntoReal = false } = {}) {
  let obj;
  try { obj = JSON.parse(jsonText); } catch (e) { throw new Error('JSON 格式錯誤'); }
  if (!obj || typeof obj !== 'object' || !obj.schema) throw new Error('唔似係本系統嘅備份檔（缺少 schema）');
  if (obj.schema !== SCHEMA) throw new Error(`備份版本（schema ${obj.schema}）同現時版本（${SCHEMA}）唔一致`);
  const from = obj._exportedFrom || obj.kind;
  if (from === 'mock' && !isMock() && !allowMockIntoReal) {
    throw new Error('呢個係示範（MOCK）備份，唔可以匯入真實資料庫（保護真實資料）');
  }
  state.db = obj;
  state.db.accounts = Array.isArray(obj.accounts) && obj.accounts.length ? obj.accounts : SEED_ACCOUNTS;
  persist();
  return state.db;
}

/** 由 data/ 檔案重新種入（清走本機改動） */
export async function resetToSeed() {
  state.db = await buildSeed(state.mode, state.unitCode);
  state.seedFailed = !!state.db.meta?.seedFailed;
  persist();
  return state.db;
}

/** 完全清空呢個旅團（真實資料） */
export function wipe() {
  state.db = blankDb(state.mode, state.unitCode, unitEntry(state.unitCode) || {});
  if (state.mode === 'real') state.db.meta.seedFailed = false;
  persist();
  return state.db;
}

/** 清除示範資料（唔會影響真實資料） */
export function clearMockData() {
  lsDel(dbKey('mock', state.unitCode));
  if (isMock()) {
    try { localStorage.removeItem('venture82.mock.db.v' + SCHEMA); } catch { /* ignore */ }
  }
}

/* ---------------- session（登入狀態） ---------------- */
export function getSession() {
  try { const raw = lsGet(K.session); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function setSession(s) {
  if (!s) lsDel(K.session); else lsSet(K.session, JSON.stringify(s));
}
export const SESSION_KEY = K.session;
