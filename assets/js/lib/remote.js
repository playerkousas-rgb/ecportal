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

/** 開機完成之後先至開始自動儲存（避免種子資料一載入就寫返上去）。
    開機對資料期間（remoteInfo／pullDb 進行中）已經積落嘅 pending 改動
    （例如開機嗰幾秒之內登入寫嘅 audit）—— arm 嗰刻要即刻排隊補存，
    唔係佢會卡住直到下一個改動先至送到後端。 */
export function arm() {
  armed = true;
  if (hasPending()) scheduleSave();
}
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

/**
 * 把成個資料庫寫入後端。
 *
 * 2026-09-18 事故修復（「一登入就把後端清空」）：
 *   以前 push 係「盲蓋」—— 本機咩版本都照寫上去。過時裝置（離線耐咗、
 *   或者開機拉唔到後端）一有改動（登入都會寫一筆 audit！）就會把
 *   另一部機啱啱同步嘅資料整個蓋走。
 *   而家：
 *   ① 送 baseVersion（本機上次見過嘅後端版本）做樂觀鎖 —— 後端版本
 *     對唔上就拒收（conflict），舊資料冇得盲蓋；
 *   ② 撞 conflict → 自動「拉後端 → 同本機未同步改動合併 → 重存一次」，
 *     全程寫入 sync log；只會自動重試一次（防無限迴圈）；
 *   ③ 空機保險閘：本機完全冇內容（新裝置／清咗 cache）又從未拉過後端
 *     → 唔會自動送空白資料上去，淨係等拉。
 */
export async function pushDb({ silent = true, _retried = 0 } = {}) {
  if (isMock()) return { ok: false, reason: 'mock', error: '示範模式唔會寫入後端' };
  const db = tryLoad();
  if (!db) return { ok: false, reason: 'no_db', error: '資料庫未載入' };
  const cfg = remoteCfg();
  if (!cfg.ok) return { ok: false, reason: 'not_configured', error: '未設定後端網址' };
  if (inFlight) return { ok: false, reason: 'busy', error: '上一次儲存仲未完成' };

  const store = await import('./store.js');
  const synced = store.lastSyncedVersion();
  /* 空機保險閘：本機完全冇內容（新裝置／清咗 cache）又從未同後端對過版本
     —— 呢種狀態只應該「拉」，唔應該「推」。
     （例外：後端本身都仲係空 —— 新旅團第一筆資料都要存得到，所以先問一次 dbInfo。） */
  if (!store.hasLocalContent() && !synced) {
    const info = await callBackend({ action: 'dbInfo' }, { timeoutMs: 20000 });
    if (info?.ok && info.found) {
      db.sync = db.sync || {};
      pushLog(db, '✗ 空白裝置唔會自動寫後端 —— 等拉到後端資料先');
      commitMeta();
      setState('idle', '空白裝置：等緊由後端載入資料');
      scheduleSave();   // 遲啲再試（拉到資料就有嘢存）
      return { ok: false, reason: 'blank_guard', error: '本機係空白裝置，唔會自動蓋後端（等拉資料）' };
    }
  }

  inFlight = true;
  if (!silent) setState('saving', '儲存緊…');
  else setState('saving');

  /* 記住「我送出嘅係邊個版本」：送出期間如果又有新改動，
     pending 唔可以當成 0（否則嗰啲改動會靜靜雞唔見咗）。 */
  const sentPending = Number(db.sync?.pending || 0);
  const sentAt = db.meta?.updatedAt || '';

  try {
    const r = await callBackend({ action: 'saveDb', db, baseVersion: synced });
    const cur = load();
    cur.sync = cur.sync || {};

    /* 樂觀鎖撞版：另一部機啱啱先寫入後端。
       自動復原：拉後端 → 聯集合併本機未同步改動 → 重存一次。 */
    if (!r.ok && r.conflict) {
      cur.sync.lastError = r.error || '後端有較新版本';
      pushLog(cur, `⚠ 後端有另一部機寫入嘅新版本 —— 自動拉返嚟合併（第 ${_retried + 1} 次）`);
      commitMeta();
      inFlight = false;
      if (_retried >= 1) {
        setState('conflict', '兩邊都改咗：已合併一次都仲撞版，請去「總表同步」核對');
        return { ...r, ok: false, reason: 'conflict', hint: '已經自動合併咗一次都仲撞版 —— 好可能兩部機同時改緊。去「帳號與系統 → 資料管理 → 總表同步」撳「由後端還原」，或者等一陣再儲存。' };
      }
      const got = await pullDb();
      if (got?.ok && got.found && got.db) {
        try {
          store.adoptRemote(got.db, { version: got.version || got.db?.meta?.updatedAt || '', merge: true });
          if (typeof window !== 'undefined') {
            try { (await import('./util.js')).toast('另一部機更新咗後端 —— 已自動合併兩邊資料', 'ok'); } catch { /* */ }
          }
          setState('pending', '合併完成，儲存緊…');
          return await pushDb({ silent, _retried: _retried + 1 });
        } catch (e) {
          setState('error', '合併失敗：' + (e?.message || ''));
          return { ok: false, reason: 'conflict', error: '自動合併失敗：' + (e?.message || '') };
        }
      }
      setState('conflict', '後端有新版本但拉唔到 —— 一陣再自動試');
      scheduleRetry();
      return { ...r, ok: false, reason: 'conflict', hint: '拉唔到後端最新版本嚟合併，會自動再試。' };
    }

    if (r.ok) {
      /* 送出期間新增嘅改動要留返 pending（送出時 snapshot 減走就啱） */
      const now = Number(cur.sync.pending || 0);
      cur.sync.pending = Math.max(0, now - sentPending);
      cur.sync.lastPushAt = new Date().toISOString();
      cur.sync.remoteVersion = r.version || sentAt;
      /* 呢個版本嘅內容而家本機＝後端完全一致 —— 之後 push 用佢做 baseVersion */
      if (r.version) cur.sync.lastSyncedVersion = String(r.version);
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

/** 測試連線（同 remoteConfigured 一樣：有同源代理＋旅團編號就算接得通，
    唔會強制要前端填 /exec —— 純環境變數開團嘅旅團根本唔會填呢格） */
export async function testConnection() {
  const cfg = remoteCfg();
  if (!cfg.url && !cfg.viaProxy) return { ok: false, error: '未填 Apps Script 網址' };
  const r = await callBackend({ action: 'status' }, { timeoutMs: 20000 });
  return r;
}

/* ============================================================
   多人同時用（2026-09-18 團長要求：一齊開 APP 一齊做嘢）
   ============================================================ */
let checkBusy = false;
let pollTimer = null;

/**
 * 「立即同步」：問後端有冇隊友寫入嘅新版本 → 有就拉落嚟。
 * 本機有未同步改動 → 自動合併（聯集＋逐格深層合併，唔會盲蓋），
 * 合併完會照樣排隊存返上去。
 * 回 { updated:true } 表示有拉新嘢；{ upToDate:true } 表示已經係最新。
 */
export async function checkRemote({ silent = false } = {}) {
  if (isMock()) return { ok: false, reason: 'mock' };
  if (!remoteConfigured()) return { ok: false, reason: 'not_configured' };
  if (checkBusy || inFlight) return { ok: false, reason: 'busy' };
  checkBusy = true;
  try {
    const store = await import('./store.js');
    const info = await remoteInfo();
    if (!info?.ok) {
      if (!silent) { try { (await import('./util.js')).toast(info?.error || '問唔到後端', 'err'); } catch { /* */ } }
      return { ok: false, error: info?.error || '問唔到後端' };
    }
    if (!info.found) return { ok: true, found: false };
    const remoteAt = String(info.version || info.at || '');
    if (!remoteAt || remoteAt === store.lastSyncedVersion()) {
      return { ok: true, upToDate: true };
    }
    const got = await pullDb();
    if (got?.ok && got.found && got.db) {
      const merged = Number(store.tryLoad()?.sync?.pending || 0) > 0;
      store.adoptRemote(got.db, { version: String(got.version || ''), merge: merged });
      if (merged) scheduleSave();          // 本機改動仲喺度 → 繼續排隊存
      return { ok: true, updated: true, merged, version: remoteAt };
    }
    return { ok: false, error: got?.error || '拉唔到後端資料' };
  } finally {
    checkBusy = false;
  }
}

/**
 * 會議模式：每 60 秒（有開住、冇收埋）靜靜問一次後端有冇隊友更新。
 * 有 → 拉落嚟；如果用家**唔係打緊字**（冇 input／textarea focus）
 * 就即刻重繪畫面 —— 一齊睇嗰陣大家都會見到對方嘅最新改動。
 * 用家打緊字就只彈提示，唔會炸走佢個表單。
 */
export function startPolling(intervalMs = 60000) {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      if (!armed || isMock() || !remoteConfigured()) return;
      if (inFlight || checkBusy || hasPending()) return;     // 自己未存好就唔好撈亂
      if (typeof document !== 'undefined' && document.hidden) return;
      const r = await checkRemote({ silent: true });
      if (!r?.updated) return;
      const util = await import('./util.js').catch(() => null);
      const tag = typeof document !== 'undefined' ? String(document.activeElement?.tagName || '').toUpperCase() : '';
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (typing) {
        try { util?.toast?.('隊友更新咗後端 —— 撳右上「立即同步」就見到最新', 'info'); } catch { /* */ }
        return;
      }
      try { window.dispatchEvent(new CustomEvent('v82:refresh')); } catch { /* */ }
      try { util?.toast?.('已載入隊友嘅最新改動', 'ok'); } catch { /* */ }
    } catch { /* 靜靜地失敗，下次再試 */ }
  }, Math.max(20000, intervalMs));
}
export function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

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
