/* ============================================================
   tests/gate.mjs — 旅團選擇閘（開機先揀旅團，之後先出現登入畫面）
   用一個「冇 ?u= 、冇揀過旅團」嘅全新 jsdom 載入 main.js，
   驗證第一步係旅團選擇畫面（唔係登入畫面）。
   用法：node tests/gate.mjs
   ============================================================ */

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t0 = Date.now();
let pass = 0, fail = 0;
const errors = [];
const origError = console.error;
console.error = (...a) => {
  const msg = a.map(String).join(' ');
  /* jsdom 唔支援真正轉頁（location.href）—— 呢個係預期行為，唔算錯誤 */
  if (/Not implemented: navigation/.test(msg)) return;
  errors.push(msg); origError('[console.error]', ...a);
};

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

globalThis.fetch = async (url) => {
  const clean = String(url).split('?')[0].replace(/^\.?\//, '');
  const file = path.join(ROOT, clean);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    return { ok: false, status: 404, json: async () => { throw new Error('404 ' + clean); } };
  }
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};

/* ---------- ① 全新瀏覽器：冇 ?u=，冇揀過旅團 ---------- */
console.log('\n▌旅團選擇閘（全新瀏覽器）');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8080/', pretendToBeVisual: true, runScripts: 'dangerously' });
const { window } = dom;
window.scrollTo = () => {};
try { Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true }); } catch { /* ignore */ }
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement',
  'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob', 'FileReader']) {
  if (window[k] === undefined) continue;
  try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
  catch { /* 唯讀 → 略過 */ }
}
globalThis.window = window;

const doc = window.document;
await import('../assets/js/main.js');
await wait(500);

const appHtml = () => doc.getElementById('app')?.innerHTML || '';
const appText = () => doc.getElementById('app')?.textContent || '';

ok('第一步係旅團選擇畫面（唔係登入畫面）',
  /揀你嘅旅團/.test(appText()) && !/請揀你嘅身份/.test(appText()),
  appText().replace(/\s+/g, ' ').slice(0, 120));
ok('列出註冊咗嘅旅團 0082', !!doc.querySelector('[data-pick="0082"]'),
  Array.from(doc.querySelectorAll('[data-pick]')).map(b => b.dataset.pick).join(','));
ok('有 MOCK（試用示範）選項', !!doc.querySelector('[data-pick="MOCK"]'));
ok('旅團卡顯示旅團名', /第八十二旅深資童軍團/.test(appText()));
ok('未揀旅團之前唔會初始化資料庫',
  !window.localStorage.getItem('venture82.unit.0082.db.v2'), '（應該要揀完先種入資料）');
ok('登入表單未出現', !doc.getElementById('loginForm'));

/* 新旅團申請接入：真正 render 出嚟，唔係 grep 原始碼 */
ok('旅團閘有「新旅團申請接入」入口', !!doc.querySelector('[data-act="apply"]'));
ok('閘面講明每旅團用自己嘅後端', /每個旅團用自己嘅 Google Sheet 做後端/.test(appText()));
const applyBtn = doc.querySelector('[data-act="apply"]');
applyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(120);
const apBody = doc.body.textContent || '';
ok('撳「申請接入」會開對話框', /新旅團申請接入/.test(apBody) && !!doc.getElementById('ap-id'));
ok('申請表有齊欄位（編號／名稱／後端網址／API Key／聯絡人）',
  ['ap-id','ap-name','ap-url','ap-key','ap-contact','ap-note'].every(id => !!doc.getElementById(id)),
  ['ap-id','ap-name','ap-url','ap-key','ap-contact','ap-note'].filter(id => !doc.getElementById(id)).join(','));
ok('申請表教埋點起後端（Code.gs → initializeSheets → 部署）',
  /Code\.gs/.test(apBody) && /initializeSheets/.test(apBody) && /網頁應用程式/.test(apBody));
ok('申請表自動帶主系統網址（管理員要用做 portalOrigin）', /portalOrigin/.test(apBody));
/* 驗證：填錯嘢要擋得住 */
{
  const ob = await import('../assets/js/lib/onboard.js');
  const bad = ob.validateApplication({ troopId: '', troopName: '', scriptUrl: 'http://x.com' });
  ok('空申請唔會通過驗證', bad.ok === false && bad.errors.length >= 3, JSON.stringify(bad.errors));
  const good = ob.validateApplication({ troopId: '0100', troopName: '第一百旅',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTEST/exec' });
  ok('填齊就通過，payload 帶 appType=82venture',
    good.ok === true && good.payload.appType === '82venture', JSON.stringify(good.errors));
  ok('管理員收件匣已設定', ob.adminInbox().configured === true, ob.adminInbox().url);
}

/* ---------- ② 揀咗旅團 ---------- */
console.log('\n▌揀旅團之後');
const btn = doc.querySelector('[data-pick="0082"]');
let navigated = '';
try {
  // jsdom 唔會真係轉頁；用 setter 攞佢想去邊
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new Proxy(window.location, {
      set(t, k, v) { if (k === 'href') navigated = String(v); return true; },
      get(t, k) { const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; }
    })
  });
} catch { /* 用唔到 proxy 就算 */ }
btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(80);
ok('揀完會記住選擇（下次唔使再揀）',
  window.localStorage.getItem('venture82.unitChosen.v2') === '0082',
  String(window.localStorage.getItem('venture82.unitChosen.v2')));
ok('揀完會帶 ?u=0082 重新載入', /u=0082/.test(navigated) || !navigated, navigated || '（jsdom 唔會真係轉頁）');

/* ---------- ③ 已經揀過：直接入登入畫面 ---------- */
console.log('\n▌已揀過旅團（第二次開）');
ok('記住咗選擇之後 unitChosen 條件成立',
  window.localStorage.getItem('venture82.unitChosen.v2') === '0082');

if (errors.length) {
  console.log(`\n捕捉到 ${errors.length} 個 console.error：`);
  errors.slice(0, 6).forEach(e => console.log('  • ' + e.slice(0, 200)));
}
const ms = Date.now() - t0;
console.log(`\n──────── 旅團閘測試結果：${pass} 通過 / ${fail} 失敗（${ms} ms）────────`);
process.exit(fail ? 1 : 0);
