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

   路線（優先次序；兩條都要行得通，見 lib/gateway.js）：
     ① 同源 /api/proxy  —— 冇 CORS、API Key 由伺服器端補上（最穩陣）
     ② 直接 POST 去 /exec —— 平台未登記旅團（或者純靜態部署）時嘅自助路線；
        領袖喺「總表同步」貼返 /exec ＋ API Key 就即刻用得，唔使等管理員。

   注意：示範（MOCK）模式永遠唔會送出任何嘢。
   ============================================================ */

import { load, tryLoad, commitMeta, isMock, currentUnit } from './store.js';
import { postBackend, isExecUrl, shortExec } from './gateway.js';

/* ---------------- 狀態 ---------------- */
/* 2026-09-19：RETRY_MS／DEBOUNCE_MS／retryStep 已剷走 ——
   佢哋係「改完 2.5 秒自動存」同「失敗後 4s/15s/60s 背景自動重試」用嘅。
   自動寫入剷走之後呢三樣冇任何用途，留低只會令人以為仲有背景寫入。 */
let timer = null;
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
  /* ============================================================
     2026-09-19 團長指示（最終決定）：
       「既然自動會有機會出事，就唔好比佢有得選 …… 將啲有機會出事嘅地方
         FIX 曬佢，同唔好比佢有機會出事。」

     所以**自動寫入已經剷走**，唔係「預設熄咗」而係**冇呢條路**：
     呢度係一個寫死嘅 false，冇任何設定、環境變數、舊遺留值可以把它變 true。
     （之前嘅 autoModel 記號都唔再需要 —— 冇得揀就冇得揀錯。）

     而家成個 app 寫後端只有一條路：用家撳「立即同步」→ syncNow()
     → 先讀後端合併 → 一次過寫。仲有團員入口交嘢（入站資料，見 pushSubmit()）。
     ============================================================ */
  return {
    url,
    apiKey: s.apiKey !== undefined ? s.apiKey : (db.backend?.apiKey || ''),
    unit,
    auto: false,                       // ← 寫死。冇得開。
    /* 會議模式（每 60 秒背景讀一次）係**淨係讀**，唔會寫任何嘢，
       所以留返做 opt-in 冇安全問題。預設關（團長：「唔好不停讀」）。 */
    poll: s.poll === true,
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
 *
 * 兩條路（完整解釋見 lib/gateway.js 頂部）：
 *   ① 同源 /api/proxy —— 平台伺服器端登記咗旅團（TROOP_<編號>_BACKEND/_APIKEY），
 *      API Key 留喺伺服器，瀏覽器唔會見到。
 *   ② 直接打領袖自己貼嘅 /exec —— 平台未登記嗰陣唯一嘅自助路線。
 *
 * 2026-09-19 修正（團長回報「填咗 /exec 都係同步唔到」）：
 * 以前 proxy 對未登記旅團回 HTTP 404 ＋ JSON，而舊 code 只在「回應唔係 JSON」
 * 嗰陣先肯跌落 ② —— 所以 ② 永遠行唔到，領袖自己貼嘅 /exec 形同虛設。
 * 而家統一由 gateway.postBackend() 路由：proxy 話「未登記」就跌落 ②。
 */
async function callBackend(payload, { timeoutMs = 60000 } = {}) {
  const cfg = remoteCfg();
  if (!cfg.unit) return { ok: false, reason: 'not_configured', error: '未知旅團編號' };
  if (!cfg.url && !cfg.viaProxy) {
    return { ok: false, reason: 'not_configured', error: '未設定後端網址（去「總表同步」填 /exec）' };
  }

  const r = await postBackend(payload, {
    unit: cfg.unit, execUrl: cfg.url, apiKey: cfg.apiKey, timeoutMs
  });

  /* 兩條路都冇得行：講清楚係「平台未登記」定「自己都未填」 */
  if (r.via === 'none') {
    return { ok: false, reason: r.reason, error: r.error, hint: r.reason === 'not_registered' ? SELF_SERVE_HINT : '' };
  }
  if (!r.json) {
    return { ok: false, reason: r.reason || 'network', error: r.error || '連唔到旅團後端', hint: r.reason === 'bad_url' ? URL_HINT : '' };
  }
  const out = normalize(r.json);
  out.via = r.via;                       // 界面／診斷用：今次行咗邊條路
  if (!out.ok) out.hint = hintOf(out.error, r.via);
  return out;
}

/* 「平台未登記」嗰陣嘅自助方法 —— 呢句一定要出到嚟，
   否則用家只見到「找不到此旅團」，完全唔知自己其實即刻救得返。 */
const SELF_SERVE_HINT =
  '平台伺服器端未登記你旅團嘅後端（TROOP_<旅團編號>_BACKEND / _APIKEY 未設定，或者變數名打錯）。'
  + '兩個選擇：① 叫平台管理員喺 Vercel 加返嗰兩個環境變數再 Redeploy；'
  + '② 自己即刻救返 —— 去「帳號與系統 → 資料管理 → 總表同步 → 同步設定」，'
  + '貼你嘅 Apps Script /exec 網址＋API Key（喺 Apps Script 執行 showApiKey() 攞），撳「儲存設定」，'
  + '然後撳「同步診斷」確認。';

const URL_HINT =
  '後端網址一定要係 Apps Script「部署為網頁應用程式」之後嘅正式網址：'
  + 'https://script.google.com/macros/s/…/exec（唔接受 /dev，唔接受其他網域）。';

function normalize(j) {
  const ok = j.ok === true || j.success === true;
  const raw = j.error || (ok ? '' : (j.msg || '後端拒絕咗呢個請求'));
  return { ...j, ok, error: raw, reason: ok ? '' : reasonOf(raw), hint: ok ? '' : hintOf(raw, '') };
}

/* 後端回嘅錯誤字眼 → 分類，等介面可以講返「去邊度撳邊粒掣」 */
function reasonOf(err) {
  const s = String(err || '');
  if (/API ?Key|未授權|unauthor/i.test(s)) return 'bad_key';
  if (/未知 action|unknown action/i.test(s)) return 'old_deploy';
  return 'backend';
}

/* 呢兩個係最常見、又最難自己估到嘅死因，所以直接寫清楚點解決。
   `via` ＝ 今次行緊邊條路（'proxy' = 平台代理／'direct' = 自己貼嘅 /exec）——
   同一個「API Key 唔啱」，兩條路嘅救法完全唔同，提示一定要分開。
   （export 出嚟畀 tests/remote.mjs 做**行為**斷言，唔使再 grep 原始碼。） */
export function hintOf(err, via = '') {
  const r = reasonOf(err);
  if (r === 'bad_key') {
    /* 行緊自助路線（直接打 /exec）＝ 條 key 由瀏覽器帶，提示就唔應該
       淨係叫「搵平台管理員」—— 用家自己貼返條 key 就即刻得。 */
    if (via === 'direct') {
      return '你而家行緊「自己貼 /exec」路線，條 API Key 要跟住一齊貼。'
        + '喺 Apps Script 執行 showApiKey() 攞到嗰條（v82_…），貼入「總表同步 → 同步設定 → API Key」再儲存。'
        + '（正路仍然係交畀平台管理員入 Vercel 環境變數 TROOP_<旅團編號>_APIKEY，咁條 key 就唔會落瀏覽器。）';
    }
    /* 平台代理路線：條 key 應該留喺伺服器端 —— 呢度**唔會**叫用家自己打 key
       （2026-09-17 嘅決定，仍然有效）。自助路線嘅提示係另一條 branch。 */
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


/* ============================================================
   開機對版本（reconcile）—— 所有 push 之前嘅必經關卡
   ------------------------------------------------------------
   2026-09-19 團長第二次回報，講到正題：
     「其他 APP 都係暫存喺瀏覽器、撳同步先一次過 SAVE；呢個成日自動 SAVE
       就變相蓋咗佢 …… A 開佢未讀後端就已經複寫，B 開又係 —— 永遠自己睇自己。」

   佢講嘅死因係真嘅。舊 code 嘅保護得兩層，兩層都堵唔到呢個位：
     · blank_guard —— 只擋「本機完全冇內容」嘅新機；一部**用咗好耐**嘅機
       （本機有內容、sync.lastSyncedVersion 係舊值）完全唔受保護；
     · 樂觀鎖 baseVersion —— 要**後端**係 v2.2.0+ 先至有效，舊 Code.gs 照收盲蓋。
   而 syncBoot() 係 `try { remoteInfo() … } catch { 照用本機 }` ——
   開機問唔到後端（網絡慢、逾時、後端未更新）就當冇事，跟住 arm()
   → `if (hasPending()) scheduleSave()` → 2.5 秒後 push。
   **未讀後端就已經寫後端**，正正係「永遠自己睇自己」。

   而家嘅規則，一句話：**未讀到後端最新版本之前，一律唔准寫後端。**
   讀唔到就照舊排隊重試（資料唔會蝕），但絕不盲蓋。
   ============================================================ */
let reconciled = false;
let reconcileBusy = null;
let blockLoggedAt = 0;

/** 呢個 session 有冇成功同後端對過版本（＝准唔准 push） */
export function isReconciled() { return reconciled; }
/** 測試／「由後端還原」等已確定兩邊一致嘅場合可以手動 set */
export function markReconciled(v = true) { reconciled = !!v; }

/**
 * 同後端對一次版本：後端有更新 → 拉落嚟（本機有未存改動就聯集合併）。
 *
 * 開機、「立即同步」掣、60 秒 poll、切返視窗、**同每次 push 之前**，
 * 全部行呢一個函數 —— 「先讀後端，先至寫後端」呢個次序冇得繞過。
 *
 * @returns {Promise<{ok:boolean, updated?:boolean, merged?:boolean,
 *                    upToDate?:boolean, found?:boolean, oldBackend?:boolean,
 *                    error?:string, reason?:string}>}
 */
export async function reconcile({ silent = true } = {}) {
  if (isMock()) return { ok: false, reason: 'mock' };
  if (!remoteConfigured()) return { ok: false, reason: 'not_configured' };
  if (reconcileBusy) return reconcileBusy;
  reconcileBusy = (async () => {
    try {
      const store = await import('./store.js');
      const info = await remoteInfo();
      if (!info?.ok) {
        if (!silent) { try { (await import('./util.js')).toast(info?.error || '問唔到後端', 'err'); } catch { /* */ } }
        /* reason／hint 一定要原封不動帶出去：callBackend 對 not_registered／
           bad_url 會附上「自救方法」（自己去貼 /exec ＋ API Key）。呢啲提示
           係 2026-09-17 落嘅政策，唔可以喺呢一層被食走，否則用家又變返
           淨係見到「同步失敗」四個字，唔知可以自己做嘢救返。 */
        return { ok: false, error: info?.error || '問唔到後端', reason: info?.reason || 'network', hint: info?.hint || '' };
      }
      /* 問到後端 ＝ 已經對過版本（後端本身係空都算）—— 之後先至准 push */
      reconciled = true;
      if (!info.found) return { ok: true, found: false, upToDate: true };
      const remoteAt = String(info.version || info.at || '');
      /* 後端連版本／時間戳都冇回 ＝ 舊版 Code.gs：版本對唔到，
         兩邊視窗永遠唔會知對方有更新（「自己睇自己」嘅另一個成因）。 */
      if (!remoteAt) return { ok: true, oldBackend: true };
      if (remoteAt === store.lastSyncedVersion()) return { ok: true, upToDate: true };
      const got = await pullDb();
      if (got?.ok && got.found && got.db) {
        const merged = Number(store.tryLoad()?.sync?.pending || 0) > 0;
        store.adoptRemote(got.db, { version: String(got.version || ''), merge: merged });
        if (merged) scheduleSave();          // 本機改動仲喺度 → 繼續排隊存
        return { ok: true, updated: true, merged, version: remoteAt };
      }
      return { ok: false, error: got?.error || '拉唔到後端資料' };
    } finally { reconcileBusy = null; }
  })();
  return reconcileBusy;
}

/**
 * 「立即同步」＝ 一次過：**先讀後端**（有新版就拉＋合併）→ **再寫後端**。
 * 團長要嘅模式：改動淨係暫存喺瀏覽器，撳呢一下先至真係同後端交換。
 * （以前「立即同步」淨係拉、「立即儲存」淨係推 —— 兩下都要撳，
 *   而且唔撳「同步」直接撳「儲存」就會蓋，正正係佢投訴嗰樣。）
 */
export async function syncNow() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (isMock()) return { ok: false, reason: 'mock', error: '示範模式唔會寫後端' };
  if (!remoteConfigured()) return { ok: false, reason: 'not_configured', error: '未設定後端' };
  const rc = await reconcile({ silent: false });
  if (!rc?.ok) return { ok: false, stage: 'pull', error: rc?.error || '讀唔到後端', reason: rc?.reason };
  if (rc.oldBackend) warnOldBackend();
  const pending = Number(tryLoad()?.sync?.pending || 0);
  if (!pending) {
    setState(rc.updated ? 'saved' : 'idle', rc.updated ? '已載入隊友最新改動' : '已同步');
    return { ok: true, pulled: !!rc.updated, mergedPull: !!rc.merged, pushed: false, upToDate: !rc.updated };
  }
  const p = await pushDb({ silent: false });
  return { ...p, stage: 'push', pulled: !!rc.updated, mergedPull: !!rc.merged, pushed: !!p.ok };
}
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
 *   ④ 2026-09-19 加：呢個 session **未成功讀到後端最新版本之前一律唔准寫**
 *     （團長回報「A 開佢未讀後端就已經複寫 …… 永遠自己睇自己」）。
 *     ①②③ 都堵唔到呢個位：③ 只擋空白新機，② 要後端係 v2.2.0+ 先至有效。
 *     讀唔到就排隊重試 —— 資料唔會蝕，但絕不盲蓋。
 */
export async function pushDb({ silent = true, _retried = 0 } = {}) {
  if (isMock()) return { ok: false, reason: 'mock', error: '示範模式唔會寫入後端' };
  /* 注意一定要用 let：下面嘅 reconcile() 會 adoptRemote()，而 adoptRemote 係
     `state.db = { ...merged }` —— **換一個新物件**。如果呢度用 const 抓住
     舊引用，後面就會把「合併之前」嘅舊 db 序列化寫上後端，隊友啲資料照樣
     冇咗（tests/remote.mjs 衝突復原一節釘住呢個位）。 */
  let db = tryLoad();
  if (!db) return { ok: false, reason: 'no_db', error: '資料庫未載入' };
  const cfg = remoteCfg();
  if (!cfg.ok) return { ok: false, reason: 'not_configured', error: '未設定後端網址' };
  if (inFlight) return { ok: false, reason: 'busy', error: '上一次儲存仲未完成' };

  const store = await import('./store.js');
  /* ★ 一定要喺 reconcile() **之前**判斷「呢部機係咪空白」。
     reconcile 會把後端資料拉落嚟，拉完之後 hasLocalContent() 一定係 true ——
     事後先判斷就永遠擋唔到空白裝置，部新機就會無端端寫一次後端（推高版本，
     搞到其他視窗全部以為有更新要重拉）。 */
  const wasBlank = !store.hasLocalContent() && !store.lastSyncedVersion();

  /* ④ 硬保險：未讀到後端最新版本之前，一律唔准寫。
     對得到就即刻繼續（reconcile 已經順手把隊友嘅新版本拉咗落嚟＋合併）；
     對唔到（離線／後端壞／平台未登記）就排隊重試，唔會盲蓋。 */
  if (!reconciled) {
    const rc = await reconcile({ silent: true });
    if (!rc?.ok) {
      setState('unreachable', '未讀到後端 —— 暫時唔寫入（避免蓋走另一部機嘅資料）');
      if (Date.now() - blockLoggedAt > 300000) {       // 5 分鐘至記一次，唔好洗版
        blockLoggedAt = Date.now();
        const d0 = tryLoad();
        d0.sync = d0.sync || {};
        pushLog(d0, `⛔ 未讀到後端（${rc?.error || '未知'}）—— 暫時唔寫入，改動繼續排隊`);
        commitMeta();
      }
      scheduleRetry();
      /* 真正嘅原因要照實報出去（平台未登記／網址唔合格 …），唔好一律叫
         not_reconciled —— 用家要分得清「自己即刻做得到」定「要等平台管理員」。
         而 callBackend 對呢啲原因附上嘅自救 hint 一定要留住（2026-09-17 政策），
         否則用家又變返淨係見到「同步失敗」，唔知原來自己貼 /exec 就救得返。 */
      const specific = !!rc?.reason && rc.reason !== 'network';
      return {
        ok: false,
        reason: specific ? rc.reason : 'not_reconciled',
        error: '未讀到後端最新版本 —— 暫時唔寫入（怕蓋走另一部機嘅資料）'
          + (specific && rc?.error ? `：${rc.error}` : ''),
        hint: [rc?.hint,
          '你嘅改動仲喺呢部機，冇蝕到；網絡／後端返嚟就會自動再試。'
          + '想即刻查係邊一格斷咗，去「帳號與系統 → 資料管理 → 總表同步」撳「同步診斷」。'
        ].filter(Boolean).join(' ')
      };
    }
    /* ★ reconcile() 可能已經拉咗後端新版本落嚟合併（adoptRemote 換咗新物件）。
       一定要重新讀一次 db —— 如果冇呢一行，下面就會把「合併之前」嘅舊 db
       寫上後端，等於自己親手蓋走啱啱拉返嚟嘅隊友資料。 */
    db = tryLoad();
  }

  const synced = store.lastSyncedVersion();
  /* 空機保險閘：本機完全冇內容（新裝置／清咗 cache）又從未同後端對過版本
     —— 呢種狀態只應該「拉」，唔應該「推」。
     （例外：後端本身都仲係空 —— 新旅團第一筆資料都要存得到，所以先問一次 dbInfo。）
     用 wasBlank（reconcile 之前嘅狀態）而唔係即場重算，理由見上。 */
  if (wasBlank) {
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

  /* 體積路由（v2.4.0）：
     · < 2.8MB → 單一 saveDb（同以前一樣）
     · ≥ 2.8MB → 自動分件（saveDbPart × N + saveDbCommit）—— 每件 < 2.8MB，
       行得晒現有所有路徑（同源 proxy／直接 /exec），所以旅團用幾十年、
       db 幾十 MB 都照存得，冇「要停止使用」嘅天花板。
     · > 40MB → 硬止（GAS 6 分鐘執行上限先會真係有問題），叫去體積檢查。 */
  let dbText = '';
  try { dbText = JSON.stringify(db); } catch { /* ignore */ }
  const dbBytes = dbText.length;
  if (dbBytes > 40000000) {
    db.sync = db.sync || {};
    pushLog(db, `✗ 資料庫已達 ${fmtBytes(dbBytes)} —— 去「體積檢查」睇下邊個分頁食緊嘢`);
    commitMeta();
    setState('error', `資料庫太大（${fmtBytes(dbBytes)}）`);
    return { ok: false, reason: 'too_big', hint: '去「帳號與系統 → 資料管理 → 總表同步 → 體積檢查」睇下邊個分頁食緊位（多數係試卷答卷／通告回應累積）。' };
  }
  const useParts = dbBytes > CHUNKED_ABOVE;

  inFlight = true;
  if (!silent) setState('saving', '儲存緊…');
  else setState('saving');

  /* 記住「我送出嘅係邊個版本」：送出期間如果又有新改動，
     pending 唔可以當成 0（否則嗰啲改動會靜靜雞唔見咗）。 */
  const sentPending = Number(db.sync?.pending || 0);
  const sentAt = db.meta?.updatedAt || '';

  try {
    let r;
    let usedParts = 0;
    if (useParts) {
      /* v2.4.0 分件：拆件 → 逐件送（任何一件撞版都即停）→ commit 拼合 */
      const parts = splitDbIntoParts(db, PART_MAX_BYTES);
      const saveId = `${cfg.unit}-stg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      r = null;
      let fellBack = false;   // 舊後端（未部署 v2.4.0）→ 退返單件路
      for (let i = 0; i < parts.length; i++) {
        setState('saving', `分件儲存中…（${i + 1}/${parts.length}）`);
        let pr = await callBackend({ action: 'saveDbPart', unit: cfg.unit, data: parts[i],
          partIdx: i, parts: parts.length, saveId, baseVersion: synced });
        /* 後端話「未知 action」＝ 仲係 v2.3.0 舊版 → 退返單件 saveDb
           （舊後端照收得到 4MB 以下；真係超標會喺單件路度如實回錯） */
        if (!pr.ok && /未知 action/.test(String(pr.error || ''))) {
          pushLog(load(), '⚠ 後端仲係舊版（未部署分件儲存 v2.4.0）—— 改用單一件儲存');
          r = await callBackend({ action: 'saveDb', db, baseVersion: synced });
          fellBack = true;
          break;      // 已經成份存咗，唔好再送剩低嘅件
        }
        if (!fellBack && !pr.ok) {
          const cur0 = load();
          cur0.sync = cur0.sync || {};
          if (pr.conflict) {
            cur0.sync.lastError = pr.error || '後端有較新版本';
            pushLog(cur0, `⚠ 第 ${i + 1}/${parts.length} 件撞版 —— 自動拉後端合併再重存`);
            commitMeta();
            inFlight = false;
            return await recoverFromConflict(pr, silent, _retried);
          }
          cur0.sync.lastError = pr.error || '分件儲存失敗';
          pushLog(cur0, `✗ 分件 ${i + 1}/${parts.length} 失敗：${pr.error || '未知錯誤'}`);
          commitMeta();
          setState('error', pr.error || '分件儲存失敗');
          return { ok: false, reason: pr.reason || 'backend', error: pr.error || '分件儲存失敗' };
        }
      }
      if (!fellBack) {
        setState('saving', `分件完成，拼合中…（${parts.length} 件）`);
        r = await callBackend({ action: 'saveDbCommit', unit: cfg.unit, saveId, parts: parts.length, baseVersion: synced });
        usedParts = parts.length;
      }
    } else {
      r = await callBackend({ action: 'saveDb', db, baseVersion: synced });
    }
    const cur = load();
    cur.sync = cur.sync || {};

    /* 樂觀鎖撞版：另一部機啱啱先寫入後端 → 自動復原（拉＋合併＋重存一次） */
    if (!r.ok && r.conflict) {
      cur.sync.lastError = r.error || '後端有較新版本';
      pushLog(cur, `⚠ 後端有另一部機寫入嘅新版本 —— 自動拉返嚟合併（第 ${_retried + 1} 次）`);
      commitMeta();
      inFlight = false;
      return await recoverFromConflict(r, silent, _retried);
    }

    if (r.ok) {
      /* 送出期間新增嘅改動要留返 pending（送出時 snapshot 減走就啱） */
      const now = Number(cur.sync.pending || 0);
      cur.sync.pending = Math.max(0, now - sentPending);
      cur.sync.lastPushAt = new Date().toISOString();
      cur.sync.remoteVersion = r.version || sentAt;
      /* 呢個版本嘅內容而家本機＝後端完全一致 —— 之後 push 用佢做 baseVersion */
      if (r.version) cur.sync.lastSyncedVersion = String(r.version);
      /* 本機＝後端 → 更新三方合併基準（淨係喺冇剩低未同步改動嗰陣；
         否則送出期間新改嘅嘢會被當成「本機冇改過」而俾後端蓋返）。 */
      if (!cur.sync.pending) store.markBaseAligned();
      cur.sync.lastError = '';
      if (usedParts) r.parts = usedParts;     // 測試／log 用：今次行咗分件
      pushLog(cur, `✓ 已儲存到後端（${fmtBytes(r.bytes)}${usedParts ? `，分 ${usedParts} 件` : ''}）`);
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

/** 撞版復原（單件／分件共用）：拉後端 → 聯集合併 → 重存一次 */
async function recoverFromConflict(r, silent, _retried) {
  if (_retried >= 1) {
    setState('conflict', '兩邊都改咗：已合併一次都仲撞版，請去「總表同步」核對');
    return { ...r, ok: false, reason: 'conflict', hint: '已經自動合併咗一次都仲撞版 —— 好可能兩部機同時改緊。去「帳號與系統 → 資料管理 → 總表同步」撳「由後端還原」，或者等一陣再儲存。' };
  }
  const got = await pullDb();
  if (got?.ok && got.found && got.db) {
    try {
      const store = await import('./store.js');
      store.adoptRemote(got.db, { version: String(got.version || got.db?.meta?.updatedAt || ''), merge: true });
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
  const r = await callBackend({ action: 'dbInfo' }, { timeoutMs: 20000 });
  /* 問唔到後端一定要出到嚟 —— 以前呢度靜靜雞回，右上角照樣顯示「已連後端」，
     用家完全唔知其實一直冇同步（2026-09-19 團長回報）。 */
  if (!r.ok) setState('unreachable', r.error || '連唔到後端');
  return r;
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
   同步診斷（2026-09-19 團長回報「唔知點解唔得，懷疑有嘢被封死」）
   ------------------------------------------------------------
   成條鏈任何一環斷咗，用家見到嘅都只係「同步失敗」四個字。
   呢度把成條鏈逐格驗一次，如實話你知**邊一格斷、要邊個做咩**。
   只讀，唔會寫任何嘢入後端。
   ============================================================ */
const FIX_ENV = (u) =>
  `交畀平台管理員：Vercel → Settings → Environment Variables 加 `
  + `TROOP_${u}_BACKEND（你嘅 /exec 網址）同 TROOP_${u}_APIKEY`
  + `（Apps Script 執行 showApiKey() 攞），然後 Deployments → Redeploy。`;

/**
 * 逐格驗成條同步鏈。
 * @returns {Promise<{ok:boolean, unit:string, route:string, backendVersion:string,
 *                    stages:Array<{id,label,state,detail,fix}>, blockers:Array}>}
 *   state: 'ok' | 'warn' | 'bad'
 */
export async function remoteDiagnose() {
  const cfg = remoteCfg();
  const out = { ok: false, unit: cfg.unit || '', route: '', backendVersion: '', stages: [], blockers: [] };
  const add = (id, label, state, detail, fix = '') => {
    out.stages.push({ id, label, state, detail: String(detail || ''), fix: String(fix || '') });
    if (state === 'bad') out.blockers.push({ id, label, detail: String(detail || ''), fix: String(fix || '') });
  };

  if (isMock()) { add('mock', '示範模式', 'warn', '示範（MOCK）模式永遠唔會寫後端', '喺旅團選擇閘揀返你嘅真實旅團'); return out; }

  /* ① 旅團編號 */
  if (!cfg.unit) {
    add('unit', '旅團編號', 'bad', '未知旅團編號', '喺旅團選擇閘揀返你嘅旅團（或者網址加 ?u=<編號>）');
    return out;
  }
  add('unit', '旅團編號', 'ok', cfg.unit);

  /* ② 平台伺服器端登記（Registry）—— 只回變數名，永遠唔會回 Key／完整網址
     嚴重程度睇「有冇自助路線頂住」：用家自己貼咗合格嘅 /exec 就只係 warn
     （同步照行得通，只係平台未接線）；兩邊都冇先至算 bad（真係同步唔到）。 */
  const selfOk = isExecUrl(cfg.url);
  const regBad = selfOk ? 'warn' : 'bad';
  let reg = null;
  try {
    const r = await fetch('api/units?diag=1&_=' + Date.now(), { cache: 'no-store' });
    if (r.ok) reg = await r.json();
  } catch (e) { /* 純靜態部署冇 /api */ }
  const diag = (reg && reg.diag) || null;
  if (!reg) {
    add('registry', '平台登記（伺服器端）', 'warn',
      '讀唔到 /api/units —— 呢個部署好似冇伺服器端 API（純靜態網站）',
      '用自助路線：喺「同步設定」貼 /exec ＋ API Key（下面第 ③ 格會驗）');
  } else {
    const ids = (diag?.ids || []).map(String);
    const trusted = (diag?.trusted || []).map(String);
    const withKey = (diag?.withKey || []).map(String);
    const u = cfg.unit;
    const viaSelf = selfOk ? '　你而家行緊自己貼嘅 /exec，所以同步照樣行得通。' : '　等唔切就自己貼 /exec ＋ API Key（自助路線）。';
    if (!ids.includes(u)) {
      add('registry', '平台登記（伺服器端）', regBad,
        `伺服器端 Registry 完全冇 ${u}（而家認到嘅旅團：${ids.join(', ') || '一個都冇'}）`,
        FIX_ENV(u) + viaSelf);
    } else if (!trusted.includes(u)) {
      add('registry', '平台登記（伺服器端）', regBad,
        `有 ${u}，但 TROOP_${u}_BACKEND 未設定（或者唔係正式 /exec 網址）`,
        FIX_ENV(u) + viaSelf);
    } else if (!withKey.includes(u)) {
      add('registry', '平台登記（伺服器端）', 'warn',
        `TROOP_${u}_BACKEND 有，但 TROOP_${u}_APIKEY 未有 —— 經平台代理嘅讀寫會被後端拒絕（未授權）`,
        FIX_ENV(u) + viaSelf);
    } else {
      add('registry', '平台登記（伺服器端）', 'ok',
        `TROOP_${u}_BACKEND ＋ TROOP_${u}_APIKEY 都已登記${diag?.vercelEnv ? `（環境：${diag.vercelEnv}）` : ''}`);
    }
    if (diag?.suspicious?.length) {
      add('envname', '環境變數名', 'warn',
        '疑似打錯名嘅變數：' + diag.suspicious.join(', '),
        `正確寫法：TROOP_${u}_BACKEND ／ TROOP_${u}_APIKEY（全大寫、底線分隔）`);
    }
  }

  /* ③ 用家自己貼嘅 /exec（自助路線） */
  if (cfg.url) {
    add('selfurl', '自己貼嘅 /exec', isExecUrl(cfg.url) ? 'ok' : 'bad',
      isExecUrl(cfg.url) ? `${shortExec(cfg.url)}${cfg.apiKey ? '（已附 API Key）' : '（未附 API Key）'}`
        : `格式唔啱：${String(cfg.url).slice(0, 60)}`,
      isExecUrl(cfg.url) ? '' : URL_HINT);
  } else {
    add('selfurl', '自己貼嘅 /exec', 'warn', '未填（平台登記正常就唔使填）',
      '平台未登記時嘅自救方法：呢格貼 /exec，旁邊 API Key 貼 showApiKey() 攞到嗰條');
  }

  /* ④ 後端回應＋版本 */
  const st = await callBackend({ action: 'status' }, { timeoutMs: 20000 });
  out.route = st.via || '';
  if (!st.ok) {
    add('status', '後端回應', 'bad', st.error || '連唔到後端', st.hint || '');
    out.summary = firstBlocker(out);
    return out;
  }
  const ver = String(st.backendVersion || '');
  out.backendVersion = ver;
  if (!ver) {
    add('status', '後端回應', 'bad', '連到，但後端回報唔到版本號 —— 仲行緊 v2.2.0 之前嘅舊 Code.gs',
      '去下面「後端 Apps Script 範本」撳「下載 Code.gs」→ 貼入 Apps Script → 部署 →「管理部署作業 → 編輯 → 版本：新版本 → 部署」（網址唔會變）。舊版後端症狀正正係：兩邊視窗對唔到料、無痕視窗讀唔到、團章公開頁睇唔到。');
  } else {
    add('status', '後端回應', 'ok', `已連接（後端 ${ver}，經${st.via === 'direct' ? '你自己貼嘅 /exec' : '平台代理'}）`);
  }

  /* ⑤ 讀寫權（dbInfo 同 saveDb 一樣要 API Key —— 過到就代表寫得入） */
  const info = await callBackend({ action: 'dbInfo' }, { timeoutMs: 20000 });
  if (!info.ok) {
    add('write', '讀寫權（API Key）', 'bad', info.error || '後端拒絕', info.hint || '');
  } else {
    const c = info.counts || {};
    add('write', '讀寫權（API Key）', 'ok',
      info.found
        ? `後端有資料庫：團員 ${c.members ?? '?'} · 帳目 ${c.transactions ?? '?'} · 通告 ${c.notices ?? '?'}（版本 ${String(info.version || info.at || '').slice(0, 19).replace('T', ' ')}）`
        : '後端仲未有資料庫 —— 撳「立即儲存到後端」推第一筆上去');
  }

  /* ⑥ 本機狀態 */
  const db = tryLoad();
  add('local', '本機狀態', 'ok',
    `團員 ${(db?.members || []).length} · 帳目 ${(db?.transactions || []).length}`
    + ` · 未儲存改動 ${Number(db?.sync?.pending || 0)} 項`
    + ` · 自動儲存${db?.sync?.auto === false ? '已關（要自己撳「立即儲存」）' : '開著'}`
    + ` · 上次同步版本 ${String(db?.sync?.lastSyncedVersion || '（未同步過）').slice(0, 19).replace('T', ' ')}`);

  out.ok = !out.blockers.length && out.stages.every(s => s.state !== 'bad');
  out.summary = out.ok
    ? `成條鏈正常（後端 ${ver || '已連接'}，經${out.route === 'direct' ? '你自己貼嘅 /exec' : '平台代理'}）`
    : firstBlocker(out);
  return out;
}

function firstBlocker(out) {
  const b = out.blockers[0] || out.stages.find(s => s.state !== 'ok');
  return b ? `${b.label}：${b.detail}` : '';
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
  if (checkBusy || inFlight) return { ok: false, reason: 'busy' };
  checkBusy = true;
  try {
    /* 2026-09-19：同 reconcile() 統一 —— 「讀後端 → 有新版就拉＋合併」
       而家成個 app 得一份實作（開機／poll／切視窗／push 之前／立即同步），
       唔會再出現「呢條路記得先讀後端、嗰條路唔記得」呢類不一致。 */
    return await reconcile({ silent });
  } finally {
    checkBusy = false;
  }
}

/**
 * 會議模式：每 60 秒（有開住、冇收埋）靜靜問一次後端有冇隊友更新。
 * 有 → 拉落嚟；如果用家**唔係打緊字**（冇 input／textarea focus）
 * 就即刻重繪畫面 —— 一齊睇嗰陣大家都會見到對方嘅最新改動。
 * 用家打緊字就只彈提示，唔會炸走佢個表單。
 *
 * 2026-09-19（團長回報：同一帳戶，無痕同普通視窗見到唔同嘢）：
 * 本機有未存好嘅改動都照樣 poll —— checkRemote 會「拉後端＋聯集合併」，
 * 本機未存嘅改動原封不動照樣排隊存，唔會再因為 push 失敗而永遠唔拉人哋嘢。
 */
export function startPolling(intervalMs = 60000) {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      if (!armed || isMock() || !remoteConfigured()) return;
      if (inFlight || checkBusy) return;             // 撞正自己存取就等下一轉
      if (typeof document !== 'undefined' && document.hidden) return;
      const r = await checkRemote({ silent: true });
      if (r?.oldBackend) { warnOldBackend(); return; }
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

/* ============================================================
   跨視窗／跨機同步（2026-09-19）
   無痕視窗同普通視窗各有各嘅 localStorage —— 同一帳戶兩邊開，
   以前要等最多 60 秒 poll 先會拉到對方嘅改動。而家：
   一切返呢個視窗（visibilitychange / focus）就 1.2 秒內即刻對一次版本，
   你撳過嚟嗰下就已經係最新。
   ============================================================ */
let visTimer = null;
let oldBackendWarned = false;

async function warnOldBackend() {
  if (oldBackendWarned) return;
  oldBackendWarned = true;
  try {
    const util = await import('./util.js');
    util?.toast?.('後端係舊版 Code.gs（冇版本號）—— 兩邊視窗會對唔到料。請去「總表同步」下載新版重新部署', 'err');
  } catch { /* */ }
}

export function startVisibilityWatch() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const poke = () => {
    if (document.hidden) return;
    clearTimeout(visTimer);
    visTimer = setTimeout(async () => {
      try {
        if (!armed || isMock() || !remoteConfigured()) return;
        if (inFlight || checkBusy) return;
        const tag = String(document.activeElement?.tagName || '').toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;   // 打緊字唔搞
        const r = await checkRemote({ silent: true });
        if (r?.oldBackend) { warnOldBackend(); return; }
        if (r?.updated) {
          try { window.dispatchEvent(new CustomEvent('v82:refresh')); } catch { /* */ }
          const util = await import('./util.js').catch(() => null);
          try { util?.toast?.('已載入最新資料', 'ok'); } catch { /* */ }
        }
      } catch { /* 靜靜地失敗 */ }
    }, 1200);
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poke(); });
  window.addEventListener('focus', poke);
  window.addEventListener('pageshow', poke);
}

/* ============================================================
   分件儲存（v2.4.0 長壽命架構）
   資料庫大過單一請求上限（proxy/Vercel ~4MB）都存得到：
   把 db 頂層 key 貪心分組成 N 件（每件 JSON < maxBytes）；
   大過 maxBytes 嘅陣列（例如十年帳目）會自己再切件。
   後端 saveDbCommit 拼合：同 key 全部係陣列 → 接駁；否則後件覆蓋。
   ============================================================ */
export const PART_MAX_BYTES = 2_800_000;   // 每件安全上限（< proxy 4MB / Vercel 4.5MB）
export const CHUNKED_ABOVE = 2_800_000;    // db JSON 大過呢個數就自動行分件

/** 純函數：把 db 拆成部分 db 陣列（每件 < maxBytes）。第一件一定有 meta／schema／unitCode。 */
export function splitDbIntoParts(db, maxBytes = PART_MAX_BYTES) {
  const must = ['schema', 'kind', 'unitCode'];
  const keys = Object.keys(db || {}).filter(k => !must.includes(k));
  const parts = [];
  let cur = {};
  const sizeOf = v => { try { return JSON.stringify(v ?? null).length; } catch { return 0; } };
  const curSize = () => Object.keys(cur).reduce((a, k) => a + sizeOf(cur[k]) + k.length + 4, 2);

  /* 細 key 先裝入第一件 */
  keys.forEach(k => {
    const sz = sizeOf(db[k]);
    if (sz > maxBytes * 0.8) return;               // 大件遲啲處理
    if (curSize() + sz > maxBytes && Object.keys(cur).length) { parts.push(cur); cur = {}; }
    cur[k] = db[k];
  });
  if (Object.keys(cur).length) { parts.push(cur); cur = {}; }

  /* 大 key：陣列可以切片；物件就要成件（理論上唔會超，超就照送） */
  keys.forEach(k => {
    const v = db[k];
    const sz = sizeOf(v);
    if (sz <= maxBytes * 0.8) return;
    if (Array.isArray(v)) {
      const per = Math.max(1, Math.ceil(v.length / Math.ceil(sz / (maxBytes * 0.8))));
      for (let i = 0; i < v.length; i += per) parts.push({ [k]: v.slice(i, i + per) });
    } else {
      parts.push({ [k]: v });
    }
  });

  /* 第一件注入必要欄位 */
  const head = {};
  must.forEach(k => { if (db?.[k] !== undefined) head[k] = db[k]; });
  if (!parts.length) parts.push({});
  parts[0] = { ...head, ...parts[0] };
  return parts;
}

/**
 * 相片上 Drive（v2.3.0 體積治理）：
 * APP 內申報嘅單據相直接經後端存入 Drive，db 入面只留連結 ——
 * 以前 dataURL 會將整個資料庫 JSON 撐到爆（saveDb 9MB 上限，
 * 一到就成個同步寫唔入）。
 */
export async function uploadPhotos(photos = [], { id = '' } = {}) {
  if (isMock()) return { ok: false, reason: 'mock', links: [] };
  const cfg = remoteCfg();
  if (!cfg.ok) return { ok: false, reason: 'not_configured', links: [] };
  /* 單據 Drive 資料夾：旅團設定（財務 → 設定／帳號與系統 都改到同一個欄） */
  const receiptDrive = String(tryLoad()?.settings?.receiptDrive || '').trim();
  const r = await callBackend({ action: 'uploadPhotos', payload: { id, photos }, folderId: receiptDrive }, { timeoutMs: 90000 });
  if (r?.ok && Array.isArray(r.links)) return { ok: true, links: r.links };
  return { ok: false, error: r?.error || '上載唔到', links: [] };
}

/* ---------------- 自動儲存 ---------------- */

/**
 * 由 store.persist() 呼叫：改動之後排隊，debounce 幾秒先寫入後端。
 * 離線／失敗會自動重試，唔會靜靜雞唔見咗。
 */
export function scheduleSave() {
  if (!armed || isMock()) return;
  const cfg = remoteCfg();
  if (!cfg.ok) return;
  /* 2026-09-19：自動寫入已剷走（remoteCfg().auto 寫死 false）。
     呢個函數而家**淨係更新狀態** —— 令頂部出「立即同步（N）」，
     話畀團長知有幾多改動暫存咗等佢撳。佢唔會排任何 timer、唔會寫後端。 */
  if (hasPending()) setState('pending', '未儲存 —— 撳「立即同步」先寫入後端');
}

/**
 * 2026-09-19：以前呢度係 `setTimeout(runSave, …)` —— 背景自動重試寫入。
 * 團長指示「唔好比佢有機會出事」，所以**自動重試一齊剷走**：
 * 寫入失敗就如實報，等用家自己撳多次。冇背景 timer ＝ 冇「唔知幾時會寫」。
 * 保留呢個函數名只係為咗唔使逐個 call site 改（佢而家淨係出狀態）。
 */
function scheduleRetry() {
  if (isMock()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setState('offline', '離線 —— 改動留喺呢部機，返到線撳「立即同步」');
    return;
  }
  setState('pending', '未儲存 —— 撳「立即同步」先寫入後端');
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

/* 一返到線：淨係**讀**一次後端（對版本／拉隊友最新）＋ 更新狀態。
   2026-09-19：以前呢度會 `runSave()` —— 一返到線就自動寫後端。
   團長指示「唔好比佢有機會出事」，所以而家返到線都唔會自動寫；
   頂部會顯示「立即同步（N）」，等用家自己撳。 */
try {
  window.addEventListener('online', () => {
    if (!armed || isMock()) return;
    if (!remoteConfigured()) return;
    setState(hasPending() ? 'pending' : 'idle', hasPending() ? '未儲存 —— 撳「立即同步」先寫入後端' : '已連後端');
    reconcile({ silent: true }).catch(() => { /* 讀唔到就算，唔阻用家 */ });
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
