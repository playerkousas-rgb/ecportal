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

/** 旅團嘅後端設定（Apps Script /exec）：旅團自己嘅 → Registry 共用 → null */
export function backendOf(code) {
  const reg = registry();
  const entry = unitEntry(code) || {};
  /* 安全：唔喺 Registry 嘅旅團（連本地都唔係）＝未開戶，唔可以借用其他旅團嘅後端 */
  if (!Object.keys(entry).length) return null;
  const val = entry.backend || {};
  /* 伺服器 Registry（env）開嘅旅團：後端由 env（TROOP_<id>_*）話事，
     唔可以借用 registry 頂層嘅共用後端（多數係示範／其他旅團嘅 Sheet） */
  const shared = entry.fromApi ? {} : (reg.backend || {});
  const gasUrl = val.gasUrl || shared.gasUrl || '';
  if (!gasUrl) return null;
  return {
    name: val.name || shared.name || '總表（Apps Script）',
    gasUrl,
    apiKey: val.apiKey !== undefined ? val.apiKey : (shared.apiKey || ''),
    shared: !val.gasUrl,
    noticeSubmitUrl: entry.notice?.submitUrl || val.noticeSubmitUrl || gasUrl,
    updated: val.updated || shared.updated || ''
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
