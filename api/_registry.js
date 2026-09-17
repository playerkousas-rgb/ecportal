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

/* ============================================================
   環境變數命名：認得嘅寫法（2026-09 加寬）
   ------------------------------------------------------------
   「喺 Vercel 加咗變數但旅團唔出現」最常見嘅原因就係名打差少少：
   TROOP_0082_URL、TROOP_0082_BACKEND_URL、TROOP_82_KEY…以前一律認唔到。
   而家全部當同一個意思（正式文件仍然建議用 BACKEND / APIKEY）。
   ============================================================ */
const FIELD_ALIASES = {
  BACKEND: ['BACKEND', 'BACKENDURL', 'BACKEND_URL', 'GASURL', 'GAS_URL', 'GAS', 'EXEC', 'EXECURL', 'EXEC_URL', 'URL', 'SCRIPTURL', 'SCRIPT_URL', 'WEBAPPURL', 'WEBAPP_URL'],
  APIKEY: ['APIKEY', 'API_KEY', 'APITOKEN', 'API_TOKEN', 'KEY', 'TOKEN', 'SECRET'],
  NAME: ['NAME', 'TROOPNAME', 'TROOP_NAME', 'DISPLAYNAME'],
  NAMEEN: ['NAMEEN', 'NAME_EN', 'EN', 'ENNAME'],
  SHORT: ['SHORT', 'SHORTNAME', 'SLUG'],
  NOTICE: ['NOTICE', 'NOTICEURL', 'NOTICE_URL', 'NOTICESUBMIT', 'NOTICESUBMITURL'],
  PROGRESSBACKEND: ['PROGRESSBACKEND', 'PROGRESS_BACKEND', 'PROGRESSURL', 'PROGRESS_URL'],
  PROGRESSAPIKEY: ['PROGRESSAPIKEY', 'PROGRESS_APIKEY', 'PROGRESS_API_KEY', 'PROGRESSKEY'],
  PROGRESSCATALOG: ['PROGRESSCATALOG', 'PROGRESS_CATALOG', 'PROGRESSCATALOGURL'],
  PORTALORIGIN: ['PORTALORIGIN', 'PORTAL_ORIGIN']
};
const KNOWN_FIELDS = new Set(Object.values(FIELD_ALIASES).flat());
/* 全部要認嘅 key（用嚟掃 process.env 搵出所有已登記旅團） */
const TROOP_KEY_RE = new RegExp(
  '^TROOP_([0-9A-Za-z]+)_(' + [...KNOWN_FIELDS].join('|') + ')(_[0-9]+)?$', 'i'
);

/** 簡寫：TROOP_0082 = https://…/exec（有人會咁寫；值一定要係合法 /exec 才當後端） */
function troopShorthand(id) {
  const ids = [...new Set([id, String(id).toUpperCase(), String(id).replace(/^0+/, '') || String(id), '0' + String(id)])];
  for (const i of ids) {
    const v = envVar(`TROOP_${i}`);
    if (v && isTrustedExecUrl(v)) return v.trim();
  }
  return '';
}

/** 讀一個旅團嘅某個欄位（同時試 有／冇前導零、大寫、package 名等寫法） */
function troopEnv(id, field) {
  const ids = [...new Set([id, String(id).toUpperCase(), String(id).toLowerCase(),
    String(id).replace(/^0+/, '') || String(id), '0' + String(id)])];
  const names = FIELD_ALIASES[field] || [field];
  for (const i of ids) {
    for (const n of names) {
      const v = envVar(`TROOP_${i}_${n}`, `TROOP_${i}_${String(n).toUpperCase()}`);
      if (v) return v;
    }
  }
  return '';
}

/* 額外寫法：一次過用 JSON 登記（例如 TROOPS_JSON）
   {"0082":{"backend":"https://…/exec","apiKey":"v82_…","name":"第八十二旅深資童軍團"}}
   方便／應急用；一樣要通過 URL 白名單驗證。 */
const JSON_ENV_NAMES = ['TROOPS_JSON', 'TROOP_REGISTRY', 'TROOPS', 'UNITS_JSON'];

function readJsonUnits() {
  const raw = envVar(...JSON_ENV_NAMES);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const units = parsed && typeof parsed === 'object'
      ? (parsed.units && typeof parsed.units === 'object' ? parsed.units : parsed)
      : {};
    const out = {};
    for (const [id, v] of Object.entries(units)) {
      if (!/^[0-9A-Za-z_-]{1,32}$/.test(id)) continue;
      if (v && typeof v === 'object') out[id] = v;
      else if (typeof v === 'string') out[id] = { backend: v };
    }
    return out;
  } catch (e) {
    console.warn('[registry] JSON env 解析失敗（檢查 TROOPS_JSON 格式）');
    return {};
  }
}

// 合併檔案 + 環境變數，回傳 { [id]: {code, name, nameEn, backend, apiKey, backendTrusted, ...} }
export function getRegistry() {
  const fileUnits = readFileUnits();
  const envUnits = readJsonUnits();
  const idsFromEnv = new Set();
  for (const k of Object.keys(process.env)) {
    const m = k.match(TROOP_KEY_RE) || k.match(/^TROOP_([0-9A-Za-z]+)$/i);
    if (m) idsFromEnv.add(m[1]);
  }

  const allIds = new Set([...Object.keys(fileUnits), ...idsFromEnv, ...Object.keys(envUnits)]);
  const out = {};
  for (const id of allIds) {
    const fileEntry = fileUnits[id] || {};
    const jsonEntry = envUnits[id] || {};
    const fromEnvOnly = !fileUnits[id];

    const gasUrl =
      troopEnv(id, 'BACKEND') || troopShorthand(id) ||
      jsonEntry.backend?.gasUrl || jsonEntry.backend || jsonEntry.gasUrl || jsonEntry.url ||
      fileEntry.backend?.gasUrl || fileEntry.backend || '';
    const apiKey =
      troopEnv(id, 'APIKEY') || jsonEntry.apiKey || jsonEntry.backend?.apiKey ||
      fileEntry.backend?.apiKey || fileEntry.apiKey || '';
    const noticeSubmitUrl =
      troopEnv(id, 'NOTICE') || jsonEntry.notice?.submitUrl || jsonEntry.noticeSubmitUrl ||
      fileEntry.notice?.submitUrl || gasUrl;
    const envName = troopEnv(id, 'NAME') || jsonEntry.name || '';
    const name = fileEntry.name || envName || `第 ${id} 旅`;
    const code = fileEntry.code || jsonEntry.code || id;
    /* 伺服器端已經有進度後端＋Key ＝ 前端唔使填任何嘢（純 env 開團用） */
    const progressBackend = troopEnv(id, 'PROGRESSBACKEND') || jsonEntry.progressBackend || '';
    const progressKey = troopEnv(id, 'PROGRESSAPIKEY') || jsonEntry.progressApiKey || '';

    out[id] = {
      code,
      name,
      nameEn: fileEntry.nameEn || fileEntry.en || troopEnv(id, 'NAMEEN') || jsonEntry.nameEn || '',
      short: fileEntry.short || troopEnv(id, 'SHORT') || jsonEntry.short || `${code}venture`,
      section: fileEntry.section || jsonEntry.section || '深資童軍',
      region: fileEntry.region || jsonEntry.region || '',
      sponsor: fileEntry.sponsor || jsonEntry.sponsor || '',
      address: fileEntry.address || jsonEntry.address || '',
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
      backendTrusted: isTrustedExecUrl(gasUrl),
      /* 呢個旅團係唔係靠伺服器端 env 開（Git 未加 JSON） */
      fromEnv: fromEnvOnly,
      progressServerSide: !!(progressBackend && progressKey)
    };
  }
  return out;
}

/* ============================================================
   診斷（只喺 /api/units?diag=1 出現）
   ------------------------------------------------------------
   目的：管理員加完環境變數，如果旅團唔出現，要即刻知**為咩**。
   只回傳變數名同布林值 —— 永遠唔會回傳 API Key、亦唔會回傳完整 /exec 網址。
   ============================================================ */
export function registryDiagnostics() {
  const reg = getRegistry();
  const ids = Object.keys(reg).sort();
  const recognizedNames = [];
  const suspicious = [];

  for (const k of Object.keys(process.env)) {
    if (JSON_ENV_NAMES.includes(k)) { recognizedNames.push(k); continue; }
    if (!/^troop/i.test(k)) continue;
    if (TROOP_KEY_RE.test(k)) { recognizedNames.push(k); continue; }
    /* TROOP_0082 = https://…/exec 呢種簡寫都算認得（前提：值係合法 /exec） */
    if (/^TROOP_[0-9A-Za-z]+$/i.test(k) && isTrustedExecUrl(process.env[k])) { recognizedNames.push(k); continue; }
    suspicious.push(k);              // 例如 TROOP0082_BACKEND／TROOP_0082_BACKENDXD 打錯名
  }

  return {
    ok: true,
    server: 'ecportal',
    onVercel: !!(process.env.VERCEL || process.env.VERCEL_ENV || process.env.NOW_BUILDER),
    env: process.env.VERCEL_ENV || (process.env.VERCEL ? 'vercel' : (process.env.NODE_ENV || 'local')),
    /* 部署環境：production / preview / development —— Vercel 只會注入對應環境嘅變數。
       如果變數只係勾咗 Production，而用家開嘅係 Preview 網址，就會一個都讀唔到。 */
    vercelEnv: process.env.VERCEL_ENV || '',
    vercelUrl: process.env.VERCEL_URL || '',
    region: process.env.VERCEL_REGION || '',
    ids,
    count: ids.length,
    /* 只有名，冇值 */
    recognizedNames: recognizedNames.sort(),
    suspicious: suspicious.sort(),
    withKey: ids.filter(i => !!reg[i].backend?.apiKey),
    trusted: ids.filter(i => !!reg[i].backendTrusted),
    withName: ids.filter(i => reg[i].name && reg[i].name !== `第 ${i} 旅`),
    notice: 'TROOP_<編號>_BACKEND 一定要係 https://script.google.com/macros/s/…/exec（唔接受 /dev、唔接受其他網域）'
  };
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
// 進度紀錄：旅團後端 —— 伺服器端設定（可選；一個後端、兩個前端）
// ------------------------------------------------------------
// 平常喺介面「進度 → 設定」填就得（存喺旅團自己嘅資料）；亦可以用 Vercel env 覆蓋：
//   TROOP_<編號>_PROGRESSBACKEND = https://script.google.com/macros/s/…/exec
//   TROOP_<編號>_PROGRESSAPIKEY  = …（喺旅團自己嘅 Apps Script 執行 showApiKey()）
//   TROOP_<編號>_PROGRESSCATALOG = https://…/items.json（自訂考核項目，可選）
// 有設就會優先採用（API Key 就唔會出現在瀏覽器）。
// ============================================================
export function getProgressRegistryEntry(id) {
  /* 一個後端、兩個前端：進度資料就係旅團自己嘅後端（GAS /exec）。
     伺服器端可以設定 TROOP_<id>_PROGRESSBACKEND / _PROGRESSAPIKEY（可選覆蓋；
     一般情況喺前端「進度 → 設定」填就得），設定咗就優先於前端輸入（API Key 唔使落前端）。 */
  const out = { backend: '', apiKey: '', catalog: '' };
  if (typeof id !== 'string' || !/^[0-9A-Za-z_-]{1,32}$/.test(id)) return out;
  const pick = (key) => troopEnv(id, key);
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
      theme: u.theme,
      /* 前端用嚟交代狀態：伺服器端已經有進度後端＋Key（前端唔使填）／通告可以直接送到總表 */
      progressServerSide: !!u.progressServerSide,
      noticeReady: !!(u.notice?.submitUrl || u.backend?.gasUrl),
      /* 呢個旅團係靠 Vercel 環境變數登記（前端會標示「Vercel 登記」） */
      server: !!u.fromEnv,
      backendReady: !!u.backendTrusted
    };
  }
  return out;
}
