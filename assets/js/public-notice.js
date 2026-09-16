/* ============================================================
   public-notice.js — 通告公開頁（notice.html）
   免登入：睇通告內容 → 填報名表 → 送出去
   送出目的地（依序）：
     1. 旅團設定嘅 Apps Script 網址（跨裝置，直接寫入總表）
     2. 冇設定 → 存喺本機（同一部裝置），並提供「複製內容去 WhatsApp」
   ============================================================ */

import { esc, icon, toast, uid } from './lib/util.js';
import { todayISO } from './lib/dates.js';

const q = new URLSearchParams(location.search);
const app = document.getElementById('app');
const unitCode = q.get('u') || '0082';
const noticeId = q.get('n') || '';
let notice = null, meta = {}, sent = false;

const LOCAL_KEY = `venture82.pub.signup.${unitCode}.${noticeId}`;

async function loadJson(url) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + '_=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function boot() {
  try {
    let registry = null;
    try { registry = await loadJson('data/units.json'); } catch (e) { /* ignore */ }
    if (registry?.units) {
      if (!q.get('u') && registry.defaultUnit) unitCode = registry.defaultUnit;
      meta = registry.units[unitCode] || {};
    }
    const src = q.get('src') || (meta.dataPath ? `${meta.dataPath}notices.json` : `data/units/${unitCode}/notices.json`);
    const data = await loadJson(src);
    const list = data.notices || [];
    notice = noticeId
      ? list.find(x => String(x.id) === String(noticeId)) || list.find(x => String(x.publicId) === String(noticeId))
      : list.filter(x => x.status === 'published')[0];
    if (!notice) throw new Error('搵唔到通告');
    if (!meta.name && data.unitName) meta.name = data.unitName;
    document.title = `${notice.title?.zh || '通告'} · ${meta.name || unitCode}`;
    render();
  } catch (e) {
    app.innerHTML = `<div class="pub-notice"><div class="card paper" style="padding:26px">
      <h1 style="font-size:20px">暫時讀唔到通告</h1>
      <p class="sm muted mt-8">可能係連結過期、通告已下架，或者網址唔完整。技術訊息：<code>${esc(e.message)}</code></p>
      <p class="xs faint mt-12">通告編號：<code>${esc(noticeId || '(未指定)')}</code></p>
    </div></div>`;
  }
}

/* ---------- 已提交嘅紀錄（本機 / 伺服器都記住） ---------- */
function localSignups() {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch (e) { return []; }
}
function saveLocal(row) {
  const list = localSignups();
  list.push(row);
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

/* ---------- 渲染 ---------- */
function render() {
  const n = notice;
  const closed = n.deadline && n.deadline < todayISO();
  const full = n.quota ? localSignups().length >= n.quota : false;
  const inner = q.get('embed') === '1';

  app.innerHTML = `
  ${inner ? '' : `<div class="pub-top no-print">
    <div class="logo">${esc((meta.short || unitCode).slice(0, 3))}</div>
    <div class="grow"><div style="font-weight:800">${esc(meta.name || unitCode)}</div>
      <div class="xs" style="color:#EBC6CE">${esc(meta.sponsor || '')}</div></div>
    ${n.needSignup ? '<span class="badge b-grey">可報名</span>' : ''}
  </div>`}

  <div class="pub-notice">
    <article class="card paper" id="notice-paper">
      <div class="row gap-8 wrap mb-12">
        <span class="notice-chip">${esc(typeLabel(n.type))}</span>
        ${n.eventDate ? `<span class="badge b-grey">${esc(n.eventDate)}</span>` : ''}
        ${n.deadline ? `<span class="badge ${closed ? 'b-danger' : 'b-warn'}">${closed ? '已截止' : '截止'} ${esc(n.deadline)}</span>` : ''}
        ${n.venue ? `<span class="badge b-grey">${esc(n.venue)}</span>` : ''}
      </div>
      <h1 class="doc-h1" style="font-size:24px">${esc(n.title?.zh || '通告')}</h1>
      ${n.title?.en ? `<div class="sm muted" style="margin-top:-6px">${esc(n.title.en)}</div>` : ''}

      ${detailRows(n)}

      <div class="notice-body mt-16">${esc(n.body?.zh || '')}</div>
      ${n.body?.en ? `<div class="notice-body muted mt-12" style="font-size:13.5px">${esc(n.body.en)}</div>` : ''}

      ${(n.attachments || []).length ? `<div class="mt-16"><div class="sm semibold mb-8">附件 / 相片</div>
        <div class="photo-grid">${n.attachments.map((p, i) => `
          <button type="button" class="photo-thumb" data-img="${i}"><img src="${p.dataUrl}" alt="${esc(p.name || '')}" loading="lazy"></button>`).join('')}</div>
      </div>` : ''}

      <div class="xs faint mt-16">發出：${esc(n.publishAt || n.createdAt || '')} · ${esc(meta.name || '')}</div>
    </article>

    ${n.needSignup ? signupCard(n, { closed, full, inner }) : ''}

    <div class="center xs faint mt-16 no-print">本頁免登入公開閱讀 · 由 82venture 執委會管理平台發出</div>
  </div>`;

  // 相片檢視
  app.querySelectorAll('[data-img]').forEach(b => b.addEventListener('click', async () => {
    const { photoViewer } = await import('./lib/util.js');
    photoViewer(n.attachments || [], Number(b.dataset.img));
  }));

  if (n.needSignup) bindSignup(n, { closed, full });
}

function detailRows(n) {
  const rows = [
    ['活動日期', n.eventDate], ['地點', n.venue], ['費用', n.fee],
    ['名額', n.quota ? `${n.quota} 人` : ''], ['報名截止', n.deadline]
  ].filter(([, v]) => v);
  if (!rows.length) return '';
  return `<div class="mt-12" style="display:grid;gap:6px">${rows.map(([k, v]) =>
    `<div class="row gap-8"><span class="xs faint" style="width:76px">${esc(k)}</span><span class="semibold sm">${esc(String(v))}</span></div>`).join('')}</div>`;
}

function signupCard(n, { closed, full, inner }) {
  if (sent) {
    return `<div class="card" style="padding:22px;text-align:center">
      <div style="color:var(--ok);margin-bottom:8px">${icon('check', 34)}</div>
      <div class="semibold">已收到你嘅報名，多謝！</div>
      <div class="sm muted mt-6">領袖會再同你確認。如果想更改，請直接聯絡團領袖。</div>
    </div>`;
  }
  if (closed) return `<div class="card" style="padding:18px"><div class="sm">報名已於 ${esc(n.deadline)} 截止。如有需要請直接聯絡團領袖。</div></div>`;
  if (full) return `<div class="card" style="padding:18px"><div class="sm">名額已滿（${n.quota} 人）。可以聯絡領袖安排後補。</div></div>`;

  return `<form class="card" id="signup-form" style="padding:18px 18px 16px" novalidate>
    <div class="card-title mb-12">${icon('send', 16)} 報名</div>
    ${(n.fields || []).map(f => `
      <div class="pub-field">
        <label>${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>
        ${fieldHtml(f)}
        <div class="field-err" data-err="${esc(f.key)}" style="display:none"></div>
      </div>`).join('')}
    <div id="signup-err" class="err" style="margin:6px 0 10px"></div>
    <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('check', 17)} 提交報名</button>
    <div class="hint mt-8" id="signup-hint">${submitHint()}</div>
  </form>`;
}

function submitHint() {
  const url = notice?.submitUrl || meta?.notice?.submitUrl || '';
  return url
    ? '提交後會直接記錄到旅團嘅總表（報名分頁）。'
    : '提交後會記錄喺你呢部裝置，領袖會同你確認（旅團未設定線上總表）。';
}

function fieldHtml(f) {
  const req = f.required ? 'required' : '';
  if (f.type === 'textarea') return `<textarea class="textarea" data-fk="${esc(f.key)}" rows="3" ${req}></textarea>`;
  if (f.type === 'select') return `<select class="select" data-fk="${esc(f.key)}" ${req}>
    <option value="">— 請選擇 —</option>${(f.options || []).map(o => `<option>${esc(o)}</option>`).join('')}</select>`;
  if (f.type === 'radio') return `<div style="display:grid;gap:8px">${(f.options || []).map((o, i) => `
    <label class="check"><input type="radio" name="${esc(f.key)}" data-fk="${esc(f.key)}" value="${esc(o)}" ${req}> ${esc(o)}</label>`).join('')}</div>`;
  if (f.type === 'check') return `<div style="display:grid;gap:8px">${(f.options || []).map(o => `
    <label class="check"><input type="checkbox" data-fk="${esc(f.key)}" value="${esc(o)}"> ${esc(o)}</label>`).join('')}</div>`;
  const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'tel' ? 'tel' : f.type === 'email' ? 'email' : 'text';
  const extra = f.type === 'tel' ? 'inputmode="tel"' : f.type === 'number' ? 'inputmode="decimal" step="0.01"' : '';
  return `<input class="input" type="${type}" data-fk="${esc(f.key)}" ${req} ${extra}>`;
}

function collect(form, fields) {
  const values = {};
  const missing = [];
  (fields || []).forEach(f => {
    const els = form.querySelectorAll(`[data-fk="${f.key}"]`);
    if (!els.length) return;
    if (f.type === 'check') values[f.key] = Array.from(els).filter(e => e.checked).map(e => e.value);
    else if (f.type === 'radio') { const c = Array.from(els).find(e => e.checked); values[f.key] = c ? c.value : ''; }
    else values[f.key] = els[0].value.trim();
    const v = values[f.key];
    if (f.required && (v === '' || (Array.isArray(v) && !v.length))) missing.push(f);
    else if (f.type === 'email' && v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) missing.push({ ...f, _bad: '電郵格式唔正確' });
    else if (f.type === 'tel' && v && v.replace(/[^0-9]/g, '').length < 8) missing.push({ ...f, _bad: '電話號碼似乎太短' });
  });
  return { values, missing };
}

function bindSignup(n, { closed, full }) {
  const form = document.getElementById('signup-form');
  if (!form) return;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const { values, missing } = collect(form, n.fields || []);
    form.querySelectorAll('[data-err]').forEach(el => { el.style.display = 'none'; el.textContent = ''; });
    form.querySelectorAll('[data-fk]').forEach(el => el.removeAttribute('aria-invalid'));
    const err = document.getElementById('signup-err');
    err.textContent = ''; err.style.display = 'none';
    if (missing.length) {
      missing.forEach(f => {
        const box = form.querySelector(`[data-err="${f.key}"]`);
        if (box) { box.textContent = f._bad || '請填寫此欄'; box.style.display = 'block'; }
        form.querySelectorAll(`[data-fk="${f.key}"]`).forEach(el => el.setAttribute('aria-invalid', 'true'));
      });
      err.textContent = '仲有欄位未填好，請檢查上面。'; err.style.display = 'block';
      return;
    }

    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '提交中…';
    const row = {
      id: uid('sg'), noticeId: n.id, noticeTitle: n.title?.zh || '',
      at: new Date().toISOString(), values, unit: unitCode
    };

    const endpoint = n.submitUrl || meta.notice?.submitUrl || registry?.backend?.gasUrl || '';
    let delivered = false, serverMsg = '';
    if (endpoint) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // 避免 CORS preflight
          body: JSON.stringify({ action: 'noticeSignup', unit: unitCode, source: '82venture', payload: row })
        });
        const txt = await res.text();
        delivered = res.ok;
        serverMsg = txt.slice(0, 120);
      } catch (err2) {
        delivered = false; serverMsg = err2.message;
      }
    }
    if (!delivered) {
      const list = localSignups();
      list.push(row);
      try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch (err3) { /* ignore */ }
    } else {
      const list = localSignups();
      list.push(row);
      try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); } catch (err3) { /* ignore */ }
    }

    sent = true;
    render();
    if (!delivered && endpoint) toast('未能連線到總表，已暫存喺你呢部裝置', 'warn');
  });
}

function typeLabel(t) {
  return ({ event: '活動通告', meeting: '會議通告', recruit: '招募 / 報名', notice: '一般通告', agm: '團員大會 / AGM' })[t] || '通告';
}

boot();
