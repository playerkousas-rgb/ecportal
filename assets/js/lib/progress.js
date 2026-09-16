/* ============================================================
   progress.js — 進度紀錄（一個後端、兩個前端）
   ------------------------------------------------------------
   設計（2026-09-16 團長更正）：
     · 唔連任何「其他系統」——進度資料本來就係寫入**旅團自己嘅後端**
       （同一個 Google Sheet ＋ 同一支 Apps Script）
     · 兩個前端餵同一個後端：
         ① 執委管理系統（呢度）  ② 進度前端（團員／領袖用）
     · 呢邊只做兩件事：讀後端（GET ?action=load）／寫後端（POST action=save）
     · 預設就用返旅團已登記嘅後端（data/units.json → backend.gasUrl / apiKey），
       所以通常唔使填任何嘢；要覆蓋就喺「進度 → 設定」自己填。
   安全：API Key 只會由瀏覽器傳去**同源** /api/progress，唔會經第三方；亦唔會出現在 log。
   ============================================================ */

import { load, commit } from './store.js';
import { profile } from './model.js';
import { backendOf } from './units.js';

/** 預設考核項目定義（app 內建，離線可用） */
export const DEFAULT_CATALOG_URL = 'data/progress/items.json';

/* ---------- 設定（跟旅團儲存；會跟 JSON 備份一齊走） ---------- */
export function progressCfg() {
  const p = profile();
  const b = p.progress?.backend || {};
  const unit = b.unit || load().unitCode || '';
  const be = backendOf(unit) || {};
  return {
    /* 後端：旅團自己填嘅 → 冇填就用返 Registry 登記咗嘅旅團後端（兩者其實係同一個後端） */
    backend: b.backend || be.gasUrl || '',
    apiKey: b.apiKey || (b.backend ? '' : (be.apiKey || '')),
    unit,
    name: p.progress?.name || '進度追蹤（同一個後端）',
    catalogUrl: b.catalogUrl || '',
    registered: !b.backend && !!be.gasUrl
  };
}

export function setProgressCfg(patch = {}) {
  const db = load();
  const cur = db.profile?.progress?.backend || {};
  const next = { ...cur, ...patch };
  db.profile = {
    ...(db.profile || db.unit || {}),
    progress: { ...((db.profile || db.unit)?.progress || {}), backend: next }
  };
  commit();
  return progressCfg();
}

export function progressConfigured() {
  const c = progressCfg();
  return !!(c.backend && c.apiKey);
}

/** 後端係唔係已經登記好（未填都可以用，話畀用戶知係「自動用返旅團後端」） */
export function progressIsRegistered() {
  return progressCfg().registered === true;
}

/* ---------- 呼叫 /api/progress（同源） ---------- */
async function callApi(payload, { timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('./api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 唔係 JSON：多數係冇 API（純靜態伺服器） */ }
    if (!json) {
      return { ok: false, reason: 'no_api',
        error: '呢部伺服器冇 /api/progress（進度接駁需要 Node 後端）。本機可以用 `npm run dev`，或在 Vercel 部署。' };
    }
    return json;
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, reason: aborted ? 'timeout' : 'network',
      error: aborted ? '連線逾時（進度系統後端冇回應）' : '連唔到本系統嘅 API（/api/progress）' };
  } finally {
    clearTimeout(timer);
  }
}

const cfgPayload = () => {
  const c = progressCfg();
  return { unit: c.unit, backend: c.backend, apikey: c.apiKey, catalog: c.catalogUrl };
};

/** 讀旅團後端全部進度資料（成員／進度／待批／其他獎章／活動履歷） */
export async function loadRemote() {
  return callApi({ ...cfgPayload(), action: 'load' });
}

/** 讀考核項目定義：預設用 app 內建副本（同源讀檔，離線都用得）；有自訂網址就經伺服器代讀 */
export async function loadItems() {
  const c = progressCfg();
  if (!c.catalogUrl) {
    try {
      const res = await fetch(DEFAULT_CATALOG_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      return { ok: true, local: true, data: json };
    } catch (e) {
      return { ok: false, reason: 'catalog_local_failed', error: '讀唔到內建考核項目（data/progress/items.json）' };
    }
  }
  return callApi({ ...cfgPayload(), action: 'catalog' });
}

/** 勾／取消勾進度 —— 直接寫入旅團自己嘅後端（同進度前端同一個 Sheet） */
export async function saveTicks(changes, confirmer = '') {
  return callApi({ ...cfgPayload(), action: 'save', data: { changes, confirmer } });
}

/** 其他獎章（服務／活動／訓練班 等） */
export async function saveOtherBadges(records) {
  return callApi({ ...cfgPayload(), action: 'saveOtherBadge', data: { records } });
}

/** 測試連線：讀一次 load，睇下 API Key 對唔對 */
export async function testConnection() {
  const started = Date.now();
  const r = await loadRemote();
  const members = r?.data?.members?.length ?? 0;
  return {
    ...r,
    ms: Date.now() - started,
    at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    summary: r.ok
      ? `連通 ✓ 讀到 ${members} 位成員、${Object.keys(r.data?.progress || {}).length} 位有進度紀錄`
      : (r.error || '連線失敗')
  };
}

/* ============================================================
   項目目錄（items.json）
   ============================================================ */
/** 攤平成 { itemId: { id, name, badgeId, badgeName, segmentId, segmentName } } */
export function flattenItems(itemsJson) {
  const map = {};
  (itemsJson?.badges || []).forEach(b => {
    (b.segments || []).forEach(seg => {
      (seg.items || []).forEach(it => {
        map[it.id] = {
          id: it.id, name: it.name || it.id, en: it.en || '',
          badgeId: b.id, badgeName: b.name || b.id, badgeIcon: b.icon || '🏅', badgeColor: b.color || '',
          segmentId: seg.code, segmentName: seg.name || ''
        };
      });
    });
  });
  return map;
}

/* ============================================================
   進度統計
   ============================================================ */
/** 由 load 回應取出某人嘅進度 { itemId: {date, confirmer} } */
export function progressOf(data, ymis) {
  const p = data?.progress || {};
  return p[ymis] || null;
}

export function memberDoneCount(data, ymis) {
  const p = progressOf(data, ymis);
  return p ? Object.keys(p).length : 0;
}

/** 後端嘅成員（{ymis,name}）對應本系統名冊 */
export function matchLocalMember(members, remote) {
  const list = members || [];
  return list.find(m => m.ymis && String(m.ymis) === String(remote.ymis))
    || list.find(m => String(m.name || '').trim() && String(m.name).trim() === String(remote.name || '').trim())
    || null;
}

/**
 * 總覽統計
 * @param {object} data load 回應
 * @param {object} catalog flattenItems() 結果（可選，只影響「完成率」）
 * @param {number} totalItems 項目總數（冇 catalog 時用）
 */
export function summarizeRemote(data, { catalog = null, roster = [] } = {}) {
  const members = data?.members || [];
  const progress = data?.progress || {};
  const totalItems = catalog ? Object.keys(catalog).length : 0;
  const rows = members.map(m => {
    const p = progress[m.ymis] || {};
    const done = Object.keys(p).length;
    const dates = Object.values(p).map(x => x?.date).filter(Boolean).sort();
    const local = matchLocalMember(roster, m);
    return {
      ymis: m.ymis, name: m.name, done,
      rate: totalItems ? Math.round(done / totalItems * 100) : null,
      lastDate: dates[dates.length - 1] || '',
      localId: local?.id || '', localName: local?.name || '', identity: local?.identity || '',
      matched: !!local
    };
  });
  // 每個獎章：邊幾多位成員有進度、總共勾咗幾多
  let badgeStats = [];
  if (catalog) {
    const byBadge = {};
    Object.values(catalog).forEach(it => {
      byBadge[it.badgeId] = byBadge[it.badgeId] || { id: it.badgeId, icon: it.badgeIcon, name: it.badgeName, items: 0, ticks: 0, members: 0 };
      byBadge[it.badgeId].items += 1;
    });
    Object.values(progress).forEach(p => {
      const seen = {};
      Object.keys(p).forEach(itemId => {
        const it = catalog[itemId];
        if (!it || !byBadge[it.badgeId]) return;
        byBadge[it.badgeId].ticks += 1;
        seen[it.badgeId] = true;
      });
      Object.keys(seen).forEach(b => { byBadge[b].members += 1; });
    });
    badgeStats = Object.values(byBadge);
  }
  const doneRows = rows.filter(r => r.done > 0);
  return {
    members: rows, memberCount: members.length,
    withProgress: doneRows.length,
    totalTicks: rows.reduce((a, r) => a + r.done, 0),
    avgRate: totalItems && rows.length ? Math.round(rows.reduce((a, r) => a + r.done, 0) / (rows.length * totalItems) * 100) : null,
    totalItems, badgeStats,
    unmatched: rows.filter(r => !r.matched).length
  };
}

/** 一位成員嘅項目清單（連完成日期），按獎章分組 */
export function memberDetail(data, catalog, ymis) {
  const p = progressOf(data, ymis) || {};
  const groups = {};
  Object.values(catalog || {}).forEach(it => {
    groups[it.badgeId] = groups[it.badgeId] || { id: it.badgeId, icon: it.badgeIcon, name: it.badgeName, items: [] };
    groups[it.badgeId].items.push({ ...it, done: !!p[it.id], date: p[it.id]?.date || '', confirmer: p[it.id]?.confirmer || '' });
  });
  return {
    done: Object.keys(p).length,
    badges: Object.values(groups).map(g => ({
      ...g, done: g.items.filter(i => i.done).length, total: g.items.length,
      rate: g.items.length ? Math.round(g.items.filter(i => i.done).length / g.items.length * 100) : 0
    })),
    extras: Object.keys(p).filter(id => !(catalog || {})[id]).map(id => ({ id, ...p[id] }))
  };
}
