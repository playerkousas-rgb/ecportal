/* 試卷：執委新設／匯入（Google Form 題目／CSV），團員喺團員入口填 */
import { collection, find, add, update, remove } from '../lib/store.js';
import { memberName } from '../lib/model.js';
import { esc, icon, uid, todayISO, toast, confirmDlg } from '../lib/util.js';
import { go } from '../lib/router.js';
import { can } from '../lib/auth.js';
import { pageHead, tabs, empty, noteBox } from './ui.js';

let tab = 'list';

export function title() { return '試卷'; }
export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }

export function parseQuizImport(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return { title: '', questions: [], error: '空白內容' };
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const questions = [];
  let title = '';
  const isCsv = lines[0] && (lines[0].includes(',') || lines[0].includes('\t'))
    && /題|question|title|類型|type/i.test(lines[0]);
  if (isCsv) {
    const delim = lines[0].includes('\t') ? '\t' : ',';
    const split = row => {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < row.length; i++) {
        const c = row[i];
        if (c === '"') { q = !q; continue; }
        if (!q && c === delim) { out.push(cur.trim()); cur = ''; continue; }
        cur += c;
      }
      out.push(cur.trim());
      return out;
    };
    const head = split(lines[0]).map(h => h.toLowerCase());
    const iTitle = head.findIndex(h => /題|question|prompt|title/.test(h));
    const iType = head.findIndex(h => /類型|type/.test(h));
    const iOpts = head.findIndex(h => /選|option|choices/.test(h));
    const iReq = head.findIndex(h => /必|required/.test(h));
    lines.slice(1).forEach(row => {
      const cols = split(row);
      const prompt = cols[iTitle >= 0 ? iTitle : 0] || '';
      if (!prompt) return;
      const typeRaw = (cols[iType] || 'short').toLowerCase();
      let type = 'short';
      if (/多選|checkbox|multi/.test(typeRaw)) type = 'multi';
      else if (/單選|choice|radio|select/.test(typeRaw)) type = 'single';
      else if (/段落|para|long/.test(typeRaw)) type = 'para';
      const opts = (cols[iOpts] || '').split(/[|;／、]/).map(s => s.trim()).filter(Boolean);
      questions.push({ id: uid('qq'), prompt, type, options: opts, required: /是|yes|1|true/i.test(cols[iReq] || '') });
    });
  } else {
    let cur = null;
    lines.forEach(line => {
      const t = line.match(/^(?:標題|試卷)[:：]\s*(.+)/);
      if (t) { title = t[1]; return; }
      const q = line.match(/^(?:\d+[\.\)、]|Q\d+[:：]?|題目[:：])\s*(.+)/i);
      if (q) {
        if (cur) questions.push(cur);
        cur = { id: uid('qq'), prompt: q[1], type: 'short', options: [], required: true };
        return;
      }
      const opt = line.match(/^(?:[\(\[]?[A-Da-d][\)\].、]|[-•●])\s*(.+)/);
      if (opt && cur) {
        cur.options.push(opt[1]);
        cur.type = cur.options.length > 1 ? 'single' : cur.type;
        return;
      }
      if (cur && !cur.options.length) cur.prompt += ' ' + line;
      else if (!cur) title = title || line;
    });
    if (cur) questions.push(cur);
  }
  if (!questions.length) return { title, questions, error: '讀唔到題目。請用「1. 題目」加 A/B 選項，或 CSV（題目,類型,選項）。' };
  return { title, questions, error: '' };
}

export function render(params) {
  if (['list', 'import'].includes(params.id)) tab = params.id;
  else if (params.id === 'new') return editor(null);
  else if (params.id && params.action === 'edit') return editor(find('quizzes', params.id));
  else if (params.id) return detail(params.id);
  return `
  ${pageHead({
    title: '試卷',
    sub: '新設試卷或匯入 Google 表單題目。團員喺「團員入口」填，唔使執委帳號。',
    actions: can('quiz.edit') ? `<button class="btn btn-sm btn-primary" data-go="#/quizzes/new">${icon('plus', 15)} 新設試卷</button>` : ''
  })}
  ${tabs([['list', '試卷', collection('quizzes').length], ['import', '匯入']], tab)}
  ${tab === 'import' ? importView() : listView()}`;
}

function listView() {
  const rows = collection('quizzes').slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  if (!rows.length) return empty('note', '未有試卷', '新設，或者由 Google Form 匯入題目');
  return `<div class="card"><div class="scroll-x"><table class="table">
    <thead><tr><th>試卷</th><th>題數</th><th>已交</th><th>狀態</th></tr></thead>
    <tbody>${rows.map(q => `<tr data-open="${q.id}" style="cursor:pointer">
      <td><div class="semibold sm">${esc(q.title)}</div><div class="xs faint">${esc(q.note || '')}</div></td>
      <td>${(q.questions || []).length}</td>
      <td>${Object.keys(q.responses || {}).length}</td>
      <td>${q.status === 'closed' ? '<span class="badge b-grey">已關閉</span>' : '<span class="badge b-ok">開放</span>'}</td>
    </tr>`).join('')}</tbody></table></div></div>`;
}

function importView() {
  return `<div class="card card-pad" style="max-width:760px">
    ${noteBox('瀏覽器通常<b>拉唔到</b> Google Form 網址（CORS）。請喺 Google 表單 → 回應 → 試算表，複製題目欄，或者用下面格式貼題目。', 'warn')}
    <div class="field mt-12"><label class="label">貼題目／CSV</label>
      <textarea class="textarea" id="qz-import" rows="12" placeholder="標題：週會小測&#10;1. 旅團格言係？&#10;A. 準備&#10;B. 日行一善&#10;2. 你嘅小隊？"></textarea>
      <div class="hint">CSV 欄：題目,類型（short／single／multi／para）,選項（用 | 分隔）,必填</div></div>
    <button class="btn btn-primary mt-12" data-act="do-import">${icon('upload', 15)} 匯入成新試卷</button>
  </div>`;
}

function editor(q) {
  const d = q || { title: '', note: '', status: 'open', questions: [{ id: uid('qq'), prompt: '', type: 'short', options: [], required: true }] };
  const qs = d.questions && d.questions.length ? d.questions : [{ id: uid('qq'), prompt: '', type: 'short', options: [], required: true }];
  return `
  <div class="no-print mb-12"><button class="btn btn-ghost btn-sm" data-go="#/quizzes">${icon('chevronL', 15)} 返回</button></div>
  ${pageHead({ title: q ? '編輯試卷' : '新設試卷' })}
  <div class="card card-pad" style="max-width:760px">
    <div class="field"><label class="label">名稱</label><input class="input" id="qz-title" value="${esc(d.title)}"></div>
    <div class="field mt-12"><label class="label">說明（團員睇到）</label><textarea class="textarea" id="qz-note" rows="3">${esc(d.note || '')}</textarea></div>
    <div class="field mt-12"><label class="label">狀態</label>
      <select class="select" id="qz-status"><option value="open" ${d.status !== 'closed' ? 'selected' : ''}>開放填寫</option>
        <option value="closed" ${d.status === 'closed' ? 'selected' : ''}>關閉</option></select></div>
    <div class="mt-16 semibold sm">題目</div>
    <div id="qz-qs">${qs.map((item, i) => qRow(item, i)).join('')}</div>
    <button class="btn btn-sm mt-12" type="button" data-act="add-q">${icon('plus', 14)} 加題</button>
    <div class="row gap-8 mt-16" style="justify-content:flex-end">
      <button class="btn" data-go="#/quizzes">取消</button>
      <button class="btn btn-primary" data-act="save">${icon('save', 16)} 儲存</button>
    </div>
  </div>`;
}

function qRow(item, i) {
  return `<div class="card card-pad mt-12" data-qrow="${esc(item.id)}">
    <div class="row-between"><div class="xs faint">第 ${i + 1} 題</div>
      <button class="btn btn-xs btn-ghost" type="button" data-delq="${esc(item.id)}">刪</button></div>
    <input class="input mt-8" data-f="prompt" value="${esc(item.prompt)}" placeholder="題目">
    <div class="grid g-2 mt-8" style="gap:8px">
      <select class="select" data-f="type">
        ${[['short', '短答'], ['para', '段落'], ['single', '單選'], ['multi', '多選']].map(([k, l]) =>
          `<option value="${k}" ${item.type === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <label class="check"><input type="checkbox" data-f="req" ${item.required ? 'checked' : ''}> 必填</label>
    </div>
    <input class="input mt-8" data-f="opts" value="${esc((item.options || []).join(' | '))}" placeholder="選項（單選／多選：用 | 分隔）">
  </div>`;
}

function detail(id) {
  const q = find('quizzes', id);
  if (!q) return empty('alert', '搵唔到試卷');
  const resp = Object.entries(q.responses || {});
  return `
  <div class="no-print mb-12"><button class="btn btn-ghost btn-sm" data-go="#/quizzes">${icon('chevronL', 15)} 返回</button></div>
  ${pageHead({
    title: q.title,
    sub: `${(q.questions || []).length} 題 · ${resp.length} 份回應`,
    actions: can('quiz.edit') ? `<button class="btn btn-sm" data-act="edit">${icon('edit', 15)} 編輯</button>
      <button class="btn btn-sm btn-danger" data-act="del">${icon('trash', 15)}</button>` : ''
  })}
  <div class="card card-pad mb-16 sm" style="white-space:pre-wrap">${esc(q.note || '')}</div>
  <div class="card"><div class="card-head"><div class="card-title">回應</div></div>
    ${resp.length ? `<div class="scroll-x"><table class="table table-compact">
      <thead><tr><th>團員</th><th>時間</th><th>答案摘要</th></tr></thead>
      <tbody>${resp.map(([mid, r]) => `<tr>
        <td class="semibold sm">${esc(r.name || memberName(mid))}</td>
        <td class="xs mono">${esc(r.at || '')}</td>
        <td class="xs">${esc(summarize(q, r.answers))}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty">未有人交卷</div>'}
  </div>`;
}

function summarize(q, answers = {}) {
  return (q.questions || []).map(item => {
    const a = answers[item.id];
    const v = Array.isArray(a) ? a.join('、') : (a || '—');
    return `${item.prompt}: ${v}`;
  }).join(' ｜ ').slice(0, 240);
}

function collectQuestions(root) {
  return [...root.querySelectorAll('[data-qrow]')].map(row => {
    const type = row.querySelector('[data-f=type]')?.value || 'short';
    const opts = (row.querySelector('[data-f=opts]')?.value || '').split('|').map(s => s.trim()).filter(Boolean);
    return {
      id: row.dataset.qrow,
      prompt: row.querySelector('[data-f=prompt]')?.value.trim() || '',
      type, options: opts, required: !!row.querySelector('[data-f=req]')?.checked
    };
  }).filter(x => x.prompt);
}

export function mount(root, params) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  root.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => go('#/quizzes/' + el.dataset.open)));
  root.querySelector('[data-act="edit"]')?.addEventListener('click', () => go('#/quizzes/' + params.id + '/edit'));
  root.querySelector('[data-act="add-q"]')?.addEventListener('click', () => {
    const box = root.querySelector('#qz-qs');
    const id = uid('qq');
    box.insertAdjacentHTML('beforeend', qRow({ id, prompt: '', type: 'short', options: [], required: true }, box.children.length));
    bindDel(root);
  });
  bindDel(root);
  root.querySelector('[data-act="save"]')?.addEventListener('click', () => {
    const title = root.querySelector('#qz-title')?.value.trim();
    if (!title) { toast('請填名稱', 'err'); return; }
    const payload = {
      title, note: root.querySelector('#qz-note')?.value.trim() || '',
      status: root.querySelector('#qz-status')?.value || 'open',
      questions: collectQuestions(root), updatedAt: todayISO()
    };
    if (params.id && params.id !== 'new') {
      update('quizzes', params.id, payload); toast('已儲存', 'ok'); go('#/quizzes/' + params.id);
    } else {
      const rec = add('quizzes', { id: uid('qz'), responses: {}, createdAt: todayISO(), ...payload });
      toast('已新增試卷', 'ok'); go('#/quizzes/' + rec.id);
    }
  });
  root.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
    if (await confirmDlg({ title: '刪除試卷', danger: true, okText: '刪除', message: '確定刪除？回應會一齊刪。' })) {
      remove('quizzes', params.id); toast('已刪除', 'ok'); go('#/quizzes');
    }
  });
  root.querySelector('[data-act="do-import"]')?.addEventListener('click', () => {
    const parsed = parseQuizImport(root.querySelector('#qz-import')?.value || '');
    if (parsed.error) { toast(parsed.error, 'err'); return; }
    const rec = add('quizzes', {
      id: uid('qz'), title: parsed.title || '匯入試卷', note: '由文字／CSV 匯入',
      status: 'open', questions: parsed.questions, responses: {}, createdAt: todayISO()
    });
    toast(`已匯入 ${parsed.questions.length} 題`, 'ok');
    go('#/quizzes/' + rec.id);
  });
}

function bindDel(root) {
  root.querySelectorAll('[data-delq]').forEach(b => {
    b.onclick = () => b.closest('[data-qrow]')?.remove();
  });
}
