/* ============================================================
   units.js — 旅團 Registry（多旅團）
   正式旅團：data/units.json + data/units/<編號>/*.json（Git 管理，同 VSBADGE 做法）
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
  if (fromFile && fromFile.units) {
    cache = fromFile;
    try { localStorage.setItem(REG_CACHE, JSON.stringify(fromFile)); } catch { /* ignore */ }
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

/** 旅團嘅後端設定（Apps Script /exec）：旅團自己嘅 → Registry 共用 → null */
export function backendOf(code) {
  const reg = registry();
  const entry = unitEntry(code) || {};
  const val = entry.backend || {};
  const shared = reg.backend || {};
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
