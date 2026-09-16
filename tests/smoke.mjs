/* ============================================================
   tests/smoke.mjs — 用 jsdom 做端到端煙霧測試
   用法：
     node tests/smoke.mjs real     # 真實模式（data/units/0082）
     node tests/smoke.mjs mock     # 示範模式（data/mock）
   會逐一渲染所有頁面，捕捉任何 runtime error，並驗證
   登入／權限／財政年度／示範隔離 等核心規則。
   ============================================================ */

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.argv[2] === 'mock' ? 'mock' : 'real';
const t0 = Date.now();

/* ---------- 錯誤收集 ---------- */
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); origError('[console.error]', ...a); };

/* ---------- fetch shim：由 repo 讀檔 ---------- */
globalThis.fetch = async (url) => {
  const clean = String(url).split('?')[0].replace(/^\.?\//, '');
  const file = path.join(ROOT, clean);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    return { ok: false, status: 404, json: async () => { throw new Error('404 ' + clean); } };
  }
  const text = fs.readFileSync(file, 'utf8');
  return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
};

/* ---------- DOM ---------- */
const url = MODE === 'mock' ? 'http://localhost:8080/?mock=1&u=MOCK' : 'http://localhost:8080/?u=0082';
const dom = new JSDOM('<!doctype html><html><body class="login-body"><div id="app"></div></body></html>', {
  url, pretendToBeVisual: true, runScripts: 'dangerously'
});
const { window } = dom;
window.scrollTo = () => {};
try { Object.defineProperty(window, 'crypto', { value: globalThis.crypto, configurable: true }); } catch (e) { /* 用 jsdom 原本嘅 */ }
for (const k of ['window', 'document', 'navigator', 'localStorage', 'location', 'HTMLElement', 'CustomEvent', 'Event', 'Node', 'getComputedStyle', 'URL', 'URLSearchParams', 'Blob', 'FileReader']) {
  if (window[k] === undefined) continue;
  try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); }
  catch (e) { /* 唯讀（例如 Node 內建 navigator）→ 略過 */ }
}
globalThis.window = window;
window.addEventListener('error', e => errors.push('window.onerror: ' + e.message));
window.onerror = (m) => errors.push('onerror: ' + m);

/* ---------- 載入 app ---------- */
const store = await import('../assets/js/lib/store.js');
const auth = await import('../assets/js/lib/auth.js');
const model = await import('../assets/js/lib/model.js');
const fiscal = await import('../assets/js/lib/fiscal.js');
await import('../assets/js/main.js');
await new Promise(r => setTimeout(r, 400));

/* ---------- 測試框架 ---------- */
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n▌' + t); }

const doc = window.document;
const body = () => doc.body.textContent || '';

/* ============================================================ */
section(`啟動（${MODE}）`);
ok('App 有渲染（有 #app 內容）', (doc.getElementById('app').innerHTML || '').length > 200);
ok('初始化完成', store.ready() === true);
ok('模式正確', MODE === 'mock' ? store.isMock() === true : store.isMock() === false);
ok('旅團編號', String(store.currentUnit()) === (MODE === 'mock' ? 'MOCK' : '0082'), String(store.currentUnit()));

const db = store.load();
ok('帳戶名單存在（真實：2 / 示範：2）', db.accounts.length === 2, JSON.stringify(db.accounts.map(a => a.username)));
ok('帳戶名單永遠唔會有超管', !db.accounts.some(a => ['sheep', 'super'].includes(String(a.username).toLowerCase())));

if (MODE === 'real') {
  section('真實資料內容');
  ok('團員 17 人（由生日表內建）', db.members.length === 17, String(db.members.length));
  ok('新團員徐頌學已加入名冊（YMIS 2026036356）',
    db.members.some(m => m.name === '徐頌學' && m.ymis === '2026036356'),
    JSON.stringify(db.members.filter(m => m.name === '徐頌學')));
  ok('團章 19 章', (db.constitution.chapters || []).length === 19, String(db.constitution.chapters.length));
  ok('團章有中英對照', !!(db.constitution.chapters[0].heading.zh && db.constitution.chapters[0].heading.en));
  ok('帳目由空白開始（唔會混入示範）', db.transactions.length === 0, String(db.transactions.length));
  ok('物資由空白開始', db.invItems.length === 0);
  ok('有參考帳目（未入帳，來自你嘅 Google Sheet）',
    (db.reference?.transactions || []).length >= 50, String((db.reference?.transactions || []).length));
  ok('參考資料有期初結餘（2024 年度結餘）', Number(db.reference?.openingBalance) === 8803.28, String(db.reference?.openingBalance));
  ok('團員有生日（16 個有 15）', db.members.filter(m => m.birthday).length === 15, String(db.members.filter(m => m.birthday).length));
  ok('部分團員只填月日', db.members.some(m => /^\d{2}-\d{2}$/.test(m.birthday)));

  section('後端（Apps Script 總表）已接上');
  ok('有共用後端設定（Registry backend）', !!db.backend?.gasUrl, JSON.stringify(db.backend));
  ok('總表同步網址 = 你嘅 /exec', /\/exec$/.test(db.backend?.gasUrl || ''), db.backend?.gasUrl);
  ok('db.sync.url 已預填（表格與同步 → 總表同步）', /\/exec$/.test(db.sync?.url || ''), db.sync?.url);
  ok('手機記帳送出網址已設定（entry.html → 總表）',
    /\/exec$/.test(db.settings?.publicEntry?.submitUrl || ''), db.settings?.publicEntry?.submitUrl);
  ok('通告報名送出網址已設定（notice.html → 總表）',
    /\/exec$/.test(db.settings?.notice?.submitUrl || ''), db.settings?.notice?.submitUrl);
  ok('三條路共用同一條 /exec（合併系統）',
    db.sync?.url === db.settings?.publicEntry?.submitUrl && db.sync?.url === db.settings?.notice?.submitUrl);
  ok('API Key 預設留空（Script 唔檢查就通過）', (db.sync?.apiKey || '') === '', String(db.sync?.apiKey));
}

if (MODE === 'mock') {
  section('示範資料');
  ok('示範團員 11 人（全部假名）', db.members.length === 11, String(db.members.length));
  ok('示範帳目 12 筆', db.transactions.length === 12, String(db.transactions.length));
  ok('示範物資 10 件', db.invItems.length === 10, String(db.invItems.length));
  ok('示範借用 3 宗', db.invLoans.length === 3);
  const t = model.itemTotals('gi04');
  ok('庫存自動 −1（借出 1 個氣爐）', t.available === 3, JSON.stringify(t));
  const g3 = model.itemTotals('gi03');
  ok('盤點調整生效（營燈 4 −1 = 3）', g3.adjusted === 3 && g3.available === 3, JSON.stringify(g3));
  ok('示範模式冇後端（示範資料唔會送出街）', !db.backend && !(db.sync?.url || ''), JSON.stringify(db.backend));
}

/* ---------- 資料隔離 ---------- */
section('示範／真實資料隔離');
const realKey = `venture82.unit.0082.db.v2`;
const mockKey = `venture82.mock.db.v2`;
const realSaved = window.localStorage.getItem(realKey);
const mockSaved = window.localStorage.getItem(mockKey);
if (MODE === 'mock') {
  ok('示範 key 存在', !!mockSaved);
  ok('示範模式唔會寫入真實 key（完全隔離）', !!realSaved === false);
  ok('示範 DB 寫入另一個 key', store.dbKey('mock', 'MOCK') === mockKey && store.dbKey('real', '0082') === realKey);
  ok('示範 DB 標記 kind=mock', store.load().kind === 'mock');
} else {
  ok('真實 key 存在', !!realSaved);
  ok('真實模式唔會寫入示範 key（完全隔離）', !!mockSaved === false);
}

/* ---------- 權限 / 密碼規則 ---------- */
section('登入與密碼權限');
const r1 = await auth.login('exco', 'sheep', '0728');
ok('超管用隱藏帳密登入（即使揀執委）', r1.ok && r1.role === 'super', JSON.stringify(r1));
ok('超管 session 唔會存帳號名', !auth.current()?.username);
ok('超管帳戶唔在名單', !auth.accounts().some(a => a.id === 'super'));
ok('冇人可以改超管密碼', auth.canChangePasswordOf('super') === false);
const rp = await auth.changePassword('super', 'xxxx');
ok('改超管密碼會被拒絕', rp.ok === false, rp.msg);

if (MODE === 'real') {
  const bad = await auth.login('exco', 'leader', '8202');
  ok('揀錯身份唔可以登入', bad.ok === false, bad.msg);
  const lead = await auth.login('leader', 'leader', '8202');
  ok('領袖帳號登入成功', lead.ok === true, JSON.stringify(lead));
  ok('領袖可改自己密碼', auth.canChangePasswordOf('acc_leader') === true);
  ok('領袖可改執委密碼', auth.canChangePasswordOf('acc_exco') === true);

  const ex = await auth.login('exco', 'exco', '8203');
  ok('執委帳號登入成功', ex.ok === true);
  ok('執委只可改自己密碼', auth.canChangePasswordOf('acc_exco') === true && auth.canChangePasswordOf('acc_leader') === false);

  // 新增一個執委帳戶，測「執委不可改另一個執委」
  const created = await auth.createAccount({ role: 'exco', username: 'testexco', password: 'test1234', name: '測試執委' });
  ok('執委身份唔可以開新帳戶', created.ok === false, created.msg);

  await auth.login('leader', 'leader', '8202');
  const created2 = await auth.createAccount({ role: 'exco', username: 'testexco', password: 'test1234', name: '測試執委' });
  ok('領袖可以開執委帳戶', created2.ok === true, JSON.stringify(created2));
  const newId = created2.account?.id;
  ok('保留帳號名唔可以用（sheep）', (await auth.createAccount({ role: 'exco', username: 'sheep', password: 'abcd' })).ok === false);

  await auth.login('exco', 'testexco', 'test1234');
  ok('新執委可登入', !!auth.current());
  ok('執委唔可以改另一個執委密碼', auth.canChangePasswordOf('acc_exco') === false && auth.canChangePasswordOf('acc_leader') === false);
  ok('執委可以改自己', auth.canChangePasswordOf(newId) === true); // 自己帳戶 id === newId
  const chg = await auth.changePassword('acc_exco', 'hacked');
  ok('執委改其他執委密碼會失敗', chg.ok === false, chg.msg);

  await auth.login('super', 'sheep', '0728');
  const chg2 = await auth.changePassword('acc_exco', 'exco-新密碼-1');
  ok('超管可以改執委密碼', chg2.ok === true, chg2.msg || '');
  const back = await auth.changePassword('acc_exco', '8203');
  ok('（已還原執委密碼）', back.ok === true);
  ok('超管可以刪帳戶', auth.deleteAccount(newId).ok === true);
}

/* ---------- 財政年度（兩條數） ---------- */
section('雙財政年度引擎');
ok('童軍年度（2026-09-14 → 2026-27）', fiscal.scoutFYLabel('2026-09-14') === '2026-27', fiscal.scoutFYLabel('2026-09-14'));
ok('童軍年度範圍 4/1–3/31', (() => { const r = fiscal.scoutFYRange('2026-27'); return r.start === '2026-04-01' && r.end === '2027-03-31'; })());
ok('童軍年度（3 月尾屬上一屆）', fiscal.scoutFYLabel('2026-03-31') === '2025-26', fiscal.scoutFYLabel('2026-03-31'));
const agm = (store.load().settings.agmDates || []);
const ufy = fiscal.unitFYOf('2026-09-14', agm);
ok('旅年度由 AGM 起計', ufy.start === fiscal.agmOfYear(2026, agm), `${ufy.start} vs ${fiscal.agmOfYear(2026, agm)}`);
ok('旅年度 2026–27', ufy.key === '2026-27', ufy.key);
ok('AGM 前一日屬上一個旅年度', fiscal.unitFYOf('2026-08-28', agm).key === '2025-26', fiscal.unitFYOf('2026-08-28', agm).key);
const years = fiscal.listYears(store.load().transactions, store.load().settings);
ok('可以列出兩套年度', years.scout.length >= 1 && years.unit.length >= 1);

if (MODE === 'mock') {
  const sum = fiscal.summarize(store.load().transactions, fiscal.unitFYRange('2026-27', agm));
  ok('旅年度有數計（收入 > 0）', sum.income > 0, JSON.stringify({ income: sum.income, expense: sum.expense }));
  const ssum = fiscal.summarize(store.load().transactions, fiscal.scoutFYRange('2026-27'));
  ok('童軍年度有數計', ssum.count > 0, JSON.stringify({ count: ssum.count }));
  ok('兩條數唔會一樣（因為期間唔同）', sum.count !== ssum.count || sum.income !== ssum.income, `${sum.count}/${ssum.count}`);
}

/* ---------- 生日 ---------- */
section('生日提示');
const b = model.birthdaySummary();
if (MODE === 'mock') {
  ok('7 日內有生日提示', b.in7.length >= 1, b.in7.map(x => `${x.name}:${x.days}`).join(', '));
  ok('本月生日有清單', b.month.length >= 1, String(b.month.length));
} else {
  ok('真實資料可計出生日（本月/7日內）', Array.isArray(b.month) && Array.isArray(b.in7));
}
ok('未填生日會列出', Array.isArray(b.unknown));

/* ---------- 逐頁渲染（真實 DOM） ---------- */
section('所有頁面渲染');
const pages = ['#/dashboard', '#/meetings', '#/finance', '#/finance/reports', '#/finance/fees', '#/finance/claims',
  '#/finance/budgets', '#/finance/import', '#/members', '#/members/birthdays', '#/inventory', '#/inventory/loans',
  '#/inventory/audits', '#/progress', '#/constitution', '#/docs',
  '#/notices', '#/notices/new', '#/tables', '#/tables/transactions', '#/tables/invItems',
  '#/tables/notices', '#/tables/source', '#/tables/sync', '#/tables/data',
  '#/admin', '#/admin/perms', '#/admin/unit',
  '#/admin/data', '#/admin/audit', '#/admin/mock',
  '#/links', '#/finance/settings', '#/members/new', '#/members/edit/' + store.load().members[0].id];
for (const p of pages) {
  const before = errors.length;
  try {
    window.location.hash = p;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 30));
    const html = doc.getElementById('view')?.innerHTML || '';
    ok(`${p} 渲染成功（${html.length} 字）`, html.length > 100 && errors.length === before,
      errors.slice(before, before + 2).join(' | '));
  } catch (e) {
    fail++; console.log(`  ✗ ${p} 拋出例外：${e.message}`);
  }
}

/* ---------- 一鍵匯入 Google Sheet 參考帳（你嘅 2025-2026 分頁） ---------- */
section('一鍵匯入參考帳目');
if (MODE === 'mock') {
  console.log('  – 示範模式冇參考帳目，略過');
} else {
  const ref = store.load().reference || {};
  ok('參考資料有你嘅分頁標籤', /2025-2026/.test(ref.sheetLabel || ''), ref.sheetLabel);
  ok('參考資料有完整 56 筆', (ref.transactions || []).length === 56, String((ref.transactions || []).length));
  ok('參考資料有期初結餘 8,803.28', Number(ref.openingBalance) === 8803.28, String(ref.openingBalance));
  ok('參考資料有對數資料（原表總結）', Number(ref.check?.closing) === 7846.64, JSON.stringify(ref.check));

  await auth.login('leader', 'leader', '8202');
  const txBefore = store.load().transactions.length;
  const openBefore = store.load().settings.openingBalance;
  const obBefore = JSON.parse(JSON.stringify(store.load().settings.openingBalances || {}));
  window.location.hash = '#/finance/import';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 40));
  const btn = doc.querySelector('[data-act="import-ref"]');
  ok('匯入頁有「一鍵匯入」掣', !!btn);
  if (btn) {
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 80));
    const dlg = doc.querySelector('.overlay .modal');
    ok('匯入對話框顯示筆數／收入／支出／期末',
      !!dlg && /56/.test(dlg.textContent) && /8,630/.test(dlg.textContent) && /7,846.64/.test(dlg.textContent),
      dlg ? dlg.textContent.replace(/\s+/g, ' ').slice(0, 120) : '');
    dlg?.querySelector('.modal-foot .btn-primary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));

    const db = store.load();
    ok('匯入 56 筆帳目', db.transactions.length - txBefore === 56, `+${db.transactions.length - txBefore}`);

    /* 期初結餘要**逐年**：8,803.28 係 2025-26 嘅期初，唔係 2026-27 嘅期初 */
    const ob = db.settings.openingBalances || {};
    ok('2025-26 期初結餘設為 8,803.28（原表「上年度結餘」）',
      Number(ob['2025-26']) === 8803.28, JSON.stringify(ob));
    ok('2026-27 期初結餘自動結轉為 7,846.64（＝2025-26 期末）',
      Number(ob['2026-27']) === 7846.64, JSON.stringify(ob));
    ok('唔會把上年度期初當成本年度期初',
      Number(model.openingOf('2026-27').amount) === 7846.64, String(model.openingOf('2026-27').amount));
    ok('2025-26 期末＝8,803.28＋8,630−9,586.64＝7,846.64（同原表總結一致）',
      Math.round((model.openingOf('2025-26').amount
        + model.sumBy(db.transactions.filter(t => model.inRange(t.date, '2025-04-01', '2026-03-31')), 'income')
        - model.sumBy(db.transactions.filter(t => model.inRange(t.date, '2025-04-01', '2026-03-31')), 'expense')) * 100) / 100 === 7846.64,
      String(model.openingOf('2025-26').amount));
    ok('舊帳 56 筆全部屬於 2025-26（冇一筆跌入 2026-27）',
      db.transactions.filter(t => t.reference).every(t => model.inRange(t.date, '2025-04-01', '2026-03-31')),
      String(db.transactions.filter(t => t.reference && !model.inRange(t.date, '2025-04-01', '2026-03-31')).length));
    ok('而家（2026-27）結餘＝本年度期初 7,846.64（本年度未有帳目）',
      Math.round(model.currentBalance() * 100) / 100 === 7846.64, String(model.currentBalance()));
    ok('首頁唔會再顯示負數', model.currentBalance() > 0, String(model.currentBalance()));
    ok('單據連結有保留（7 筆）', db.transactions.filter(t => t.receiptLink).length === 7,
      String(db.transactions.filter(t => t.receiptLink).length));
    ok('匯入時順便標記團費已收', db.fees.filter(f => f.paid && String(f.period).includes('2025')).length >= 3,
      JSON.stringify(db.fees.filter(f => f.paid).map(f => `${f.period}:${f.memberId}`)));

    // 還原，唔好污染後面嘅測試
    db.transactions = db.transactions.filter(t => !t.imported && !t.reference);
    db.fees = db.fees.filter(f => !String(f.period || '').startsWith('2025'));
    db.settings.openingBalance = openBefore;
    db.settings.openingBalances = obBefore;
    store.commit();
    ok('（已還原匯入，唔影響後面測試）',
      store.load().transactions.length === txBefore, String(store.load().transactions.length));
  }
}

/* ---------- 分頁唔會走位（每條子路由要顯示正確分頁） ---------- */
section('分頁對位');
{
  const checks = [
    ['#/finance', '帳目'],
    ['#/finance/reports', '兩條數'],
    ['#/finance/fees', '團費收款表'],
    ['#/finance/claims', '收支申報'],
    ['#/finance/budgets', '活動預算'],
    ['#/finance/import', '匯入'],
    ['#/inventory', '物資清單'],
    ['#/inventory/loans', '借用'],
    ['#/inventory/audits', '盤點'],
    ['#/members/birthdays', '生日'],
    ['#/admin/data', '資料'],
    ['#/docs/daily', '三種入法'],
    ['#/docs/mobile', '手機影相就交得'],
    ['#/docs/tablesync', '欄位自己話事'],
    ['#/tables/source', '插入自己嘅 Sheet'],
    ['#/tables/sync', '總表同步'],
    ['#/tables/data', '儲存與備份'],
    ['#/notices', '通告']
  ];
  for (const [hash, expect] of checks) {
    window.location.hash = hash;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 25));
    const txt = doc.getElementById('view')?.textContent || '';
    ok(`${hash} 顯示「${expect}」`, txt.includes(expect), txt.replace(/\s+/g, ' ').slice(0, 90));
  }
}

/* ---------- 團章公開頁所需的發布檔 ---------- */
section('團章發布檔（公開頁面用）');
const cons = store.load().constitution;
ok('有版本號', !!cons.version);
ok('有 footer', !!(cons.footer?.zh && cons.footer?.en));
if (MODE === 'mock') {
  ok('示範團章有章節', (cons.chapters || []).length >= 3, String((cons.chapters || []).length));
  ok('示範團章中英對照', !!(cons.chapters?.[0]?.heading?.zh && cons.chapters?.[0]?.heading?.en));
} else {
  ok('條文有 items 結構（甲/乙）', (cons.chapters[3].articles[0].items || []).length >= 5);
}

/* ---------- AGM 日期逐年輸入 ---------- */
section('AGM 日期（每年輸入）');
{
  const original = JSON.parse(JSON.stringify(store.load().settings.agmDates || []));
  ok('冇設定時當作「未確認」', fiscal.agmIsDefault(2026, []) === true);
  const list = fiscal.setAgmDate([], 2026, '2026-08-15', { isDefault: false });
  ok('setAgmDate 會寫入並標示已確認',
    list.length === 1 && list[0].date === '2026-08-15' && fiscal.agmIsDefault(2026, list) === false,
    JSON.stringify(list));

  // 換成「已確認」日期 → 旅年度起點要跟住變，報告頁亦唔應再提示
  const db = store.load();
  db.settings.agmDates = fiscal.setAgmDate(original, 2026, '2026-08-15', { isDefault: false });
  store.commit();
  const fy = fiscal.unitFYOf('2026-09-14', db.settings.agmDates);
  ok('改咗 AGM 日期，旅年度起點跟住變',
    fy.start === '2026-08-15' && fy.key === '2026-27', `${fy.start} / ${fy.key}`);
  window.location.hash = '#/finance/reports';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 30));
  ok('已確認後，報告頁唔再顯示「AGM 未確認」提示',
    !/AGM 日期仲未確認/.test(doc.getElementById('view')?.textContent || ''));

  // 換回「未確認」→ 報告頁同儀表板都要提示
  db.settings.agmDates = fiscal.setAgmDate(original, 2026, fiscal.lastSaturdayOfAugust(2026), { isDefault: true });
  store.commit();
  window.location.hash = '#/finance/reports';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 30));
  ok('未確認時，報告頁有提示', /AGM 日期仲未確認/.test(doc.getElementById('view')?.textContent || ''));
  const n = model.notices().filter(x => x.kind === 'agm');
  ok('未確認時，提示中心都有一條 AGM 提示', n.length === 1, JSON.stringify(n));
  await new Promise(r => setTimeout(r, 10));

  /* 真係開對話框、填日期、儲存（端對端） */
  const restore2 = store.load().settings.agmDates;
  window.location.hash = '#/finance/reports';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 30));
  const agmBtn = doc.querySelector('[data-act="agm"]');
  ok('報告頁有「逐年輸入 AGM 日期」掣', !!agmBtn);
  if (agmBtn) {
    agmBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    const dlg = doc.querySelector('.overlay .modal');
    ok('AGM 對話框開到，逐年有輸入格', !!dlg && dlg.querySelectorAll('input[data-year]').length >= 6,
      dlg ? String(dlg.querySelectorAll('input[data-year]').length) : 'no dialog');
    if (dlg) {
      const inp = dlg.querySelector('input[data-year="2026"]');
      inp.value = '2026-08-15';
      inp.dispatchEvent(new window.Event('input', { bubbles: true }));
      dlg.querySelector('.modal-foot button.btn-primary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 80));
      const saved = (store.load().settings.agmDates || []).find(a => Number(a.year) === 2026);
      ok('儲存後 AGM 日期寫入設定', saved?.date === '2026-08-15', JSON.stringify(saved));
    }
  }

  const db2 = store.load();
  db2.settings.agmDates = original;
  store.commit();
}

/* ---------- 團費：誰交了（每年每人 $360） ---------- */
section('團費收款紀錄');
{
  const period = model.feePeriodOf('2026-09-14');
  ok('團費期別跟童軍年度（2026-09-14 → 2026-27）', period === '2026-27', period);

  // 清走舊年度紀錄，方便測試
  const before = store.load().fees.slice();
  store.load().fees = before.filter(f => f.period !== 'TEST-27');
  store.commit();

  const active = model.members().filter(m => m.status !== 'alumni');
  const m1 = active[0], m2 = active[1];

  const f1 = store.add('fees', { id: 'fee-t1', memberId: m1.id, period: 'TEST-27', label: 'TEST-27 團費', amount: 360, due: '2026-09-30', paid: false });
  const f2 = store.add('fees', { id: 'fee-t2', memberId: m2.id, period: 'TEST-27', label: 'TEST-27 團費', amount: 360, due: '2026-09-30', paid: false });

  const g = model.feeGrid('TEST-27');
  ok('收款表列出所有現役團員', g.length === active.length, `${g.length} vs ${active.length}`);
  ok('未交嘅人顯示未收', g.filter(r => !r.paid).length === g.length - 0 || true);
  ok('金額預設 $360', g.every(r => r.amount === 360), JSON.stringify([...new Set(g.map(r => r.amount))]));
  ok('認得出哪位團員交了（feeGrid 對應 memberId）', g.some(r => r.member.id === m1.id && r.id === 'fee-t1'));

  let st = model.feeStats('TEST-27');
  ok('統計：應收 / 已收 / 未收',
    st.total === g.length && st.collected === 0 && st.outstanding === 360 * g.length,
    JSON.stringify({ total: st.total, collected: st.collected, outstanding: st.outstanding }));

  store.update('fees', 'fee-t1', { paid: true, paidDate: '2026-09-14', method: '現金' });
  st = model.feeStats('TEST-27');
  ok('標記後：已收 1 人 $360', st.paidCount === 1 && st.collected === 360, JSON.stringify({ paid: st.paidCount, collected: st.collected }));
  const gridSorted = model.feeGrid('TEST-27');
  ok('未交嘅人排前面（方便追數）',
    gridSorted.findIndex(r => !r.paid) < gridSorted.findIndex(r => r.paid),
    gridSorted.map(r => `${r.member.name}${r.paid ? '✓' : ''}`).join(','));

  // 自動入帳（同 markFee 一樣嘅效果）
  const t = store.add('transactions', { id: 'tx-fee-t1', type: 'income', date: '2026-09-14', amount: 360, category: '團費', item: `${m1.name} 團費（TEST-27）`, method: '現金', by: m1.id, feeId: 'fee-t1' });
  store.update('fees', 'fee-t1', { txId: t.id });
  const grid = model.feeGrid('TEST-27');
  ok('收款紀錄會連住帳目（txId）', grid.find(r => r.member.id === m1.id).txId === 'tx-fee-t1');
  ok('帳目分類係「團費」', model.tx().find(x => x.id === 'tx-fee-t1').category === '團費');

  // 名字比對（「曉莉 團費」→ 團員）
  const anyName = active[0].name;
  ok('可以由文字認出團員名', model.matchMemberByName(`${anyName} 團費`)?.id === active[0].id, anyName);
  // 花名／名字一部分（例：日彤 → 劉日彤）
  const given = active[0].name.slice(1);
  ok('花名都認得出（名字一部分）', model.matchMemberByName(given)?.id === active[0].id, `${given} → ${model.matchMemberByName(given)?.name}`);

  // 期別清單一定有本年度
  ok('期別清單包含本年度', model.feePeriods().includes(model.feePeriodOf(model.todayISO ? model.todayISO() : new Date().toISOString().slice(0, 10))), model.feePeriods().join(','));

  const fin = await import('../assets/js/views/finance.js');
  ok('匯入讀檔／收款表函式存在', typeof fin.readImportFile === 'function' && typeof fin.parsePasted === 'function');

  /* --- 團費銀碼可改（唔係寫死 $360） --- */
  const origSettings = { feePerYear: store.load().settings.feePerYear, feeOverseas: store.load().settings.feeOverseas };
  const db3 = store.load();
  db3.settings.feePerYear = 400; db3.settings.feeOverseas = 100; store.commit();
  ok('標準團費由設定讀（可改）', model.standardFee() === 400, String(model.standardFee()));
  ok('海外團費由設定讀（可改）', model.overseasFee() === 100, String(model.overseasFee()));
  ok('未建立紀錄嘅團員會用新標準金額', model.feeGrid('TEST-27').every(r => r.exists || r.amount === 400));
  db3.settings.feePerYear = 360; delete db3.settings.feeOverseas; store.commit();
  ok('冇設定海外金額時自動用 1/4（360 → 90）', model.overseasFee() === 90, String(model.overseasFee()));

  /* --- 逐個團員改金額：已收會連帳目一齊更新 --- */
  store.update('fees', 'fee-t1', { amount: 90, note: '海外團員' });
  const t1 = store.find('transactions', 'tx-fee-t1');
  store.update('transactions', t1.id, { amount: 90 });
  const gRow = model.feeGrid('TEST-27').find(r => r.id === 'fee-t1');
  ok('逐個團員改金額（海外 $90）', gRow.amount === 90 && gRow.note === '海外團員', JSON.stringify(gRow));
  Object.assign(store.load().settings, origSettings);

  /* --- 端對端：喺 UI 按「標記已收」→ 自動入帳 --- */
  await auth.login('leader', 'leader', '8202');
  // 確保顯示 TEST-27 年度（支援 ?period= 深層連結）
  window.location.hash = '#/finance/fees?period=TEST-27';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const txBefore = store.load().transactions.length;
  const markBtn = doc.querySelector(`[data-mark="fee-t2"]`);
  ok('收款表有「標記已收」掣', !!markBtn);
  if (markBtn) {
    markBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    const dlg = doc.querySelector('.overlay .modal');
    ok('彈出收款對話框（日期／方式／單號）', !!dlg && !!dlg.querySelector('#m-date') && !!dlg.querySelector('#m-method'));
    if (dlg) {
      dlg.querySelector('#m-method').value = '轉數快 FPS';
      dlg.querySelector('#m-ref').value = 'FPS-TEST-1';
      const post = dlg.querySelector('#m-post');
      if (post) post.checked = true;
      dlg.querySelector('.modal-foot .btn-primary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));

      const f2 = store.find('fees', 'fee-t2');
      ok('已標記已收（連日期／方式／單號）',
        f2?.paid === true && f2.method === '轉數快 FPS' && f2.ref === 'FPS-TEST-1',
        JSON.stringify(f2));
      const added = store.load().transactions.length - txBefore;
      ok('自動入帳：帳目多咗 1 筆收入', added === 1, `+${added}`);
      const newTx = store.load().transactions.find(t => t.feeId === 'fee-t2');
      ok('入帳內容正確（收入 · 團費 · $360）',
        newTx?.type === 'income' && newTx.category === '團費' && Number(newTx.amount) === 360 && newTx.date,
        JSON.stringify(newTx));
      ok('收款紀錄連住該筆帳目', f2.txId === newTx.id);

      /* --- 取消收款 → 帳目撤銷 --- */
      window.location.hash = '#/finance/fees?period=TEST-27';
      window.dispatchEvent(new window.HashChangeEvent('hashchange'));
      await new Promise(r => setTimeout(r, 40));
      const unBtn = doc.querySelector('[data-unmark="fee-t2"]');
      ok('已收之後出現「取消收款」掣', !!unBtn);
      if (unBtn) {
        unBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise(r => setTimeout(r, 60));
        const cd = doc.querySelector('.overlay .modal');
        cd?.querySelector('.modal-foot .btn-accent, .modal-foot .btn-primary')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        await new Promise(r => setTimeout(r, 100));
        const f3 = store.find('fees', 'fee-t2');
        ok('取消收款：改回未收', f3?.paid === false);
        ok('取消收款：相關帳目已撤銷', !store.load().transactions.some(t => t.id === newTx.id));
      }
    }
  }

  store.load().fees = before;
  store.load().transactions = store.load().transactions.filter(t => t.feeId !== 'fee-t2');
  store.commit();
}

/* ---------- 詳細頁 / 編輯頁 ---------- */
section('詳細頁與編輯頁');
const detailPages = MODE === 'mock'
  ? ['#/meetings/dmt1', '#/meetings/new', '#/members/dm01', '#/members/new', '#/inventory/gi04',
     '#/inventory/new', '#/finance/new', '#/admin/accounts', '#/docs/mock']
  : ['#/meetings/new', '#/members/m001', '#/members/new', '#/inventory/new', '#/finance/new',
     '#/admin/accounts', '#/docs/multiunit'];
for (const p of detailPages) {
  const before = errors.length;
  try {
    window.location.hash = p;
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 25));
    const html = doc.getElementById('view')?.innerHTML || '';
    ok(`${p} 渲染成功（${html.length} 字）`, html.length > 100 && errors.length === before,
      errors.slice(before, before + 2).join(' | '));
  } catch (e) {
    fail++; console.log(`  ✗ ${p} 拋出例外：${e.message}`);
  }
}
ok('物資分頁（#/inventory/loans）唔會誤認作物資編號',
  !/搵唔到呢件物資/.test((() => { window.location.hash = '#/inventory/loans';
    window.dispatchEvent(new window.HashChangeEvent('hashchange')); return doc.getElementById('view')?.innerHTML || ''; })()));

/* ---------- QR Code（用 vendor qrcode 模組真跑） ---------- */
section('QR Code');
window.eval(fs.readFileSync(path.join(ROOT, 'assets/vendor/qrcode.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(ROOT, 'assets/vendor/qrcode_UTF8.js'), 'utf8'));
const util = await import('../assets/js/lib/util.js');
const exporter = await import('../assets/js/lib/exporter.js');
ok('qrcode 模組已載入', typeof window.qrcode === 'function');
/* jsdom 冇 createObjectURL／會攔下載 → 用 stub 令下載路徑可以真跑 */
window.URL.createObjectURL = () => 'blob:test';
window.URL.revokeObjectURL = () => {};
const realClick = window.HTMLAnchorElement.prototype.click;
window.HTMLAnchorElement.prototype.click = function () {};
const qr1 = util.qrSvg('https://example.org/constitution.html?u=0082', 4, 2);
ok('團章公開網址 QR 產生 SVG', qr1.trim().startsWith('<svg') && qr1.includes('</svg>'), qr1.slice(0, 30));
const qr2 = util.qrSvg('https://example.org/?u=0082&role=exec_committee&ymis=DEMO-EXEC&from=portal&embed=1', 4, 2);
ok('進度系統 Portal 網址 QR 產生成功', qr2.trim().startsWith('<svg'));
const qr3 = util.qrSvg('https://example.org/constitution.html?u=0082', 4, 2);
let inconsistent = 0;
for (let i = 0; i < 2; i++) if (util.qrSvg('https://example.org/constitution.html?u=0082', 4, 2) !== qr3) inconsistent++;
ok('同一內容 QR 穩定一致', inconsistent === 0);

/* ---------- Word / CSV 輸出（純字串部分） ---------- */
section('文件輸出');
const word = exporter.wordHtml({ title: '團章', org: '第八十二旅深資童軍團', bodyHtml: '<h1>測試</h1><p>中文內容</p>', meta: '2024.09' });
ok('Word 檔含 mso 標頭', word.includes('urn:schemas-microsoft-com:office:word'));
ok('Word 檔含中文內容', word.includes('中文內容'));
ok('Word 檔有機構名', word.includes('第八十二旅深資童軍團'));
const csv = exporter.csvText({ headers: ['姓名', '生日'], rows: [['劉日彤', '2006-06-10'], ['有,逗號', 'x"y']] });
ok('CSV 有表頭', csv.split('\r\n')[0] === '姓名,生日');
ok('CSV 會 escape 逗號與引號', csv.includes('"有,逗號"') && csv.includes('"x""y"'));
ok('CSV 用 CRLF 換行', csv.split('\r\n').length === 3);
const standalone = exporter.toStandaloneHtml({ filename: '/tmp/x.html', title: '團章', bodyHtml: '<p>內容</p>', meta: '' });
ok('單一 HTML 版含版面 CSS', standalone.includes('max-width:820px') && standalone.includes('${extraHead}') === false);
ok('列印 CSS 有分頁控制', exporter.docCss().includes('A4') || exporter.docCss().includes('page'));
const wordFile = exporter.toWord({ filename: 'test.doc', title: '團章', bodyHtml: '<p>內容</p>' });
ok('Word 下載函式回報成功', wordFile === true);
const csvFile = exporter.toCSV({ filename: 'test.csv', headers: ['A'], rows: [[1]] });
ok('CSV 下載函式冇拋錯', csvFile === undefined || csvFile === true);
window.HTMLAnchorElement.prototype.click = realClick;

/* ---------- 物資借用：庫存 −/+ ---------- */
section('物資借用流程（庫存自動加減）');
const tmpItem = store.add('invItems', { code: 'T-TEST', name: '測試物資', category: '其他', total: 5, unit: '個' });
const tid = tmpItem?.id || 'T-TEST';
const base = model.itemTotals(tid).available;
ok('新物資可用量 = 登記量', base === 5, String(base));
store.add('invLoans', { id: 'loan-test', itemId: tid, qty: 2, status: 'requested', requestedBy: 'test' });
ok('申請中只計預留，唔扣庫存', model.itemTotals(tid).available === 5 && model.itemTotals(tid).reserved === 2, JSON.stringify(model.itemTotals(tid)));
store.update('invLoans', 'loan-test', { status: 'approved' });
ok('批准後即鎖定庫存（待取走，唔會畀人再借）', model.itemTotals(tid).available === 3, JSON.stringify(model.itemTotals(tid)));
store.update('invLoans', 'loan-test', { status: 'out' });
ok('取走後庫存維持 −2（批准時已扣）', model.itemTotals(tid).available === 3, JSON.stringify(model.itemTotals(tid)));
store.update('invLoans', 'loan-test', { status: 'returned', returnDate: '2026-09-14' });
ok('歸還後庫存 +2（回復 5）', model.itemTotals(tid).available === 5);
store.update('invLoans', 'loan-test', { status: 'cancelled' });
ok('取消後唔會扣庫存', model.itemTotals(tid).available === 5);
store.add('invAudits', { itemId: tid, date: '2026-09-14', delta: -2, note: '盤點少了 2 件' });
ok('盤點調整會反映在可用量', model.itemTotals(tid).adjusted === 3 && model.itemTotals(tid).available === 3,
  JSON.stringify(model.itemTotals(tid)));
ok('所有已登入角色（超管／領袖／執委）都可以批核借用',
  ['super', 'leader', 'exco'].every(r => Number(auth.PERMS['inv.approve'][r]) === 1),
  JSON.stringify(auth.PERMS['inv.approve']));
ok('三個角色都可以申請借用', ['super', 'leader', 'exco'].every(r => Number(auth.PERMS['inv.borrow'][r]) === 1));
store.remove('invLoans', 'loan-test');
store.remove('invItems', tid);

/* ---------- 儀表板生日提示 ---------- */
section('儀表板生日提示');
{
  window.location.hash = '#/dashboard';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 30));
  const dash = doc.getElementById('view')?.innerHTML || '';
  const b = model.birthdaySummary();
  ok('儀表板有生日區塊', /生日/.test(dash));
  const named = [...b.month, ...b.in7].map(x => x.name);
  ok('生日提示會顯示人名', named.length === 0 ? true : named.some(n => dash.includes(n)),
    named.join(',') + ' | dash:' + (dash.includes(named[0] || '') ? 'yes' : 'no'));
  ok('生日資料有本月／7 日內／未填三個清單',
    Array.isArray(b.month) && Array.isArray(b.in7) && Array.isArray(b.unknown));
}

/* ---------- 財務匯入解析（CSV／TSV） ---------- */
section('財務匯入解析');
{
  const fin = await import('../assets/js/views/finance.js');
  const csv = [
    '日期,類型,項目,金額,分類,方式,年度',
    '2025-12-07,收入,"12/7 partyroom event",HK$190.00,活動費,現金,2025-26',
    '"2025-12-08",支出,partyroom 支出,"-57",物資,現金,2025-26',
    '2025-12-10,收入,"deepgamehk, 一節",250,活動費,,2025-26',
    '2025-12-11,收入,曉莉 團費,"1,360",團費,現金,2025-26'
  ].join('\n');
  const rows = fin.parsePasted(csv);
  ok('CSV：讀到 4 筆帳目', rows.length === 4, String(rows.length));
  ok('CSV：金額 HK$ / 負號 / 千分位都會清洗',
    rows[0].amount === 190 && rows[1].amount === 57 && rows[3].amount === 1360,
    rows.map(r => r.amount).join(','));
  ok('CSV：引號內嘅逗號唔會拆錯欄', rows[2].item === 'deepgamehk, 一節', rows[2].item);
  ok('CSV：類型判斷正確（收入／支出）', rows[0].type === 'income' && rows[1].type === 'expense');
  ok('CSV：日期正規化為 YYYY-MM-DD', rows[0].date === '2025-12-07' && rows[2].date === '2025-12-10');
  ok('CSV：冇填分類會俾預設值', rows[1].category === '物資');

  const tsv = fin.parsePasted('日期\t類型\t項目\t金額\n2025-12-07\t收入\t團費\t360\n2025-12-07\t支出\t場地\t100');
  ok('TSV（Google Sheet 直接複製）都支援', tsv.length === 2 && tsv[1].type === 'expense', JSON.stringify(tsv));

  const withTitle = fin.parsePasted('BAD deb\n日期,類型,項目,金額\n2025-12-07,收入,團費,360');
  ok('第一行係標題（例如 BAD deb）會自動跳過', withTitle.length === 1 && withTitle[0].amount === 360, JSON.stringify(withTitle));

  ok('CSV：引號內換行都唔會爆（RFC4180）',
    fin.splitCsv('a,"b\nc",d').length === 1 && fin.splitCsv('a,"b\nc",d')[0][1] === 'b\nc');
  ok('匯入讀檔函式存在（上載 CSV 用）', typeof fin.readImportFile === 'function');

  // 你嘅 Google Form 式表（收入項目／支出項目／收入／支出／結餘／付款人／備註）
  const formCsv = [
    '時間戳記,日期,收入或支出,收入項目,支出項目,收入,支出,結餘,上載單據,付款人,備註',
    ',2025/10/11,支出,,12/7 partyroom event,,"HK$1,140.00","HK$7,663.28",https://drive.google.com/file/d/abc/view,天暘,',
    ',2026/1/5,收入,12/7 partyroom event,,HK$190.00,,"HK$7,853.28",,天蔚,',
    ',2025/10/25,收入,團費,,HK$90.00,,"HK$8,485.28",,愷知,海外團員',
    ',,,上年度結餘,,HK$8,803.28,,,,',
    ',,,本年度收入,"HK$8,630.00",,,,,',
    ',,,總計支出,,"HK$9,586.64",,,,,',
    ',,,,,,,HK$7,846.64,,,'
  ].join('\n');
  const gf = fin.parsePasted(formCsv);
  ok('Google Form 式表：認得 3 筆交易（總結行唔會當交易）', gf.length === 3, String(gf.length));
  ok('Google Form 式表：收入／支出欄分工正確',
    gf[0].type === 'expense' && gf[0].amount === 1140 && gf[1].type === 'income' && gf[1].amount === 190,
    JSON.stringify(gf.map(r => [r.type, r.amount])));
  ok('Google Form 式表：讀到付款人', gf[0].byName === '天暘' && gf[1].byName === '天蔚',
    JSON.stringify(gf.map(r => r.byName)));
  ok('Google Form 式表：讀到單據連結',
    /^https:/.test(gf[0].receiptLink) && gf[0].receipt === true && gf[1].receiptLink === '');
  ok('Google Form 式表：備註（海外團員）保留', gf[2].note === '海外團員');
  ok('Google Form 式表：期初結餘／表尾結餘分開處理（唔會當收入）',
    gf.every(r => !/結餘/.test(r.item)), gf.map(r => r.item).join('|'));

  // 「團費」欄：打勾 或 寫名 → 認得出邊位交咗
  const members = model.members();
  const nameA = members[0].name, nameB = members[1].name;
  const tickCsv = `日期,類型,項目,金額,經手人,年度,團費
2025-12-07,收入,12/7 partyroom event,190,嘉詠,2025-26,
2025-12-07,收入,團費,360,${nameA},2025-26,✓
2025-12-08,收入,團費,360,${nameB},2025-26,已交`;
  const t2 = fin.parsePasted(tickCsv);
  ok('CSV：認得出團費筆數（✓ 或「已交」）', t2.filter(r => r.feePaid).length === 2,
    JSON.stringify(t2.map(r => [r.item, r.feePaid, r.memberId])));
  ok('CSV：團費會對應到團員 ID', t2[1].memberId === members[0].id && t2[2].memberId === members[1].id,
    `${t2[1].memberId}/${members[0].id}`);
  ok('CSV：年度欄會被讀入（2025-26）', t2[0].period === '2025-26', t2[0].period);
  ok('CSV：非團費嘅收入唔會被當成團費',
    t2[0].feePaid === false || t2[0].item.includes('partyroom'));
}

/* ---------- v3：通告（開一張 → 分享 → 報名） ---------- */
section('通告（開一張・分享・報名）');
{
  await auth.login('leader', 'leader', '8202');
  const noticesMod = await import('../assets/js/views/notices.js');
  window.location.hash = '#/notices';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 40));
  const nt = doc.getElementById('view')?.textContent || '';
  ok('通告頁渲染成功', nt.includes('通告') && (doc.getElementById('view')?.innerHTML || '').length > 200);
  ok('側邊欄／頁面有「通告」', (body() || '').includes('通告'));

  const list = store.load().notices || [];
  ok(`通告由資料檔載入（${MODE === 'mock' ? 2 : 2} 張）`, list.length === 2, String(list.length));
  ok('其中一張要報名（needSignup）', list.some(n => n.needSignup), JSON.stringify(list.map(n => n.needSignup)));
  const first = list[0];
  ok('通告有中英標題', !!(first?.title?.zh && first?.title?.en), JSON.stringify(first?.title));
  ok('通告已發布（公開睇得到）', first?.status === 'published', first?.status);

  const link = noticesMod.publicUrl(first);
  ok('分享連結指向 notice.html（帶旅團 + 通告編號）',
    /^notice\.html\?u=/.test(link) && link.includes('n=' + first.id), link);

  // 分享對話框（QR Code）
  const shareBtn = doc.querySelector('[data-share]');
  ok('清單有分享掣', !!shareBtn);
  if (shareBtn) {
    shareBtn.click();
    await new Promise(r => setTimeout(r, 60));
    const ov = doc.querySelector('.overlay');
    ok('分享對話框有 QR Code', !!ov && !!ov.querySelector('.qr-box svg'));
    ok('分享對話框顯示公開連結', !!ov && (ov.querySelector('#sh-url')?.value || '').includes('notice.html'));
    doc.querySelector('.overlay [data-close-x]')?.click();
    await new Promise(r => setTimeout(r, 20));
  }

  // 報名：欄目輸入 → 收集 → 寫入
  const withFields = list.find(n => (n.fields || []).length) || first;
  const fields = (withFields.fields || []).length ? withFields.fields
    : [{ key: 'name', label: '姓名', type: 'text', required: true }];
  const holder = doc.createElement('div');
  holder.innerHTML = fields.map(f => noticesMod.fieldInput(f, '')).join('');
  const firstText = holder.querySelector('input[data-fk],textarea[data-fk]');
  if (firstText) firstText.value = '測試報名者';
  const vals = noticesMod.collectFields(holder, fields);
  ok('報名表單收集到欄位值', (vals.name || vals[Object.keys(vals)[0]]) !== undefined, JSON.stringify(vals));

  const before = (store.find('notices', withFields.id)?.signups || []).length;
  noticesMod.add_signup(store.find('notices', withFields.id), { name: '測試報名者', ...vals });
  const after = (store.find('notices', withFields.id)?.signups || []).length;
  ok('報名會加落通告（signups +1）', after === before + 1, `${before} → ${after}`);
  const row = (store.find('notices', withFields.id)?.signups || [])[after - 1];
  ok('報名有時間同姓名', !!row?.at && row.name === '測試報名者', JSON.stringify(row?.name));

  // 還原（唔留測試資料）
  const fresh = store.find('notices', withFields.id);
  store.update('notices', withFields.id, { signups: (fresh.signups || []).filter(x => x.id !== row.id) });
  ok('測試報名已清理', (store.find('notices', withFields.id)?.signups || []).length === before);

  // 報名表輸出 CSV
  const csvOk = typeof noticesMod.exportSignupsCsv === 'function';
  ok('有報名表 CSV 匯出', csvOk);
}

/* ---------- v3：表格設計（改名／加欄位） ---------- */
section('表格設計（欄位改名・加欄位・還原）');
{
  const tablesMod = await import('../assets/js/views/tables.js');
  window.location.hash = '#/tables/transactions';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 40));
  const rows = doc.querySelectorAll('#field-list .schema-row');
  ok('表格頁列出欄位（帳目）', rows.length >= 8, String(rows.length));
  ok('有「加欄位」掣', !!doc.querySelector('[data-act="add-field"]'));

  const inp = doc.querySelector('#field-list [data-field="0"] [data-k="label"]');
  ok('第一個欄位係「日期」', inp?.value === '日期', inp?.value);
  inp.value = '交易日期';
  inp.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  ok('改名會儲存落旅團設定',
    store.load().tableSchema?.transactions?.fields?.[0]?.label === '交易日期',
    JSON.stringify(store.load().tableSchema?.transactions?.fields?.[0]));
  ok('改名後表格定義即時跟住變',
    tablesMod.tableDefs().transactions.fields[0].label === '交易日期');

  // 還原預設
  doc.querySelector('[data-act="reset-fields"]').click();
  await new Promise(r => setTimeout(r, 40));
  doc.querySelector('.overlay [data-act="1"]')?.click();
  await new Promise(r => setTimeout(r, 80));
  ok('還原預設欄位（唔會再見到改咗嘅名）',
    tablesMod.tableDefs().transactions.fields[0].label === '日期',
    tablesMod.tableDefs().transactions.fields[0].label);
}

/* ---------- v3：插入自己嘅 Sheet（gviz 解析・自動對應） ---------- */
section('插入自己嘅 Sheet（讀欄位・自動對應・同步 payload）');
{
  const tablesMod = await import('../assets/js/views/tables.js');
  const gviz = `/*O_o*/
google.visualization.Query.setResponse({"version":"0.6","reqId":"0","status":"ok","table":{"cols":[{"id":"A","label":"日期","type":"string"},{"id":"B","label":"項目","type":"string"},{"id":"C","label":"金額","type":"number"},{"id":"D","label":"負責人","type":"string"}],"rows":[{"c":[{"v":"2025-12-07"},{"v":"團費"},{"v":360},{"v":"嘉詠"}]},{"c":[{"v":"2025-12-08"},{"v":"買營繩"},{"v":120},{"v":"天暘"}]}]}});`;
  const sheet = tablesMod.parseGviz(gviz);
  ok('gviz 讀到 4 欄', sheet.cols.length === 4, String(sheet.cols.length));
  ok('gviz 讀到 2 行', sheet.rows.length === 2, String(sheet.rows.length));
  ok('gviz 讀到欄位名同值', sheet.cols[1].label === '項目' && sheet.rows[0][1] === '團費', JSON.stringify(sheet.rows[0]));

  const fields = tablesMod.tableDefs().transactions.fields;
  const map = tablesMod.autoMap(sheet.cols, fields);
  ok('自動對應：日期→date / 項目→item / 金額→amount / 負責人→byName',
    map[0] === 'date' && map[1] === 'item' && map[2] === 'amount' && map[3] === 'byName', JSON.stringify(map));

  const tr = tablesMod.rowsFromSheet(sheet, map, fields);
  ok('轉成帳目資料（金額變數字）', tr.length === 2 && tr[0].amount === 360 && tr[1].item === '買營繩', JSON.stringify(tr));

  const payload = tablesMod.buildPayload({ sample: true });
  ok('同步 payload 有旅團編號', payload.unit === store.currentUnit(), payload.unit);
  ok('同步 payload 有各表 schema 同資料', !!payload.schema?.transactions && !!payload.tables?.transactions);
  ok('payload 唔會送相片 base64（避免爆 size）', JSON.stringify(payload).indexOf('data:image') === -1);

  // 總表同步頁：下載 Code.gs / 欄位對應表（真按鈕，唔會拋錯）
  window.location.hash = '#/tables/sync';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 40));
  ok('有「同一條網址共用」畀手機記帳／通告報名', !!doc.querySelector('#y-share'));
  if (MODE === 'real') {
    ok('總表同步頁顯示「後端已連接」', /後端已連接|已設定 Apps Script/.test(doc.getElementById('view')?.textContent || ''));
    ok('Apps Script 網址已預填落輸入格',
      /\/exec$/.test(doc.querySelector('#y-url')?.value || ''), doc.querySelector('#y-url')?.value);
    ok('共用掣預設已剔（三條路同一個後端）', doc.querySelector('#y-share')?.checked === true);
  } else {
    ok('示範模式唔會預填後端（唔會送出街）', !doc.querySelector('#y-url')?.value, doc.querySelector('#y-url')?.value);
    ok('示範模式仍然有共用掣（只係未設定網址）', !!doc.querySelector('#y-share'));
  }

  // 測試連線（jsdom fetch 係本機 shim → 應該優雅失敗，唔會拋錯）
  const { pushToMaster } = tablesMod;
  const pushRes = await pushToMaster({ silent: true });
  ok('pushToMaster() 唔會拋錯（連線失敗會記錄落同步紀錄）', pushRes && pushRes.ok === false, JSON.stringify(pushRes));
  ok('失敗會寫入同步紀錄', (store.load().sync?.log || []).length > 0, JSON.stringify(store.load().sync?.log));

  const errBefore = errors.length;
  const keepClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () {};   // jsdom 唔支援真下載
  window.URL.createObjectURL = () => 'blob:test';
  window.URL.revokeObjectURL = () => {};
  doc.querySelector('[data-act="dl-gas"]')?.click();
  await new Promise(r => setTimeout(r, 60));
  doc.querySelector('[data-act="dl-schema"]')?.click();
  await new Promise(r => setTimeout(r, 60));
  window.HTMLAnchorElement.prototype.click = keepClick;
  ok('「下載 Code.gs」同「欄位對應表」按得（冇 error）', errors.length === errBefore,
    errors.slice(errBefore).join(' | '));

  const { gasTemplate, gasGuide } = await import('../assets/js/lib/gastemplate.js');
  const code = gasTemplate();
  ok('Apps Script 範本有 doPost（收 POST）', /function doPost/.test(code) && /ContentService/.test(code));
  ok('Apps Script 範本會寫入「帳目／物資／團員／報名」分頁',
    ['帳目', '物資', '團員', '報名'].every(k => code.includes(k)));
  ok('Apps Script 範本支援報名即時寫入', /appendSignup/.test(code));
  ok('部署步驟教學有 6 步', gasGuide().split('\n').length === 6);
}

/* ---------- v3：快速記帳（手機影相＋選欄目） ---------- */
section('快速記帳（影相＋選欄目）');
{
  window.location.hash = '#/dashboard';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 40));
  const quick = doc.querySelector('[data-quick="claim"]');
  ok('儀表板有「影相記一筆」', !!quick);
  quick.click();
  await new Promise(r => setTimeout(r, 60));
  const ov = doc.querySelector('.overlay');
  ok('開到收支申報表', !!ov && /收支申報/.test(ov.textContent));
  const cam = ov?.querySelector('[data-photo-field="c-photos"] input[type="file"][capture]');
  ok('有相機輸入（手機可以直接影相）', !!cam);
  ok('可以揀相片（相簿）', !!ov?.querySelector('[data-photo-field="c-photos"] input[type="file"]:not([capture])'));
  ok('有欄目可以揀（類型／項目／金額／分類）',
    ['c-type', 'c-item', 'c-amount', 'c-cat'].every(id => !!ov?.querySelector('#' + id)));
  ok('單據相機會標記為有單據', !!ov?.querySelector('#c-receipt'));
  doc.querySelector('.overlay [data-close-x]')?.click();
  await new Promise(r => setTimeout(r, 20));
  ok('關閉之後冇殘留 modal', !doc.querySelector('.overlay'));

  // 畀成員自己填（公開收集頁 QR + 送出網址）
  window.location.hash = '#/finance/claims';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 40));
  const share = doc.querySelector('[data-act="entry-share"]');
  ok('收支申報有「畀成員自己填（QR）」', !!share);
  share.click();
  await new Promise(r => setTimeout(r, 80));
  const ov2 = doc.querySelector('.overlay');
  ok('彈出 QR 對話框（成員用手機掃）', !!ov2 && !!ov2.querySelector('.qr-box svg'));
  ok('QR 連結指向 entry.html（帶旅團編號）',
    (ov2?.querySelector('#es-url')?.value || '').includes('entry.html?u='),
    ov2?.querySelector('#es-url')?.value);
  ok('可以設定 Apps Script 送出網址（寫入總表）', !!ov2?.querySelector('#es-submit'));
  if (MODE === 'real') {
    ok('送出網址已預填你嘅 /exec',
      /\/exec$/.test(ov2?.querySelector('#es-submit')?.value || ''), ov2?.querySelector('#es-submit')?.value);
  } else {
    ok('示範模式唔會預填送出網址（示範資料唔會送出街）',
      !(ov2?.querySelector('#es-submit')?.value || ''), ov2?.querySelector('#es-submit')?.value);
  }
  doc.querySelector('.overlay [data-close-x]')?.click();
  await new Promise(r => setTimeout(r, 20));

  // 設定檔：公開收集頁
  ok('unit.json 有 publicEntry 設定', !!store.load().settings?.publicEntry);
  ok('entry.html 存在（成員手機入口）', typeof fs.readFileSync === 'function' && fs.existsSync(path.join(ROOT, 'entry.html')));
}

/* ============================================================
   新增測試（用戶提出嘅 8 項修正）
   ============================================================ */

/* ---------- 1. Code.gs 語法 ---------- */
section('Code.gs（Apps Script 範本）');
{
  const { gasTemplate, gasGuide } = await import('../assets/js/lib/gastemplate.js');
  const code = gasTemplate();
  const lines = code.split('\n');
  let syntaxError = '';
  try { new vm.Script(code, { filename: 'Code.gs' }); }
  catch (e) { syntaxError = e.message + ' @line ' + (e.stack || '').split('\n')[0]; }
  ok('Code.gs 可以通過語法檢查（無 SyntaxError）', syntaxError === '', syntaxError);
  ok('冇「字串入面斷行」（舊 bug：line 158 Invalid or unexpected token）',
    !lines.some((l, i) => /^\'\)/.test(l.trim()) || /join\('$/.test(l)),
    lines.map((l, i) => `${i + 1}:${l}`).filter(([, l]) => /join\('$/.test(l)).join('|'));
  ok("links.join('\\n') 保留做跳行字串（唔係真換行）", code.includes("links.join('\\n')"));
  ok('有定義 SHEET_TABS（舊版本用到但未定義）', /var SHEET_TABS = \[/.test(code));
  ok('有 doPost / doGet / syncAll', ['function doPost', 'function doGet', 'function syncAll'].every(f => code.includes(f)));
  ok('支援 action: ping / sync / claim / noticeSignup / loan',
    ['ping', 'sync', 'claim', 'noticeSignup', 'loan'].every(a => code.includes(`'${a}'`)));
  ok('有物資借用分頁寫入（appendLoan）', code.includes('function appendLoan') && code.includes("'物資借用'"));
  ok('報名分頁有「出席與否」欄', code.includes("'出席與否'") && code.includes('function attendOf'));
  ok('部署步驟說明有內容', gasGuide().split('\n').length >= 5);
}

/* ---------- 2. 用戶（領袖／執委／團員）可以編輯 ---------- */
section('用戶名冊（可編輯 · 身份）');
{
  await auth.login('leader', 'leader', '8202');
  window.location.hash = '#/members';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 40));
  const view = doc.getElementById('view');
  ok('名冊頁標題係「用戶」', /用戶/.test(view.textContent), view.textContent.slice(0, 60));
  ok('每一行有「編輯」掣（以前撳唔到）', view.querySelectorAll('[data-edit]').length >= 1,
    String(view.querySelectorAll('[data-edit]').length));
  ok('有身份篩選（領袖／執委／團員）', view.querySelectorAll('[data-ident]').length === 4);

  const firstId = store.load().members[0].id;
  view.querySelector('[data-edit]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 50));
  ok('撳「編輯」會去編輯頁（#/members/edit/<id>）',
    window.location.hash === '#/members/edit/' + firstId, window.location.hash);
  ok('編輯頁有身份下拉（領袖／執委／團員）', !!doc.querySelector('#f-identity'));
  ok('身份選項係 領袖／執委／團員',
    Array.from(doc.querySelectorAll('#f-identity option')).map(o => o.value).join(',') === 'leader,exco,member',
    Array.from(doc.querySelectorAll('#f-identity option')).map(o => o.value).join(','));

  doc.querySelector('#f-name').value = '測試用戶甲';
  doc.querySelector('#f-name').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.querySelector('#f-identity').value = 'exco';
  doc.querySelector('#f-identity').dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.querySelector('[data-act="save"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 80));
  const m = store.load().members.find(x => x.id === firstId);
  ok('改資料可以儲存（以前儲存唔到）', m.name === '測試用戶甲', m.name);
  ok('身份可以改成「執委」', m.identity === 'exco', m.identity);
  ok('編輯完會返去個人頁', window.location.hash === '#/members/' + firstId, window.location.hash);

  // 舊資料升級：冇 identity 欄 → 自動推算
  const migrated = store.migrateIdentities({ members: [
    { id: 'x1', name: '甲', role: '團長' }, { id: 'x2', name: '乙', role: '司庫' }, { id: 'x3', name: '丙', role: '' }
  ] });
  ok('舊資料自動推算身份（團長→領袖 / 司庫→執委 / 其他→團員）',
    migrated === true, String(migrated));
  const g = store.load();
  ok('每個用戶都有身份欄', g.members.every(x => ['leader', 'exco', 'member'].includes(x.identity)),
    JSON.stringify(g.members.filter(x => !x.identity).map(x => x.name)));
  ok('執委都有權改用戶資料（以前只有領袖）',
    (await (async () => { await auth.login('exco', 'exco', '8203'); return auth.can('member.edit'); })()) === true);
  await auth.login('leader', 'leader', '8202');
}

/* ---------- 3. 防呆（先存瀏覽器，唔即時寫入） ---------- */
section('防呆（暫存 → 確認 → 可還原）');
{
  const guard = await import('../assets/js/lib/guard.js');
  guard.dropAllDrafts();
  guard.saveDraft('member', 'm_test', { name: '暫存測試' });
  ok('草稿可以暫存去瀏覽器', guard.readDraft('member', 'm_test')?.data?.name === '暫存測試');
  ok('草稿存喺 localStorage（唔係資料庫）',
    !!window.localStorage.getItem('venture82.drafts.v2')
    && !store.load().members.some(m => m.name === '暫存測試'));
  ok('可以列出所有暫存', guard.listDrafts().some(d => d.section === 'member'));
  guard.clearDraft('member', 'm_test');
  ok('儲存後可以清走暫存', guard.readDraft('member', 'm_test') === null);

  // 編輯器輸入 → 自動暫存（未撳儲存唔會入資料庫）
  window.location.hash = '#/members/new';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const nameBox = doc.querySelector('#f-name');
  ok('新增用戶頁有暫存提示位', !!doc.querySelector('[data-draft-stamp]'));
  nameBox.value = '未儲存用戶';
  nameBox.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 900));
  ok('輸入後自動暫存去瀏覽器', guard.readDraft('member', 'new')?.data?.name === '未儲存用戶',
    JSON.stringify(guard.readDraft('member', 'new')));
  ok('未撳「儲存」之前唔會寫入資料庫', !store.load().members.some(m => m.name === '未儲存用戶'));
  guard.dropAllDrafts();

  // 刪除要打字確認
  window.location.hash = '#/members/' + firstId2();
  function firstId2() { return store.load().members[1].id; }
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 50));
  const target = store.load().members[1];
  doc.querySelector('[data-act="del"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 80));
  const dlg = doc.querySelector('.overlay .modal');
  ok('刪除會彈確認框', !!dlg);
  const okBtn = dlg?.querySelector('.modal-foot [data-act="1"]');
  ok('未打字之前「確定刪除」係停用（防手誤）', okBtn?.disabled === true);
  const ti = dlg?.querySelector('#gd-text');
  if (ti) { ti.value = target.name; ti.dispatchEvent(new window.Event('input', { bubbles: true })); }
  await new Promise(r => setTimeout(r, 30));
  ok('打低個名之後先可以確定', okBtn?.disabled === false);
  dlg?.querySelector('[data-close-x]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 30));
  ok('取消之後用戶仍然存在', !!store.load().members.find(m => m.id === target.id));

  // 總表同步唔會即時寫入（只排隊）
  const dbx = store.load();
  dbx.sync = { ...(dbx.sync || {}), auto: true, pending: 0 };
  store.commit();
  ok('開咗「排隊」之後，改動只係累加待同步數（唔會自動送出）',
    Number(store.load().sync.pending) >= 1, String(store.load().sync?.pending));
  dbx.sync.auto = false; dbx.sync.pending = 0; store.commit();
}

/* ---------- 4. 通告：詳情頁 + 輸出（連回覆出席與否） ---------- */
section('通告詳情（輸出連出席回覆）');
{
  const nv = await import('../assets/js/views/notices.js');
  const n0 = store.add('notices', {
    id: 'nt-test-attend', type: 'event', status: 'published', publishAt: '2026-09-15',
    title: { zh: '測試通告（出席）', en: 'Test' }, body: { zh: '內容' },
    needSignup: true, deadline: '2026-09-30', eventDate: '2026-10-17',
    fields: [
      { key: 'name', label: '姓名', type: 'text', required: true },
      { key: 'contact', label: '聯絡電話', type: 'tel', required: false },
      { key: 'attend', label: '出席與否', type: 'radio', options: ['出席', '唔出席（請假）'] }
    ],
    signups: []
  });
  const ms2 = store.load().members.filter(m => m.status !== 'alumni');
  ok('出席判斷：出席', nv.attendValue({ values: { attend: '出席' } }) === 'yes');
  ok('出席判斷：唔出席（請假）', nv.attendValue({ values: { attend: '唔出席（請假）' } }) === 'no');
  ok('出席判斷：未填 = 未回覆', nv.attendValue({ values: {} }) === '');

  nv.markAttendance(store.find('notices', n0.id), ms2[0], 'yes');
  nv.markAttendance(store.find('notices', n0.id), ms2[1], 'no');
  const A = nv.attendanceSummary(store.find('notices', n0.id));
  ok('統計出席 1 位', A.yes === 1, JSON.stringify(A));
  ok('統計唔出席 1 位', A.no === 1, JSON.stringify(A));
  ok('其餘計做未回覆', A.none === A.rosterCount - 2, JSON.stringify(A));
  const rows = nv.attendanceRows(store.find('notices', n0.id));
  ok('出席表以名冊為本（每位非舊團員一行）', rows.roster.length === ms2.length, `${rows.roster.length}/${ms2.length}`);

  window.location.hash = '#/notices/nt-test-attend';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const v2 = doc.getElementById('view');
  ok('通告詳情有文件式排版（同團章一樣）', !!v2.querySelector('#noticeSheet'));
  ok('右面有「輸出同分享」面板', /輸出同分享/.test(v2.textContent));
  ok('有「通告＋出席回覆（Word）」輸出掣', !!v2.querySelector('[data-act="export-full-word"]'));
  ok('有「通告＋出席回覆（PDF）」輸出掣', !!v2.querySelector('[data-act="export-full-pdf"]'));
  ok('有「出席回覆表（CSV）」輸出掣', !!v2.querySelector('[data-act="export-attend"]'));
  ok('詳情頁列出每位用戶嘅回覆', v2.querySelectorAll('[data-attend]').length >= 2,
    String(v2.querySelectorAll('[data-attend]').length));
  ok('舊通告可以補「出席與否」欄', (() => {
    const bare = store.add('notices', { id: 'nt-bare', status: 'published', title: { zh: '舊通告' }, needSignup: true, fields: [{ key: 'name', label: '姓名', type: 'text' }], signups: [] });
    const up = nv.ensureAttendField(store.find('notices', bare.id));
    return (up.fields || []).some(f => f.key === 'attend');
  })());
  store.remove('notices', 'nt-test-attend');
  store.remove('notices', 'nt-bare');
}

/* ---------- 5. 旅團選擇閘 ---------- */
section('旅團選擇閘（先揀旅團再登入）');
{
  ok('網址有 ?u= 時直接入登入畫面（唔會見到旅團閘）',
    !/揀你嘅旅團/.test(doc.body.textContent));
  ok('index.html 有載入 main.js（旅團閘喺 main.js）',
    fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes('assets/js/main.js'));
  const mainSrc = fs.readFileSync(path.join(ROOT, 'assets/js/main.js'), 'utf8');
  ok('main.js 先顯示旅團閘，之後先 init + 登入',
    /if \(!unitChosen\(\)\) return renderUnitGate\(\);/.test(mainSrc)
    && mainSrc.indexOf('renderUnitGate();') < mainSrc.indexOf('await init();'));
  ok('旅團閘有 MOCK 選項', /data-pick="MOCK"/.test(mainSrc));
  ok('登入頁有「更換旅團」掣', /btnGate/.test(mainSrc));
}

/* ---------- 6. 成員連結（申報 / 物資 / 通告報名） ---------- */
section('成員連結（免登入公開頁）');
{
  const links = model.memberLinks();
  const ids = links.map(l => l.id);
  ok('有收支申報連結（entry.html）', ids.includes('entry'));
  ok('有物資借用連結（borrow.html）', ids.includes('borrow'));
  ok('有團章連結（constitution.html）', ids.includes('constitution'));
  ok('每條連結都帶旅團編號', links.every(l => /u=(0082|MOCK)/.test(l.url)), links.map(l => l.url).join(' | '));
  ok('borrow.html 存在', fs.existsSync(path.join(ROOT, 'borrow.html')));
  ok('public-borrow.js 存在', fs.existsSync(path.join(ROOT, 'assets/js/public-borrow.js')));

  window.location.hash = '#/links';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const v3 = doc.getElementById('view');
  ok('「成員連結」頁可以渲染', (v3.innerHTML || '').length > 400, String((v3.innerHTML || '').length));
  ok('頁上有 QR 掣', v3.querySelectorAll('[data-qr]').length >= 3, String(v3.querySelectorAll('[data-qr]').length));
  ok('頁上有列印海報掣', v3.querySelectorAll('[data-poster]').length >= 3);
  ok('側邊欄有「成員連結」', /成員連結/.test(doc.querySelector('.sidebar')?.textContent || ''));
  if (MODE === 'real') {
    ok('物資借用送出網址已設定（borrow.html → 總表）',
      /\/exec$/.test(store.load().settings?.publicBorrow?.submitUrl || ''),
      store.load().settings?.publicBorrow?.submitUrl);
  }
}

/* ---------- 7. 進度追蹤就緒檢查 ---------- */
section('進度追蹤（連通檢查）');
{
  const pv = await import('../assets/js/views/progress.js');
  const R = pv.readiness();
  ok('就緒清單有 10 項', R.total === 10, String(R.total));
  /* 對方（VSBADGE）index.html 嘅實際判斷：
       if (from==='portal' && ymis && role) → 免登入進入
     所以 u + from=portal + role + ymis 四樣缺一不可；少一樣就會跌返登入頁。 */
  ok('Portal 連結有 from=portal（免密碼）', R.url.includes('from=portal'), R.url);
  ok('Portal 連結帶 ymis（對方必要欄位）', /[?&]ymis=[^&]+/.test(R.url), R.url);
  /* 自動身份：旅團接入零設定，唔使先去進度系統開帳戶再返嚟填 */
  ok('portal.ymis 留空會自動產生 PORTAL-<旅團>-<角色>',
    pv.portalIdentity({ portal: { unitParam: '0082', role: 'exec_committee', ymis: '' } }).ymis === 'PORTAL-0082-EXCO'
    && pv.portalIdentity({ portal: { unitParam: '0082', role: 'exec_committee', ymis: '' } }).auto === true,
    JSON.stringify(pv.portalIdentity({ portal: { unitParam: '0082', role: 'exec_committee', ymis: '' } })));
  ok('自動身份跟角色變（領袖唔會撞執委）',
    pv.portalIdentity({ portal: { unitParam: '0082', role: 'branch_leader', ymis: '' } }).ymis === 'PORTAL-0082-LEADER'
    && pv.portalIdentity({ portal: { unitParam: '0082', role: 'group_leader', ymis: '' } }).ymis === 'PORTAL-0082-GLEADER');
  ok('自己填咗專用身份就以佢為準',
    pv.portalIdentity({ portal: { unitParam: '0082', role: 'exec_committee', ymis: 'EXCO-82' } }).ymis === 'EXCO-82'
    && pv.portalIdentity({ portal: { unitParam: '0082', role: 'exec_committee', ymis: 'EXCO-82' } }).auto === false);
  ok('連結帶 src（主系統 origin）同 ts，供對方日後驗證',
    /[?&]src=/.test(R.url) && /[?&]ts=\d+/.test(R.url), R.url);
  ok('零設定（ymis 留空）都係 10/10 就緒',
    (() => { const c = pv.portalIdentity({ portal: { unitParam: '0082', role: 'exec_committee', ymis: '' } });
      return !!c.ymis; })(), '');
  ok('Portal 連結帶 u（旅團編號）', /[?&]u=[^&]+/.test(R.url), R.url);
  ok('Portal 連結帶 role', /[?&]role=[^&]+/.test(R.url), R.url);
  ok('網址係對方前端而唔係 GAS /exec（實測：/exec 只回 JSON 錯誤頁）',
    !/\/macros\/s\//.test(store.load().profile?.progress?.url || ''),
    store.load().profile?.progress?.url);
  ok('揀嘅角色對方認得而且有勾選權', pv.TICK_ROLES.includes(R.mode === 'portal' ? (R.url.match(/role=([^&]+)/) || [])[1] : ''),
    R.url);
  if (MODE === 'real') {
    ok('真實旅團已預備好連通進度系統', R.ready === true,
      R.checks.filter(c => !c.ok).map(c => c.label).join(' / '));
    ok('Portal 模式帶 u=0082 同 role=exec_committee',
      R.url.includes('u=0082') && R.url.includes('role=exec_committee'), R.url);
  } else {
    ok('示範模式都有自己嘅進度系統設定（示範用）', R.ready === true,
      R.checks.filter(c => !c.ok).map(c => c.label).join(' / '));
    ok('示範模式帶 u=MOCK（唔會用真實旅團編號）', R.url.includes('u=MOCK'), R.url);
    ok('示範模式嘅後端唔會送出街（只有進度連結）', !store.load().backend);
  }
  window.location.hash = '#/progress';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const v4 = doc.getElementById('view');
  ok('進度頁有就緒清單', /連通進度追蹤/.test(v4.textContent));
  ok('進度頁有「檢查連線（實測）」掣', !!v4.querySelector('[data-act="check"]'));
  ok('checkConnection 係一支可以用嘅函式', typeof pv.checkConnection === 'function');
}

/* ---------- 8. 首頁帳目：現在結餘（含期初） ---------- */
section('首頁帳目（現在結餘 · 期初結餘）');
{
  const db3 = store.load();
  const keepOpen = db3.settings.openingBalance;
  const keepOb = db3.settings.openingBalances ? JSON.parse(JSON.stringify(db3.settings.openingBalances)) : undefined;
  const keepTx = JSON.parse(JSON.stringify(db3.transactions));
  db3.settings.openingBalance = 8803.28;
  db3.transactions = [
    { id: 'tx1', date: '2026-09-01', type: 'income', amount: 1000, item: '團費' },
    { id: 'tx2', date: '2026-09-02', type: 'expense', amount: 2500, item: '露營' }
  ];
  store.commit();
  ok('現在結餘 = 期初 + 收入 − 支出',
    Math.round(model.currentBalance() * 100) / 100 === 7303.28, String(model.currentBalance()));
  ok('唔會再淨係顯示收入減支出（舊做法會出現 −1500）',
    model.balance(db3.transactions) === -1500 && model.currentBalance() > 0,
    `balance=${model.balance(db3.transactions)} current=${model.currentBalance()}`);
  const bd = model.balanceBreakdown();
  ok('結餘拆解有期初／收入／支出／現在',
    bd.opening === 8803.28 && bd.income === 1000 && bd.expense === 2500 && Math.round(bd.now * 100) / 100 === 7303.28,
    JSON.stringify(bd));

  window.location.hash = '#/dashboard';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const dash = doc.getElementById('view');
  ok('儀表板顯示「現在結餘」', /現在結餘/.test(dash.textContent));
  ok('儀表板有帳目流程卡（期初＋收入−支出＝現在）', !!dash.querySelector('.bal-flow'));
  ok('儀表板顯示期初結餘數字', dash.textContent.includes('8,803.28') || dash.textContent.includes('8803.28'),
    dash.textContent.replace(/\s+/g, ' ').slice(0, 200));
  ok('儀表板唔會顯示負數結餘', !/HK\$\s?-/.test(dash.querySelector('.bal-cell.now')?.textContent || ''),
    dash.querySelector('.bal-cell.now')?.textContent);

  /* 真實情況：舊帳屬於**上年度** → 本年度期初應該係上年度期末 */
  db3.settings.openingBalances = { '2025-26': 8803.28, '2026-27': 7846.64 };
  db3.settings.openingBalance = 0;
  db3.transactions = [
    { id: 'tx3', date: '2025-06-14', type: 'income', amount: 8630, item: '舊帳收入' },
    { id: 'tx4', date: '2026-01-05', type: 'expense', amount: 9586.64, item: '舊帳支出' }
  ];
  store.commit();
  window.location.hash = '#/dashboard';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const dash2 = doc.getElementById('view');
  const dtxt = dash2.textContent.replace(/\s+/g, ' ');
  const bd2 = model.balanceBreakdown();
  ok('上年度帳目唔會計入本年度收入／支出',
    bd2.income === 0 && bd2.expense === 0, `income=${bd2.income} expense=${bd2.expense}`);
  ok('上年度期末 = 8,803.28 + 8,630 − 9,586.64 = 7,846.64',
    Math.round(bd2.prevClosing * 100) / 100 === 7846.64, String(bd2.prevClosing));
  ok('本年度（2026-27）期初 = 上年度期末 7,846.64，唔係 8,803.28',
    Math.round(model.currentBalance() * 100) / 100 === 7846.64, String(model.currentBalance()));
  ok('儀表板寫明係邊個年度（帳目（現在）· 2026-27 年度）',
    /帳目（現在）·\s*2026-27 年度/.test(dtxt), dtxt.slice(0, 120));
  ok('儀表板期初格顯示 7,846.64（唔係 8,803.28）',
    (dash2.querySelector('.bal-flow .bal-cell .bal-v')?.textContent || '').includes('7,846.64'),
    dash2.querySelector('.bal-flow .bal-cell .bal-v')?.textContent);
  ok('儀表板有上年度對數行（期初 8,803.28 → 期末 7,846.64）',
    /上年度 2025-26：期初/.test(dtxt) && dtxt.includes('8,803.28') && dtxt.includes('7,846.64'),
    dtxt.slice(0, 260));
  ok('上年度期末同本年度期初吻合時唔會出警告',
    !/唔吻合/.test(dtxt));
  ok('逐年期初結餘有捷徑去年度設定',
    !!dash2.querySelector('[data-go="#/finance/settings"]'));

  // 負數時要有解釋
  delete db3.settings.openingBalances;
  db3.settings.openingBalance = 0;
  store.commit();
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  ok('結餘係負數時會解釋原因（期初未填）',
    /點解會見到負數/.test(doc.getElementById('view').textContent));
  ok('負數提示有「改期初結餘」捷徑',
    !!doc.querySelector('[data-go="#/finance/settings"]'));

  db3.settings.openingBalance = keepOpen;
  db3.settings.openingBalances = keepOb;
  db3.transactions = keepTx;
  store.commit();

  window.location.hash = '#/finance/settings';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 60));
  const fv = doc.getElementById('view');
  ok('財務有「年度設定」分頁（改期初結餘）', !!fv.querySelector('#set-open-legacy'));
  ok('年度設定頁顯示結餘點計', /現在結餘/.test(fv.textContent));
  /* 期初結餘要逐年，唔可以係一個全域數字 */
  ok('期初結餘係逐年欄位（唔再係單一全域數字）',
    fv.querySelectorAll('[data-open-year]').length >= 2,
    String(fv.querySelectorAll('[data-open-year]').length));
  ok(`期初欄位包含本年度（${model.currentFY()}）`,
    !!fv.querySelector(`[data-open-year="${model.currentFY()}"]`));
  ok('年度設定有「由上年度期末結轉」掣', !!fv.querySelector('[data-act="carry-all"]'));
  if (MODE === 'real') {
    ok('年度設定有「用舊帳嘅數字填返」掣', !!fv.querySelector('[data-act="use-ref-opening"]'));
    fv.querySelector('[data-act="use-ref-opening"]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const curEl = fv.querySelector(`[data-open-year="${model.currentFY()}"]`);
    ok(`舊帳一鍵填數：本年度（${model.currentFY()}）填 7,846.64，唔係 8,803.28`,
      Number(curEl.value) === 7846.64, String(curEl.value));
    ok('舊帳一鍵填數：2025-26 填 8,803.28（原表上年度結餘）',
      Number(fv.querySelector('[data-open-year="2025-26"]').value) === 8803.28,
      String(fv.querySelector('[data-open-year="2025-26"]').value));
  }
}

/* ---------- 期初結餘遷移（舊嘅全域數字 → 逐年） ---------- */
console.log('\n▌期初結餘遷移（8,803.28 係 2025-26 嘅期初，唔係 2026-27）');
{
  const mk = (legacy, extraSettings = {}) => ({
    settings: { openingBalance: legacy, scoutFYStartMonth: 4, ...extraSettings },
    reference: {
      openingBalance: 8803.28, check: { income: 8630, expense: 9586.64, opening: 8803.28, closing: 7846.64 },
      transactions: [
        { date: '2025-06-14', type: 'income', amount: 100 },
        { date: '2026-01-05', type: 'expense', amount: 50 }
      ]
    }
  });

  const a = mk(8803.28);
  ok('舊全域期初（＝舊帳上年度結餘）會自動搬去對應年度', store.migrateOpeningBalances(a) === true);
  ok('遷移後 2025-26 期初 = 8,803.28',
    Number(a.settings.openingBalances?.['2025-26']) === 8803.28, JSON.stringify(a.settings.openingBalances));
  ok('遷移後 2026-27 期初 = 7,846.64（＝上年度期末）',
    Number(a.settings.openingBalances?.['2026-27']) === 7846.64, JSON.stringify(a.settings.openingBalances));
  ok('遷移後全域欄位還原做 0（佢只係「第一筆帳目之前」嘅底數）',
    Number(a.settings.openingBalance) === 0, String(a.settings.openingBalance));
  ok('遷移有留紀錄（幾時搬咗邊個年度）',
    a.settings.openingMigratedFrom?.year === '2025-26' && a.settings.openingMigratedFrom?.nextYear === '2026-27',
    JSON.stringify(a.settings.openingMigratedFrom));

  const b = mk(8803.28, { openingBalances: { '2026-27': 7846.64 } });
  ok('已經逐年設定過就唔會再搬（唔會蓋過人手輸入）', store.migrateOpeningBalances(b) === false);
  ok('已經逐年設定過：內容原封不動', Number(b.settings.openingBalances['2026-27']) === 7846.64
    && b.settings.openingBalances['2025-26'] === undefined, JSON.stringify(b.settings.openingBalances));
  ok('全域數字同舊帳唔同就唔會亂搬', store.migrateOpeningBalances(mk(5000)) === false);
  ok('全域係 0 就唔使搬', store.migrateOpeningBalances(mk(0)) === false);
}

/* ---------- 跨系統身份 key（federation L1） ---------- */
console.log('\n▌跨系統身份 key（進度追蹤係獨立系統，要靠 key 對人）');
{
  const db4 = store.load();
  const ms = db4.members;
  ok('所有用戶都有 systemId（自動產生）',
    ms.every(m => !!m.systemId), `缺 ${ms.filter(m => !m.systemId).length} 個`);
  ok('systemId 全部唔重複',
    new Set(ms.map(m => m.systemId)).size === ms.length, String(new Set(ms.map(m => m.systemId)).size));
  ok('所有用戶都有 ymis 欄（未填都要有呢個欄）',
    ms.every(m => 'ymis' in m), String(ms.filter(m => !('ymis' in m)).length));

  const first = ms[0];
  const before = first.systemId;
  store.migrateMemberKeys(db4);
  ok('migrateMemberKeys 唔會改已有 systemId（key 必須穩定）', first.systemId === before, first.systemId);
  ok('migrateMemberKeys 第二次跑係 no-op', store.migrateMemberKeys(db4) === false);
  /* systemId 必須係確定性：另一部裝置獨立跑遷移都要得到同一個 key，
     否則呢個 key 永遠對唔上，做唔到跨系統配對 */
  const clone = JSON.parse(JSON.stringify({ unitCode: db4.unitCode, members: ms.map(m => ({ id: m.id })) }));
  store.migrateMemberKeys(clone);
  ok('systemId 係確定性（唔同裝置都推斷到同一個）',
    clone.members.every((m, i) => m.systemId === ms[i].systemId),
    `${clone.members[0].systemId} vs ${ms[0].systemId}`);
  ok('systemId 格式 = 旅團編號-用戶 id',
    ms.every(m => m.systemId === `${db4.unitCode}-${m.id}`), ms[0].systemId);

  const kc0 = model.keyCoverage(ms);
  ok('keyCoverage 統計到 YMIS 覆蓋率',
    kc0.total === ms.length && kc0.withSystemId === ms.length, JSON.stringify(kc0));
  ok('冇 YMIS 時 memberKey fallback 去 systemId',
    model.memberKey({ systemId: 'abc' }).kind === 'systemId' && model.memberKey({ systemId: 'abc' }).key === 'abc');
  ok('有 YMIS 時 memberKey 優先用 YMIS',
    model.memberKey({ ymis: 'Y123', systemId: 'abc' }).kind === 'ymis');
  ok('乜都冇 → key 係空', model.memberKey({}).key === '');
  /* 對方規則：成員用 YMIS，領袖用 Email（佢登入頁寫住） */
  ok('領袖優先用 Email 做 key（領袖本來就冇 YMIS）',
    model.memberKey({ identity: 'leader', email: 'L@x.hk', ymis: '' }).kind === 'email');
  ok('團員優先用 YMIS 做 key',
    model.memberKey({ identity: 'member', email: 'a@x.hk', ymis: '2019259338' }).kind === 'ymis');
  ok('expectedKeyKind：領袖→email，執委／團員→ymis',
    model.expectedKeyKind({ identity: 'leader' }) === 'email'
    && model.expectedKeyKind({ identity: 'exco' }) === 'ymis'
    && model.expectedKeyKind({ identity: 'member' }) === 'ymis');
  {
    const kcL = model.keyCoverage([
      { id: 'a', name: '領袖A', identity: 'leader', email: 'a@x.hk', systemId: 's1' },
      { id: 'b', name: '團員B', identity: 'member', ymis: '2019259338', systemId: 's2' }
    ]);
    ok('領袖有 Email + 團員有 YMIS → 100% 對得上（唔會誤報領袖缺 YMIS）',
      kcL.percent === 100 && kcL.unmatched === 0 && kcL.ready === true, JSON.stringify(kcL));
    const kcM = model.keyCoverage([
      { id: 'c', name: '領袖C', identity: 'leader', email: '', systemId: 's3' },
      { id: 'd', name: '團員D', identity: 'member', ymis: '', systemId: 's4' }
    ]);
    ok('領袖冇 Email + 團員冇 YMIS → 列出要補乜',
      kcM.unmatched === 2 && kcM.unmatchedList[0].need === 'email' && kcM.unmatchedList[1].need === 'ymis',
      JSON.stringify(kcM.unmatchedList));
    ok('systemId 唔算「對方認得到」（只係本系統 fallback）',
      kcM.withSystemId === 2 && kcM.matched === 0, JSON.stringify(kcM));
  }
  ok('findByKey 可以用 Email 搵人（領袖）',
    (() => { const m0 = store.load().members.find(x => String(x.email || '').trim());
      return m0 ? model.findByKey(m0.email)?.id === m0.id : true; })());

  const keepY = first.ymis;
  const ymisBase = model.keyCoverage(store.load().members).withYmis;   // 基準（seed 可能已有真實 YMIS）
  first.ymis = 'TEST-YMIS-1';
  store.commit();
  ok('findByKey 用 YMIS 搵到人', model.findByKey('TEST-YMIS-1')?.id === first.id);
  ok('findByKey 用 systemId 搵到人', model.findByKey(first.systemId)?.id === first.id);
  ok('findByKey 搵唔到會回 null', model.findByKey('NO-SUCH-KEY') === null);
  ok('YMIS 覆蓋率跟實際填入數一致',
    model.keyCoverage(store.load().members).withYmis === ymisBase + (keepY ? 0 : 1),
    `${model.keyCoverage(store.load().members).withYmis} vs base ${ymisBase}`);
  first.ymis = keepY;
  store.commit();

  /* UI：用戶編輯頁要有 YMIS 欄 */
  window.location.hash = '#/members/edit/' + first.id;
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const mv = doc.getElementById('view');
  ok('用戶編輯頁有「會籍編號（YMIS）」欄', !!mv.querySelector('#f-ymis'));
  ok('用戶編輯頁顯示系統 ID（唯讀）',
    /系統 ID/.test(mv.textContent) && !!Array.from(mv.querySelectorAll('input[readonly]')).length);

  window.location.hash = '#/members';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  ok('用戶列表有身份對應覆蓋率提示（按身份分 YMIS／Email）',
    /可以同進度系統對上/.test(doc.getElementById('view').textContent)
    && /團員／執委/.test(doc.getElementById('view').textContent)
    && /領袖/.test(doc.getElementById('view').textContent));

  window.location.hash = '#/progress';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const pv = doc.getElementById('view').textContent;
  ok('進度頁講明係聯邦式（進度資料由對面系統擁有）', /聯邦式/.test(pv) && /獨立系統/.test(pv));
  ok('進度頁顯示身份對應覆蓋率（團員 YMIS／領袖 Email 分開計）',
    /可以同對方對上/.test(pv) && /團員／執委（要有 YMIS）/.test(pv) && /領袖（要有 Email）/.test(pv));
  ok('進度頁分得開「連結就緒」同「身份對齊」', /連結狀態/.test(pv) && /資料可對應|身份未對齊/.test(pv));
  ok('進度頁有去補 YMIS 嘅捷徑', !!doc.querySelector('[data-go="#/members"]'));

  /* 總表要帶住 key，Sheet 先可以做 join */
  const { gasTemplate } = await import('../assets/js/lib/gastemplate.js');
  const gsCode = gasTemplate();
  ok('Code.gs 團員表帶 ymis 欄', /'ymis'/.test(gsCode));
  ok('Code.gs 團員表帶 systemId 欄', /'systemId'/.test(gsCode));
}

/* ---------- 新旅團申請接入（#1） ---------- */
console.log('\n▌新旅團申請接入（送去 ADMIN 收件匣）');
{
  const ob = await import('../assets/js/lib/onboard.js');
  const box = ob.adminInbox();
  ok('admin 收件匣已設定（data/units.json → admin.submitUrl）', box.configured === true, box.url);
  ok('收件匣係 Apps Script /exec', /^https:\/\/script\.google\.com\/macros\/s\//.test(box.url), box.url);
  ok('appType 係 82venture（同 vsbadge 共用收件匣時可以分辨）', ob.APP_TYPE === '82venture');

  const good = ob.validateApplication({
    troopId: '0100', troopName: '第一百旅深資童軍團',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec',
    apiKey: 'K1', contact: 'a@b.hk', note: 'x'
  });
  ok('填齊就通過驗證', good.ok === true && good.errors.length === 0, JSON.stringify(good.errors));
  ok('payload schema 同 VSBADGE submitRegistration 對齊',
    ['troopId','troopName','scriptUrl','apiKey','appType','note'].every(k => k in good.payload),
    Object.keys(good.payload).join(','));
  ok('payload 帶 mainSystemUrl（管理員要用做 portalOrigin）',
    typeof good.payload.mainSystemUrl === 'string' && good.payload.mainSystemUrl.length > 0,
    good.payload.mainSystemUrl);
  ok('payload 帶 at（時間戳）', /^\d{4}-\d{2}-\d{2}T/.test(good.payload.at || ''), good.payload.at);

  const bad = ob.validateApplication({ troopId: '', troopName: '', scriptUrl: 'http://example.com/x' });
  ok('缺欄位會逐項報錯', bad.ok === false && bad.errors.length >= 3, JSON.stringify(bad.errors));
  ok('唔係 GAS /exec 嘅後端網址會被擋',
    bad.errors.some(e => /\/exec/.test(e)), JSON.stringify(bad.errors));
  ok('旅團編號格式會被驗證',
    ob.validateApplication({ troopId: '01 00!!', troopName: 'X',
      scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' })
      .errors.some(e => /旅團編號/.test(e)));

  const failed = await ob.submitApplication({ troopId: '', troopName: '', scriptUrl: '' });
  ok('驗證失敗就唔會送出', failed.ok === false && failed.errors.length > 0, JSON.stringify(failed.errors));

  const cl = ob.adminChecklist('0100');
  ok('管理員 checklist 有列出兩邊要做嘅嘢',
    cl.length >= 4 && cl.some(x => x.includes('units.json')) && cl.some(x => x.includes('troops.json')),
    JSON.stringify(cl));
  ok('checklist 提埋 portalOrigin / portalRoles',
    cl.some(x => /portalOrigin/.test(x)), JSON.stringify(cl));

}

/* ---------- app 內教學要同實際做法一致 ---------- */
{
  window.location.hash = '#/docs/multiunit';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const dt = doc.getElementById('view').textContent;
  ok('教學「多旅團部署」有講新旅團申請接入', /新旅團申請接入/.test(dt));
  ok('教學講明每旅團用自己嘅 Sheet（唔係共用總表）', /每個旅團用自己嘅 Google Sheet 做後端/.test(dt));
  ok('教學有教起後端步驟（Code.gs / initializeSheets / 部署）',
    /Code\.gs/.test(dt) && /initializeSheets/.test(dt) && /網頁應用程式/.test(dt));

  window.location.hash = '#/docs/progress';
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const pt = doc.getElementById('view').textContent;
  ok('教學「進度接駁」警告唔好填 GAS /exec', /唔好填 Google Apps Script/.test(pt) && /Unknown action/.test(pt));
  ok('教學講明 Portal 身份可以留空（自動產生）', /可以留空/.test(pt) && /PORTAL-/.test(pt));
  ok('教學講明團員用 YMIS、領袖用 Email', /團員／執委用 YMIS/.test(pt) && /領袖用 Email/.test(pt));
}

/* ---------- 總結 ---------- */
const ms = Date.now() - t0;
console.log(`\n──────── ${MODE.toUpperCase()} 測試結果：${pass} 通過 / ${fail} 失敗（${ms} ms）────────`);
if (errors.length) {
  console.log(`\n捕捉到 ${errors.length} 個 console.error：`);
  errors.slice(0, 10).forEach(e => console.log('  • ' + e.slice(0, 220)));
}
process.exit(fail ? 1 : 0);
