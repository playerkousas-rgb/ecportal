/* 行事曆（活動，唔係會議）—— 團員可見／執委內部、RSVP、點名、出席統計 */
import { collection, find, add, update, remove } from '../lib/store.js';
import { memberName, RSVP, rsvpCounts, attendanceStats, activeMembers } from '../lib/model.js';
import { esc, icon, uid, todayISO, toast, modal, confirmDlg } from '../lib/util.js';
import { go } from '../lib/router.js';
import { can } from '../lib/auth.js';
import { pageHead, tabs, stat, empty } from './ui.js';

let tab = 'cal';
let cursor = todayISO().slice(0, 7);

export function title() { return '行事曆'; }
export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }

const KINDS = { assembly: '集會', activity: '活動', ec: '執委會', other: '其他' };

function list() { return collection('events'); }

export function render(params) {
  if (['cal', 'list', 'stats'].includes(params.id)) tab = params.id;
  else if (params.id === 'new') return editor(null, params.query);
  else if (params.id && params.action === 'edit') return editor(find('events', params.id), params.query);
  else if (params.id) return detail(params.id, params.query);
  return `
  ${pageHead({
    title: '行事曆',
    sub: '活動／集會：團員可見或只限執委＋領袖。所有活動都有回覆同點名。',
    actions: can('calendar.edit') ? `<button class="btn btn-sm btn-primary" data-go="#/calendar/new">${icon('plus', 15)} 新增活動</button>` : ''
  })}
  ${tabs([['cal', '月曆'], ['list', '清單', list().length], ['stats', '出席統計']], tab)}
  ${tab === 'stats' ? statsView() : tab === 'list' ? listView() : monthView()}`;
}

function monthView() {
  const [yy, mm] = cursor.split('-').map(Number);
  const first = new Date(yy, mm - 1, 1);
  const startDow = (first.getDay() + 6) % 7;
  const days = new Date(yy, mm, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const byDay = {};
  list().forEach(e => {
    if (!String(e.date || '').startsWith(cursor)) return;
    const d = Number(String(e.date).slice(8, 10));
    (byDay[d] = byDay[d] || []).push(e);
  });
  return `<div class="card">
    <div class="card-head">
      <div class="row gap-8">
        <button class="btn btn-sm" data-cal="prev">${icon('chevronL', 14)}</button>
        <div class="card-title">${yy} 年 ${mm} 月</div>
        <button class="btn btn-sm" data-cal="next">${icon('chevronR', 14)}</button>
      </div>
    </div>
    <div class="cal-grid">
      ${['一','二','三','四','五','六','日'].map(w => `<div class="cal-dow">${w}</div>`).join('')}
      ${cells.map(d => {
        if (!d) return '<div class="cal-cell empty"></div>';
        const iso = `${cursor}-${String(d).padStart(2, '0')}`;
        const items = byDay[d] || [];
        return `<div class="cal-cell" data-calday="${iso}">
          <div class="cal-n">${d}</div>
          ${items.map(e => {
            const c = rsvpCounts(e);
            return `<button class="cal-ev ${e.visibility === 'exco' ? 'exco' : ''}" data-open="${e.id}">
              ${esc((e.title || '').slice(0, 18))}
              <span class="xs faint"> ${c.present + c.late + c.early}出／${c.absent}唔出</span>
            </button>`;
          }).join('')}
        </div>`;
      }).join('')}
    </div>
    <div class="hint" style="padding:10px 14px">棗紅＝團員可見；虛線＝只限執委＋領袖。撳日子新增，撳活動睇人數同點名。</div>
  </div>`;
}

function listView() {
  const rows = list().slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!rows.length) return empty('calendar', '未有活動', '按右上「新增活動」');
  return `<div class="card"><div class="scroll-x"><table class="table">
    <thead><tr><th>日期</th><th>活動</th><th>可見</th><th>回覆</th><th>點名</th></tr></thead>
    <tbody>${rows.map(e => {
      const c = rsvpCounts(e);
      return `<tr data-open="${e.id}" style="cursor:pointer">
        <td class="mono sm">${esc(e.date)} ${esc(e.time || '')}</td>
        <td><div class="semibold sm">${esc(e.title)}</div><div class="xs faint">${esc(KINDS[e.kind] || '')} · ${esc(e.venue || '')}</div></td>
        <td>${e.visibility === 'exco' ? '<span class="badge b-warn">執委＋領袖</span>' : '<span class="badge b-ok">團員可見</span>'}</td>
        <td class="sm">出 ${c.present} · 唔出 ${c.absent} · 遲 ${c.late} · 早 ${c.early}</td>
        <td class="sm">${c.rollTotal ? `已點 ${c.rollTotal}` : '<span class="faint">未點名</span>'}</td>
      </tr>`;
    }).join('')}</tbody></table></div></div>`;
}

function statsView() {
  const roster = activeMembers();
  const evs = list().filter(e => e.status !== 'cancelled');
  if (!evs.length) return empty('chart', '未有活動，未有出席統計');
  const rows = roster.map(m => {
    const s = attendanceStats(m.id);
    return { m, ...s };
  }).sort((a, b) => b.rate - a.rate);
  return `<div class="note-box mb-16">${icon('chart', 15)}<div>統計用<strong>執委點名</strong>（唔係團員自己回覆），方便計全年出席率。</div></div>
  <div class="card"><div class="scroll-x"><table class="table table-compact">
    <thead><tr><th>成員</th><th class="right">出席</th><th class="right">遲到</th><th class="right">早走</th><th class="right">不出席</th><th class="right">已點</th><th style="width:140px">出席率</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td class="semibold sm">${esc(r.m.name)}<div class="xs faint">${esc(r.m.role || '')}</div></td>
      <td class="right">${r.present}</td><td class="right">${r.late}</td><td class="right">${r.early}</td>
      <td class="right">${r.absent}</td><td class="right">${r.marked}/${r.total}</td>
      <td><div class="bar"><span style="width:${r.rate}%"></span></div><div class="xs faint">${r.rate}%</div></td>
    </tr>`).join('')}</tbody>
  </table></div></div>`;
}

function peopleOf(ev, key) {
  const map = ev[key] || {};
  const groups = { present: [], absent: [], late: [], early: [] };
  Object.entries(map).forEach(([id, v]) => {
    const st = v.status || v;
    if (groups[st]) groups[st].push(memberName(id));
  });
  return groups;
}

function detail(id, query) {
  const e = find('events', id);
  if (!e) return empty('alert', '搵唔到呢個活動');
  const pane = query.tab || 'info';
  const c = rsvpCounts(e);
  const rsvp = peopleOf(e, 'rsvp');
  const roll = peopleOf(e, 'rollcall');
  const roster = activeMembers();
  return `
  <div class="no-print mb-12"><button class="btn btn-ghost btn-sm" data-go="#/calendar">${icon('chevronL', 15)} 返回行事曆</button></div>
  ${pageHead({
    title: e.title,
    sub: `${e.date} ${e.time || ''} · ${e.venue || ''} · ${KINDS[e.kind] || ''} · ${e.visibility === 'exco' ? '只限執委＋領袖' : '團員可見'}`,
    actions: can('calendar.edit') ? `<button class="btn btn-sm" data-act="edit">${icon('edit', 15)} 編輯</button>
      <button class="btn btn-sm btn-danger" data-act="del">${icon('trash', 15)}</button>` : ''
  })}
  <div class="grid g-4 mb-16">
    ${stat('出席', String(c.present), '團員回覆', 'ok')}
    ${stat('不出席', String(c.absent), '', c.absent ? 'danger' : '')}
    ${stat('遲到', String(c.late), '', c.late ? 'warn' : '')}
    ${stat('早走', String(c.early), '', '')}
  </div>
  <div class="seg mb-16 no-print">
    ${[['info', '內容'], ['who', '邊個回覆'], ['roll', '點名']].map(([k, l]) =>
      `<button data-dtab="${k}" aria-selected="${pane === k}">${l}</button>`).join('')}
  </div>
  ${pane === 'who' ? `<div class="grid g-2">${['present','absent','late','early'].map(k => `
    <div class="card"><div class="card-head"><div class="card-title">${RSVP[k].label}（${rsvp[k].length}）</div></div>
      <div style="padding:12px 16px" class="sm">${rsvp[k].length ? rsvp[k].map(esc).join('、') : '<span class="faint">未有</span>'}</div></div>`).join('')}</div>`
  : pane === 'roll' ? `<div class="card">
      <div class="card-head"><div><div class="card-title">執委點名</div>
        <div class="card-sub">點名結果會計入出席統計。已點 ${c.rollTotal} / ${roster.length}</div></div>
        <button class="btn btn-xs" data-act="all-present">全部出席</button></div>
      <div class="scroll-x"><table class="table table-compact">
        <thead><tr><th>成員</th><th>回覆</th><th>點名</th></tr></thead>
        <tbody>${roster.map(m => {
          const r = (e.rsvp || {})[m.id];
          const rc = (e.rollcall || {})[m.id];
          const rst = r?.status || r || '';
          const cst = rc?.status || rc || '';
          return `<tr>
            <td class="semibold sm">${esc(m.name)}</td>
            <td class="xs">${rst ? RSVP[rst]?.label : '—'}</td>
            <td>${['present','absent','late','early'].map(k =>
              `<button class="btn btn-xs ${cst === k ? 'btn-primary' : 'btn-ghost'}" data-roll="${m.id}" data-val="${k}">${RSVP[k].label}</button>`).join(' ')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </div>`
  : `<div class="card card-pad"><div class="sm" style="white-space:pre-wrap">${esc(e.detail || '未有詳細內容')}</div>
      ${e.fee ? `<div class="mt-12 xs">費用：${esc(e.fee)}</div>` : ''}
      ${e.deadline ? `<div class="xs">回覆截止：${esc(e.deadline)}</div>` : ''}</div>`}`;
}

function editor(e, query = {}) {
  const d = e || { title: '', date: query.date || todayISO(), time: '19:30', venue: '', kind: 'activity', visibility: 'members', detail: '', fee: '', deadline: '' };
  return `
  <div class="no-print mb-12"><button class="btn btn-ghost btn-sm" data-go="#/calendar">${icon('chevronL', 15)} 返回</button></div>
  ${pageHead({ title: e ? '編輯活動' : '新增活動', sub: '揀「團員可見」或「只限執委＋領袖」' })}
  <div class="card card-pad" style="max-width:720px">
    <div class="grid g-2" style="gap:12px">
      <div class="field" style="grid-column:1/-1"><label class="label">名稱 <span class="req">*</span></label>
        <input class="input" id="e-title" value="${esc(d.title)}" placeholder="例：週五集會／遠足"></div>
      <div class="field"><label class="label">日期</label><input class="input" type="date" id="e-date" value="${esc(d.date)}"></div>
      <div class="field"><label class="label">時間</label><input class="input" type="time" id="e-time" value="${esc(d.time || '')}"></div>
      <div class="field"><label class="label">地點</label><input class="input" id="e-venue" value="${esc(d.venue || '')}"></div>
      <div class="field"><label class="label">種類</label>
        <select class="select" id="e-kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field" style="grid-column:1/-1"><label class="label">邊個睇到</label>
        <select class="select" id="e-vis">
          <option value="members" ${d.visibility !== 'exco' ? 'selected' : ''}>團員可見（集會／活動）</option>
          <option value="exco" ${d.visibility === 'exco' ? 'selected' : ''}>只限執委＋領袖（例：EC 會議）</option>
        </select></div>
      <div class="field"><label class="label">費用（可空）</label><input class="input" id="e-fee" value="${esc(d.fee || '')}"></div>
      <div class="field"><label class="label">回覆截止</label><input class="input" type="date" id="e-dead" value="${esc(d.deadline || '')}"></div>
      <div class="field" style="grid-column:1/-1"><label class="label">內容／資訊</label>
        <textarea class="textarea" id="e-detail" rows="6">${esc(d.detail || '')}</textarea></div>
    </div>
    <div class="row gap-8 mt-16" style="justify-content:flex-end">
      <button class="btn" data-go="#/calendar">取消</button>
      <button class="btn btn-primary" data-act="save">${icon('save', 16)} 儲存</button>
    </div>
  </div>`;
}

export function mount(root, params) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  root.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', e => { e.stopPropagation(); go('#/calendar/' + el.dataset.open); }));
  root.querySelector('[data-cal="prev"]')?.addEventListener('click', () => {
    const [y, m] = cursor.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    cursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    refresh();
  });
  root.querySelector('[data-cal="next"]')?.addEventListener('click', () => {
    const [y, m] = cursor.split('-').map(Number);
    const d = new Date(y, m, 1);
    cursor = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    refresh();
  });
  root.querySelectorAll('[data-calday]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('[data-open]')) return;
    if (!can('calendar.edit')) return;
    go('#/calendar/new?date=' + el.dataset.calday);
  }));
  root.querySelectorAll('[data-dtab]').forEach(b => b.addEventListener('click', () => {
    go('#/calendar/' + params.id + '?tab=' + b.dataset.dtab);
  }));
  root.querySelectorAll('[data-roll]').forEach(b => b.addEventListener('click', () => {
    const e = find('events', params.id);
    if (!e) return;
    const roll = { ...(e.rollcall || {}) };
    roll[b.dataset.roll] = { status: b.dataset.val, at: todayISO() };
    update('events', e.id, { rollcall: roll });
    refresh();
  }));
  root.querySelector('[data-act="all-present"]')?.addEventListener('click', () => {
    const e = find('events', params.id);
    if (!e) return;
    const roll = { ...(e.rollcall || {}) };
    activeMembers().forEach(m => { roll[m.id] = { status: 'present', at: todayISO() }; });
    update('events', e.id, { rollcall: roll });
    toast('已全部點出席', 'ok'); refresh();
  });
  root.querySelector('[data-act="edit"]')?.addEventListener('click', () => go('#/calendar/' + params.id + '/edit'));
  if (params.action === 'edit' && params.id) {
    /* fall through save on editor if we rendered editor via id/edit — handled below if render used editor */
  }
  root.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
    if (await confirmDlg({ title: '刪除活動', danger: true, okText: '刪除', message: '確定刪除此活動？回覆同點名會一齊刪。' })) {
      remove('events', params.id); toast('已刪除', 'ok'); go('#/calendar');
    }
  });
  root.querySelector('[data-act="save"]')?.addEventListener('click', () => {
    const v = k => root.querySelector(k)?.value.trim() || '';
    const title = v('#e-title');
    if (!title) { toast('請填名稱', 'err'); return; }
    const payload = {
      title, date: v('#e-date') || todayISO(), time: v('#e-time'), venue: v('#e-venue'),
      kind: v('#e-kind') || 'activity', visibility: v('#e-vis') || 'members',
      detail: v('#e-detail'), fee: v('#e-fee'), deadline: v('#e-dead'), status: 'ok'
    };
    if (params.id && params.id !== 'new') {
      update('events', params.id, payload); toast('已更新', 'ok'); go('#/calendar/' + params.id);
    } else {
      const rec = add('events', { id: uid('ev'), rsvp: {}, rollcall: {}, ...payload });
      toast('已新增活動', 'ok'); go('#/calendar/' + rec.id);
    }
  });
}
