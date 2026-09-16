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

const BUILTIN = {
  schema: 2,
  defaultUnit: '0082',
  units: {
    '0082': {
      code: '0082', name: '第八十二旅深資童軍團', short: '82venture',
      dataPath: 'data/units/0082/'
    }
  }
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

export async function loadRegistry(force = false) {
  if (cache && !force) return cache;
  let fromFile = null;
  try {
    const r = await fetch(REG_URL + '?_=' + Date.now(), { cache: 'no-store' });
    if (r.ok) fromFile = await r.json();
  } catch (e) { /* 可能係 file:// 或者未部署 */ }

  /* 伺服器 Registry：Vercel 環境變數定義嘅旅團（冇 /api 就自動略過） */
  const fromApi = await fetchServerUnits();

  if (fromFile && fromFile.units) {
    const merged = { ...fromFile, units: { ...fromFile.units } };
    Object.entries(fromApi).forEach(([code, u]) => {
      merged.units[code] = { ...(merged.units[code] || {}), ...u, fromApi: true };
    });
    cache = merged;
    try { localStorage.setItem(REG_CACHE, JSON.stringify(merged)); } catch { /* ignore */ }
  } else {
    registry(); // 用快取或內建
  }
  return cache;
}

/** 由 /api/units 攞伺服器端（環境變數）定義嘅旅團；靜態部署／未設定就回傳空物件 */
async function fetchServerUnits() {
  try {
    const r = await fetch('api/units?_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return {};
    const j = await r.json();
    return (j && j.units && typeof j.units === 'object') ? j.units : {};
  } catch (e) { return {}; }
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
  return reg.defaultUnit && units[reg.defaultUnit] ? reg.defaultUnit : (Object.keys(units)[0] || '0082');
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
