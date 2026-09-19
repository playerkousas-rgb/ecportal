/* ============================================================
   tests/_device.mjs — 「一部裝置」模擬器（畀 tests/remote.mjs 用）
   ------------------------------------------------------------
   每次執行 ＝ 一部全新嘅機（全新 process、全新 localStorage）。
   會經**真實 HTTP** 打去 dev-server 嘅 /api/proxy，再由 proxy 轉去假 GAS。
   用法：node tests/_device.mjs <baseUrl> <動作JSON>
   輸出：一行 JSON（畀父 process 讀）
   ============================================================ */

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2];
const PLAN = JSON.parse(process.argv[3] || '{}');

const out = { ok: false, steps: [], error: '' };

try {
  /* ---- 一部全新嘅「瀏覽器」 ---- */
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: `${BASE}/?u=0082`, pretendToBeVisual: true
  });
  const { window } = dom;
  window.scrollTo = () => {};
  try { Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true }); } catch { /* ignore */ }
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
    'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams']) {
    if (window[k] === undefined) continue;
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* ignore */ }
  }
  globalThis.window = window;

  /* ---- fetch：相對路徑補返 base，行真 HTTP ---- */
  const nodeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    let u = String(url);
    if (!/^https?:\/\//.test(u)) u = `${BASE}/${u.replace(/^\.?\//, '')}`;
    return nodeFetch(u, init);
  };

  const units = await import('../assets/js/lib/units.js');
  const store = await import('../assets/js/lib/store.js');
  const remote = await import('../assets/js/lib/remote.js');

  await units.loadRegistry(true);
  await store.init({ mode: 'real', unit: '0082' });
  store.setSaveHook(() => remote.scheduleSave());

  out.configured = remote.remoteConfigured();
  out.cfg = { url: remote.remoteCfg().url, unit: remote.remoteCfg().unit, auto: remote.remoteCfg().auto };
  out.seededMembers = store.load().members.length;

  /* ---- 依照劇本做嘢 ---- */
  for (const step of (PLAN.steps || [])) {
    if (step.op === 'wipe') {
      store.wipe();
      out.steps.push({ op: 'wipe', members: store.load().members.length });
    }
    if (step.op === 'addMember') {
      store.add('members', { name: step.name, ymis: step.ymis, identity: 'member' });
      out.steps.push({ op: 'addMember', name: step.name, total: store.load().members.length });
    }
    if (step.op === 'bulkMembers') {
      /* 灌大量團員把 db 谷大過分件閾值 —— 測 v2.4.0 分件儲存。
         一次過注入再 commit 一次（同真實「試算表匯入」路徑一樣；
         唔係逐個 add —— 咁樣會千幾次全 db 序列化，純粹燒記憶體）。 */
      const db = store.load();
      for (let i = 0; i < (step.count || 0); i++) {
        db.members.push({ id: 'mb' + i, name: (step.prefix || 'Bulk') + i, ymis: '2026' + String(1000000 + i), identity: 'member', note: 'x'.repeat((step.kb || 2) * 1024) });
      }
      store.commit();
      const db2 = store.load();
      out.steps.push({ op: 'bulkMembers', total: db2.members.length, bytes: JSON.stringify(db2).length });
    }
    if (step.op === 'addTx') {
      store.add('transactions', { date: step.date, type: step.type, item: step.item, amount: step.amount });
      out.steps.push({ op: 'addTx', total: store.load().transactions.length });
    }
    /* 設置測試資料（tests/hub.mjs 用）：一次過放入活動／通告／連結等 */
    if (step.op === 'put') {
      const db = store.load();
      db[step.coll] = step.rows;
      store.commit();
      out.steps.push({ op: 'put', coll: step.coll, n: (step.rows || []).length });
    }
    if (step.op === 'patchSettings') {
      const db = store.load();
      db.settings = { ...(db.settings || {}), ...step.patch };
      store.commit();
      out.steps.push({ op: 'patchSettings', keys: Object.keys(step.patch || {}) });
    }
    if (step.op === 'setConstitution') {
      const db = store.load();
      db.constitution = step.obj;
      store.commit();
      out.steps.push({ op: 'setConstitution', version: step.obj?.version || '' });
    }
    /* 領袖喺「總表同步 → 同步設定」貼 /exec ＋ API Key（自助路線） */
    if (step.op === 'setSync') {
      /* 2026-09-19：自動寫入已剷走（remoteCfg().auto 寫死 false），
         所以呢度冇 auto／autoModel 可設 —— 剩「會議模式」（淨係讀）一個開關。 */
      const db = store.load();
      db.sync = {
        ...(db.sync || {}), url: step.url || '', apiKey: step.apiKey || '',
        unit: step.unit || '0082', poll: step.poll === true
      };
      store.commit();
      const cfg = remote.remoteCfg();
      out.steps.push({
        op: 'setSync', url: cfg.url, hasKey: !!cfg.apiKey, viaProxy: cfg.viaProxy,
        ok: cfg.ok, auto: cfg.auto, poll: cfg.poll
      });
    }
    /* 「同步診斷」：逐格驗成條鏈 */
    if (step.op === 'diagnose') {
      const d = await remote.remoteDiagnose();
      out.steps.push({
        op: 'diagnose', ok: d.ok, route: d.route, backendVersion: d.backendVersion,
        summary: d.summary || '', blockers: (d.blockers || []).map(b => b.id),
        stages: (d.stages || []).map(s => `${s.id}:${s.state}`)
      });
    }
    if (step.op === 'push') {
      const r = await remote.pushDb({ silent: true });
      out.steps.push({ op: 'push', ok: r.ok, error: r.error || '', reason: r.reason || '', hint: (r.hint || '').slice(0, 400), bytes: r.bytes || 0, parts: r.parts || 0, pending: Number(store.load().sync?.pending || 0) });
    }
    /* 2026-09-19「讀唔到後端就唔准寫」硬保險：呢個 session 對唔對到後端版本 */
    if (step.op === 'reconciled') {
      out.steps.push({ op: 'reconciled', reconciled: remote.isReconciled(), state: remote.syncState().state, pending: Number(store.load().sync?.pending || 0) });
    }
    /* 「實際生效」嘅同步模式（唔係 db 入面存咗乜，而係 remoteCfg() 點解）——
       用來釘死 2026-09-19 團長指示：預設手動、舊遺留 auto:true 都當手動。 */
    if (step.op === 'syncMode') {
      const db = store.load();
      const cfg = remote.remoteCfg();
      out.steps.push({
        op: 'syncMode',
        storedAuto: db.sync?.auto === undefined ? 'undefined' : String(db.sync?.auto),
        storedAutoModel: String(db.sync?.autoModel ?? 'none'),
        effAuto: cfg.auto, effPoll: cfg.poll
      });
    }
    /* 模擬「舊版本遺留落嚟嘅 db.sync.auto:true」（舊 checkbox 預設剔住，
       用家一撳儲存設定就明寫 auto:true）—— 新預設必須仍然係手動。 */
    if (step.op === 'legacyAuto') {
      const db = store.load();
      db.sync = { ...(db.sync || {}), auto: true };
      delete db.sync.autoModel;
      store.commitMeta();
      const cfg = remote.remoteCfg();
      out.steps.push({ op: 'legacyAuto', effAuto: cfg.auto, effPoll: cfg.poll });
    }
    /* 團長要嘅「撳同步」：一次過 先讀後端（拉＋合併）→ 再寫後端 */
    if (step.op === 'syncNow') {
      const r = await remote.syncNow();
      const db = store.tryLoad();
      out.steps.push({
        op: 'syncNow', ok: !!r?.ok, error: r?.error || '', reason: r?.reason || '', stage: r?.stage || '',
        pulled: !!r?.pulled, mergedPull: !!r?.mergedPull, pushed: !!r?.pushed, upToDate: !!r?.upToDate,
        members: (db?.members || []).length, names: (db?.members || []).map(m => m.name).sort(),
        pending: Number(db?.sync?.pending || 0)
      });
    }
    /* 劇本中途直接問後端而家有咩（唔信前端自己講）——
       要喺兩個 step **之間**取樣先有意義，例如證明「手動模式下未撳同步
       之前，後端真係一個字都未收到」。 */
    if (step.op === 'backendPeek') {
      const cfg = remote.remoteCfg();
      const r = await fetch(cfg.url, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'dbInfo', unit: cfg.unit || '0082', apiKey: cfg.apiKey })
      });
      const j = await r.json().catch(() => ({}));
      out.steps.push({
        op: 'backendPeek', http: r.status, found: !!j.found,
        members: Number(j.counts?.members || 0), version: String(j.version || '')
      });
    }
    /* 手動模式：改動淨係暫存，等 debounce 過咗都唔應該自動寫 */
    if (step.op === 'manualStage') {
      const db0 = store.load();
      db0.sync = { ...(db0.sync || {}), auto: false };
      store.commit();
      remote.arm();
      store.add('members', { name: step.name, ymis: step.ymis, identity: 'member' });
      remote.scheduleSave();
      await new Promise(r => setTimeout(r, step.waitMs || 4000));
      out.steps.push({
        op: 'manualStage', pending: Number(store.load().sync?.pending || 0),
        state: remote.syncState().state, msg: remote.syncState().msg || '',
        members: (store.load().members || []).length
      });
    }
    if (step.op === 'autosave') {
      /* 2026-09-19 團長指示「自動會有機會出事就唔好比佢有得選」——
         自動寫入已經**剷走**，所以呢個 op 而家測嘅係反過來嘅嘢：
         「改完嘢、arm 咗、等足 debounce 時間，都**唔會**自動寫後端」。
         仲刻意把 db.sync.auto 強行設做 true（模擬舊遺留值／有人手改 db），
         證明就算咁都寫唔到 —— 因為 remoteCfg().auto 係寫死嘅 false。 */
      const dbA = store.load();
      dbA.sync = { ...(dbA.sync || {}), auto: true };
      store.commitMeta();
      remote.arm();
      store.add('members', { name: step.name, ymis: step.ymis, identity: 'member' });
      await new Promise(r => setTimeout(r, step.waitMs || 4000));
      out.steps.push({ op: 'autosave', pending: Number(store.load().sync?.pending || 0), state: remote.syncState().state });
    }
    /* 「成員連結」頁會派出去嘅公開連結（驗 ?be= 自助後端附埋入 link） */
    if (step.op === 'links') {
      const model = await import('../assets/js/lib/model.js');
      const route = model.publicLinkRoute();
      const list = model.memberLinks();
      out.steps.push({
        op: 'links', route: route.route, label: route.label, routeOk: route.ok,
        selfServeExec: model.selfServeExec(),
        urls: list.slice(0, 6).map(l => ({ id: l.id, url: l.url }))
      });
    }
    if (step.op === 'info') {
      const i = await remote.remoteInfo();
      out.steps.push({ op: 'info', ok: i.ok, found: !!i.found, reason: i.reason || '', error: (i.error || '').slice(0, 80), counts: i.counts || null, at: i.at || '' });
    }
    if (step.op === 'pull') {
      const g = await remote.pullDb();
      let adopted = null;
      if (g.ok && g.db) {
        store.adoptRemote(g.db, { version: String(g.version || '') });
        adopted = {
          members: store.load().members.length,
          transactions: store.load().transactions.length,
          names: store.load().members.map(m => m.name),
          pending: Number(store.load().sync?.pending || 0)
        };
      }
      out.steps.push({ op: 'pull', ok: g.ok, found: !!g.found, error: g.error || '', adopted });
    }
    if (step.op === 'snapshot') {
      const db = store.load();
      out.steps.push({
        op: 'snapshot',
        members: db.members.length,
        transactions: db.transactions.length,
        names: db.members.map(m => m.name),
        hasLocalContent: store.hasLocalContent(),
        updatedAt: store.localUpdatedAt(),
        lastSyncedVersion: String(db.sync?.lastSyncedVersion || ''),
        pending: Number(db.sync?.pending || 0)
      });
    }
    /* 「第 N 部機」模擬：把呢部機嘅本機 db 匯出／匯入（模擬同一部機走開咗再返嚟，
       中間有第二部機更新咗後端 —— 用嚟測衝突復原）。 */
    if (step.op === 'export') {
      fs.writeFileSync(step.file, store.exportAll(), 'utf8');
      out.steps.push({ op: 'export', file: step.file, members: store.load().members.length });
    }
    /* 模擬「隊友喺另一部機儲存」：直接經 proxy 用正確 baseVersion 寫入後端 */
    if (step.op === 'teammatePush') {
      const got = await remote.pullDb();
      if (!got.ok || !got.db) { out.steps.push({ op: 'teammatePush', ok: false, error: got.error || '後端空' }); continue; }
      const db = JSON.parse(JSON.stringify(got.db));
      db.members = [...(db.members || []), { id: 'm8' + Date.now(), name: step.name, ymis: step.ymis, identity: 'member' }];
      db.meta = { ...(db.meta || {}), updatedAt: '2026-09-18T20:00:00.000Z' };
      const r = await (await fetch(`${BASE}/api/proxy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'saveDb', unit: '0082', db, baseVersion: String(got.version || '') })
      })).json();
      out.steps.push({ op: 'teammatePush', ok: r.ok === true, version: String(r.version || '') });
    }
    /* 「立即同步」：問後端有冇隊友新版本，有就拉（本機有 pending 就會合併） */
    if (step.op === 'checksync') {
      const r = await remote.checkRemote({ silent: true });
      const db = store.tryLoad();
      out.steps.push({
        op: 'checksync', ok: !!r?.ok, updated: !!r?.updated, merged: !!r?.merged, upToDate: !!r?.upToDate,
        members: (db?.members || []).length, names: (db?.members || []).map(m => m.name),
        pending: Number(db?.sync?.pending || 0)
      });
    }
    /* 跨視窗同步（2026-09-19）：部機開住、隊友喺另一部機推咗新版，
       用家「撳返呢個視窗」（focus）→ 1.2 秒內自動對版本、拉隊友嘅改動。
       （前一個 step 通常係 teammatePush —— 模擬「另一個視窗／無痕視窗做咗嘢」） */
    if (step.op === 'watchAndFocus') {
      remote.arm();
      remote.startVisibilityWatch();
      await new Promise(r => setTimeout(r, 300));                 // 等 watcher 綁好
      window.dispatchEvent(new window.Event('focus'));            // 模擬切返呢個視窗
      await new Promise(r => setTimeout(r, step.waitMs || 2600)); // 等 1.2s debounce＋拉取
      const db = store.tryLoad();
      out.steps.push({
        op: 'watchAndFocus',
        members: (db?.members || []).length,
        names: (db?.members || []).map(m => m.name),
        lastSyncedVersion: String(db?.sync?.lastSyncedVersion || ''),
        pending: Number(db?.sync?.pending || 0)
      });
    }
    if (step.op === 'import') {
      store.importAll(fs.readFileSync(step.file, 'utf8'));
      const db = store.load();
      out.steps.push({
        op: 'import', file: step.file, members: db.members.length,
        names: db.members.map(m => m.name), pending: Number(db.sync?.pending || 0),
        lastSyncedVersion: String(db.sync?.lastSyncedVersion || '')
      });
    }
  }

  out.ok = true;
} catch (e) {
  out.error = e?.stack || String(e);
}

process.stdout.write('\n@@RESULT@@' + JSON.stringify(out) + '@@END@@\n');
/* jsdom 會留低 timer／rAF handle，唔明確 exit 就會吊死 */
process.exit(out.ok ? 0 : 1);
