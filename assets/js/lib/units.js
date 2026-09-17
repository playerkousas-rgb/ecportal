/* ============================================================
   units.js — 旅團 Registry（多旅團）
   正式旅團：data/units.json + data/units/<編號>/*.json（Git Registry 管理）
   伺服器旅團：由 Vercel 環境變數 TROOP_<編號>_* 定義（/api/units 回傳；
               唔使改 Git 都開得新旅團，資料由空白開始）
   本地旅團：只存喺呢部機嘅 localStorage（測試用，標示「本地」）
   ============================================================ */

const REG_URL = 'data/units.json';
const REG_CACHE = 'venture82.units.cache.v2';
const LOCAL_KEY = 'venture82.units.local.v2';

let cache = null;

/* 連線唔到 Registry（/api/units 同 data/units.json 都讀唔到）嗰陣嘅最後備案。
   **唔可以** hardcode 任何一個真實旅團 —— 以前呢度寫死咗 0082（連名、連
   dataPath），結果任何人一開 app、Registry 一讀唔到，就會見到第八十二旅，
   甚至讀到佢個資料夾。而家留空：讀唔到 Registry ＝ 冇旅團可揀，
   畫面會叫用家申請接入，唔會洩露任何旅團嘅資料。 */
const BUILTIN = {
  schema: 2,
  defaultUnit: '',
  units: {}
};

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') || {}; } catch { return {}; }
}
function writeLocal(obj) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(obj)); } catch { /* ignore */ }
}

/** 同步取得 Registry（第一次要先 await loadRegistry()） */
export function registry() {
  return cache || (() => {
    try {
      const raw = localStorage.getItem(REG_CACHE);
      if (raw) { cache = JSON.parse(raw); return cache; }
    } catch { /* ignore */ }
    cache = BUILTIN;
    return cache;
  })();
}

/* Registry 到底讀唔讀到？（分開「讀唔到檔」同「讀到但一個旅團都未登記」）
   ——  兩種情況個提示要唔同：前者叫人開 HTTP 伺服器，後者叫人申請接入。 */
let regReachable = false;
export function registryReachable() { return regReachable; }

/* ---------------- 伺服器端 Registry（Vercel 環境變數）狀態 ----------------
   2026-09 團長回報「喺 Vercel 加咗 TROOP_*，但首頁揀唔到旅團」。
   以前 /api/units 一失敗（未 redeploy、環境變數名打錯、函數 500…）
   前端就靜靜雞當「冇旅團」，得一句「暫時未有旅團登記」—— 完全查唔到原因。
   而家每次讀完都留低狀態，旅團閘可以照計出嚟畀管理員睇。 */
let serverStatus = { ok: false, status: 0, count: 0, error: '', at: '' };
export function serverUnitsStatus() { return { ...serverStatus }; }

const API_UNITS_URL = 'api/units';
const API_DIAG_URL = 'api/units?diag=1';

/** 由 /api/units 攞伺服器端（環境變數）定義嘅旅團；靜態部署／未設定就回傳空物件 */
async function fetchServerUnits() {
  const url = API_UNITS_URL + '?_=' + Date.now();
  let lastErr = '';
  let lastCode = 0;
  for (let attempt = 0; attempt < 2; attempt++) {          // 一次重試：redeploy 中／冷啟動
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const units = (j && j.units && typeof j.units === 'object') ? j.units : {};
        serverStatus = { ok: true, status: r.status, count: Object.keys(units).length, error: '', at: new Date().toISOString() };
        return units;
      }
      lastErr = `HTTP ${r.status}`; lastCode = r.status;
      /* 404／405 ＝ 呢個部署根本冇呢個 API（純靜態網頁），重試都冇用 */
      if (r.status === 404 || r.status === 405 || r.status === 501) break;
    } catch (e) {
      lastErr = e?.message || String(e); lastCode = 0;
    }
    if (attempt === 0) await sleep(200);
  }
  /* 記住係「讀唔到」，畀旅團閘顯示（連 HTTP code）—— 好過靜靜雞當冇旅團 */
  serverStatus = { ok: false, status: lastCode, count: 0, error: lastErr, at: new Date().toISOString() };
  return {};
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 伺服器端 Registry 診斷（只喺旅團閘撳「診斷」時叫）。
 * 回傳嘅係**變數名同布林值**，永遠唔會回傳 API Key／完整 /exec 網址。
 */
export async function fetchRegistryDiag() {
  try {
    const r = await fetch(API_DIAG_URL + '&_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, status: r.status };
    const j = await r.json();
    /* /api/units?diag=1 回 { units, diag }；唔支援 diag 嘅舊部署只回 { units } */
    if (!j || !j.diag) {
      return { ok: false, server: true, error: '呢個部署嘅 /api/units 未支援診斷（請重新部署最新版本）', count: Object.keys(j?.units || {}).length };
    }
    return { ok: true, ...j.diag };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function loadRegistry(force = false) {
  if (cache && !force) return cache;
  let fromFile = null;
  try {
    const r = await fetch(REG_URL + '?_=' + Date.now(), { cache: 'no-store' });
    if (r.ok) { fromFile = await r.json(); regReachable = true; }
  } catch (e) { /* 可能係 file:// 或者未部署 */ }

  /* 伺服器 Registry：Vercel 環境變數定義嘅旅團（冇 /api 就自動略過） */
  const fromApi = await fetchServerUnits();
  if (Object.keys(fromApi).length) regReachable = true;

  if (fromFile && fromFile.units) {
    const merged = { ...fromFile, units: { ...fromFile.units } };
    Object.entries(fromApi).forEach(([code, u]) => {
      merged.units[code] = { ...(merged.units[code] || {}), ...u, fromApi: true, server: true };
    });
    cache = merged;
    try { localStorage.setItem(REG_CACHE, JSON.stringify(merged)); } catch { /* ignore */ }
  } else if (Object.keys(fromApi).length) {
    /* 讀唔到 data/units.json（例如 Vercel 唔會 bundle 呢個檔）但伺服器 Registry 有嘢
       → 直接用伺服器嗰份，唔好白白當冇旅團 */
    cache = { schema: 2, defaultUnit: '', units: { ...fromApi } };
    Object.values(cache.units).forEach(u => { u.fromApi = true; u.server = true; });
    regReachable = true;
    try { localStorage.setItem(REG_CACHE, JSON.stringify(cache)); } catch { /* ignore */ }
  } else {
    registry(); // 用快取或內建
  }
  return cache;
}

export function localUnits() { return readLocal(); }

/** 全部旅團（正式 + 本地） */
export function allUnits() {
  const reg = registry();
  const out = { ...(reg.units || {}) };
  Object.entries(readLocal()).forEach(([code, u]) => { out[code] = { ...u, local: true }; });
  return out;
}

export function unitList() {
  const all = allUnits();
  return Object.values(all).sort((a, b) => String(a.code).localeCompare(String(b.code)));
}

export function unitEntry(code) {
  const all = allUnits();
  return all[code] || all[String(code).replace(/^0+/, '')] || null;
}

/**
 * 旅團嘅後端設定（Apps Script /exec）。
 *
 * 【嚴格隔離】每個旅團**只可以**用自己 entry 入面登記嘅後端。
 * 以前呢度會 fallback 去 registry 頂層嘅共用 `backend`，
 * 後果係：新開嘅旅團一登入就會讀／寫**第八十二旅嘅 Google Sheet**
 * （即係見到人哋嘅團員、帳目，自己嘅資料又寫咗入人哋張表）。
 * 所以任何情況都唔再借用共用後端 —— 冇自己嘅 /exec 就當未開戶（回 null）。
 */
export function backendOf(code) {
  const entry = unitEntry(code) || {};
  /* 安全：唔喺 Registry 嘅旅團（連本地都唔係）＝未開戶 */
  if (!Object.keys(entry).length) return null;
  const val = entry.backend || {};
  const gasUrl = val.gasUrl || '';
  if (!gasUrl) return null;          // ← 冇自己嘅後端就係冇，唔會借用其他旅團嘅
  return {
    name: val.name || '總表（Apps Script）',
    gasUrl,
    apiKey: val.apiKey !== undefined ? val.apiKey : '',
    shared: false,                   // 永遠唔會再共用
    noticeSubmitUrl: entry.notice?.submitUrl || val.noticeSubmitUrl || gasUrl,
    updated: val.updated || ''
  };
}

export function defaultUnitCode() {
  const reg = registry();
  const units = allUnits();
  /* 冇旅團就回空字串 —— 唔好 fallback 落任何真實旅團編號。
     以前呢度寫死 '0082'，即係 Registry 一有冷場就會靜靜雞當你係 82 旅。 */
  return reg.defaultUnit && units[reg.defaultUnit] ? reg.defaultUnit : (Object.keys(units)[0] || '');
}

export function dataPathOf(code) {
  const u = unitEntry(code);
  if (u?.dataPath) return u.dataPath;
  if (u?.local) return null;                    // 本地旅團冇資料檔案
  if (u?.fromApi) return null;                  // 伺服器旅團：由空白資料庫開始（資料喺自己後端）
  return `data/units/${code}/`;
}

export function saveLocalUnit(unit) {
  const all = readLocal();
  all[unit.code] = { ...(all[unit.code] || {}), ...unit, local: true };
  writeLocal(all);
  return all[unit.code];
}

export function removeLocalUnit(code) {
  const all = readLocal();
  delete all[code];
  writeLocal(all);
}

export function isLocalUnit(code) { return !!readLocal()[code]; }

export async function fetchUnitData(code, file) {
  const base = dataPathOf(code);
  if (!base) return null;
  try {
    const r = await fetch(`${base}${file}?_=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

export async function fetchMockData(file) {
  try {
    const r = await fetch(`data/mock/${file}?_=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
