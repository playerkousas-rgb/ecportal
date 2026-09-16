/* ============================================================
   links.js — 成員連結（免登入公開頁）

   申報系統、物資借用、通告報名 —— 呢啲唔應該只限執委用。
   呢一頁把每一條公開連結（＋QR Code）列出嚟，
   領袖／執委可以：複製、下載 QR、列印海報，貼落 WhatsApp 群或者旅部。
   ============================================================ */

import { load, commit } from '../lib/store.js';
import { esc, icon, modal, toast, copyText, qrSvg } from '../lib/util.js';
import { toWord, printDoc, downloadQrSvg, stamp } from '../lib/exporter.js';
import { profile, settings, memberLinks, publicPageUrl } from '../lib/model.js';
import { pageHead, empty, noteBox } from './ui.js';
import { can } from '../lib/auth.js';

export function title() { return '成員連結'; }

export function render() {
  const list = memberLinks();
  const core = list.filter(l => !l.id.startsWith('notice:'));
  const noticesList = list.filter(l => l.id.startsWith('notice:'));
  const backend = load().backend;
  const s = settings().publicLinks || {};

  return `
  ${pageHead({
    title: '成員連結',
    sub: '免登入公開頁 —— 團員／家長用手機開就用得，唔使執委帳戶',
    actions: `
      <button class="btn btn-sm" data-act="print-all">${icon('print', 15)} 列印全部 QR 海報</button>
      <button class="btn btn-sm" data-act="copy-all">${icon('copy', 15)} 複製全部連結</button>
      <button class="btn btn-sm" data-act="settings">${icon('settings', 15)} 公開頁網址</button>`
  })}

  ${noteBox(`<b>點解要有呢一頁？</b>申報、物資借用、通告報名都係<b>成員自己</b>用嘅嘢，
    唔應該只限執委登入先用得。呢度每一條連結都<b>免登入</b>，
    貼落 WhatsApp 群／印出 QR 貼喺旅部就得。${backend
      ? '<br><span class="xs">已連接總表：成員一送出就會寫入你嘅 Google Sheet（待批核）。</span>'
      : '<br><span class="xs" style="color:var(--warn)">未設定 Apps Script：成員送出嘅內容會存喺佢哋自己部手機，可以「複製內容」傳畀司庫。</span>'}`, 'brand')}
  <div class="mb-16"></div>

  <div class="card mb-16">
    <div class="card-head"><div><div class="card-title">成員系統</div>
      <div class="card-sub">申報 · 物資 · 團章</div></div></div>
    <div style="padding:14px 16px" class="col gap-10">
      ${core.map(linkCard).join('')}
    </div>
  </div>

  <div class="card mb-16">
    <div class="card-head"><div><div class="card-title">通告報名連結</div>
      <div class="card-sub">已發布嘅通告，每張一條獨立連結（可以逐張派）</div></div>
      <button class="btn btn-sm" data-go="#/notices/new">${icon('plus', 14)} 開新通告</button></div>
    <div style="padding:14px 16px" class="col gap-10">
      ${noticesList.length ? noticesList.map(linkCard).join('')
        : empty('megaphone', '未有已發布嘅通告', '去「通告」頁開一張，發布之後呢度就會出現連結')}
    </div>
  </div>

  <div class="grid g-2">
    <div class="card">
      <div class="card-head"><div class="card-title">點樣派畀團員？</div></div>
      <div style="padding:16px 18px" class="sm muted">
        <ol style="padding-left:18px;line-height:1.95;margin:0">
          <li><b>WhatsApp / Signal 群</b>：撳「複製連結」貼入群，或者撳「複製 QR＋文字」連圖一齊發</li>
          <li><b>旅部當眼處</b>：撳「列印海報」，A4 印出嚟貼低，團員掃 QR 即用</li>
          <li><b>通告紙本</b>：通告頁撳「輸出」→「QR 海報」，連通告內容一齊印</li>
          <li><b>家長</b>：通告連結免登入，家長可以直接代填回覆出席與否</li>
        </ol>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div class="card-title">收到之後去邊睇？</div></div>
      <div style="padding:14px 16px" class="col gap-8">
        <button class="btn btn-sm btn-block btn-soft" data-go="#/finance/claims">${icon('note', 15)} 收支申報（批核）</button>
        <button class="btn btn-sm btn-block btn-soft" data-go="#/inventory/loans">${icon('grid', 15)} 物資借用（批核）</button>
        <button class="btn btn-sm btn-block btn-soft" data-go="#/notices/signups">${icon('megaphone', 15)} 通告報名 / 出席回覆</button>
        <div class="hint mt-4">批核之後：申報自動入帳、借用自動扣庫存。</div>
      </div>
    </div>
  </div>`;
}

function linkCard(l) {
  return `<div class="link-card">
    <span class="ic">${icon(l.icon, 18)}</span>
    <div class="grow" style="min-width:0">
      <div class="semibold sm">${esc(l.label)}</div>
      <div class="xs muted mt-4">${esc(l.desc)}</div>
      <div class="u mt-6">${esc(l.url)}</div>
    </div>
    <div class="row gap-6 wrap no-print" style="justify-content:flex-end">
      <button class="btn btn-xs" data-copy="${esc(l.url)}">${icon('copy', 13)} 複製</button>
      <button class="btn btn-xs" data-qr="${esc(l.url)}" data-qrt="${esc(l.label)}">${icon('qr', 13)} QR</button>
      <button class="btn btn-xs" data-poster="${esc(l.url)}" data-qrt="${esc(l.label)}">${icon('print', 13)} 海報</button>
      <button class="btn btn-xs" data-open="${esc(l.url)}">${icon('external', 13)}</button>
    </div>
  </div>`;
}

/* ============================================================
   mount
   ============================================================ */
export function mount(root) {
  root.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => {
    location.hash = el.dataset.go;
  }));

  root.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
    if (await copyText(b.dataset.copy)) toast('已複製連結', 'ok'); else toast('複製失敗', 'err');
  }));
  root.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => {
    window.open(b.dataset.open, '_blank', 'noopener');
  }));
  root.querySelectorAll('[data-qr]').forEach(b => b.addEventListener('click', async () => {
    const url = b.dataset.qr;
    await modal({
      title: b.dataset.qrt || 'QR Code', wide: true,
      body: `<div class="center">
          <div class="qr-box" style="width:250px;margin:0 auto">${qrSvg(url, 6, 2)}</div>
          <div class="sm muted mt-12" style="word-break:break-all">${esc(url)}</div>
        </div>`,
      actions: [
        { label: '下載 SVG', class: 'btn', onClick: () => { downloadQrSvg(url, `QR_${stamp()}.svg`, 8, 3); return false; } },
        { label: '複製連結', class: 'btn', onClick: async () => { await copyText(url); toast('已複製', 'ok'); return false; } },
        { label: '關閉', class: 'btn-primary', value: null }
      ]
    });
  }));
  root.querySelectorAll('[data-poster]').forEach(b => b.addEventListener('click', () => poster(b.dataset.poster, b.dataset.qrt)));

  root.querySelector('[data-act="copy-all"]')?.addEventListener('click', async () => {
    const text = memberLinks().map(l => `${l.label}\n${l.url}`).join('\n\n');
    if (await copyText(`【${profile().name || ''}】成員連結\n\n${text}`)) toast('已複製全部連結', 'ok');
  });
  root.querySelector('[data-act="print-all"]')?.addEventListener('click', () => printAllPosters());
  root.querySelector('[data-act="settings"]')?.addEventListener('click', () => settingsDialog());
}

function poster(url, label) {
  printDoc({
    title: label || '成員連結', org: profile().name,
    bodyHtml: `<div style="text-align:center">
      <div class="doc-org" style="letter-spacing:.2em">${esc(profile().name || '')}</div>
      <div class="doc-title" style="font-size:19pt;letter-spacing:.14em;margin:8pt 0 4pt">${esc(label || '')}</div>
      <div style="margin:16pt auto;width:240px">${qrSvg(url, 7, 2)}</div>
      <p style="font-size:12pt">用手機掃描上面嘅 QR Code 即用（<b>免登入</b>）。</p>
      <p class="mono" style="font-size:9pt;word-break:break-all">${esc(url)}</p>
    </div>`
  });
}

function printAllPosters() {
  const list = memberLinks();
  printDoc({
    title: '成員連結 QR 一覽', org: profile().name,
    bodyHtml: `<div class="doc-head"><div class="doc-title" style="font-size:17pt">成員連結 QR 一覽</div>
        <div class="doc-sub">${esc(profile().name || '')} · ${esc(new Date().toISOString().slice(0, 10))}</div></div>
      <table><tbody>
        ${list.map(l => `<tr><td style="width:44%">
            <div style="font-weight:700">${esc(l.label)}</div>
            <div class="mono" style="font-size:8pt;word-break:break-all">${esc(l.url)}</div>
          </td><td style="width:56%;text-align:center">${qrSvg(l.url, 5, 2)}</td></tr>`).join('')}
      </tbody></table>`
  });
}

async function settingsDialog() {
  const s = settings().publicLinks || {};
  const { modal: m } = await import('../lib/util.js');
  const r = await m({
    title: '公開頁網址', sub: '留空就用本網站嘅相對位置', wide: true,
    body: `
      <div class="grid g-2" style="gap:12px">
        <div class="field" style="grid-column:1/-1"><label class="label">基礎網址（可留空）</label>
          <input class="input" id="pl-base" value="${esc(s.base || '')}" placeholder="例：https://82.example.com/">
          <div class="hint">如果你把公開頁上載去另一個位置（學校網頁空間 / GitHub Pages），填呢度。</div></div>
        <div class="field"><label class="label">entry.html（收支申報）</label>
          <input class="input" id="pl-entry" value="${esc(s['entry.html'] || '')}"></div>
        <div class="field"><label class="label">borrow.html（物資借用）</label>
          <input class="input" id="pl-borrow" value="${esc(s['borrow.html'] || '')}"></div>
        <div class="field"><label class="label">notice.html（通告）</label>
          <input class="input" id="pl-notice" value="${esc(s['notice.html'] || '')}"></div>
        <div class="field"><label class="label">constitution.html（團章）</label>
          <input class="input" id="pl-cons" value="${esc(s['constitution.html'] || '')}"></div>
      </div>
      <div class="hint mt-8">現時用緊：<code>${esc(publicPageUrl('entry.html', { u: load().unitCode }))}</code></div>`,
    actions: [{ label: '取消', class: 'btn', value: null },
      { label: '儲存', class: 'btn-primary', onClick: el => ({
        base: el.querySelector('#pl-base').value.trim(),
        'entry.html': el.querySelector('#pl-entry').value.trim(),
        'borrow.html': el.querySelector('#pl-borrow').value.trim(),
        'notice.html': el.querySelector('#pl-notice').value.trim(),
        'constitution.html': el.querySelector('#pl-cons').value.trim()
      }) }]
  });
  if (!r) return;
  const db = load();
  db.settings = { ...db.settings, publicLinks: { ...(db.settings.publicLinks || {}), ...r } };
  commit();
  toast('已儲存公開頁網址', 'ok');
  window.dispatchEvent(new CustomEvent('v82:refresh'));
}

export function refresh() { window.dispatchEvent(new CustomEvent('v82:refresh')); }
