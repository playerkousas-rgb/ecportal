// 伺服器端可信旅團 Registry（只供 /api 內部使用，不會作為 endpoint 公開）
// 資料來源（全部在伺服器端解析）：
//   1. data/units.json ／ units.json（存放在 Git 的公開 Registry）
//   2. Vercel 環境變數 TROOP_{ID}_BACKEND / TROOP_{ID}_GASURL / TROOP_{ID}_APIKEY（優先於檔案）
// safety: backend 必須通過 isTrustedExecUrl() 驗證，否則視為未登記。

import fs from 'fs';
import path from 'path';

// 已登記的 GAS /exec URL 白名單格式（只接受 HTTPS 正式部署 URL，不接受 /dev）
const EXEC_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/i;

// 正規化 origin：只接受 http/https，並用 URL.origin 統一
export function normalizeOrigin(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch (e) { return ''; }
}

// 本機測試專用：設 V82_PROXY_TEST=1 或 VSBADGE_PROXY_TEST=1 時允許 http://127.0.0.1|localhost 的 mock GAS。
const TEST_LOCAL_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[A-Za-z0-9._~\-/?=&%]*)?$/;

export function isTrustedExecUrl(url) {
  if (typeof url !== 'string' || url.length > 300) return false;
  if (EXEC_URL_RE.test(url.trim())) return true;
  if ((process.env.V82_PROXY_TEST === '1' || process.env.VSBADGE_PROXY_TEST === '1') && TEST_LOCAL_RE.test(url.trim())) return true;
  return false;
}

function readFileUnits() {
  const candidates = [
    path.join(process.cwd(), 'data', 'units.json'),
    path.join(process.cwd(), 'units.json')
  ];
  const merged = {};
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const json = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (json && json.units && typeof json.units === 'object') {
          Object.assign(merged, json.units);
        }
      }
    } catch (e) {
      console.warn('[registry] read units file failed:', p);
    }
  }
  return merged;
}

function envVar(...names) {
  for (const n of names) {
    if (process.env[n]) return process.env[n];
  }
  return '';
}

// 合併檔案 + 環境變數，回傳 { [id]: {code, name, nameEn, backend, apiKey, backendTrusted, ...} }
export function getRegistry() {
  const fileUnits = readFileUnits();
  const idsFromEnv = new Set();
  for (const k of Object.keys(process.env)) {
    const m = k.match(/^TROOP_([0-9A-Za-z]+)_(BACKEND|GASURL|APIKEY|NOTICE|PORTALORIGIN)$/i);
    if (m) idsFromEnv.add(m[1]);
  }

  const allIds = new Set([...Object.keys(fileUnits), ...idsFromEnv]);
  const out = {};
  for (const id of allIds) {
    const fileEntry = fileUnits[id] || {};
    const idUpper = String(id).toUpperCase();
    const idNoZero = String(id).replace(/^0+/, '') || String(id);
    const gasUrl =
      envVar(
        `TROOP_${id}_BACKEND`, `TROOP_${idUpper}_BACKEND`, `TROOP_${idNoZero}_BACKEND`,
        `TROOP_${id}_GASURL`, `TROOP_${idUpper}_GASURL`, `TROOP_${idNoZero}_GASURL`
      ) || fileEntry.backend?.gasUrl || fileEntry.backend || '';
    const apiKey =
      envVar(`TROOP_${id}_APIKEY`, `TROOP_${idUpper}_APIKEY`, `TROOP_${idNoZero}_APIKEY`) ||
      fileEntry.backend?.apiKey || fileEntry.apiKey || '';
    const noticeSubmitUrl =
      envVar(`TROOP_${id}_NOTICE`, `TROOP_${idUpper}_NOTICE`, `TROOP_${idNoZero}_NOTICE`) ||
      fileEntry.notice?.submitUrl || gasUrl;
    const name = fileEntry.name || `第 ${id} 旅`;
    const code = fileEntry.code || id;

    out[id] = {
      code,
      name,
      nameEn: fileEntry.nameEn || fileEntry.en || '',
      short: fileEntry.short || `${code}venture`,
      section: fileEntry.section || '深資童軍',
      region: fileEntry.region || '',
      sponsor: fileEntry.sponsor || '',
      address: fileEntry.address || '',
      dataPath: fileEntry.dataPath || `data/units/${code}/`,
      theme: fileEntry.theme || null,
      progress: fileEntry.progress || null,
      backend: {
        gasUrl,
        apiKey
      },
      notice: {
        submitUrl: noticeSubmitUrl
      },
      backendTrusted: isTrustedExecUrl(gasUrl)
    };
  }
  return out;
}

// Proxy 專用：只回傳通過 URL 白名單驗證的旅團
export function getTrustedUnit(id) {
  if (typeof id !== 'string' || !/^[0-9A-Za-z_-]{1,32}$/.test(id)) return null;
  const reg = getRegistry();
  const u = reg[id] || reg[String(id).replace(/^0+/, '')];
  if (!u || !u.backend?.gasUrl || !u.backendTrusted) return null;
  return {
    code: u.code,
    name: u.name,
    gasUrl: u.backend.gasUrl.trim(),
    apiKey: (u.backend.apiKey || '').trim(),
    noticeSubmitUrl: (u.notice?.submitUrl || u.backend.gasUrl).trim(),
    theme: u.theme
  };
}

// ============================================================
// 進度系統（VSBADGE）後端 —— 伺服器端設定（可選）
// ------------------------------------------------------------
// 旅團可以喺介面自己填（存喺佢自己嘅資料／瀏覽器），亦可以改用 Vercel env：
//   TROOP_<編號>_PROGRESSBACKEND = https://script.google.com/macros/s/…/exec
//   TROOP_<編號>_PROGRESSAPIKEY  = …（喺 VSBADGE 個 Apps Script 執行 showApiKey()）
//   TROOP_<編號>_PROGRESSFRONT   = https://vsbadge.vercel.app/
// 有設就會優先採用（API Key 就唔會出現在瀏覽器）。
// ============================================================
export function getProgressRegistryEntry(id) {
  /* 一個後端、兩個前端：進度資料就係旅團自己嘅後端（GAS /exec）。
     伺服器端可以設定 TROOP_<id>_PROGRESSBACKEND / _PROGRESSAPIKEY，
     設定咗就優先於前端輸入（API Key 唔使落前端）。 */
  const out = { backend: '', apiKey: '', catalog: '' };
  if (typeof id !== 'string' || !/^[0-9A-Za-z_-]{1,32}$/.test(id)) return out;
  const idUpper = id.toUpperCase();
  const idNoZero = id.replace(/^0+/, '') || id;
  const pick = (key) => envVar(
    `TROOP_${id}_${key}`, `TROOP_${idUpper}_${key}`, `TROOP_${idNoZero}_${key}`
  );
  const backend = pick('PROGRESSBACKEND').trim();
  out.backend = isTrustedExecUrl(backend) ? backend : '';
  out.apiKey = pick('PROGRESSAPIKEY').trim();
  // 可選：自訂考核項目定義（預設用 app 內建 data/progress/items.json）
  const catalog = pick('PROGRESSCATALOG').trim();
  if (catalog && /^https:\/\//i.test(catalog)) out.catalog = catalog;
  return out;
}

// 前端旅團選擇器專用：只暴露公開資訊，任何情況都不回傳 gasUrl / apiKey
export function listPublicUnits() {
  const reg = getRegistry();
  const out = {};
  for (const [id, u] of Object.entries(reg)) {
    out[id] = {
      code: u.code,
      name: u.name,
      nameEn: u.nameEn,
      short: u.short,
      section: u.section,
      region: u.region,
      sponsor: u.sponsor,
      address: u.address,
      theme: u.theme
    };
  }
  return out;
}
