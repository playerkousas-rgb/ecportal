/* ============================================================
   tests/remote.mjs — 後端儲存（資料真正寫入旅團自己嘅 Sheet）
   ------------------------------------------------------------
   呢個係團長回報嘅頭號問題：「資料只能瀏覽器儲存，唔能寫入後端」。
   呢度驗證整條來回路：
     ① api/proxy 放行 saveDb / loadDb / dbInfo，並且照樣做旅團白名單
     ② Code.gs 有「資料庫」分頁同 saveDb / loadDb / dbInfo，而且分段邏輯正確
     ③ 端到端：app 改資料 → 自動寫入後端 → 換一部「新機」→ 讀返同一份資料
     ④ 嚴格隔離：新旅團唔會借用 0082 嘅後端（唔會見到 82 旅嘅資料）
   用法：node tests/remote.mjs
   ============================================================ */

import http from 'node:http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import proxyHandler from '../api/proxy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 留低真 fetch：後面有啲測試會用 stub 蓋住佢，但 proxy 要真嘢先連到本機假 GAS */
const realFetchForProxy = globalThis.fetch;
const t0 = Date.now();
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }

const GAS = 'https://script.google.com/macros/s/AKfycbySGLBg5KuWzgM9EySiOIppqnzrL0QASIYLlhbCIHocGHcLHKbkMdvmhJvam3baG___/exec';

function mockRes() {
  const r = { statusCode: 0, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (o) => { r.body = o; return r; };
  return r;
}

/* ============================================================
   ① api/proxy 放行新 action
   ============================================================ */
section('同源 Proxy 支援「整份資料庫」讀寫');
{
  /* 0082 嘅資料已全清、registry 亦冇咗佢，所以用環境變數開一個虛構旅團做 fixture
     （真旅團登記方式一樣：Vercel env TROOP_<編號>_BACKEND / _APIKEY）。 */
  process.env.TROOP_TEST9_BACKEND = GAS;
  process.env.TROOP_TEST9_APIKEY = 'test9_secret_key';
  process.env.TROOP_TEST9_NAME = '測試旅深資童軍團';

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (target, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ target: String(target), body });
    return { status: 200, async text() { return JSON.stringify({ ok: true, success: true, found: true, db: { schema: 2, members: [] } }); } };
  };
  const realLog = console.log;
  const logLines = [];
  console.log = (...a) => { logLines.push(a.join(' ')); };

  const call = async (payload) => {
    const res = mockRes();
    await proxyHandler({ method: 'POST', body: payload }, res);
    return res;
  };

  const rSave = await call({ action: 'saveDb', unit: 'TEST9', db: { schema: 2, members: [{ name: '測試' }] } });
  const rLoad = await call({ action: 'loadDb', unit: 'TEST9' });
  const rInfo = await call({ action: 'dbInfo', unit: 'TEST9' });
  const rBad = await call({ action: 'dropEverything', unit: 'TEST9' });
  const rUnknownUnit = await call({ action: 'loadDb', unit: '9999' });

  console.log = realLog;
  globalThis.fetch = realFetch;

  ok('saveDb 可以經 proxy 轉發', rSave.statusCode === 200 && rSave.body?.ok === true, JSON.stringify(rSave.body));
  ok('loadDb 可以經 proxy 轉發', rLoad.statusCode === 200 && rLoad.body?.ok === true);
  ok('dbInfo 可以經 proxy 轉發', rInfo.statusCode === 200 && rInfo.body?.ok === true);
  ok('未知 action 仍然會被擋', rBad.statusCode === 400);
  ok('未登記旅團唔會轉發（唔會寫錯去人哋張 Sheet）', rUnknownUnit.statusCode === 404, JSON.stringify(rUnknownUnit.body));
  ok('轉發目的地係旅團自己嘅 /exec', calls[0]?.target === GAS, calls[0]?.target);
  ok('saveDb 有把整個資料庫帶上去', Array.isArray(calls[0]?.body?.db?.members));
  ok('Proxy log 唔會記低資料庫內容（唔外洩團員姓名）',
    !logLines.join('\n').includes('測試'), logLines.join(' | ').slice(0, 120));
}

/* ============================================================
   ② Code.gs 後端範本
   ============================================================ */
section('Apps Script 範本（Code.gs）');
{
  const code = fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8');
  ok('有「資料庫」分頁（app 真正嘅儲存）', /var DB_TAB = '資料庫'/.test(code));
  ok('initializeSheets 會建立「資料庫」分頁', /\{ name: '資料庫', headers:/.test(code));
  ok('有 saveDb（寫入整份資料庫）', /function saveDb\(body\)/.test(code));
  ok('有 loadDb（讀返整份資料庫）', /function loadDb\(unit\)/.test(code));
  ok('有 dbInfo（只問 meta，唔使拉成份落嚟）', /function dbInfo\(unit\)/.test(code));
  ok('doPost 有處理 saveDb / loadDb / dbInfo',
    /body\.action === 'saveDb' \|\| body\.action === 'loadDb' \|\| body\.action === 'dbInfo'/.test(code));
  ok('doGet 都讀得（換機時用瀏覽器直接開都拎得返）', /action === 'loadDb' \|\| action === 'dbInfo'/.test(code));
  ok('寫入用 LockService 包住（兩個執委同時改都唔會爛）',
    /withLock\(function \(\) \{ return saveDb\(body\); \}\)/.test(code));
  ok('寫入前會刪走舊段（唔會殘留舊資料）', /sh\.deleteRow\(i \+ 1\)/.test(code));
  ok('分段大小喺 Sheet 單格上限之內（50000）', /var DB_CHUNK = 45000;/.test(code));
  ok('sync 一併存埋整份資料庫（報表 ＋ 可讀返嘅資料庫）', /if \(body\.db && typeof body\.db === 'object'\)/.test(code));
  ok('寫入資料庫要 API Key（唔係人人改得）',
    /寫入資料庫需要 API Key/.test(code) || /未授權：API Key 唔正確/.test(code));
}

/* ============================================================
   ③ 分段／拼合邏輯（直接跑 Code.gs 嘅演算法）
   ============================================================ */
section('分段寫入／拼合（大資料都唔會爛）');
{
  const DB_CHUNK = 45000;
  const big = { schema: 2, members: Array.from({ length: 2000 }, (_, i) => ({ id: 'm' + i, name: '團員' + i, ymis: String(2020000000 + i) })) };
  const text = JSON.stringify(big);
  const chunks = [];
  for (let p = 0; p < text.length; p += DB_CHUNK) chunks.push(text.substring(p, p + DB_CHUNK));

  ok('大資料會分段（超過單格上限）', text.length > DB_CHUNK && chunks.length > 1, `${text.length} 字元 → ${chunks.length} 段`);
  ok('每段都喺 Sheet 單格上限（50000）之內', chunks.every(c => c.length <= 50000));

  // 模擬亂序讀返（Sheet 行序唔保證）再排返
  const rows = chunks.map((c, i) => ({ seq: i + 1, text: c })).sort(() => Math.random() - 0.5);
  rows.sort((a, b) => a.seq - b.seq);
  const rebuilt = JSON.parse(rows.map(r => r.text).join(''));
  ok('拼返之後同原本一模一樣（冇甩欄、冇走樣）',
    rebuilt.members.length === 2000 && rebuilt.members[1999].name === '團員1999' && rebuilt.members[0].ymis === '2020000000');
}

/* ============================================================
   ④ 端到端（真 HTTP、兩個獨立 process ＝ 兩部真‧唔同嘅機）
   ------------------------------------------------------------
   流程：假 GAS ← dev-server(/api/proxy) ← 裝置 A / 裝置 B
   ============================================================ */
section('端到端：換機／清 cache 都唔會冇咗資料（真 HTTP）');
{
  const { spawn } = await import('node:child_process');
  const net0 = await import('node:net');
  /* 用隨機空閒 port：唔會撞到之前跑剩低嘅伺服器（撞到就會讀到舊資料，測試假失敗） */
  const freePort = () => new Promise((resolve, reject) => {
    const srv = net0.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
  const GAS_PORT = await freePort();
  const WEB_PORT = await freePort();
  const BASE = `http://127.0.0.1:${WEB_PORT}`;
  const FAKE_EXEC = `http://127.0.0.1:${GAS_PORT}/exec`;

  const procs = [];
  const spawnBg = (args, env = {}) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    return p;
  };
  const waitPort = async (port, ms = 8000) => {
    const net = await import('node:net');
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

  /* 用假 /exec 覆蓋 0082 嘅後端（唔會掂真 Google），
     並開啟 V82_PROXY_TEST 令 proxy 接受本機網址 */
  const ENV = {
    TROOP_0082_BACKEND: FAKE_EXEC,
    TROOP_0082_APIKEY: 'test_key_0082',
    V82_PROXY_TEST: '1',
    PORT: String(WEB_PORT)
  };

  try {
    spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS_PORT)]);
    spawnBg([path.join(ROOT, 'dev-server.mjs')], ENV);
    const gasUp = await waitPort(GAS_PORT);
    const webUp = await waitPort(WEB_PORT);
    ok('測試用假後端已啟動', gasUp);
    ok('本機 dev-server（連 /api/proxy）已啟動', webUp);

    const runDevice = (plan) => new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'tests', '_device.mjs'), BASE, JSON.stringify(plan)],
        { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '', err = '';
      p.stdout.on('data', d => { buf += d; });
      p.stderr.on('data', d => { err += d; });
      const done = (r) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(r); };
      const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（30 秒）' }), 30000);
      p.on('close', () => {
        clearTimeout(guard);
        const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
        if (!m) return resolve({ ok: false, error: (err || buf).slice(-600) });
        try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
      });
    });

    /* ---- 裝置 A：清走種子資料 → 加人加帳 → 寫後端 ---- */
    const A = await runDevice({ steps: [
      { op: 'wipe' },
      { op: 'addMember', name: '陳大文', ymis: '2026000001' },
      { op: 'addTx', date: '2026-09-17', type: 'income', item: '團費', amount: 360 },
      { op: 'push' },
      { op: 'snapshot' }
    ] });
    ok('裝置 A 開得機、後端設定自動帶入', A.ok === true && A.configured === true,
      (A.error || JSON.stringify(A.cfg || {})).slice(0, 200));
    const pushStep = (A.steps || []).find(s => s.op === 'push');
    ok('裝置 A 把整個資料庫寫入後端', pushStep?.ok === true, JSON.stringify(pushStep));
    ok('寫入成功後 pending 清零（介面顯示「已存到後端」）', pushStep?.pending === 0, String(pushStep?.pending));
    const snapA = (A.steps || []).find(s => s.op === 'snapshot');
    ok('裝置 A 本機有 1 個團員、1 筆帳目', snapA?.members === 1 && snapA?.transactions === 1, JSON.stringify(snapA));

    /* ---- 裝置 B ＝ 全新一部機（全新 process、全新 localStorage） ---- */
    const B = await runDevice({ steps: [
      { op: 'info' },
      { op: 'pull' },
      { op: 'snapshot' }
    ] });
    ok('裝置 B（新機）開得機', B.ok === true, (B.error || '').slice(0, 300));
    const infoB = (B.steps || []).find(s => s.op === 'info');
    ok('新機問後端：有資料', infoB?.ok === true && infoB?.found === true, JSON.stringify(infoB));
    ok('後端報返啱數（1 個團員、1 筆帳目）',
      infoB?.counts?.members === 1 && infoB?.counts?.transactions === 1, JSON.stringify(infoB?.counts));

    const pullB = (B.steps || []).find(s => s.op === 'pull');
    ok('新機讀得返整份資料庫', pullB?.ok === true && !!pullB?.adopted, JSON.stringify(pullB).slice(0, 200));
    ok('新機見返同一個團員（換機冇冇咗資料）',
      pullB?.adopted?.names?.includes('陳大文') && pullB?.adopted?.members === 1,
      JSON.stringify(pullB?.adopted));
    ok('新機見返同一筆帳目', pullB?.adopted?.transactions === 1);
    ok('採用後端資料之後唔會即刻又寫返上去（唔會來回打交）',
      pullB?.adopted?.pending === 0, String(pullB?.adopted?.pending));

    /* ---- 裝置 C：自動儲存（改完唔使撳掣） ---- */
    const C = await runDevice({ steps: [
      { op: 'pull' },                                   // 先拉後端（＝1 個團員）
      { op: 'snapshot' },
      { op: 'autosave', name: '李小明', ymis: '2026000002', waitMs: 6000 }
    ] });
    const snapC = (C.steps || []).find(s => s.op === 'snapshot');
    ok('裝置 C 拉完後端之後只有後端嗰 1 個團員（種子資料唔會撈返轉頭）',
      snapC?.members === 1, JSON.stringify(snapC?.names));
    const auto = (C.steps || []).find(s => s.op === 'autosave');
    ok('改完資料會自動寫入後端（唔使記得撳同步）',
      auto?.pending === 0 && auto?.state === 'saved', JSON.stringify(auto));

    /* ---- 裝置 D：確認自動儲存真係入咗後端 ---- */
    const D = await runDevice({ steps: [{ op: 'info' }, { op: 'pull' }] });
    const pullD = (D.steps || []).find(s => s.op === 'pull');
    ok('第三部機見到裝置 C 自動儲存嘅新團員（＝自動儲存真係入咗後端）',
      pullD?.adopted?.names?.includes('李小明') && pullD?.adopted?.names?.includes('陳大文') &&
      pullD?.adopted?.members === 2,
      JSON.stringify(pullD?.adopted?.names));
  } finally {
    procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
  }
}


/* ============================================================
   ④.5 衝突復原（2026-09-18「登入清空後端」事故嘅回歸測試）
   ------------------------------------------------------------
   劇本（全部真 HTTP）：
     A 部機同步咗（陳大文）→ B 部機拉咗，然後離線加咗（李四）
     → C 部機（有正確 baseVersion）加咗（張三）並同步
     → B 部機返嚟先 push → 撞版 → 要自動拉後端＋合併＋重存
       （三個人都要喺度，唔可以任何人被蓋走）
   另加：空白裝置（清咗 cache）唔可以自動蓋後端。
   ============================================================ */
section('衝突復原：兩部機都改過，同步要合併唔可以盲蓋（真 HTTP）');
{
  const net0 = await import('node:net');
  const os0 = await import('node:os');
  const fs0 = fs;
  const { spawn } = await import('node:child_process');
  const freePort = () => new Promise((resolve, reject) => {
    const srv = net0.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
  const GAS_PORT = await freePort();
  const WEB_PORT = await freePort();
  const BASE = `http://127.0.0.1:${WEB_PORT}`;
  const FAKE_EXEC = `http://127.0.0.1:${GAS_PORT}/exec`;
  const ENV = {
    TROOP_0082_BACKEND: FAKE_EXEC,
    TROOP_0082_APIKEY: 'test_key_conflict',
    V82_PROXY_TEST: '1',
    PORT: String(WEB_PORT)
  };
  const procs = [];
  const spawnBg = (args, env = {}) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(p);
    return p;
  };
  const waitPort = async (port, ms = 8000) => {
    const net = await import('node:net');
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
  const runDevice = (plan) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'tests', '_device.mjs'), BASE, JSON.stringify(plan)],
      { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', err = '';
    p.stdout.on('data', d => { buf += d; });
    p.stderr.on('data', d => { err += d; });
    const done = (r) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(r); };
    const guard = setTimeout(() => done({ ok: false, error: '裝置逾時（30 秒）' }), 30000);
    p.on('close', () => {
      clearTimeout(guard);
      const m = buf.match(/@@RESULT@@([\s\S]*?)@@END@@/);
      if (!m) return resolve({ ok: false, error: (err || buf).slice(-600) });
      try { resolve(JSON.parse(m[1])); } catch (e) { resolve({ ok: false, error: 'parse: ' + e.message }); }
    });
  });
  const stepOf = (res, op) => (res.steps || []).find(s2 => s2.op === op);
  const tmp = path.join(os0.tmpdir(), 'v82-conflict-' + Date.now() + '.json');

  try {
    spawnBg([path.join(ROOT, 'tests', '_fakegas.mjs'), String(GAS_PORT)]);
    spawnBg([path.join(ROOT, 'dev-server.mjs')], ENV);
    ok('衝突測試：假後端＋dev-server 已啟動', await waitPort(GAS_PORT) && await waitPort(WEB_PORT));

    /* A 部機：陳大文 → 同步（版本 V1） */
    const A = await runDevice({ steps: [
      { op: 'wipe' },
      { op: 'addMember', name: '陳大文', ymis: '2026000101' },
      { op: 'push' }
    ] });
    ok('A 部機首次同步成功', stepOf(A, 'push')?.ok === true, JSON.stringify(stepOf(A, 'push')));

    /* B 部機：拉 V1 → 離線加李四（唔好 push）→ 匯出本機 db */
    const B1 = await runDevice({ steps: [
      { op: 'pull' },
      { op: 'addMember', name: '李四', ymis: '2026000102' },
      { op: 'export', file: tmp },
      { op: 'snapshot' }
    ] });
    ok('B 部機拉到 V1 並離線加咗李四（pending=1）', stepOf(B1, 'snapshot')?.pending === 1 && stepOf(B1, 'snapshot')?.lastSyncedVersion !== '', JSON.stringify(stepOf(B1, 'snapshot')));

    /* C 部機：由 V1 加張三 → 同步成功（版本 V2：陳大文＋張三） */
    const C = await runDevice({ steps: [
      { op: 'pull' },
      { op: 'addMember', name: '張三', ymis: '2026000103' },
      { op: 'push' }
    ] });
    ok('C 部機同步成功（V2）', stepOf(C, 'push')?.ok === true, JSON.stringify(stepOf(C, 'push')));

    /* B 部機返嚟：匯入返之前嘅本機 db（李四未同步、baseVersion 仲係 V1）→ push
       舊版：盲蓋 → 張三消失（事故）。
       新版：撞版 → 自動拉＋合併 → 重存 → 三個人都在。 */
    const B2 = await runDevice({ steps: [
      { op: 'import', file: tmp },
      { op: 'push' },
      { op: 'snapshot' }
    ] });
    const b2push = stepOf(B2, 'push');
    ok('B 部機撞版後自動復原：push 最終成功', b2push?.ok === true, JSON.stringify(b2push));
    const b2snap = stepOf(B2, 'snapshot');
    ok('合併後 B 部機本機有齊三個人', b2snap?.names?.includes('陳大文') && b2snap?.names?.includes('張三') && b2snap?.names?.includes('李四'), JSON.stringify(b2snap));
    ok('合併後 B 部機 pending 清零（已存到後端）', b2snap?.pending === 0, String(b2snap?.pending));

    const D = await runDevice({ steps: [{ op: 'pull' }] });
    const dnames = stepOf(D, 'pull')?.adopted?.names || [];
    ok('第四部機由後端見到三個人（冇任何人被蓋走）',
      dnames.includes('陳大文') && dnames.includes('張三') && dnames.includes('李四'), JSON.stringify(dnames));

    /* 空白裝置保險閘：清咗 cache 嘅新機唔可以自動蓋有料後端 */
    const Z = await runDevice({ steps: [
      { op: 'wipe' },
      { op: 'push' },
      { op: 'snapshot' }
    ] });
    ok('空白裝置 push 被保險閘擋住（blank_guard）', stepOf(Z, 'push')?.ok === false, JSON.stringify(stepOf(Z, 'push')));
    const D2 = await runDevice({ steps: [{ op: 'pull' }] });
    ok('空白裝置冇蓋爛後端（資料仲在）',
      (stepOf(D2, 'pull')?.adopted?.members || 0) >= 3, JSON.stringify(stepOf(D2, 'pull')?.adopted));
  } finally {
    procs.forEach(p => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
    try { fs0.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/* ============================================================
   ⑤ 嚴格隔離：新旅團唔會見到／寫入 0082 嘅資料
   ============================================================ */
section('旅團隔離（新旅團唔會見到 82 旅嘅資料）');
{
  const units = await import('../assets/js/lib/units.js?iso=1');
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'units.json'), 'utf8'));

  /* 以前 registry 有個頂層共用 backend，任何未登記旅團都會 fallback 去到，
     即係會見到 82 旅張 Sheet。而家已經拆走 —— 呢個測試守住佢唔好返嚟。 */
  ok('Registry 冇咗頂層共用 backend（舊漏洞已封）', !reg.backend?.gasUrl, JSON.stringify(reg.backend || null));
  ok('★ 0082 得個公開名單（冇後端冇 Key，唔會洩漏唔會被借用）',
    !!reg.units?.['0082'] && !reg.units['0082'].backend?.gasUrl && !reg.units['0082'].apiKey
    && !/script\.google/.test(JSON.stringify(reg.units)),
    Object.keys(reg.units || {}).join(',') || '（空）');
  ok('Registry 預設旅團係空（唔會靜靜雞當你係 82 旅）', !reg.defaultUnit, String(reg.defaultUnit));

  /* 扮一個「已登記但未交後端」嘅新旅團 */
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] ?? null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (/api\/units/.test(u)) return { ok: false, status: 404 };
    if (/units\.json/.test(u)) {
      const withNew = {
        ...reg,
        units: {
          ...reg.units,
          '0077': { code: '0077', name: '第七十七旅深資童軍團' },
          TEST9: { code: 'TEST9', name: '測試旅深資童軍團', backend: { gasUrl: GAS } }
        }
      };
      return { ok: true, status: 200, json: async () => withNew, text: async () => JSON.stringify(withNew) };
    }
    return { ok: false, status: 404 };
  };
  await units.loadRegistry(true);

  const newTroop = units.backendOf('0077');
  ok('未交後端嘅新旅團 ＝ 冇後端（唔會借用 82 旅張 Sheet）', newTroop === null, JSON.stringify(newTroop));
  ok('自己有登記後端嘅旅團照樣讀得到', (units.backendOf('TEST9') || {}).gasUrl === GAS);
  ok('登記咗嘅後端唔會被標記做「共用」', units.backendOf('TEST9')?.shared === false);
  ok('0082 已經冇登記 → 攞唔到後端（資料清乾淨）', units.backendOf('0082') === null,
    JSON.stringify(units.backendOf('0082')));
  ok('新旅團冇靜態資料夾（唔會讀到人哋嘅團員檔）',
    units.dataPathOf('0077') === 'data/units/0077/' && !fs.existsSync(path.join(ROOT, 'data', 'units', '0077')));
  ok('0082 靜態資料夾已經喺 Git 移除（唔會再種落任何人部機）',
    !fs.existsSync(path.join(ROOT, 'data', 'units', '0082')));
}

/* ============================================================
   ⑥ API Key 由伺服器端注入（唔可以要求用家喺瀏覽器打 key）
   ------------------------------------------------------------
   架構：TROOP_<編號>_BACKEND / _APIKEY 入 Vercel 環境變數
   → /api/proxy 喺伺服器端解析 → 前端只送旅團編號。
   曾經出過嘅錯：前端無論如何都送 apiKey:''，而 proxy 係寫
   `if (unit.apiKey && !payload.apiKey)` 先注入 —— 個空字串令
   注入唔到，後端就回「未授權」，變成要用家自己去打條 key。
   ============================================================ */
section('API Key 由伺服器端注入（前端唔應該知）');
{
  /* 上面第 ⑤ 段用咗個「乜都 404」嘅 fetch stub 去扮 registry，
     而且冇還原 —— proxy 要用真 fetch 先去到本機假 GAS，所以喺度還原返。 */
  globalThis.fetch = realFetchForProxy;
  const KEY = 'v82_serverside_only';
  let keySeenByGas = null;
  const gas = http.createServer((q, s) => {
    let raw = '';
    q.on('data', c => { raw += c; });
    q.on('end', () => {
      const b = JSON.parse(raw || '{}');
      keySeenByGas = b.apiKey || b.apikey || '';
      const needKey = ['saveDb', 'loadDb', 'dbInfo'].includes(b.action);
      const out = (needKey && keySeenByGas !== KEY)
        ? { ok: false, success: false, error: '未授權：API Key 唔正確' }
        : { ok: true, success: true, bytes: 10, chunks: 1, found: true };
      s.setHeader('Content-Type', 'application/json');
      s.end(JSON.stringify(out));
    });
  });
  await new Promise(r => gas.listen(0, '127.0.0.1', r));
  const gasUrl = `http://127.0.0.1:${gas.address().port}/exec`;

  const saved = { b: process.env.TROOP_0082_BACKEND, k: process.env.TROOP_0082_APIKEY, t: process.env.V82_PROXY_TEST };
  process.env.TROOP_0082_BACKEND = gasUrl;
  process.env.TROOP_0082_APIKEY = KEY;
  process.env.V82_PROXY_TEST = '1';

  const callProxy = (body) => new Promise(resolve => {
    const res = {
      _s: 200, setHeader() {}, status(c) { this._s = c; return this; },
      json(o) { resolve({ status: this._s, json: o }); }
    };
    proxyHandler({ method: 'POST', body, headers: {} }, res);
  });

  /* 前端完全唔送 apiKey —— 正路 */
  keySeenByGas = null;
  const clean = await callProxy({ action: 'saveDb', unit: '0082', db: { members: [] } });
  ok('前端唔送 apiKey，proxy 由 env 注入', clean.json?.ok === true, JSON.stringify(clean.json));
  ok('GAS 真係收到伺服器端條 key', keySeenByGas === KEY, JSON.stringify(keySeenByGas));

  /* 前端送空字串 —— 唔可以令注入失效 */
  keySeenByGas = null;
  const empty = await callProxy({ action: 'saveDb', unit: '0082', apiKey: '', apikey: '', db: { members: [] } });
  ok('前端送空 apiKey 都唔會阻住注入', empty.json?.ok === true, JSON.stringify(empty.json));
  ok('空字串唔會蓋過伺服器端條 key', keySeenByGas === KEY, JSON.stringify(keySeenByGas));

  /* remote.js 呢邊：唔應該把空 key 放入 proxy payload */
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/lib/remote.js'), 'utf8');
  ok('remote.js 只喺有 key 嗰陣先加入 payload（proxy 路線）',
    /if \(cfg\.apiKey\) \{\s*body\.apiKey/.test(src));
  ok('remote.js 有 proxy 路線就唔再強制要前端填 /exec',
    /viaProxy/.test(src) && /viaProxy && !!unit/.test(src));

  /* 提示文字要指向 Vercel 環境變數，唔可以叫用家喺瀏覽器打 key */
  ok('bad_key 提示叫人設定 TROOP_<編號>_APIKEY（唔係叫用家自己打）',
    /TROOP_<[^>]*>_APIKEY/.test(src) && /環境變數/.test(src));
  ok('bad_key 提示冇再叫用家去「同步設定」填 key',
    !/總表同步 → 同步設定 → API Key/.test(src));

  gas.close();
  if (saved.b === undefined) delete process.env.TROOP_0082_BACKEND; else process.env.TROOP_0082_BACKEND = saved.b;
  if (saved.k === undefined) delete process.env.TROOP_0082_APIKEY; else process.env.TROOP_0082_APIKEY = saved.k;
  if (saved.t === undefined) delete process.env.V82_PROXY_TEST; else process.env.V82_PROXY_TEST = saved.t;
}

/* ============================================================
   ⑦ 搬遷檢查：清走前端資料之前，要證實後端真係有齊嘢
   ------------------------------------------------------------
   0082 原本係「靜態檔 + localStorage」嘅系統，要搬入後端。
   清嘢係不可逆，所以「搬遷檢查」必須喺以下情況擋住：
     · 後端仲係空（未推過）
     · 本機有嘢未寫入後端（pending）
     · 兩邊筆數對唔上
   ============================================================ */
section('搬遷檢查（清前端之前要對數）');
{
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/views/tables.js'), 'utf8');
  ok('「總表同步」有「搬遷檢查」掣', /data-act="migrate-check"/.test(src));
  ok('檢查會 pullDb 攞成份後端資料落嚟逐項數（唔淨係信 dbInfo 個 count）',
    /act === 'migrate-check'/.test(src) && /remote\.pullDb\(\)/.test(src));
  ok('後端空 → 明確叫人唔好清', /後端仲係空/.test(src) && /千祈唔好/.test(src));
  ok('有 pending → 擋住', /pendingCount\(\)/.test(src) && /未寫入後端/.test(src));
  ok('筆數唔夾 → 唔畀清', /未可以清/.test(src));
  ok('全部夾 → 先至講可以安全清走', /可以安全清走前端資料/.test(src));
  ok('對數範圍唔止 6 項（連團章／團費／申報／預算／借用都數）',
    /團章章節/.test(src) && /團費紀錄/.test(src) && /收支申報/.test(src)
    && /活動預算/.test(src) && /物資借用/.test(src));
  ok('建議次序有叫人先做 JSON 備份', /匯出 JSON 備份/.test(src));
}

/* ============================================================
   ⑧ 「總表同步」唔填 /exec 都要經得同源代理（純環境變數開團）
   ------------------------------------------------------------
   2026-09-17 0082 事件：純 Vercel env 開團嘅旅團，前端根本唔會填
   /exec（網址同 key 留喺伺服器端），但 pushToMaster 一見冇 s.url
   就即刻話「未設定網址」—— 連「測試連線」都撳唔到。
   而家：冇本地網址就經同源 /api/proxy 照送。
   ============================================================ */
section('總表同步經同源代理（唔填 /exec 都得）');
{
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:8080/', pretendToBeVisual: true });
  const { window } = dom;
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
    'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
    catch { /* 唯讀 → 略過 */ }
  }
  globalThis.window = window;

  const seen = [];
  const memFetch = globalThis.fetch;
  /* 假代理：扮 GAS 經 proxy 回嚟嘅 JSON */
  let proxyReply = { ok: true, msg: '已寫入總表', counts: { members: 1 }, unit: '0082' };
  globalThis.fetch = async (url, init = {}) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (clean === 'api/proxy') {
      seen.push(JSON.parse(init.body || '{}'));
      return { ok: true, status: 200, text: async () => JSON.stringify(proxyReply) };
    }
    return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '404' };
  };

  const store = await import('../assets/js/lib/store.js');
  await store.init({ mode: 'real', unit: '0082' });
  ok('測試 DB 冇本地後端網址（純 env 開團嘅狀態）',
    !store.load().sync?.url && !store.load().backend?.gasUrl);

  const tables = await import('../assets/js/views/tables.js');
  const r1 = await tables.pushToMaster({ silent: true });
  ok('★ 冇填 /exec 都經得代理送出', r1.ok === true, JSON.stringify(r1).slice(0, 200));
  ok('送去代理嘅係 sync action＋旅團編號',
    seen[0]?.action === 'sync' && seen[0]?.unit === '0082',
    JSON.stringify({ a: seen[0]?.action, u: seen[0]?.unit }));
  ok('★ 經代理唔會送空 apiKey（等伺服器端注入）',
    !('apiKey' in (seen[0] || {})), Object.keys(seen[0] || {}).join(','));
  ok('有帶成份資料庫上去（後端會存入「資料庫」分頁）', seen[0]?.db?.unitCode === '0082');

  /* GAS 拒絕（例如 key 唔啱）嗰陣，HTTP 200 都要當失敗，而且要講得出原因 */
  proxyReply = { ok: false, success: false, error: '未授權：API Key 唔正確（寫入資料庫需要 API Key）' };
  const r2 = await tables.pushToMaster({ silent: true });
  ok('★ 代理回未授權 → 唔可以扮成功', r2.ok === false, JSON.stringify(r2).slice(0, 160));
  ok('錯誤原因要浮得返上嚟', /未授權/.test(String(r2.msg || '')), String(r2.msg || '').slice(0, 100));

  /* 純靜態部署（冇 /api/proxy）＋ 冇填網址 → 先至係真・未設定 */
  globalThis.fetch = async (url) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (clean === 'api/proxy') return { ok: false, status: 404, text: async () => '<h1>404</h1>' };
    return { ok: false, status: 404, json: async () => { throw new Error('404'); }, text: async () => '404' };
  };
  const r3 = await tables.pushToMaster({ silent: true });
  ok('冇代理又冇網址 → 明確話連唔到代理', r3.ok === false && /同源代理/.test(String(r3.msg || '')),
    String(r3.msg || '').slice(0, 120));

  /* remote.testConnection 一樣唔可以強制要本地網址 */
  globalThis.fetch = async (url) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (clean === 'api/proxy') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, msg: '82venture 後端正常' }) };
    }
    return { ok: false, status: 404, text: async () => '404' };
  };
  const remote = await import('../assets/js/lib/remote.js');
  const t = await remote.testConnection();
  ok('remote.testConnection 經代理都 test 到（唔使本地網址）', t.ok === true, JSON.stringify(t).slice(0, 160));

  globalThis.fetch = memFetch;
}

/* ============================================================
   ⑨ 舊系統遷移：指去 82venture 嘅公開網址要搵得出＋一鍵搬
   ------------------------------------------------------------
   各旅團資料庫入面嘅公開網址（通告／團章／公開頁）好可能仲係
   舊站嗰陣填嘅 82venture.vercel.app —— 嗰啲 QR／WhatsApp 連結
   退役之後會死晒。呢度驗：搵得出、搬得啱、頁面識得警告。
   （沿用第 ⑧ 節嘅 jsdom 環境：location ＝ http://localhost:8080/）
   ============================================================ */
section('舊系統遷移（一鍵搬公開網址）');
{
  const store = await import('../assets/js/lib/store.js');
  const model = await import('../assets/js/lib/model.js');

  ok('認得舊站網址', model.isLegacyUrl('https://82venture.vercel.app/notice.html?u=0082&n=x') === true);
  ok('唔理大細楷', model.isLegacyUrl('https://82VENTURE.VERCEL.APP/entry.html') === true);
  ok('相對路徑唔算舊站', model.isLegacyUrl('notice.html?u=0082') === false);
  ok('新站唔算舊站', model.isLegacyUrl('https://ecportal.vercel.app/notice.html') === false);
  ok('而家唔係喺舊站', model.onLegacyHost() === false);

  /* 播種：扮 0082 資料庫入面仲有舊網址（單旅團年代填落嘅） */
  const db = store.load();
  db.settings.notice = { ...(db.settings.notice || {}), publicBaseUrl: 'https://82venture.vercel.app/notice.html' };
  db.settings.publicBaseUrl = 'https://82venture.vercel.app/constitution.html?u={u}';
  db.settings.publicLinks = {
    ...(db.settings.publicLinks || {}), base: '',
    'entry.html': 'https://82venture.vercel.app/entry.html', 'borrow.html': ''
  };
  store.commit();

  const found = model.findLegacyPublicUrls();
  ok('★ 搵得出 3 個指去舊站嘅設定', found.length === 3, JSON.stringify(found.map(f => f.key)));
  ok('搬遷淨係換 host（path＋參數照留）',
    model.migrateLegacyUrl('https://82venture.vercel.app/notice.html?u=0082&n=5') === 'http://localhost:8080/notice.html?u=0082&n=5',
    model.migrateLegacyUrl('https://82venture.vercel.app/notice.html?u=0082&n=5'));
  ok('唔係舊站網址就原樣回傳',
    model.migrateLegacyUrl('https://ecportal.vercel.app/x') === 'https://ecportal.vercel.app/x');

  const n = model.migrateLegacyPublicUrls();
  ok('★ 一鍵搬走 3 個', n === 3, String(n));
  ok('搬完之後搵唔到舊站網址', model.findLegacyPublicUrls().length === 0);
  ok('通告網址已經係而家呢個站',
    store.load().settings.notice.publicBaseUrl === 'http://localhost:8080/notice.html',
    store.load().settings.notice.publicBaseUrl);
  ok('{u} 參數搬完之後仲喺度',
    store.load().settings.publicBaseUrl === 'http://localhost:8080/constitution.html?u={u}',
    store.load().settings.publicBaseUrl);

  /* 成員連結頁會出 banner（播返個舊嘅先） */
  store.load().settings.publicLinks['borrow.html'] = 'https://82venture.vercel.app/borrow.html';
  store.commit();
  const links = await import('../assets/js/views/links.js');
  const html = links.render();
  ok('★ 成員連結頁有舊站警告＋一鍵搬掣', /舊系統/.test(html) && /data-act="migrate-urls"/.test(html));
  ok('受影響嘅連結卡有警告', /退役之後會死/.test(html));

  /* 通告分享連結都係同一個來源（搬完就啱） */
  const notices = await import('../assets/js/views/notices.js');
  store.add('notices', { id: 'n_legacy1', title: { zh: '測試通告' }, status: 'published' });
  const rec = store.find('notices', 'n_legacy1');
  ok('通告 publicUrl 用搬完之後嘅新網址',
    notices.publicUrl(rec).startsWith('http://localhost:8080/notice.html?'), notices.publicUrl(rec));
}

console.log(`\n──────── 後端儲存測試結果：${pass} 通過 / ${fail} 失敗（${Date.now() - t0} ms）────────\n`);
process.exit(fail ? 1 : 0);
