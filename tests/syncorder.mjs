/* ============================================================
   tests/syncorder.mjs — 「先讀後端，先至寫後端」次序測試
   ------------------------------------------------------------
   2026-09-19 團長回報（同一個病徵第三次，今次講到正題）：

     「其他 APP 都係暫存喺瀏覽器，撳『同步』先一次過 SAVE 落後端。
       呢個 APP 成日自動 SAVE 就變相蓋咗佢 ……
       A 開佢未讀後端就以經複寫，B 開就未讀後端就以經複寫 ……
       永遠自己睇自己。」

   佢講嘅死因係真嘅，而且舊 code 兩層保護都堵唔到：

     · blank_guard —— 只擋「本機完全冇內容」嘅新機。一部**用咗好耐**嘅機
       （有內容、lastSyncedVersion 係舊值）完全唔受保護；
     · 樂觀鎖 baseVersion —— 要後端係 v2.2.0+ 先至有效，舊 Code.gs 照收盲蓋；
     · syncBoot() 嘅 try/catch —— 開機 remoteInfo() 失敗（逾時／瞬斷／5xx）
       就當冇事繼續 arm()，而 arm() 一見到 pending 就 scheduleSave()
       → 2.5 秒後 push。**未讀後端就已經寫後端。**

   呢個檔用 _flaky.mjs 造出決定性嘅故障組合：**讀會失敗、但寫係得嘅**
   （真實世界＝GAS 凍啟動逾時／網絡瞬斷／proxy 一時 5xx）。
   讀寫一齊死嘅話舊版都一樣寫唔入，證明唔到任何嘢 —— 所以必須分開。

   釘死四件事：
     ① 讀唔到後端 → 一律唔寫（not_reconciled），後端一個字都冇被蓋
     ② 自動儲存模式下都一樣擋住（唔係淨係擋「立即儲存」掣）
     ③ 讀返到之後撳「立即同步」→ 先拉後端合併，再寫；兩邊資料一個都冇少
     ④ 手動模式：改動淨係暫存喺瀏覽器，撳「立即同步」先至寫
   用法：node tests/syncorder.mjs
   ============================================================ */

import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const waitPort = async (port, ms = 10000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const up = await new Promise(r => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); r(true); });
      s.on('error', () => r(false));
    });
    if (up) return true;
    await new Promise(r => setTimeout(r, 120));
  }
  return false;
};

const GAS_PORT = await freePort();
const WEB_PORT = await freePort();
const BAD_READ_PORT = await freePort();   // 讀永遠 503、寫照通
const GOOD_PORT = await freePort();       // 純轉發（讀寫都通）
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const FAKE_EXEC = `http://127.0.0.1:${GAS_PORT}/exec`;
const BAD_READ_EXEC = `http://127.0.0.1:${BAD_READ_PORT}/exec`;
const GOOD_EXEC = `http://127.0.0.1:${GOOD_PORT}/exec`;
const KEY = 'v82_syncorder_test_key';

const procs = [];
const spawnBg = (args, env = {}) => {
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return p;
};
process.on('exit', () => procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }));

const runDevice = (plan) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'tests', '_device.mjs'), BASE, JSON.stringify(plan)],
    { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', err = '';
  p.stdout.on('data', d => { buf += d; });
  p.stderr.on('data', d => { err += d; });
  const done = (r) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(r); };
  const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（45 秒）' }), 45000);
  p.on('close', () => {
    clearTimeout(guard);
    const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
    if (!m) return resolve({ ok: false, error: (err || buf).slice(-800) });
    try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
  });
});
const step = (r, op) => (r?.steps || []).find(s => s.op === op) || {};

/* 直接問假後端：後端而家實際有咩（唔信前端自己講） */
const backendTruth = async () => {
  const r = await fetch(FAKE_EXEC, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'dbInfo', unit: '0082', apiKey: KEY })
  });
  const j = await r.json().catch(() => ({}));
  return { found: !!j.found, members: Number(j.counts?.members || 0), version: String(j.version || '') };
};

section('起假後端（讀壞寫好 ＋ 讀寫都好）');
spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS_PORT)], { FAKEGAS_APIKEY: KEY });
spawnBg([path.join(ROOT, 'tests', '_flaky.mjs'), String(BAD_READ_PORT), String(GAS_PORT)], { FAIL_INFO: '9999' });
spawnBg([path.join(ROOT, 'tests', '_flaky.mjs'), String(GOOD_PORT), String(GAS_PORT)], { FAIL_INFO: '0' });
/* 冇 TROOP_0082_* —— proxy 對 0082 回 404，gateway 自動改行「直接打用家貼嘅 /exec」 */
spawnBg([path.join(ROOT, 'dev-server.mjs')], { PORT: String(WEB_PORT), V82_PROXY_TEST: '1' });
ok('假後端已啟動', await waitPort(GAS_PORT));
ok('故障注入後端已啟動（dbInfo 永遠 503）', await waitPort(BAD_READ_PORT));
ok('正常後端已啟動', await waitPort(GOOD_PORT));
ok('dev-server 已啟動', await waitPort(WEB_PORT));

/* ---- 前提：故障注入真係「讀壞、寫好」，唔係兩樣一齊壞 ---- */
section('前提：故障注入係「讀壞寫好」（否則呢個測試證明唔到任何嘢）');
{
  const bad = await fetch(BAD_READ_EXEC, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'dbInfo', unit: '0082', apiKey: KEY })
  });
  ok('dbInfo（讀）→ 503', bad.status === 503, 'HTTP ' + bad.status);
  const good = await fetch(BAD_READ_EXEC, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'loadDb', unit: '0082', apiKey: KEY })
  });
  ok('loadDb（寫／載入路徑）→ 照樣通', good.status === 200, 'HTTP ' + good.status);
}

/* ---- ① A 正常寫入，建立基線 ---- */
section('① 裝置 A 正常寫入（建立基線）');
{
  const A = await runDevice({ steps: [
    { op: 'setSync', url: FAKE_EXEC, apiKey: KEY },
    { op: 'addMember', name: '陳大文', ymis: '2026000001' },
    { op: 'push' }
  ] });
  ok('裝置 A 開到機', A.ok === true, A.error || '');
  ok('A 寫入成功', step(A, 'push').ok === true, JSON.stringify(step(A, 'push')));
  const truth = await backendTruth();
  ok('後端真係收到 A（團員 1）', truth.found && truth.members === 1, JSON.stringify(truth));
}
const baseline = await backendTruth();
const baselineVersion = baseline.version;

/* ---- ② 決定性測試：讀唔到後端 → 一律唔寫 ---- */
section('② ★ 讀唔到後端但寫得入 → 舊版會盲蓋，而家必須擋住');
{
  const B = await runDevice({ steps: [
    { op: 'setSync', url: BAD_READ_EXEC, apiKey: KEY },
    /* 呢部機係「用咗好耐」嘅機：有內容 + 有自己嘅新改動。
       即係 blank_guard（淨係擋空機）同 baseVersion 樂觀鎖都唔會出手 ——
       只有新加嘅硬保險至擋得到。 */
    { op: 'addMember', name: '李小龍', ymis: '2026000002' },
    { op: 'reconciled' },
    { op: 'push' },
    { op: 'reconciled' }
  ] });
  ok('裝置 B 開到機', B.ok === true, B.error || '');
  const cfg = step(B, 'setSync');
  ok('前提：B 嘅後端設定係有效嘅（唔係「未設定」所以先至冇寫）', cfg.ok === true && cfg.hasKey === true, JSON.stringify(cfg));
  const rc0 = step(B, 'reconciled');
  ok('前提：B 呢個 session 未同後端對過版本', rc0.reconciled === false, JSON.stringify(rc0));
  const p = step(B, 'push');
  /* 釘死嘅係「有冇寫到」呢個不變量，唔係某個 reason 字串：
     503 會被 callBackend 歸類做 bad_response（比 not_reconciled 更準確），
     重點係 ok=false ＋ bytes=0（一個 byte 都冇送出去）。 */
  const BLOCKED = ['not_reconciled', 'bad_response', 'not_registered', 'bad_url', 'network', 'timeout'];
  ok('★ pushDb 被擋住（一個 byte 都冇送去後端）',
    p.ok === false && Number(p.bytes || 0) === 0 && BLOCKED.includes(p.reason), JSON.stringify(p));
  ok('★ 改動冇蝕到 —— 仲喺本機排隊', Number(p.pending || 0) >= 1, JSON.stringify(p));
  ok('錯誤訊息講清楚點解唔寫（唔係淨係「同步失敗」）',
    /未讀到後端/.test(String(p.error || '')) && /冇蝕/.test(String(p.hint || '')),
    String(p.error || '') + ' | ' + String(p.hint || '').slice(0, 80));
  const truth = await backendTruth();
  ok('★★ 後端一個字都冇被蓋（仍然係 A 嗰份，version 冇變）',
    truth.members === baseline.members && truth.version === baselineVersion,
    JSON.stringify({ now: truth, baseline }));
}

/* ---- ③ 自動寫入已經冇呢條路（唔係「擋住」，係「不存在」）---- */
section('③ ★ 自動寫入已剷走：arm 咗＋等足時間都唔會寫（就算 db 入面 auto:true）');
{
  /* autosave 呢個 op 會刻意把 db.sync.auto 強行設做 true（模擬舊遺留值／
     有人手改 db），再 arm() ＋ 等 5 秒。如果仲有任何自動寫入路，呢度就會寫到。 */
  const C = await runDevice({ steps: [
    { op: 'setSync', url: GOOD_EXEC, apiKey: KEY },
    { op: 'autosave', name: '自動寫入測試', ymis: '2026000003', waitMs: 5000 }
  ] });
  const a = step(C, 'autosave');
  ok('★ 改動淨係暫存（pending 留住，冇自動寫）', Number(a.pending || 0) >= 1, JSON.stringify(a));
  ok('★ 狀態係「未儲存」而唔係「已儲存」', a.state === 'pending', JSON.stringify(a));
  const mode = step(C, 'setSync');
  ok('★ db 入面 auto:true 都冇用 —— remoteCfg().auto 係寫死嘅 false',
    mode.auto === false, JSON.stringify(mode));
}

/* ---- ④ 讀返到 → 撳「立即同步」：先拉後端合併，再寫 ---- */
section('④ ★ 「立即同步」＝ 先讀後端 → 合併 → 再寫（兩邊資料一個都冇少）');
{
  const D = await runDevice({ steps: [
    { op: 'setSync', url: GOOD_EXEC, apiKey: KEY },
    /* 呢部機自己有新改動（本機 pending > 0），跟住撳同步 */
    { op: 'addMember', name: '黃小明', ymis: '2026000004' },
    { op: 'syncNow' },
    { op: 'reconciled' }
  ] });
  ok('裝置 D 開到機', D.ok === true, D.error || '');
  const s = step(D, 'syncNow');
  ok('★ 同步成功', s.ok === true, JSON.stringify(s));
  ok('★ 先拉咗後端（pulled=true）', s.pulled === true, JSON.stringify(s));
  ok('★ 同本機改動合併咗（mergedPull=true）', s.mergedPull === true, JSON.stringify(s));
  ok('★ 然後先至寫入（pushed=true）', s.pushed === true, JSON.stringify(s));
  ok('★★ 兩邊團員都喺度（A 嘅陳大文 ＋ D 自己嘅黃小明）',
    Array.isArray(s.names) && s.names.includes('陳大文') && s.names.includes('黃小明'),
    JSON.stringify(s.names));
  ok('寫完 pending 已清', Number(s.pending || 0) === 0, JSON.stringify(s));
  ok('呢個 session 而家已經對過版本（之後至准寫）', step(D, 'reconciled').reconciled === true,
    JSON.stringify(step(D, 'reconciled')));
  const truth = await backendTruth();
  ok('★★ 後端而家有齊兩個團員（冇人蓋走人）', truth.members >= 2, JSON.stringify(truth));
}

/* ---- ⑤ 手動模式：暫存喺瀏覽器，撳同步先寫 ---- */
section('⑤ 手動模式（團長要嘅用法）：改動淨係暫存，撳「立即同步」先寫');
{
  /* 取樣一定要喺劇本**中間**做：runDevice 成個跑完先至問後端嘅話，
     syncNow 嗰次合法寫入都會被計入，證明唔到「未撳同步之前冇寫」。 */
  const before = await backendTruth();
  const E = await runDevice({ steps: [
    { op: 'setSync', url: GOOD_EXEC, apiKey: KEY },
    { op: 'manualStage', name: '手動模式團員', ymis: '2026000005', waitMs: 5000 },
    { op: 'backendPeek' },          // ← 未撳同步之前
    { op: 'syncNow' },
    { op: 'backendPeek' }           // ← 撳完同步之後
  ] });
  const m = step(E, 'manualStage');
  ok('改動有暫存喺本機（pending > 0）', Number(m.pending || 0) >= 1, JSON.stringify(m));
  ok('頂部會出「未儲存」提示（唔會扮「已連後端」）', m.state === 'pending', JSON.stringify(m));
  const peeks = (E.steps || []).filter(s => s.op === 'backendPeek');
  const [mid, afterPeek] = [peeks[0] || {}, peeks[1] || {}];
  ok('★ 等完 debounce（5 秒）後端都仲未收到 —— 手動模式真係暫存住',
    mid.version === before.version && mid.members === before.members,
    JSON.stringify({ before, mid }));
  const s = step(E, 'syncNow');
  ok('★ 撳咗「立即同步」之後先至寫入', s.ok === true && s.pushed === true, JSON.stringify(s));
  ok('★ 後端而家收到（version 變咗、團員多咗一個）',
    afterPeek.version !== before.version && afterPeek.members === before.members + 1,
    JSON.stringify({ before, afterPeek }));
}

/* ---- ⑥ 團長指示：預設「只讀 ＋ 撳掣先一次過寫」 ---- */
section('⑥ ★ 預設＝手動：改動淨係暫存，乜都唔會自動寫');
{
  /* 呢個裝置**完全冇**明確揀過同步方式（冇 autoModel）—— 即係一般安裝嘅狀態 */
  /* 對照版本一定要喺 manualStage **之前**即刻攞 —— 前面 ④⑤ 已經合法寫過後端，
     用開頭嘅 baseline 做對照係錯嘅（呢個測試第一次跑就係死喺呢度）。 */
  const G = await runDevice({ steps: [
    { op: 'setSync', url: GOOD_EXEC, apiKey: KEY },
    { op: 'syncMode' },
    { op: 'legacyAuto' },          // 舊版遺留 auto:true（舊 checkbox 預設剔住）
    { op: 'backendPeek' },         // ← 未改嘢之前
    { op: 'manualStage', name: '預設模式團員', ymis: '2026000006', waitMs: 5000 },
    { op: 'backendPeek' }          // ← 等完 debounce 之後
  ] });
  const mode = step(G, 'syncMode');
  ok('★ 冇得揀自動（remoteCfg().auto 寫死 false）', mode.effAuto === false, JSON.stringify(mode));
  ok('★ 會議模式（60 秒背景讀）預設係關（唔會不停讀）', mode.effPoll === false, JSON.stringify(mode));
  const legacy = step(G, 'legacyAuto');
  ok('★ 舊遺留 auto:true 一律失效（團長部機唔會「話改咗但冇改」）',
    legacy.effAuto === false, JSON.stringify(legacy));
  const m = step(G, 'manualStage');
  ok('改動有暫存喺本機', Number(m.pending || 0) >= 1, JSON.stringify(m));
  const peeks = (G.steps || []).filter(s => s.op === 'backendPeek');
  const [pre, post] = [peeks[0] || {}, peeks[1] || {}];
  ok('★ 等完 debounce 後端一個字都未收到（要自己撳「立即同步」）',
    post.version === pre.version && post.members === pre.members,
    JSON.stringify({ pre, post }));
}

/* ---- ⑦ 團長回報：「IG／FB 公開資料，團員登入後完全見唔到」 ---- */
section('⑦ ★ 團員公開連結（IG／FB）：儲存≠發布，撳同步先至到後端');
{
  /* 執委喺「帳號與系統 → 旅團設定」填 IG／FB → 撳「儲存」。
     團長以為咁就出咗街；實際上（手動同步）改動淨係暫存喺佢部機。 */
  const H = await runDevice({ steps: [
    { op: 'setSync', url: GOOD_EXEC, apiKey: KEY },
    { op: 'backendPeek' },                     // ← 未改之前
    { op: 'patchSettings', patch: { troopLinks: { instagram: 'https://instagram.com/troop82', facebook: 'https://facebook.com/troop82' } } },
    { op: 'backendPeek' },                     // ← 儲存咗，但未撳同步
    { op: 'syncNow' },
    { op: 'backendPeek' }                      // ← 撳咗同步之後
  ] });
  const pk = (H.steps || []).filter(s => s.op === 'backendPeek');
  const [b4, afterSave, afterSync] = [pk[0] || {}, pk[1] || {}, pk[2] || {}];
  ok('★ 執委撳「儲存」之後，後端**未**收到（改動淨係暫存喺佢部機）',
    afterSave.version === b4.version && afterSave.members === b4.members,
    JSON.stringify({ b4, afterSave }));
  ok('★ 撳「立即同步」之後後端先至變（version 唔同）',
    afterSync.version !== b4.version, JSON.stringify({ b4, afterSync }));
  ok('同步本身成功', step(H, 'syncNow').ok === true, JSON.stringify(step(H, 'syncNow')));

  /* 後端而家實際存咗乜 settings.troopLinks（唔信前端自己講） */
  const readLinks = async () => {
    const r = await fetch(GOOD_EXEC, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'loadDb', unit: '0082', apiKey: KEY })
    });
    const j = await r.json().catch(() => ({}));
    return j.db?.settings?.troopLinks || null;
  };
  const now = await readLinks();
  ok('★ 後端真係收到 IG／FB 連結',
    now?.instagram === 'https://instagram.com/troop82' && now?.facebook === 'https://facebook.com/troop82',
    JSON.stringify(now));

  /* 全新裝置（＝團員部機）拉落嚟 → 讀到 IG／FB ＝ 入口「旅團連結」會出 */
  const I = await runDevice({ steps: [{ op: 'setSync', url: GOOD_EXEC, apiKey: KEY }, { op: 'checksync' }] });
  ok('團員部機拉得到後端資料', step(I, 'checksync').ok === true, JSON.stringify(step(I, 'checksync')));
  const seen = await readLinks();
  ok('★★ 團員嗰邊讀到 IG／FB（入口「旅團連結」因此出到）',
    seen?.instagram === 'https://instagram.com/troop82', JSON.stringify(seen));
}

/* ---- ⑧ 後果檢查：全場冇任何資料被蓋走 ---- */
section('⑦ 全場結果：冇人被盲蓋');
{
  const F = await runDevice({ steps: [{ op: 'setSync', url: GOOD_EXEC, apiKey: KEY }, { op: 'checksync' }] });
  const c = step(F, 'checksync');
  const names = c.names || [];
  ok('全新裝置拉落嚟見到全部團員（冇人嘅資料消失咗）',
    names.includes('陳大文') && names.includes('黃小明') && names.includes('手動模式團員'),
    JSON.stringify(names));
}

console.log(`\n結果：${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
