/* 團員入口：行事曆、RSVP、試卷、其他公開頁 */
import { loadRegistry, defaultUnitCode } from './lib/units.js';
import { init, load, update, commit } from './lib/store.js';
import { memberLinks, profile, publicEvents, RSVP, quizzes, activeMembers } from './lib/model.js';
import { esc, icon, toast, todayISO } from './lib/util.js';

const app = document.getElementById('app');
const ME_KEY = 'v82.hub.me';

function meId() { try { return localStorage.getItem(ME_KEY) || ''; } catch { return ''; } }
function setMe(id) { try { localStorage.setItem(ME_KEY, id); } catch { /* */ } }

async function boot() {
  const u = new URLSearchParams(location.search);
  const code = (u.get('u') || '').trim() || defaultUnitCode();
  await loadRegistry();
  await init({ mode: 'real', unit: code });
  try {
    const remoteApi = await import('./lib/remote.js');
    const store = await import('./lib/store.js');
    if (remoteApi.remoteConfigured?.()) {
      store.setSaveHook(() => remoteApi.scheduleSave());
      remoteApi.arm?.();
    }
  } catch { /* 公開頁冇後端都得 */ }
  paint();
}

function paint() {
  const p = profile();
  const hash = location.hash.replace(/^#\/?/, '') || 'cal';
  const [sec, id] = hash.split('/');
  app.innerHTML = `
  <div class="hub-top">
    <div class="hub-wrap">
      <div class="xs" style="opacity:.8">團員入口 · 免登入</div>
      <div style="font-size:22px;font-weight:800;margin-top:4px">${esc(p.name || '深資童軍團')}</div>
    </div>
  </div>
  <div class="hub-wrap">
    <div class="seg mb-16" style="width:100%">
      ${[['cal', '行事曆'], ['quiz', '試卷'], ['more', '其他']].map(([k, l]) =>
        `<button type="button" data-hub="${k}" aria-selected="${sec === k || (k === 'cal' && !['quiz','more'].includes(sec))}">${l}</button>`).join('')}
    </div>
    ${whoBar()}
    ${sec === 'quiz' ? (id ? quizFill(id) : quizList()) : sec === 'more' ? moreList() : (id ? eventDetail(id) : calList())}
  </div>`;
  app.querySelectorAll('[data-hub]').forEach(b => b.addEventListener('click', () => { location.hash = '#/' + b.dataset.hub; paint(); }));
  app.querySelector('#hubMe')?.addEventListener('change', e => { setMe(e.target.value); paint(); });
  app.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.open; paint(); }));
  app.querySelectorAll('[data-rsvp]').forEach(b => b.addEventListener('click', () => rsvp(b.dataset.eid, b.dataset.rsvp)));
  app.querySelector('[data-quiz-submit]')?.addEventListener('click', () => submitQuiz(id));
}

function whoBar() {
  const roster = activeMembers();
  const cur = meId();
  return `<div class="card card-pad mb-16">
    <div class="field"><label class="label">我係邊個（回覆／交卷用）</label>
      <select class="select" id="hubMe">
        <option value="">— 請揀名冊上嘅名 —</option>
        ${roster.map(m => `<option value="${esc(m.id)}" ${m.id === cur ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
      </select>
      <div class="hint">揀一次之後會記住喺呢部手機。</div>
    </div></div>`;
}

function calList() {
  const list = publicEvents();
  if (!list.length) return '<div class="card card-pad muted">暫時未有團員可見嘅活動。</div>';
  const mid = meId();
  return list.map(e => {
    const mine = mid ? (e.rsvp || {})[mid] : null;
    const st = mine?.status || mine || '';
    return `<button class="hub-card" type="button" data-open="#/cal/${e.id}" style="width:100%;text-align:left">
      <span class="stat-ic">${icon('calendar', 18)}</span>
      <div class="grow"><div class="semibold">${esc(e.title)}</div>
        <div class="xs muted mt-4">${esc(e.date)} ${esc(e.time || '')} · ${esc(e.venue || '')}</div>
        ${st ? `<div class="xs mt-4"><span class="badge ${RSVP[st]?.cls || ''}">已回覆：${esc(RSVP[st]?.label || st)}</span></div>` : ''}</div>
    </button>`;
  }).join('');
}

function eventDetail(id) {
  const e = (load().events || []).find(x => x.id === id);
  if (!e || e.visibility === 'exco') return '<div class="card card-pad">搵唔到呢個活動（可能只限執委）。</div>';
  const mid = meId();
  const mine = mid ? (e.rsvp || {})[mid] : null;
  const st = mine?.status || mine || '';
  return `<button class="btn btn-ghost btn-sm mb-12" type="button" data-open="#/cal">${icon('chevronL', 14)} 返回</button>
    <div class="card card-pad">
      <div class="page-title" style="font-size:20px">${esc(e.title)}</div>
      <div class="sm muted mt-4">${esc(e.date)} ${esc(e.time || '')} · ${esc(e.venue || '')}</div>
      <div class="sm mt-12" style="white-space:pre-wrap">${esc(e.detail || '未有詳細內容')}</div>
      ${e.fee ? `<div class="xs mt-8">費用：${esc(e.fee)}</div>` : ''}
      ${e.deadline ? `<div class="xs">回覆截止：${esc(e.deadline)}</div>` : ''}
      <div class="semibold sm mt-16">我會…</div>
      <div class="row wrap gap-8 mt-8">
        ${Object.entries(RSVP).map(([k, v]) =>
          `<button class="btn btn-sm ${st === k ? 'btn-primary' : ''}" type="button" data-eid="${e.id}" data-rsvp="${k}">${v.label}</button>`).join('')}
      </div>
      ${!mid ? '<div class="hint mt-8">請先喺上面揀你嘅名。</div>' : ''}
    </div>`;
}

function rsvp(eid, status) {
  const mid = meId();
  if (!mid) { toast('請先揀你嘅名', 'err'); return; }
  const e = (load().events || []).find(x => x.id === eid);
  if (!e) return;
  const map = { ...(e.rsvp || {}) };
  map[mid] = { status, at: todayISO() };
  update('events', eid, { rsvp: map });
  toast('已回覆：' + RSVP[status].label, 'ok');
  paint();
}

function quizList() {
  const list = quizzes().filter(q => q.status !== 'closed');
  if (!list.length) return '<div class="card card-pad muted">暫時未有開放試卷。</div>';
  return list.map(q => `<button class="hub-card" type="button" data-open="#/quiz/${q.id}" style="width:100%;text-align:left">
    <span class="stat-ic">${icon('note', 18)}</span>
    <div class="grow"><div class="semibold">${esc(q.title)}</div>
      <div class="xs muted mt-4">${(q.questions || []).length} 題 · ${esc(q.note || '')}</div></div>
  </button>`).join('');
}

function quizFill(id) {
  const q = quizzes().find(x => x.id === id);
  if (!q) return '<div class="card card-pad">搵唔到試卷</div>';
  const mid = meId();
  const prev = mid ? (q.responses || {})[mid] : null;
  return `<button class="btn btn-ghost btn-sm mb-12" type="button" data-open="#/quiz">${icon('chevronL', 14)} 返回</button>
    <div class="card card-pad">
      <div class="page-title" style="font-size:20px">${esc(q.title)}</div>
      <div class="sm muted mt-4">${esc(q.note || '')}</div>
      ${(q.questions || []).map((item, i) => `<div class="field mt-16">
        <label class="label">${i + 1}. ${esc(item.prompt)} ${item.required ? '<span class="req">*</span>' : ''}</label>
        ${item.type === 'para' ? `<textarea class="textarea" data-ans="${esc(item.id)}" rows="4">${esc(prev?.answers?.[item.id] || '')}</textarea>`
        : item.type === 'single' ? (item.options || []).map(o =>
          `<label class="check"><input type="radio" name="q_${esc(item.id)}" data-ans="${esc(item.id)}" value="${esc(o)}" ${(prev?.answers?.[item.id] === o) ? 'checked' : ''}> ${esc(o)}</label>`).join('')
        : item.type === 'multi' ? (item.options || []).map(o => {
          const arr = prev?.answers?.[item.id] || [];
          return `<label class="check"><input type="checkbox" data-ans="${esc(item.id)}" value="${esc(o)}" ${arr.includes?.(o) ? 'checked' : ''}> ${esc(o)}</label>`;
        }).join('')
        : `<input class="input" data-ans="${esc(item.id)}" value="${esc(prev?.answers?.[item.id] || '')}">`}
      </div>`).join('')}
      <button class="btn btn-primary btn-block mt-16" type="button" data-quiz-submit>交卷</button>
    </div>`;
}

function submitQuiz(id) {
  const mid = meId();
  if (!mid) { toast('請先揀你嘅名', 'err'); return; }
  const q = quizzes().find(x => x.id === id);
  if (!q) return;
  const answers = {};
  (q.questions || []).forEach(item => {
    if (item.type === 'multi') {
      answers[item.id] = [...app.querySelectorAll(`[data-ans="${item.id}"]:checked`)].map(el => el.value);
    } else if (item.type === 'single') {
      answers[item.id] = app.querySelector(`[data-ans="${item.id}"]:checked`)?.value || '';
    } else {
      answers[item.id] = app.querySelector(`[data-ans="${item.id}"]`)?.value.trim() || '';
    }
    if (item.required && (!answers[item.id] || (Array.isArray(answers[item.id]) && !answers[item.id].length))) {
      toast('請填：' + item.prompt, 'err');
      answers._bad = true;
    }
  });
  if (answers._bad) return;
  delete answers._bad;
  const m = activeMembers().find(x => x.id === mid);
  const responses = { ...(q.responses || {}) };
  responses[mid] = { name: m?.name || '', at: todayISO(), answers };
  update('quizzes', id, { responses });
  toast('已交卷', 'ok');
  location.hash = '#/quiz';
  paint();
}

function moreList() {
  const links = memberLinks().filter(l => l.id !== 'hub');
  return links.map(l => `<a class="hub-card" href="${esc(l.url)}">
    <span class="stat-ic">${icon(l.icon, 18)}</span>
    <div class="grow"><div class="semibold">${esc(l.label)}</div>
      <div class="xs muted mt-4">${esc(l.desc)}</div></div>
  </a>`).join('') || '<p class="muted">暫時未有其他連結</p>';
}

window.addEventListener('hashchange', () => { try { paint(); } catch { /* */ } });
boot().catch(e => {
  app.innerHTML = `<div style="padding:40px" class="muted">載入失敗：${esc(e.message || e)}</div>`;
});
