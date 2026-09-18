/* 團員入口：掃一次見到全部公開功能。名可選填，存瀏覽器。 */
import { loadRegistry, defaultUnitCode } from './lib/units.js';
import { init, load, update } from './lib/store.js';
import { memberLinks, profile, publicEvents, RSVP, quizzes, activeMembers, publicPageUrl, troopPublicLinks, identityOf, IDENTITIES } from './lib/model.js';
import { loadMe, saveMe, identityForSubmit } from './lib/member-me.js';
import { loadHubAuth, saveHubAuth, clearHubAuth } from './lib/hub-session.js';
import { loginMember, changeMemberOwnPassword, TEMP_PASSWORD } from './lib/auth.js';
import { progressConfigured, loadRemote, loadItems, flattenItems, memberDetail } from './lib/progress.js';
import { esc, icon, toast, todayISO, modal } from './lib/util.js';

const app = document.getElementById('app');
let pending = null; /* { kind, id, extra } 等填完名再做 */

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
  } catch { /* */ }
  paint();
}

function code() { return load().unitCode; }

function paint() {
  const p = profile();
  const auth = loadHubAuth(code());
  if (!auth) return paintGate();
  saveMe({ id: auth.id, name: auth.name });
  const hash = location.hash.replace(/^#\/?/, '') || 'home';
  const [sec, id] = hash.split('/');
  const ident = auth.identity || 'member';
  const identL = IDENTITIES[ident]?.l || '團員';
  app.innerHTML = `
  <div class="hub-top">
    <div class="hub-wrap">
      <div class="xs" style="opacity:.8">團員入口 · ${esc(identL)} · 掃一次齊晒</div>
      <div style="font-size:22px;font-weight:800;margin-top:4px">${esc(p.name || '深資童軍團')}</div>
      <div class="xs" style="opacity:.85;margin-top:6px">你好，<b>${esc(auth.name)}</b>（YMIS ${esc(auth.ymis || '—')}）
        · <button class="btn btn-xs" type="button" id="hubLogout" style="color:#fff;border-color:rgba(255,255,255,.35)">登出</button></div>
    </div>
  </div>
  <div class="hub-wrap">
    ${sec === 'cal' && id ? eventDetail(id)
      : sec === 'quiz' && id ? quizFill(id)
      : home()}
  </div>`;
  bind();
}

function paintGate() {
  const p = profile();
  app.innerHTML = `
  <div class="hub-top">
    <div class="hub-wrap">
      <div class="xs" style="opacity:.8">團員入口 · 要 YMIS＋密碼</div>
      <div style="font-size:22px;font-weight:800;margin-top:4px">${esc(p.name || '深資童軍團')}</div>
      <div class="xs" style="opacity:.85;margin-top:6px">外人入唔到。首次密碼係 ${TEMP_PASSWORD}，入去要改。</div>
    </div>
  </div>
  <div class="hub-wrap">
    <form class="card card-pad" id="hubLogin" autocomplete="off">
      <div class="field"><label class="label">YMIS 會籍編號</label>
        <input class="input" id="hYmis" inputmode="numeric" placeholder="10 位數字" autocomplete="username"></div>
      <div class="field mt-12"><label class="label">密碼</label>
        <input class="input" id="hPass" type="password" placeholder="首次：${TEMP_PASSWORD}" autocomplete="current-password"></div>
      <div id="hErr" class="err mt-8"></div>
      <button class="btn btn-primary btn-block mt-16" type="submit">${icon('key', 16)} 進入</button>
    </form>
  </div>`;
  app.querySelector('#hubLogin')?.addEventListener('submit', async e => {
    e.preventDefault();
    const err = app.querySelector('#hErr');
    if (err) { err.textContent = ''; err.style.display = 'none'; }
    const res = await loginMember(app.querySelector('#hYmis')?.value, app.querySelector('#hPass')?.value);
    if (!res.ok) {
      if (err) { err.textContent = res.msg; err.style.display = 'block'; }
      return;
    }
    const m = res.member;
    saveHubAuth(code(), { id: m.id, name: m.name, ymis: m.ymis, identity: identityOf(m), mustChangePw: !!res.mustChangePw });
    saveMe({ id: m.id, name: m.name });
    paint();
    if (res.mustChangePw) forceMemberPw(m.id);
  });
}

function idBar() {
  const me = loadMe();
  const roster = activeMembers();
  return `<div class="card card-pad mb-16">
    <div class="semibold sm mb-8">我叫咩名？（可留空，入去先填都得）</div>
    <div class="field">
      <select class="select" id="hubPick">
        <option value="">— 名冊上嘅名 —</option>
        ${roster.map(m => `<option value="${esc(m.id)}" ${m.id === me.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
      </select>
    </div>
    <div class="field mt-8"><label class="label">或者自己打（唔喺名冊都得）</label>
      <input class="input" id="hubName" placeholder="例：陳大文" value="${esc(me.name)}">
    </div>
    <button class="btn btn-sm mt-10" type="button" id="hubSaveName">${icon('save', 14)} 記住喺呢部機</button>
    ${me.name ? `<button class="btn btn-xs btn-ghost mt-8" type="button" id="hubClearName">清除記住嘅名</button>` : ''}
  </div>`;
}

function home() {
  const evs = publicEvents();
  const qz = quizzes().filter(q => q.status !== 'closed');
  const notices = (load().notices || []).filter(n => n.status === 'published');
  const u = code();
  const tools = [
    { href: publicPageUrl('entry.html', { u }), icon: 'camera', title: '影單據／記一筆', desc: '墊支或代收，影相交司庫' },
    { href: publicPageUrl('borrow.html', { u }), icon: 'grid', title: '借物資', desc: '申請借用旅團物資' },
    { href: publicPageUrl('constitution.html', { u }), icon: 'book', title: '團章', desc: '免登入閱讀' }
  ];
  return `
    <div class="semibold mb-8">我要做</div>
    ${tools.map(t => `<a class="hub-card" href="${esc(withName(t.href))}">
      <span class="stat-ic">${icon(t.icon, 18)}</span>
      <div class="grow"><div class="semibold">${esc(t.title)}</div><div class="xs muted mt-4">${esc(t.desc)}</div></div>
    </a>`).join('')}

    <div class="semibold mt-24 mb-8">活動行事曆</div>
    ${evs.length ? evs.map(e => {
      const st = myRsvp(e);
      return `<button class="hub-card" type="button" data-open="#/cal/${e.id}" style="width:100%;text-align:left">
        <span class="stat-ic">${icon('calendar', 18)}</span>
        <div class="grow"><div class="semibold">${esc(e.title)}</div>
          <div class="xs muted mt-4">${esc(e.date)} ${esc(e.time || '')} · ${esc(e.venue || '')}</div>
          ${st ? `<div class="xs mt-4"><span class="badge ${RSVP[st]?.cls || ''}">已回覆：${esc(RSVP[st]?.label)}</span></div>` : ''}</div>
      </button>`;
    }).join('') : '<div class="card card-pad muted">暫時未有團員可見活動。</div>'}

    <div class="semibold mt-24 mb-8">試卷</div>
    ${qz.length ? qz.map(q => `<button class="hub-card" type="button" data-open="#/quiz/${q.id}" style="width:100%;text-align:left">
      <span class="stat-ic">${icon('note', 18)}</span>
      <div class="grow"><div class="semibold">${esc(q.title)}</div>
        <div class="xs muted mt-4">${(q.questions || []).length} 題</div></div>
    </button>`).join('') : '<div class="card card-pad muted">暫時未有開放試卷。</div>'}

    <div class="semibold mt-24 mb-8">通告</div>
    ${notices.length ? notices.map(n => {
      const href = publicPageUrl('notice.html', { u, n: n.id });
      return `<a class="hub-card" href="${esc(withName(href))}">
        <span class="stat-ic">${icon('megaphone', 18)}</span>
        <div class="grow"><div class="semibold">${esc(n.title?.zh || n.id)}</div>
          <div class="xs muted mt-4">${esc(n.eventDate || '')} ${n.needSignup ? '· 可回覆出席' : ''}</div></div>
      </a>`;
    }).join('') : '<div class="card card-pad muted">暫時未有已發布通告。</div>'}
  `;
}

function withName(url) {
  const me = loadMe();
  if (!me.name) return url;
  try {
    const u = new URL(url, location.href);
    u.searchParams.set('name', me.name);
    if (me.id) u.searchParams.set('mid', me.id);
    return u.toString();
  } catch { return url; }
}

function myRsvp(e) {
  const ident = identityForSubmit(activeMembers());
  if (!ident.id) return '';
  const v = (e.rsvp || {})[ident.id];
  return v?.status || v || '';
}

function needName(kind, id, extra) {
  persistNameFromBar();
  const ident = identityForSubmit(activeMembers());
  if (ident.name) return ident;
  pending = { kind, id, extra };
  toast('請喺上面填／揀你嘅名，再撳「記住」', 'warn');
  app.querySelector('#hubName')?.focus();
  return null;
}

function eventDetail(id) {
  const e = (load().events || []).find(x => x.id === id);
  if (!e || e.visibility === 'exco') return '<div class="card card-pad">搵唔到呢個活動。</div>';
  const st = myRsvp(e);
  return `<button class="btn btn-ghost btn-sm mb-12" type="button" data-open="#/home">${icon('chevronL', 14)} 返回</button>
    <div class="card card-pad">
      <div class="page-title" style="font-size:20px">${esc(e.title)}</div>
      <div class="sm muted mt-4">${esc(e.date)} ${esc(e.time || '')} · ${esc(e.venue || '')}</div>
      <div class="sm mt-12" style="white-space:pre-wrap">${esc(e.detail || '未有詳細內容')}</div>
      <div class="semibold sm mt-16">我會…（未填名都可以先睇；回覆先要名）</div>
      <div class="row wrap gap-8 mt-8">
        ${Object.entries(RSVP).map(([k, v]) =>
          `<button class="btn btn-sm ${st === k ? 'btn-primary' : ''}" type="button" data-eid="${e.id}" data-rsvp="${k}">${v.label}</button>`).join('')}
      </div>
    </div>`;
}

function quizFill(id) {
  const q = quizzes().find(x => x.id === id);
  if (!q) return '<div class="card card-pad">搵唔到試卷</div>';
  const ident = identityForSubmit(activeMembers());
  const prev = ident.id ? (q.responses || {})[ident.id] : null;
  return `<button class="btn btn-ghost btn-sm mb-12" type="button" data-open="#/home">${icon('chevronL', 14)} 返回</button>
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

function persistNameFromBar() {
  const pick = app.querySelector('#hubPick')?.value || '';
  let name = app.querySelector('#hubName')?.value.trim() || '';
  if (pick) {
    const m = activeMembers().find(x => x.id === pick);
    name = m?.name || name;
    saveMe({ id: pick, name });
  } else {
    saveMe({ id: '', name });
  }
}

function bind() {
  app.querySelector('#hubLogout')?.addEventListener('click', () => {
    clearHubAuth(code());
    paint();
  });
  app.querySelector('#hubPick')?.addEventListener('change', e => {
    const m = activeMembers().find(x => x.id === e.target.value);
    if (m) {
      const inp = app.querySelector('#hubName');
      if (inp) inp.value = m.name;
    }
  });
  app.querySelector('#hubSaveName')?.addEventListener('click', () => {
    persistNameFromBar();
    toast(loadMe().name ? '已記住：' + loadMe().name : '已清除名', 'ok');
    if (pending) {
      const p = pending; pending = null;
      if (p.kind === 'rsvp') rsvp(p.id, p.extra);
      if (p.kind === 'quiz') submitQuiz(p.id);
    } else paint();
  });
  app.querySelector('#hubClearName')?.addEventListener('click', () => { saveMe({}); paint(); });
  app.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.open; paint(); }));
  app.querySelectorAll('[data-rsvp]').forEach(b => b.addEventListener('click', () => rsvp(b.dataset.eid, b.dataset.rsvp)));
  app.querySelector('[data-quiz-submit]')?.addEventListener('click', () => submitQuiz(location.hash.split('/')[2] || location.hash.split('/')[1]));
}

function rsvp(eid, status) {
  const ident = needName('rsvp', eid, status);
  if (!ident) return;
  const e = (load().events || []).find(x => x.id === eid);
  if (!e) return;
  const map = { ...(e.rsvp || {}) };
  map[ident.id] = { status, at: todayISO(), name: ident.name };
  update('events', eid, { rsvp: map });
  toast('已回覆：' + RSVP[status].label, 'ok');
  paint();
}

function submitQuiz(id) {
  const ident = needName('quiz', id);
  if (!ident) return;
  const q = quizzes().find(x => x.id === id);
  if (!q) return;
  const answers = {};
  (q.questions || []).forEach(item => {
    if (item.type === 'multi') answers[item.id] = [...app.querySelectorAll(`[data-ans="${item.id}"]:checked`)].map(el => el.value);
    else if (item.type === 'single') answers[item.id] = app.querySelector(`[data-ans="${item.id}"]:checked`)?.value || '';
    else answers[item.id] = app.querySelector(`[data-ans="${item.id}"]`)?.value.trim() || '';
    if (item.required && (!answers[item.id] || (Array.isArray(answers[item.id]) && !answers[item.id].length))) {
      toast('請填：' + item.prompt, 'err'); answers._bad = true;
    }
  });
  if (answers._bad) return;
  delete answers._bad;
  const responses = { ...(q.responses || {}) };
  responses[ident.id] = { name: ident.name, at: todayISO(), answers };
  update('quizzes', id, { responses });
  toast('已交卷', 'ok');
  location.hash = '#/home';
  paint();
}

async function fillMyProgress() {
  const box = app.querySelector('#myProgress');
  if (!box) return;
  const auth = loadHubAuth(code());
  if (!progressConfigured()) {
    box.innerHTML = `<div class="semibold mb-4">我的進度</div>
      <div class="xs muted">旅團未接進度後端。進度追蹤系統仍然可以獨立使用；接好之後你會喺呢度見到自己嘅獎章進度。</div>`;
    return;
  }
  if (!auth?.ymis) {
    box.innerHTML = `<div class="semibold mb-4">我的進度</div><div class="xs muted">名冊未有你嘅 YMIS，無法對應進度。</div>`;
    return;
  }
  try {
    const [r, it] = await Promise.all([loadRemote(), loadItems()]);
    if (!r.ok) {
      box.innerHTML = `<div class="semibold mb-4">我的進度</div><div class="xs muted">${esc(r.error || '讀唔到進度')}</div>`;
      return;
    }
    const catalog = it.ok ? flattenItems(it.data) : {};
    const d = memberDetail(r.data, catalog, String(auth.ymis).trim());
    const badges = (d.badges || []).filter(b => b.total);
    box.innerHTML = `<div class="semibold mb-8">我的進度</div>
      <div class="xs muted mb-8">已完成 ${d.done} 項（YMIS ${esc(auth.ymis)}）。進度追蹤獨立入口仍然可以用。</div>
      ${badges.map(b => `<div class="mb-8">
        <div class="row-between sm"><span>${esc(b.icon || '')} ${esc(b.name)}</span><span class="mono">${b.done}/${b.total}（${b.rate}%）</span></div>
        <div class="progress mt-4"><i style="width:${b.rate}%"></i></div>
      </div>`).join('') || '<div class="xs muted">未有考核項目定義。</div>'}`;
  } catch (e) {
    box.innerHTML = `<div class="semibold">我的進度</div><div class="xs muted mt-4">${esc(e.message || '失敗')}</div>`;
  }
}

async function forceMemberPw(memberId) {
  const r = await modal({
    title: '首次登入：請改密碼',
    sub: `唔可以繼續用預設 ${TEMP_PASSWORD}`,
    body: `<div class="field"><label class="label">新密碼</label>
        <input class="input" id="mp1" type="password" autocomplete="new-password"></div>
      <div class="field mt-12"><label class="label">再輸入一次</label>
        <input class="input" id="mp2" type="password" autocomplete="new-password"></div>
      <div id="mpErr" class="err mt-8"></div>`,
    actions: [
      { label: '稍後', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => {
        const p1 = el.querySelector('#mp1').value, p2 = el.querySelector('#mp2').value;
        const err = el.querySelector('#mpErr');
        if (p1.length < 4) { err.textContent = '至少 4 個字'; err.style.display = 'block'; return false; }
        if (p1 === TEMP_PASSWORD) { err.textContent = '唔可以繼續用預設密碼'; err.style.display = 'block'; return false; }
        if (p1 !== p2) { err.textContent = '兩次輸入唔一樣'; err.style.display = 'block'; return false; }
        return p1;
      } }
    ]
  });
  if (!r) return;
  const res = await changeMemberOwnPassword(memberId, '', r);
  toast(res.ok ? '密碼已更改' : (res.msg || '改唔到'), res.ok ? 'ok' : 'err');
  if (res.ok) {
    const a = loadHubAuth(code());
    if (a) saveHubAuth(code(), { ...a, mustChangePw: false });
    if (location.hash === '#forcepw') location.hash = '#/home';
  }
}

window.addEventListener('hashchange', () => { try { paint(); } catch { /* */ } });
boot().catch(e => {
  app.innerHTML = `<div style="padding:40px" class="muted">載入失敗：${esc(e.message || e)}</div>`;
});
