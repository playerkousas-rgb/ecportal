/* 團員入口：一條網址整合所有公開頁 */
import { loadRegistry, defaultUnitCode } from './lib/units.js';
import { init, load } from './lib/store.js';
import { memberLinks, profile } from './lib/model.js';
import { esc, icon } from './lib/util.js';

const app = document.getElementById('app');

async function boot() {
  const u = new URLSearchParams(location.search);
  const code = (u.get('u') || '').trim() || defaultUnitCode();
  await loadRegistry();
  await init({ mode: 'real', unit: code });
  const p = profile();
  const links = memberLinks();
  app.innerHTML = `
  <div class="hub-top">
    <div class="hub-wrap">
      <div class="xs" style="opacity:.8">團員入口 · 免登入</div>
      <div style="font-size:22px;font-weight:800;margin-top:4px">${esc(p.name || '深資童軍團')}</div>
      <div class="xs" style="opacity:.85;margin-top:4px">記帳、借用、通告、團章 —— 一頁搞掂</div>
    </div>
  </div>
  <div class="hub-wrap">
    ${links.map(l => `<a class="hub-card" href="${esc(l.url)}">
      <span class="stat-ic">${icon(l.icon, 18)}</span>
      <div class="grow"><div class="semibold">${esc(l.label)}</div>
        <div class="xs muted mt-4">${esc(l.desc)}</div></div>
    </a>`).join('') || '<p class="muted" style="padding:20px">暫時未有公開連結</p>'}
  </div>`;
}
boot().catch(e => {
  app.innerHTML = `<div style="padding:40px" class="muted">載入失敗：${esc(e.message || e)}</div>`;
});
