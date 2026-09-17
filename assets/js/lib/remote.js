/* ============================================================
   remote.js — 後端儲存（資料真正寫入旅團自己嘅 Google Sheet）
   ------------------------------------------------------------
   點解要有呢個檔：
     以前 app 嘅資料**淨係**存喺瀏覽器 localStorage。
     「總表同步」只係把資料**攤平**寫入 Sheet 嘅報表分頁（相片變數量、
     巢狀欄位變文字），讀返上嚟砌唔返個資料庫 —— 所以：
       · 換手機／換瀏覽器／清 cache ＝ 資料冇晒
       · 兩個執委各自喺自己部機做嘢 ＝ 兩份唔同嘅資料
     呢個模組加返真正嘅「來回」：
       saveDb  把成個資料庫（原樣 JSON）寫入後端「資料庫」分頁
       loadDb  由後端讀返成個資料庫
       dbInfo  只問 meta（後端有冇嘢、幾時更新）—— 開機比對用

   路線（優先次序）：
     ① 同源 /api/proxy  —— 冇 CORS、API Key 由伺服器端補上（最穩陣）
     ② 直接 POST 去 /exec —— 純靜態部署（GitHub Pages）時嘅後備

   注意：示範（MOCK）模式永遠唔會送出任何嘢。
   ============================================================ */

import { load, tryLoad, commitMeta, isMock, currentUnit } from './store.js';

/* ---------------- 狀態 ---------------- */
const RETRY_MS = [4000, 15000, 60000];      // 失敗重試間隔
const DEBOUNCE_MS = 2500;                   // 改完幾耐先自動存
let timer = null;
let retryStep = 0;
let inFlight = false;
let armed = false;                          // 開機／種資料期間唔好自動送
let lastState = { state: 'idle', msg: '' };

/** 目前同步狀態（畀介面畫個提示） */
export function syncState() { return { ...lastState }; }

function setState(state, msg = '') {
  lastState = { state, msg, at: Date.now() };
  try {
    window.dispatchEvent(new CustomEvent('v82:sync', { detail: lastState }));
  } catch { /* 非瀏覽器環境（測試）→ 冇所謂 */ }
}

/** 開機完成之後先至開始自動儲存（避免種子資料一載入就寫返上去） */
export function arm() { armed = true; }
export function disarm() { armed = false; if (timer) { clearTimeout(timer); timer = null; } }
export function isArmed() { return armed; }

/* ---------------- 設定 ---------------- */
export function remoteCfg() {
  const db = tryLoad();
  if (!db) return { url: '', apiKey: '', unit: '', auto: true, ok: false, viaProxy: false };
  const s = db.sync || {};
  const url = s.url || db.backend?.gasUrl || '';
  const unit = s.unit || db.unitCode || currentUnit() || '';
  /* 部署喺 Vercel（有 /api/proxy）嗰陣，後端網址同 API Key 都係伺服器端
     由 TROOP_<編號>_BACKEND / TROOP_<編號>_APIKEY 解析 —— 前端唔應該、
     亦都唔需要知道。所以只要有旅團編號就當接得通，唔好再要求用家填 /exec。 */
  const viaProxy = canUseProxy();
  return {
    url,
    apiKey: s.apiKey !== undefined ? s.apiKey : (db.backend?.apiKey || ''),
    unit,
    /* 預設「開」：改完自動存去後端。要關就喺「總表同步」熄咗佢。 */
    auto: s.auto !== false,
    ok: (!!url || (viaProxy && !!unit)) && !isMock(),
    viaProxy
  };
}

/** 後端有冇設定好（可以寫入） */
export function remoteConfigured() { return remoteCfg().ok; }

/* ---------------- 呼叫後端 ---------------- */
function canUseProxy() {
  try {
    return typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
  } catch { return false; }
}

/**
 * 送一個 action 去旅團後端。
 * 先試同源 /api/proxy；proxy 唔存在（純靜態）就直接打 /exec。
 */
async function callBackend(payload, { timeoutMs = 60000 } = {}) {
  const cfg = remoteCfg();
  if (!cfg.unit) return { ok: false, reason: 'not_configured', error: '未知旅團編號' };
  if (!cfg.url && !cfg.viaProxy) {
    return { ok: false, reason: 'not_configured', error: '未設定後端網址（去「總表同步」填 /exec）' };
  }

  /* ① 同源 proxy —— 正路。
     只送旅團編號，由伺服器端 Registry（TROOP_<編號>_BACKEND / _APIKEY）
     解析真實 /exec 同 API Key。**唔好送空 apiKey**：proxy 見到 payload
     已經有 apiKey 就唔會再注入（api/proxy.js: `if (unit.apiKey && !payload.apiKey)`），
     送個空字串上去會令伺服器端條 key 注入唔到，後端就會回「未授權」。 */
  if (cfg.viaProxy) {
    const body = { ...payload, unit: cfg.unit };
    if (cfg.apiKey) { body.apiKey = cfg.apiKey; body.apikey = cfg.apiKey; }
    const r = await postJson('api/proxy', body, timeoutMs);
    if (r.ok && r.json) return normalize(r.json);
    /* proxy 唔存在（純靜態部署）→ 跌落去直接打 /exec；其他錯誤照報 */
    if (!r.noApi) {
      if (r.json) return normalize(r.json);
      if (r.error) return { ok: false, reason: r.reason || 'network', error: r.error };
    }
  }

  /* ② 直接打 Apps Script（純靜態部署，例如 GitHub Pages）。
     呢條路冇伺服器端，條 key 唯有由前端帶。 */
  if (!cfg.url) {
    return { ok: false, reason: 'not_configured', error: '冇同源 /api/proxy，又未設定後端網址' };
  }
  const direct = { ...payload, unit: cfg.unit, apiKey: cfg.apiKey, apikey: cfg.apiKey };
  const d = await postJson(cfg.url, direct, timeoutMs, true);
  if (d.json) return normalize(d.json);
  return { ok: false, reason: d.reason || 'network', error: d.error || '連唔到旅團後端' };
}

async function postJson(endpoint, body, timeoutMs, plain = false) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      /* text/plain 避免 CORS preflight（Apps Script 唔支援 OPTIONS） */
      headers: { 'Content-Type': plain ? 'text/plain;charset=utf-8' : 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 唔係 JSON */ }
    if (!json) {
      /* 同源 proxy 唔存在（靜態伺服器回 HTML／404）→ 可以試直接打 */
      return { ok: false, noApi: res.status === 404 || /<!doctype|<html/i.test(text), error: `後端回應格式異常（HTTP ${res.status}）`, reason: 'bad_response' };
    }
    return { ok: res.ok, json };
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, error: aborted ? '連線逾時' : (e?.message || '網絡錯誤'), reason: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(t);
  }
}

function normalize(j) {
  const ok = j.ok === true || j.success === true;
  const raw = j.error || (ok ? '' : (j.msg || '後端拒絕咗呢個請求'));
  return { ...j, ok, error: raw, reason: ok ? '' : reasonOf(raw), hint: ok ? '' : hintOf(raw) };
}

/* 後端回嘅錯誤字眼 → 分類，等介面可以講返「去邊度撳邊粒掣」 */
function reasonOf(err) {
  const s = String(err || '');
  if (/API ?Key|未授權|unauthor/i.test(s)) return 'bad_key';
  if (/未知 action|unknown action/i.test(s)) return 'old_deploy';
  return 'backend';
}

/* 呢兩個係最常見、又最難自己估到嘅死因，所以直接寫清楚點解決 */
function hintOf(err) {
  const r = reasonOf(err);
  if (r === 'bad_key') {
    /* 正路係伺服器端設定，唔係叫用家喺瀏覽器打 key。
       前端填 key 只係純靜態部署（冇 /api/proxy）先需要嘅後備做法。 */
    return '後端有設 API Key，但伺服器端未有。'
      + '請平台管理員喺 Vercel 加環境變數 TROOP_<旅團編號>_APIKEY（值＝喺 Apps Script 執行 showApiKey() 攞到嗰條），'
      + '同埋確認 TROOP_<旅團編號>_BACKEND 係你個 /exec 網址，然後重新部署。'
      + '咁條 key 就淨係留喺伺服器端，瀏覽器完全唔會見到。';
  }
  if (r === 'old_deploy') {
    return '你個 /exec 仲行緊舊版程式碼。喺 Apps Script 撳「部署 → 管理部署作業 → 編輯（鉛筆）→ 版本揀「新版本」→ 部署」，個 /exec 網址唔會變。';
  }
  return '';
}

/* ---------------- 三個主要動作 ---------------- */

/** 把成個資料庫寫入後端 */
export async function pushDb({ silent = true } = {}) {
  if (isMock()) return { ok: false, reason: 'mock', error: '示範模式唔會寫入後端' };
  const db = tryLoad();
  if (!db) return { ok: false, reason: 'no_db', error: '資料庫未載入' };
  const cfg = remoteCfg();
  if (!cfg.ok) return { ok: false, reason: 'not_configured', error: '未設定後端網址' };
  if (inFlight) return { ok: false, reason: 'busy', error: '上一次儲存仲未完成' };

  inFlight = true;
  if (!silent) setState('saving', '儲存緊…');
  else setState('saving');

  /* 記住「我送出嘅係邊個版本」：送出期間如果又有新改動，
     pending 唔可以當成 0（否則嗰啲改動會靜靜雞唔見咗）。 */
  const sentPending = Number(db.sync?.pending || 0);
  const sentAt = db.meta?.updatedAt || '';

  try {
    const r = await callBackend({ action: 'saveDb', db });
    const cur = load();
    cur.sync = cur.sync || {};
    if (r.ok) {
      /* 送出期間新增嘅改動要留返 pending（送出時 snapshot 減走就啱） */
      const now = Number(cur.sync.pending || 0);
      cur.sync.pending = Math.max(0, now - sentPending);
      cur.sync.lastPushAt = new Date().toISOString();
      cur.sync.remoteVersion = r.version || sentAt;
      cur.sync.lastError = '';
      pushLog(cur, `✓ 已儲存到後端（${fmtBytes(r.bytes)}）`);
      retryStep = 0;
      setState(cur.sync.pending ? 'pending' : 'saved', cur.sync.pending ? '仲有新改動未儲存' : '已儲存到後端');
      /* 送出期間又有改動 → 再存多次 */
      if (cur.sync.pending && armed) scheduleSave();
    } else {
      cur.sync.lastError = r.error || '';
      pushLog(cur, `✗ 儲存失敗：${r.error || '未知錯誤'}`);
      setState('error', r.error || '儲存失敗');
    }
    /* 一定要用 commitMeta（唔係 commit）：簿記唔可以再標記成「有改動」，
       否則會變成「存完又存」嘅無限迴圈。 */
    commitMeta();
    return r;
  } finally {
    inFlight = false;
  }
}

/** 由後端讀返成個資料庫（唔會自動覆蓋本機 —— 交返畀呼叫者決定） */
export async function pullDb() {
  if (isMock()) return { ok: false, reason: 'mock', error: '示範模式唔會讀後端' };
  const cfg = remoteCfg();
  if (!cfg.ok) return { ok: false, reason: 'not_configured', error: '未設定後端網址' };
  setState('loading', '讀取緊後端資料…');
  const r = await callBackend({ action: 'loadDb' });
  if (r.ok) setState('idle');
  else setState('error', r.error || '讀取失敗');
  return r;
}

/** 只問後端有冇資料、幾時更新（開機比對用，唔會傳成份資料落嚟） */
export async function remoteInfo() {
  if (isMock()) return { ok: false, reason: 'mock' };
  const cfg = remoteCfg();
  if (!cfg.ok) return { ok: false, reason: 'not_configured' };
  return callBackend({ action: 'dbInfo' }, { timeoutMs: 20000 });
}

/** 測試連線 */
export async function testConnection() {
  const cfg = remoteCfg();
  if (!cfg.url) return { ok: false, error: '未填 Apps Script 網址' };
  const r = await callBackend({ action: 'status' }, { timeoutMs: 20000 });
  return r;
}

/* ---------------- 自動儲存 ---------------- */

/**
 * 由 store.persist() 呼叫：改動之後排隊，debounce 幾秒先寫入後端。
 * 離線／失敗會自動重試，唔會靜靜雞唔見咗。
 */
export function scheduleSave() {
  if (!armed || isMock()) return;
  const cfg = remoteCfg();
  if (!cfg.ok || !cfg.auto) return;

  setState('pending', '未儲存');
  if (timer) clearTimeout(timer);
  timer = setTimeout(runSave, DEBOUNCE_MS);
}

async function runSave() {
  timer = null;
  if (!armed || isMock()) return;
  const cfg = remoteCfg();
  if (!cfg.ok || !cfg.auto) return;

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setState('offline', '離線 —— 一有網絡就會自動儲存');
    scheduleRetry();
    return;
  }
  if (inFlight) { scheduleRetry(); return; }

  const r = await pushDb({ silent: true });
  if (!r.ok && r.reason !== 'not_configured' && r.reason !== 'mock') scheduleRetry();
}

function scheduleRetry() {
  const wait = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)];
  retryStep = Math.min(retryStep + 1, RETRY_MS.length - 1);
  if (timer) clearTimeout(timer);
  timer = setTimeout(runSave, wait);
}

/** 即刻寫入（唔等 debounce）——「立即儲存」掣同離開頁面前用 */
export async function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!remoteConfigured()) return { ok: false, reason: 'not_configured' };
  return pushDb({ silent: false });
}

/** 有冇改動仲未寫入後端 */
export function hasPending() {
  const db = tryLoad();
  return !!(db?.sync?.pending);
}

/* 一返到線就即刻試多次 */
try {
  window.addEventListener('online', () => {
    if (armed && hasPending()) { retryStep = 0; runSave(); }
  });
} catch { /* 非瀏覽器環境 */ }

/* ---------------- 小工具 ---------------- */
function pushLog(db, msg) {
  db.sync = db.sync || {};
  const at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.sync.log = [...(db.sync.log || []), { at, msg }].slice(-40);
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB';
  return (v / 1024 / 1024).toFixed(2) + ' MB';
}

export { fmtBytes };
