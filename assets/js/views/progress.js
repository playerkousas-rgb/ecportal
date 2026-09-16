/* ============================================================
   progress.js — 進度紀錄（直接接駁 VSBADGE）
   ------------------------------------------------------------
   2026-09-16 團長要求：
     1) 唔要「外連」（唔想開新分頁／iframe 去 vsbadge，再撞 referer_mismatch）
     2) 要**直接讀取 VSBADGE 嘅 script**，喺執委管理系統內顯示進度
     3) 每個旅團嘅進度追蹤有自己嘅 Script 同 API Key → 由旅團自己填入
     4) 可以直接勾進度（同一個後端）

   做法：瀏覽器 → 同源 /api/progress（伺服器） → 旅團自己嘅 VSBADGE GAS /exec
       讀：action=load（成員／進度／待批完成／其他獎章／活動履歷）
       寫：action=save / saveOtherBadge（用 API Key，唔使登入）
   ------------------------------------------------------------
   「外連（Portal 信任模式）」仍然保留做後備，喺「設定」最底。
   ============================================================ */

import { load, commit } from '../lib/store.js';
import { profile, members, memberName, settings, keyCoverage } from '../lib/model.js';
import { esc, icon, modal, toast, copyText, qrSvg, nf, todayISO } from '../lib/util.js';
import { go } from '../lib/router.js';
import { can, current } from '../lib/auth.js';
import { pageHead, tabs, stat, empty, noteBox, kv, chipbar, progressBar } from './ui.js';
import {
  progressCfg, setProgressCfg, progressConfigured, loadRemote, loadItems, saveTicks,
  flattenItems, summarizeRemote, memberDetail, testConnection, matchLocalMember
} from '../lib/progress.js';

/* ---------- 狀態 ---------- */
let tab = 'overview';
let remote = null;        // { data, at }
let catalog = null;       // flattenItems() 結果
let loading = false;
let errMsg = '';
let lastCheck = null;     // 測試連線結果
let selYmis = '';         // 成員進度 / 勾選 用
let selBadge = 'all';     // 勾選：獎章篩選
let pending = {};         // { 'ymis|itemId': true/false } 未儲存嘅改動
let tickDate = '';        // 勾選日期
let memberSearch = '';

export function title() { return '進度紀錄'; }

/* ============================================================
   舊有：Portal 外連模式（保留做後備）
   ============================================================ */
export const PROGRESS_ROLES = [
  { v: 'exec_committee', l: '執委（exec_committee）', tick: true },
  { v: 'branch_leader', l: '支部領袖（branch_leader）', tick: true },
  { v: 'group_leader', l: '團長（group_leader）', tick: true },
  { v: 'admin', l: '管理員（admin）', tick: true },
  { v: 'super_admin', l: '超級管理員（super_admin）', tick: true },
  { v: 'member', l: '團員（member）—— 只可以睇自己', tick: false }
];
export const TICK_ROLES = PROGRESS_ROLES.filter(r => r.tick).map(r => r.v);

const ROLE_SHORT = {
  exec_committee: 'EXCO', branch_leader: 'LEADER', group_leader: 'GLEADER',
  admin: 'ADMIN', super_admin: 'SUPER', member: 'MEMBER'
};

/** Portal 身份（自動產生 PORTAL-<旅團>-<角色>） */
export function portalIdentity(c) {
  const manual = String(c.portal?.ymis || '').trim();
  if (manual) return { ymis: manual, auto: false };
  const unit = String(c.portal?.unitParam || load().unitCode || 'UNIT').trim();
  const role = String(c.portal?.role || 'exec_committee');
  return { ymis: `PORTAL-${unit}-${ROLE_SHORT[role] || 'EXCO'}`, auto: true };
}

function cfg() {
  const p = profile();
  const db = load();
  return {
    url: p.progress?.url || db.settings.progressUrl || '',
    name: p.progress?.name || '深資童軍進度及行政平台 (VSBADGE)',
    mode: p.progress?.mode || 'portal',
    portal: p.progress?.portal || { unitParam: db.unitCode, role: 'exec_committee', ymis: '', extraParams: 'embed=1' },
    dedicated: p.progress?.dedicated || { username: '', password: '' },
    paramUser: p.progress?.paramUser || 'ymis',
    paramPass: p.progress?.paramPass || 'p'
  };
}

function buildUrl(c) {
  if (!c.url) return '';
  const qs = new URLSearchParams();
  if (c.mode === 'portal') {
    const p = c.portal || {};
    if (p.unitParam) qs.set('u', p.unitParam);
    if (p.role) qs.set('role', p.role);
    qs.set('ymis', portalIdentity(c).ymis);
    qs.set('name', (p.name || '執委會').trim());
    qs.set('from', 'portal');
    try { qs.set('src', globalThis.location?.origin || ''); } catch (e) { /* 冇 origin 就算 */ }
    qs.set('ts', String(Date.now()));
    (String(p.extraParams || '').split('&').filter(Boolean)).forEach(pair => {
      const [k, v = '1'] = pair.split('=');
      qs.set(k.trim(), v);
    });
  } else if (c.mode === 'dedicated') {
    const d = c.dedicated || {};
    if (d.username) qs.set(c.paramUser, d.username);
    if (d.password) qs.set(c.paramPass, d.password);
  }
  const sep = c.url.includes('?') ? '&' : '?';
  return qs.toString() ? c.url + sep + qs.toString() : c.url;
}

/** 就緒檢查（外連模式用） */
export function readiness() {
  const c = cfg();
  const db = load();
  const act = members().filter(m => m.status === 'active');
  const checks = [
    { ok: !!c.url, label: '進度系統網址已填', detail: c.url || '（未填 —— 撳「設定」）' },
    { ok: /^https:\/\//.test(c.url || ''), label: '網址係 HTTPS', detail: c.url ? c.url.slice(0, 48) + '…' : '—' },
    { ok: !/\/macros\/s\//.test(c.url || ''), label: '網址係系統前端（唔係 GAS /exec）',
      detail: /\/macros\/s\//.test(c.url || '') ? '⚠ 呢條係 Apps Script API 端點，開出嚟會係 JSON 錯誤頁 —— 請改填對方嘅前端網址' : (c.url || '—') },
    { ok: !!c.mode, label: '已揀連接模式', detail: { portal: 'Portal 信任模式（免密碼）', dedicated: '專用帳戶', link: '只開連結' }[c.mode] || c.mode },
    { ok: c.mode !== 'portal' || !!(c.portal?.unitParam), label: 'Portal 帶旅團編號（u）', detail: c.portal?.unitParam || '（未填）' },
    { ok: c.mode !== 'portal' || !!portalIdentity(c).ymis, label: 'Portal 帶身份（ymis）—— 對方必要欄位',
      detail: (() => {
        if (c.mode !== 'portal') return '—';
        const pi = portalIdentity(c);
        return pi.auto ? `${pi.ymis} <span class="faint">（自動產生，唔使人手填）</span>` : `${pi.ymis}（你自己填嘅專用身份）`;
      })() },
    { ok: c.mode !== 'portal' || TICK_ROLES.includes(c.portal?.role), label: 'Portal 角色有管理／勾選權',
      detail: c.portal?.role
        ? (TICK_ROLES.includes(c.portal?.role) ? c.portal?.role : `⚠ 「${c.portal?.role}」對方唔認，會當你冇權限`)
        : '（未填）' },
    { ok: c.mode !== 'dedicated' || !!(c.dedicated?.username && c.dedicated?.password), label: c.mode === 'dedicated' ? '專用帳戶帳密已填' : '唔需要專用帳戶帳密', detail: c.mode === 'dedicated' ? (c.dedicated?.username || '（未填）') : '—' },
    { ok: act.length > 0, label: `名冊有現役用戶（${act.length} 位）`, detail: act.slice(0, 3).map(m => m.name).join('、') + (act.length > 3 ? ' 等' : '') },
    { ok: !!buildUrl(c), label: '可以組合出登入連結', detail: buildUrl(c) || '（未有網址）' }
  ];
  const last = db.settings?.progressCheck || null;
  const ident = keyCoverage();
  return {
    checks, pass: checks.filter(x => x.ok).length, total: checks.length,
    ready: checks.every(x => x.ok), last, url: buildUrl(c) || c.url, name: c.name, mode: c.mode,
    ident, linkReady: checks.every(x => x.ok), dataReady: ident.ready
  };
}

/** 由瀏覽器實際 ping 一次（外連模式用） */
export async function checkConnection(url, timeoutMs = 12000) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    return {
      ok: true, opaque: res.type === 'opaque', status: res.status || 0,
      ms: Date.now() - started, at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      msg: res.type === 'opaque'
        ? '有回應（Apps Script 唔畀瀏覽器讀內容，屬正常）—— 網址可達'
        : `HTTP ${res.status}`
    };
  } catch (e) {
    clearTimeout(timer);
    const aborted = e?.name === 'AbortError';
    return {
      ok: false, ms: Date.now() - started, at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      msg: aborted ? `逾時（${Math.round(timeoutMs / 1000)} 秒冇回應）` : (e?.message || String(e))
    };
  }
}

/* ============================================================
   直接接駁：讀取
   ============================================================ */
async function fetchAll({ silent = false } = {}) {
  if (!progressConfigured()) return;
  loading = true; errMsg = '';
  if (!silent) refresh();
  const r = await loadRemote();
  if (!r.ok) {
    loading = false; remote = null;
    errMsg = r.error || '讀取失敗';
    refresh();
    return;
  }
  remote = { data: r.data || {}, at: new Date().toLocaleString('zh-HK', { hour12: false }) };
  const cfgNow = progressCfg();
  if (cfgNow.front) {
    const it = await loadItems();
    if (it.ok) catalog = flattenItems(it.data);
  }
  loading = false;
  refresh();
}

function needSetup() {
  return `
  <div class="card" style="max-width:760px">
    <div class="card-head"><div><div class="card-title">第一步：直接接駁 VSBADGE（讀旅團自己嘅進度系統）</div>
      <div class="card-sub">唔使外連、唔使登入多一次 —— 我哋直接讀你嘅 Apps Script</div></div></div>
    <div style="padding:16px 18px" class="sm muted">
      <ol style="padding-left:18px;line-height:1.95">
        <li>去旅團自己嘅 <b>VSBADGE Google Sheet</b> → 擴充功能 → Apps Script</li>
        <li>執行 <code>showApiKey()</code>（或喺編輯器底部「執行紀錄」睇）→ 複製 <b>API Key</b></li>
        <li>複製部署好嘅 <b>Web App /exec 網址</b>（部署 → 管理部署 → 網頁應用程式網址）</li>
        <li>返嚟呢一頁按「<b>設定</b>」貼上兩樣，撳「<b>測試連線</b>」就得</li>
      </ol>
      ${noteBox('同一支 API Key 亦係 VSBADGE 自己用嘅 key（<code>getApiKey()</code>）；本系統只會由<b>同源伺服器</b>傳送，唔會經第三方，亦唔會寫入 log。', 'info')}
      <div class="row gap-8 mt-12 wrap">
        <button class="btn btn-primary" data-act="settings">${icon('settings', 16)} 去設定</button>
      </div>
    </div>
  </div>`;
}

/* ---------- 總覽 ---------- */
function overviewView() {
  if (!progressConfigured()) return needSetup();
  if (errMsg) {
    return `<div class="note-box warn">${icon('alert', 15)}<div><b>讀唔到進度系統：</b>${esc(errMsg)}
      <div class="xs mt-4">如果係「Invalid API Key」→ 去 VSBADGE Apps Script 重新複製 API Key；如果係「連唔到」→ 檢查 /exec 網址同網絡。</div></div></div>
      <div class="row gap-8 mt-12"><button class="btn" data-act="settings">${icon('settings', 15)} 檢查設定</button>
      <button class="btn" data-act="reload">${icon('refresh', 15)} 再試</button></div>`;
  }
  if (!remote) return `<div class="card"><div style="padding:34px" class="center muted">${loading ? '讀取進度系統中…（最多等 45 秒）' : '按「重新讀取」開始'}</div></div>`;

  const S = summarizeRemote(remote.data, { catalog, roster: members() });
  const pendingReqs = remote.data.pendingRequests || [];
  const logs = remote.data.logs || [];
  const logReqs = remote.data.logRequests || [];

  return `
  <div class="grid g-4 mb-16">
    ${stat('進度系統成員', String(S.memberCount), `${S.withProgress} 位有進度紀錄`, '')}
    ${stat('已勾項目', String(S.totalTicks), catalog ? `共 ${S.totalItems} 個考核項目` : '（未讀到項目定義）', 'ok')}
    ${stat('平均完成率', S.avgRate === null ? '—' : S.avgRate + '%', '以全團 × 全部項目計', S.avgRate >= 50 ? 'ok' : '')}
    ${stat('待批完成', String(pendingReqs.length), pendingReqs.length ? '要去 VSBADGE 或領袖審批' : '冇待批', pendingReqs.length ? 'warn' : 'ok')}
  </div>

  ${S.unmatched ? `<div class="note-box mb-16">${icon('alert', 15)}<div>
    有 <b>${S.unmatched}</b> 位 VSBADGE 成員喺本系統名冊搵唔到（多數係未填 YMIS）。
    去「用戶」幫佢哋填返<b>會籍編號（YMIS）</b>，兩邊就對得返。</div></div>` : ''}

  <div class="grid g-2-1">
    <div class="col gap-16">
      ${catalog ? `<div class="card">
        <div class="card-head"><div><div class="card-title">獎章進度（全團）</div>
          <div class="card-sub">每個獎章：有幾多人開始、合共勾咗幾多項</div></div></div>
        <div style="padding:14px 18px" class="col gap-14">
          ${S.badgeStats.map(b => {
            const ticksRate = b.items ? Math.round(b.ticks / (b.items * Math.max(1, S.memberCount)) * 100) : 0;
            return `<div>
              <div class="row-between xs mb-4"><span>${esc(b.icon)} <b>${esc(b.name)}</b> <span class="faint">${esc(b.id)}</span></span>
                <span class="mono">${b.members} 人開始 · 勾咗 ${b.ticks} 項 / ${b.items * Math.max(1, S.memberCount)}</span></div>
              ${progressBar(ticksRate)}
            </div>`;
          }).join('')}
        </div>
      </div>` : `<div class="note-box">${icon('alert', 15)}<div>未讀到考核項目定義（<code>data/items.json</code>）。喺「設定」填返 VSBADGE 前端網址就得。</div></div>`}

      <div class="card">
        <div class="card-head"><div><div class="card-title">待批完成（${pendingReqs.length}）</div>
          <div class="card-sub">團員自己申報、等領袖審批 —— 呢度只顯示（審批仍喺 VSBADGE 做）</div></div></div>
        ${pendingReqs.length ? `<div class="scroll-x"><table class="table table-compact">
          <thead><tr><th>申請日期</th><th>團員</th><th>項目</th><th>申報日期</th></tr></thead>
          <tbody>${pendingReqs.slice(0, 20).map(r => `<tr>
            <td class="mono sm">${esc(r.created_at || '')}</td>
            <td class="sm">${esc(r.name || r.ymis || '')}</td>
            <td class="sm">${esc(r.item_name || r.item_id || '')}</td>
            <td class="mono sm">${esc(r.requested_date || '')}</td></tr>`).join('')}</tbody>
        </table></div>` : `<div style="padding:16px" class="sm faint">冇待批項目</div>`}
      </div>
    </div>

    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div><div class="card-title">活動履歷</div>
          <div class="card-sub">服務／活動／訓練班紀錄（讀取自 VSBADGE）</div></div></div>
        <div style="padding:16px 18px">
          <div class="grid g-2" style="gap:10px">
            <div><div class="xs faint">已批紀錄</div><div class="semibold">${logs.length} 條</div></div>
            <div><div class="xs faint">待批申報</div><div class="semibold">${logReqs.length} 條</div></div>
          </div>
          ${logs.length ? `<div class="mt-12 col gap-6">${logs.slice(0, 6).map(l => `
            <div class="list-item"><div class="li-main"><div class="li-t">${esc(l.name || l.title || '')}</div>
              <div class="li-s">${esc(l.kind || l.type || '')} · ${esc(String(l.date || '').slice(0, 10))}</div></div></div>`).join('')}</div>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">本系統保留嘅資料</div>
          <div class="card-sub">出席率、團費 —— 進度同獎章由 VSBADGE 擁有</div></div></div>
        <div style="padding:14px 16px" class="sm muted">
          兩邊用<b>會籍編號（YMIS）</b>對同一個人。喺「用戶」填好 YMIS，呢度嘅完成率就會自動對應到正確嘅團員。
          <div class="mt-8 xs faint">上次讀取：${esc(remote.at || '')}</div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ---------- 成員進度 ---------- */
function membersView() {
  if (!progressConfigured()) return needSetup();
  if (!remote) return empty('chart', '未讀取進度', '按右上「重新讀取」');
  const S = summarizeRemote(remote.data, { catalog, roster: members() });
  const k = memberSearch.trim().toLowerCase();
  const rows = S.members.filter(r => !k || (r.name + ' ' + r.ymis + ' ' + (r.localName || '')).toLowerCase().includes(k))
    .sort((a, b) => b.done - a.done);
  return `
  <div class="row-between wrap gap-12 mb-16 no-print">
    <div class="toolbar">
      <div class="search-wrap"><span class="ic">${icon('search', 15)}</span>
        <input class="input" id="pgSearch" placeholder="搵成員／YMIS" value="${esc(memberSearch)}"></div>
      <span class="chip">${rows.length} / ${S.memberCount} 位</span>
    </div>
    <div class="xs faint">按任何一位睇佢嘅項目明細${can('progress.tick') ? '，亦可以直接勾' : ''}</div>
  </div>
  <div class="card">
    <div class="scroll-x"><table class="table">
      <thead><tr><th>團員</th><th>YMIS</th><th>本系統名冊</th><th class="right">已勾項目</th><th style="width:180px">完成率</th><th>最近一次</th><th></th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td class="semibold">${esc(r.name)}</td>
        <td class="mono sm">${esc(r.ymis || '')}</td>
        <td class="sm">${r.matched ? `<span style="color:var(--ok)">✓ ${esc(r.localName)}</span>` : '<span class="xs" style="color:var(--warn)">未對應（請填 YMIS）</span>'}</td>
        <td class="right mono">${r.done}</td>
        <td>${r.rate === null ? '<span class="faint xs">—</span>' : `<div class="row gap-8"><span class="mono xs" style="min-width:34px">${r.rate}%</span><span class="grow">${progressBar(r.rate)}</span></div>`}</td>
        <td class="mono sm">${esc(r.lastDate || '—')}</td>
        <td class="right"><button class="btn btn-xs" data-member="${esc(r.ymis)}">明細</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${!rows.length ? empty('users', '冇成員', 'VSBADGE 嗰邊嘅「成員名單」係空？') : ''}
  </div>`;
}

/** 單一成員明細（彈窗） */
function openMemberDetail(ymis) {
  const data = remote?.data || {};
  const m = (data.members || []).find(x => String(x.ymis) === String(ymis)) || {};
  const local = matchLocalMember(members(), m);
  const d = catalog ? memberDetail(data, catalog, ymis) : { badges: [], done: 0, extras: [] };
  const body = `
    <div class="row-between wrap gap-8 mb-12">
      <div><div class="semibold" style="font-size:15px">${esc(m.name || ymis)}</div>
        <div class="xs faint">YMIS ${esc(ymis)}${local ? ` · 本系統：${esc(local.name)}` : ' · <span style="color:var(--warn)">名冊未對應</span>'}</div></div>
      <div class="right"><div class="xs faint">已勾項目</div><div class="semibold mono">${d.done}</div></div>
    </div>
    ${d.badges.map(b => `
      <div class="card mb-12">
        <div class="card-head"><div><div class="card-title">${esc(b.icon)} ${esc(b.name)}</div>
          <div class="card-sub">${b.done} / ${b.total} 項（${b.rate}%）</div></div></div>
        <div style="padding:0 0 6px">${b.items.map(it => `
          <div class="list-item">
            <span class="stat-ic" style="background:${it.done ? 'var(--ok-bg)' : 'var(--line-2)'};color:${it.done ? 'var(--ok)' : 'var(--ink-3)'}">${it.done ? icon('check', 14) : icon('x', 13)}</span>
            <div class="li-main"><div class="li-t">${esc(it.name)}</div>
              <div class="li-s">${esc(it.id)}${it.done && it.date ? ` · ${esc(it.date)}${it.confirmer ? ` · ${esc(it.confirmer)}` : ''}` : ''}</div></div>
          </div>`).join('')}</div>
      </div>`).join('') || '<div class="sm muted">未讀到項目定義（去「設定」填 VSBADGE 前端網址）</div>'}
    ${d.extras.length ? `<div class="card"><div class="card-head"><div class="card-title">額外紀錄</div></div>
      <div style="padding:8px 0">${d.extras.map(x => `<div class="list-item"><div class="li-main">
        <div class="li-t">${esc(x.id)}</div><div class="li-s">${esc(x.date || '')}</div></div></div>`).join('')}</div></div>` : ''}`;
  return modal({
    title: '進度明細', sub: profile().name || '', wide: true, body,
    actions: [
      { label: '關閉', class: 'btn', value: null },
      ...(can('progress.tick') ? [{ label: '去勾選', class: 'btn-primary', value: 'tick' }] : [])
    ]
  }).then(r => { if (r === 'tick') { selYmis = ymis; tab = 'tick'; refresh(); } });
}

/* ---------- 勾選 ---------- */
function tickView() {
  if (!progressConfigured()) return needSetup();
  if (!remote) return empty('check', '未讀取進度', '按右上「重新讀取」');
  const data = remote.data || {};
  const list = data.members || [];
  if (!list.length) return empty('users', 'VSBADGE 冇成員名單');
  if (!selYmis || !list.some(m => String(m.ymis) === String(selYmis))) selYmis = list[0].ymis;
  const progress = data.progress || {};
  const done = progress[selYmis] || {};
  const badgeIds = catalog ? [...new Set(Object.values(catalog).map(i => i.badgeId))] : [];
  const shown = catalog ? Object.values(catalog).filter(i => selBadge === 'all' || i.badgeId === selBadge) : [];
  const pendingCount = Object.keys(pending).length;

  return `
  <div class="note-box mb-16">${icon('check', 15)}<div>
    喺呢度勾選會**直接寫入旅團自己嘅 VSBADGE 後端**（同一個 Sheet、同一支 Script），
    同喺 VSBADGE 介面勾係一樣嘅效果；未撳「儲存」之前唔會送出。
  </div></div>

  <div class="row-between wrap gap-12 mb-16 no-print">
    <div class="toolbar">
      <select class="select" id="tickMember" style="width:auto">
        ${list.map(m => `<option value="${esc(m.ymis)}" ${String(m.ymis) === String(selYmis) ? 'selected' : ''}>${esc(m.name)}（${esc(m.ymis)}）· 已勾 ${Object.keys(progress[m.ymis] || {}).length}</option>`).join('')}
      </select>
      ${badgeIds.length ? chipbar([['all', '全部獎章']].concat(badgeIds.map(b => {
        const it = Object.values(catalog).find(x => x.badgeId === b) || {};
        return [b, `${it.badgeIcon || ''} ${it.badgeName || b}`];
      })), selBadge, 'data-badge') : ''}
      <div class="field" style="margin:0"><input class="input" id="tickDate" type="date" value="${esc(tickDate || todayISO())}" style="width:auto"></div>
    </div>
    <div class="row gap-8 wrap">
      <button class="btn" data-act="undo-ticks" ${pendingCount ? '' : 'disabled'}>${icon('refresh', 15)} 放棄改動</button>
      <button class="btn btn-primary" data-act="save-ticks" ${pendingCount ? '' : 'disabled'}>${icon('save', 15)} 儲存${pendingCount ? `（${pendingCount} 項）` : ''}</button>
    </div>
  </div>

  ${catalog ? `<div class="col gap-12">${groupByBadge(shown, done).map(g => `
    <div class="card">
      <div class="card-head"><div><div class="card-title">${esc(g.icon)} ${esc(g.name)}</div>
        <div class="card-sub">已勾 ${g.items.filter(it => eff(it.id, !!(done[it.id]))).length} / ${g.items.length}</div></div>
        <div class="row gap-6">
          <button class="btn btn-xs" data-bulk="${g.id}|1">全勾</button>
          <button class="btn btn-xs" data-bulk="${g.id}|0">全清</button>
        </div></div>
      <div style="padding:6px 0">${g.items.map(it => {
        const orig = !!(done[it.id]);
        const cur = eff(it.id, orig);
        const changed = pending[`${selYmis}|${it.id}`] !== undefined;
        return `<label class="list-item" style="cursor:pointer;${changed ? 'background:var(--brand-50)' : ''}">
          <input type="checkbox" data-tick="${esc(it.id)}" ${cur ? 'checked' : ''} style="width:18px;height:18px">
          <div class="li-main"><div class="li-t">${esc(it.name)}</div>
            <div class="li-s">${esc(it.id)}${orig && done[it.id]?.date ? ` · 原勾選日 ${esc(done[it.id].date)}` : ''}${changed ? ' · <b>未儲存</b>' : ''}</div></div>
        </label>`;
      }).join('')}</div>
    </div>`).join('')}</div>`
    : `<div class="note-box">${icon('alert', 15)}<div>未讀到考核項目定義 —— 去「設定」填 VSBADGE 前端網址（例：<code>https://vsbadge.vercel.app/</code>）就可以逐項勾。</div></div>`}`;
}

function eff(itemId, fallback = false) {
  const key = `${selYmis}|${itemId}`;
  return pending[key] === undefined ? fallback : pending[key];
}

function groupByBadge(items, done) {
  const groups = {};
  items.forEach(it => {
    groups[it.badgeId] = groups[it.badgeId] || { id: it.badgeId, icon: it.badgeIcon, name: it.badgeName, items: [] };
    groups[it.badgeId].items.push(it);
  });
  return Object.values(groups);
}

/* ---------- 設定 ---------- */
function settingsView() {
  const c = progressCfg();
  const R = readiness();
  const Rc = cfg();
  return `
  <div class="grid g-2-1">
    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div><div class="card-title">直接接駁（建議）</div>
          <div class="card-sub">留意：呢度係<b>旅團自己</b>嘅進度系統後端，唔係本系統嘅總表</div></div></div>
        <div style="padding:16px 18px">
          ${lastCheck ? `<div class="note-box ${lastCheck.ok ? '' : 'warn'} mb-12">${icon(lastCheck.ok ? 'check' : 'alert', 15)}
            <div>${esc(lastCheck.summary)}${lastCheck.ms ? ` <span class="faint xs">（${lastCheck.ms} ms · ${esc(lastCheck.at)}）</span>` : ''}</div></div>` : ''}
          <div class="grid g-2" style="gap:12px">
            <div class="field" style="grid-column:1/-1"><label class="label">VSBADGE 前端網址（讀考核項目用）</label>
              <input class="input" id="p-front" value="${esc(c.front)}" placeholder="例：https://vsbadge.vercel.app/">
              <div class="hint">用嚟讀 <code>data/items.json</code>（第 11 版綱要嘅考核項目定義）。伺服器會代讀，唔會有跨網域問題。</div></div>
            <div class="field" style="grid-column:1/-1"><label class="label">VSBADGE 後端 Web App /exec 網址 <span class="req">*</span></label>
              <input class="input" id="p-backend" value="${esc(c.backend)}" placeholder="https://script.google.com/macros/s/…/exec">
              <div class="hint">喺旅團自己嘅 Google Sheet → 擴充功能 → Apps Script → 部署 → 管理部署 → 複製「網頁應用程式」網址（要 <b>任何人可存取</b>）。</div></div>
            <div class="field" style="grid-column:1/-1"><label class="label">API Key <span class="req">*</span></label>
              <input class="input" id="p-key" type="text" value="${esc(c.apiKey)}" placeholder="喺 Apps Script 執行 showApiKey()">
              <div class="hint">喺 Apps Script 編輯器執行 <code>showApiKey()</code> 就會彈出。<b>唔會</b>經第三方傳送，只會由本系統嘅伺服器傳去你自己嘅 GAS。</div></div>
            <div class="field"><label class="label">旅團編號（u）</label>
              <input class="input" id="p-unit" value="${esc(c.unit)}" placeholder="0082"></div>
            <div class="field"><label class="label">顯示名稱</label>
              <input class="input" id="p-name" value="${esc(c.name)}"></div>
          </div>
          <div class="row gap-8 wrap mt-12">
            <button class="btn btn-primary" data-act="save-cfg">${icon('save', 16)} 儲存</button>
            <button class="btn" data-act="test">${icon('send', 16)} 測試連線</button>
            <button class="btn" data-act="reload">${icon('refresh', 16)} 重新讀取</button>
            <button class="btn btn-ghost" data-act="clear-cfg">${icon('trash', 15)} 清除設定</button>
          </div>
          <div class="hint mt-8">API Key 存喺<b>旅團自己嘅資料</b>（會跟你嘅 JSON 備份走）。如果唔想俾人睇到，可以改用 Vercel 環境變數
            <code>TROOP_${esc((c.unit || '0082'))}_PROGRESSBACKEND</code> / <code>…_PROGRESSAPIKEY</code>，設定咗就以伺服器端為準。</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">外連模式（舊做法，可以唔用）</div>
          <div class="card-sub">開新分頁／內嵌去 VSBADGE 介面（舊做法；對方要登記本系統網址先入得，否則會出現 referer_mismatch）</div></div></div>
        <div style="padding:16px 18px" class="sm muted">
          <div class="row gap-8 wrap mb-12">
            <button class="btn btn-sm" data-act="open-external" ${Rc.url ? '' : 'disabled'}>${icon('external', 15)} 開啟 VSBADGE 介面</button>
            <button class="btn btn-sm" data-act="copy-external" ${Rc.url ? '' : 'disabled'}>${icon('copy', 15)} 複製連結</button>
            <button class="btn btn-sm" data-act="qr-external" ${Rc.url ? '' : 'disabled'}>${icon('qr', 15)} QR Code</button>
            <button class="btn btn-sm" data-act="check-external" ${Rc.url ? '' : 'disabled'}>${icon('send', 15)} 檢查連線</button>
            <button class="btn btn-sm" data-act="legacy-config">${icon('settings', 15)} 進階設定</button>
          </div>
          <div class="xs faint" style="word-break:break-all">${esc(R.url || '（未設定前端網址）')}</div>
        </div>
      </div>
    </div>

    <div class="col gap-16">
      <div class="card">
        <div class="card-head"><div class="card-title">連線狀態</div></div>
        <div style="padding:14px 16px">
          ${kv([
            ['後端網址', c.backend ? '<span style="color:var(--ok)">已填</span>' : '<span style="color:var(--warn)">未填</span>'],
            ['API Key', c.apiKey ? '<span style="color:var(--ok)">已填</span>' : '<span style="color:var(--warn)">未填</span>'],
            ['前端網址（項目定義）', c.front ? '<span style="color:var(--ok)">已填</span>' : '<span style="color:var(--warn)">未填</span>'],
            ['上次讀取', remote ? esc(remote.at) : '—'],
            ['讀到嘅成員', remote ? String((remote.data.members || []).length) : '—'],
            ['項目定義', catalog ? `${Object.keys(catalog).length} 項` : '未有']
          ])}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">跨系統對人</div></div>
        <div style="padding:14px 16px" class="sm muted">
          用<b>會籍編號（YMIS）</b>對同一個人。現時對得上：<b>${R.ident.matched} / ${R.ident.total}</b>（${R.ident.percent}%）。
          <div class="mt-8"><button class="btn btn-sm btn-block" data-go="#/members">${icon('users', 15)} 去用戶名冊填 YMIS</button></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">權限</div></div>
        <div style="padding:14px 16px" class="sm muted">
          睇進度：全部已登入用戶。勾進度／改設定：${can('progress.tick') ? '<b style="color:var(--ok)">你而家可以</b>' : '<span style="color:var(--warn)">你冇權限（要領袖或執委）</span>'}。
        </div>
      </div>
    </div>
  </div>`;
}

/* ============================================================
   頁面
   ============================================================ */
export function render(params) {
  if (params?.id && ['overview', 'members', 'tick', 'settings'].includes(params.id)) tab = params.id;
  else tab = 'overview';   // 由側邊欄入返嚟時，返去總覽（唔好留住上次嘅分頁）
  const configured = progressConfigured();

  return `
  ${pageHead({
    title: '進度紀錄',
    sub: configured
      ? `${progressCfg().name} · 直接接駁（唔使外連）${remote ? ` · 上次讀取 ${remote.at}` : ''}`
      : '未接駁 —— 去「設定」填入旅團自己嘅 VSBADGE 後端網址同 API Key',
    actions: `
      <button class="btn btn-sm" data-act="reload" ${configured ? '' : 'disabled'}>${icon('refresh', 15)} ${loading ? '讀取中…' : '重新讀取'}</button>
      <button class="btn btn-sm btn-primary" data-act="settings">${icon('settings', 15)} 設定</button>`
  })}

  ${tabs([
    ['overview', '總覽'],
    ...(configured ? [
      ['members', `成員進度${remote ? `（${(remote.data.members || []).length}）` : ''}`],
      ['tick', can('progress.tick') ? '勾選進度' : '勾選進度（無權限）', Object.keys(pending).length || undefined]
    ] : []),
    ['settings', configured ? '設定' : '設定（未接駁）']
  ], tab)}

  ${tab === 'settings' ? settingsView()
    : !configured ? needSetup()
    : tab === 'members' ? membersView()
    : tab === 'tick' ? tickView()
    : overviewView()}`;
}

export function mount(root, params) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  root.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    go('#/progress/' + tab);
    refresh();
  }));

  root.querySelectorAll('[data-act="settings"]').forEach(b => b.addEventListener('click', () => {
    tab = 'settings'; go('#/progress/settings'); refresh();
  }));
  root.querySelectorAll('[data-act="reload"]').forEach(b => b.addEventListener('click', () => fetchAll()));

  /* 成員明細 */
  root.querySelectorAll('[data-member]').forEach(b => b.addEventListener('click', () => openMemberDetail(b.dataset.member)));

  /* 勾選 */
  const tickMember = root.querySelector('#tickMember');
  if (tickMember) tickMember.addEventListener('change', () => { selYmis = tickMember.value; refresh(); });
  const tickDateEl = root.querySelector('#tickDate');
  if (tickDateEl) tickDateEl.addEventListener('change', () => { tickDate = tickDateEl.value; });
  root.querySelectorAll('[data-badge]').forEach(b => b.addEventListener('click', () => { selBadge = b.dataset.badge; refresh(); }));
  root.querySelectorAll('[data-tick]').forEach(cb => cb.addEventListener('change', () => {
    const itemId = cb.dataset.tick;
    const key = `${selYmis}|${itemId}`;
    const orig = !!((remote?.data?.progress || {})[selYmis] || {})[itemId];
    if (cb.checked === orig) delete pending[key];
    else pending[key] = cb.checked;
    refresh();
  }));
  root.querySelectorAll('[data-bulk]').forEach(b => b.addEventListener('click', () => {
    const [badgeId, on] = b.dataset.bulk.split('|');
    const data = remote?.data || {};
    const done = (data.progress || {})[selYmis] || {};
    Object.values(catalog || {}).filter(i => i.badgeId === badgeId).forEach(i => {
      const key = `${selYmis}|${i.id}`;
      const val = on === '1';
      if (val === !!done[i.id]) delete pending[key]; else pending[key] = val;
    });
    refresh();
  }));
  root.querySelector('[data-act="undo-ticks"]')?.addEventListener('click', () => { pending = {}; toast('已放棄未儲存嘅改動', 'ok'); refresh(); });
  root.querySelector('[data-act="save-ticks"]')?.addEventListener('click', async () => {
    if (!can('progress.tick')) { toast('你冇勾選權限', 'err'); return; }
    const changes = Object.entries(pending).map(([key, val]) => {
      const [ymis, itemId] = key.split('|');
      return { ymis, itemId, date: tickDate || todayISO(), uncomplete: !val, note: '' };
    });
    if (!changes.length) return;
    const onCount = changes.filter(c => !c.uncomplete).length;
    const offCount = changes.length - onCount;
    const r = await saveTicks(changes, current()?.name || '執委管理系統');
    if (!r.ok) { toast(r.error || '儲存失敗', 'err'); return; }
    const processed = r.data?.processed ?? changes.length;
    toast(`已寫入 VSBADGE：新增 ${onCount} 項、取消 ${offCount} 項（後端處理 ${processed} 項）`, 'ok');
    pending = {};
    await fetchAll({ silent: true });
  });

  /* 設定 */
  root.querySelector('[data-act="save-cfg"]')?.addEventListener('click', () => {
    if (!can('progress.tick')) { toast('只有領袖／執委可以改設定', 'err'); return; }
    const v = k => root.querySelector(k)?.value.trim() || '';
    setProgressCfg({
      front: v('#p-front'), backend: v('#p-backend'), apiKey: v('#p-key'),
      unit: v('#p-unit') || load().unitCode, name: v('#p-name') || '深資童軍進度及行政平台 (VSBADGE)'
    });
    toast('已儲存接駁設定', 'ok');
    tab = 'overview';
    fetchAll();
  });
  root.querySelector('[data-act="test"]')?.addEventListener('click', async () => {
    const v = k => root.querySelector(k)?.value.trim() || '';
    setProgressCfg({
      front: v('#p-front'), backend: v('#p-backend'), apiKey: v('#p-key'),
      unit: v('#p-unit') || load().unitCode, name: v('#p-name') || '深資童軍進度及行政平台 (VSBADGE)'
    });
    lastCheck = { ok: false, summary: '測試中…', ms: 0, at: '' };
    refresh();
    lastCheck = await testConnection();
    if (lastCheck.ok) {
      remote = { data: lastCheck.data || {}, at: new Date().toLocaleString('zh-HK', { hour12: false }) };
      const it = await loadItems();
      if (it.ok) catalog = flattenItems(it.data);
      toast('連線成功 ✓', 'ok');
    } else {
      toast(lastCheck.error || '連線失敗', 'err');
    }
    refresh();
  });
  root.querySelector('[data-act="clear-cfg"]')?.addEventListener('click', async () => {
    if (!(await modal({
      title: '清除接駁設定', danger: true,
      body: '<p class="sm">會清空後端網址同 API Key（名冊同其他資料唔會受影響）。</p>',
      actions: [{ label: '取消', class: 'btn', value: false }, { label: '清除', class: 'btn-accent', value: true }]
    }))) return;
    setProgressCfg({ backend: '', apiKey: '', front: '' });
    remote = null; catalog = null; errMsg = '';
    toast('已清除', 'ok'); refresh();
  });

  /* 外連（舊做法） */
  const Rc = cfg();
  const launch = buildUrl(Rc);
  root.querySelector('[data-act="open-external"]')?.addEventListener('click', () => { if (launch) window.open(launch, '_blank', 'noopener'); });
  root.querySelector('[data-act="copy-external"]')?.addEventListener('click', async () => {
    if (await copyText(launch)) toast('已複製連結', 'ok');
  });
  root.querySelector('[data-act="qr-external"]')?.addEventListener('click', async () => {
    await modal({ title: '進度系統 QR Code', body: `<div class="center"><div class="qr-box" style="width:260px">${qrSvg(launch, 6, 2)}</div>
      <div class="sm muted mt-12" style="word-break:break-all">${esc(launch)}</div></div>`, actions: [{ label: '關閉', class: 'btn-primary', value: null }] });
  });
  root.querySelector('[data-act="check-external"]')?.addEventListener('click', async () => {
    const out = await checkConnection(launch || Rc.url);
    const db = load();
    db.settings = { ...(db.settings || {}), progressCheck: { ...out, url: launch || Rc.url } };
    commit();
    toast(out.ok ? `可達（${out.ms} ms）` : `連唔通：${out.msg}`, out.ok ? 'ok' : 'err');
  });
  root.querySelector('[data-act="legacy-config"]')?.addEventListener('click', legacyConfigModal);

  /* 第一次入嚟：自動讀一次 */
  if (progressConfigured() && !remote && !loading && !errMsg) setTimeout(() => fetchAll({ silent: true }), 30);
}

/* 舊版進階設定（外連模式） */
async function legacyConfigModal() {
  const cc = cfg();
  const r = await modal({
    title: '外連模式設定', wide: true,
    body: `<div class="grid g-2" style="gap:12px">
        <div class="field" style="grid-column:1/-1"><label class="label">VSBADGE <b>前端</b>網址</label>
          <input class="input" id="q-url" value="${esc(cc.url)}" placeholder="https://vsbadge.vercel.app/">
          <div class="hint">要填網頁網址，<b>唔好</b>填 Apps Script <code>/exec</code>。</div></div>
        <div class="field"><label class="label">Portal 角色</label>
          <select class="select" id="q-role">
            ${PROGRESS_ROLES.map(x => `<option value="${x.v}" ${(cc.portal?.role || 'exec_committee') === x.v ? 'selected' : ''}>${esc(x.l)}</option>`).join('')}
          </select></div>
        <div class="field"><label class="label">旅團編號參數（u）</label>
          <input class="input" id="q-unit" value="${esc(cc.portal?.unitParam || load().unitCode)}"></div>
      </div>
      <div class="hint mt-12">呢個模式會開 VSBADGE 自己嘅介面；對方要將本系統嘅網址登記做入口（portalOrigin），
        否則會顯示 <code>referer_mismatch</code>。所以建議用上面「直接接駁」。</div>`,
    actions: [{ label: '取消', class: 'btn', value: null }, { label: '儲存', class: 'btn-primary', onClick: el => ({
      url: el.querySelector('#q-url').value.trim(),
      portal: { ...(cc.portal || {}), role: el.querySelector('#q-role').value, unitParam: el.querySelector('#q-unit').value.trim() },
      mode: 'portal'
    }) }]
  });
  if (!r) return;
  const db = load();
  db.profile = { ...(db.profile || db.unit || {}), progress: { ...((db.profile || db.unit)?.progress || {}), ...r } };
  commit();
  toast('已更新外連設定', 'ok');
  refresh();
}

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
