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
    if (step.op === 'addTx') {
      store.add('transactions', { date: step.date, type: step.type, item: step.item, amount: step.amount });
      out.steps.push({ op: 'addTx', total: store.load().transactions.length });
    }
    if (step.op === 'push') {
      const r = await remote.pushDb({ silent: true });
      out.steps.push({ op: 'push', ok: r.ok, error: r.error || '', bytes: r.bytes || 0, pending: Number(store.load().sync?.pending || 0) });
    }
    if (step.op === 'autosave') {
      /* 模擬「改完自動存」：arm 之後改一筆，等 debounce 過咗 */
      remote.arm();
      store.add('members', { name: step.name, ymis: step.ymis, identity: 'member' });
      await new Promise(r => setTimeout(r, step.waitMs || 4000));
      out.steps.push({ op: 'autosave', pending: Number(store.load().sync?.pending || 0), state: remote.syncState().state });
    }
    if (step.op === 'info') {
      const i = await remote.remoteInfo();
      out.steps.push({ op: 'info', ok: i.ok, found: !!i.found, counts: i.counts || null, at: i.at || '' });
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
