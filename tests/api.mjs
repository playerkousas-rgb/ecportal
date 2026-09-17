/* ============================================================
   tests/api.mjs — 測試 Vercel Serverless Function API
   驗證 Registry、Units 清單、Proxy 轉發與安全規則。
   ============================================================ */

import { getRegistry, getTrustedUnit, listPublicUnits, isTrustedExecUrl } from '../api/_registry.js';
import unitsHandler from '../api/units.js';
import proxyHandler from '../api/proxy.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n▌Serverless API & Registry 測試');

// 1. isTrustedExecUrl
ok('驗證正常 GAS /exec URL', isTrustedExecUrl('https://script.google.com/macros/s/AKfycbySGLBg5KuWzgM9EySiOIppqnzrL0QASIYLlhbCIHocGHcLHKbkMdvmhJvam3baG___/exec'));
ok('擋住非 GAS URL', !isTrustedExecUrl('https://evil.com/exec'));
ok('擋住 GAS /dev URL', !isTrustedExecUrl('https://script.google.com/macros/s/AKfycbySGLBg5KuWzgM9EySiOIppqnzrL0QASIYLlhbCIHocGHcLHKbkMdvmhJvam3baG___/dev'));

// 2. getRegistry & getTrustedUnit
/* 注意：data/units.json 而家冇任何旅團（0082 嘅資料已全清，
   真旅團一律靠 Vercel 環境變數 TROOP_<編號>_* 登記）。
   所以呢度先用環境變數開一個虛構旅團 TEST9 做 fixture。 */
const TEST_GAS = 'https://script.google.com/macros/s/AKfycbTESTonlyFixtureNotARealDeploymentId000000000/exec';
process.env.TROOP_TEST9_BACKEND = TEST_GAS;
process.env.TROOP_TEST9_APIKEY = 'test9_secret_key';
process.env.TROOP_TEST9_NAME = '測試旅深資童軍團';

const reg = getRegistry();
ok('Registry 讀取到環境變數登記嘅旅團', !!reg.TEST9, Object.keys(reg).join(','));
ok('旅團包含 code 與名稱', reg.TEST9?.code === 'TEST9' && reg.TEST9?.name === '測試旅深資童軍團');
ok('Registry 冇殘留 0082（資料已全清）', !reg['0082'], Object.keys(reg).join(','));

const trusted = getTrustedUnit('TEST9');
ok('getTrustedUnit 取得可信後端', !!trusted && !!trusted.gasUrl);
ok('getTrustedUnit 帶埋伺服器端 API Key', trusted?.apiKey === 'test9_secret_key');
ok('非白名單旅團回傳 null', getTrustedUnit('9999') === null);
ok('0082 冇登記就攞唔到後端（唔會再借用舊旅團）', getTrustedUnit('0082') === null);

// 3. listPublicUnits
const pub = listPublicUnits();
ok('公開清單包含登記咗嘅旅團', !!pub.TEST9);
ok('公開清單絕不外洩 gasUrl / apiKey', pub.TEST9.gasUrl === undefined && pub.TEST9.apiKey === undefined);

// 4. unitsHandler
let resStatus = 0;
let resHeaders = {};
let resJson = null;
const mockRes = {
  setHeader(k, v) { resHeaders[k] = v; return this; },
  status(s) { resStatus = s; return this; },
  json(obj) { resJson = obj; return this; }
};
unitsHandler({ method: 'GET' }, mockRes);
ok('unitsHandler 回傳 HTTP 200', resStatus === 200);
ok('unitsHandler 回傳 units 物件', !!resJson?.units?.TEST9);

// 5. 純環境變數開新旅團（唔改 Git 都開得）
{
  const GAS = 'https://script.google.com/macros/s/AKfycbxqQ3JnEdSRnxlhoSEasa6-wX5F58p3dMqiQRj1zg-SDn7YtFLBKykN5LiWcadgRdCBg/exec';
  process.env.TROOP_0081_BACKEND = GAS;
  process.env.TROOP_0081_APIKEY = 'troop_key_81';
  process.env.TROOP_0081_NAME = '第八十一旅深資童軍團';
  process.env.TROOP_0081_NOTICE = GAS;
  process.env.TROOP_0081_PROGRESSBACKEND = GAS;
  process.env.TROOP_0081_PROGRESSAPIKEY = 'progress_key_81';

  const envPub = listPublicUnits();
  ok('淨係設 env 都開到新旅團（0081 出現喺公開清單）', !!envPub['0081'], Object.keys(envPub).join(','));
  ok('旅團名由 TROOP_<id>_NAME 讀（冇填就「第 0081 旅」）', envPub['0081'].name === '第八十一旅深資童軍團', envPub['0081'].name);
  ok('公開清單一樣唔外洩 gasUrl / apiKey / progress key',
    envPub['0081'].gasUrl === undefined && envPub['0081'].apiKey === undefined && envPub['0081'].progressApiKey === undefined);
  ok('公開清單標示「伺服器端已備妥進度後端」（前端唔使填）', envPub['0081'].progressServerSide === true);
  ok('公開清單標示通告可以直接送去總表', envPub['0081'].noticeReady === true);
  ok('env 旅團一樣通過白名單驗證（proxy 用得到）', !!getTrustedUnit('0081')?.gasUrl);

  delete process.env.TROOP_0081_BACKEND;
  delete process.env.TROOP_0081_APIKEY;
  delete process.env.TROOP_0081_NAME;
  delete process.env.TROOP_0081_NOTICE;
  delete process.env.TROOP_0081_PROGRESSBACKEND;
  delete process.env.TROOP_0081_PROGRESSAPIKEY;
  ok('刪走 env 之後就唔再出現（唔會殘留）', !listPublicUnits()['0081']);
}

// 6. 新旅團申請 → 經 proxy 送去 ADMIN 系統（中央收件匣）
{
  const ADMIN = 'https://script.google.com/macros/s/AKfycbxj5BDDGgjs559smkK4Z5aYImWYeXbN5af8U1ObON0z9WnsN6QJW4I1XWolhs5kQ_H-UQ/exec';
  const proxyRes = () => {
    const r = { statusCode: 0, headers: {}, body: null };
    r.setHeader = (k, v) => { r.headers[k] = v; return r; };
    r.status = (s) => { r.statusCode = s; return r; };
    r.json = (o) => { r.body = o; return r; };
    return r;
  };
  const calls = [];
  let upstreamJson = { success: true, message: '申請已提交' };
  let upstreamRaw = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (target, init = {}) => {
    calls.push({ target: String(target), init });
    const text = upstreamRaw !== null ? upstreamRaw : JSON.stringify(upstreamJson);
    return {
      ok: true, status: 200,
      text: async () => text,
      json: async () => JSON.parse(text)
    };
  };
  const post = async (body) => {
    const res = proxyRes();
    await proxyHandler({ method: 'POST', body }, res);
    return res;
  };

  const good = await post({
    action: 'submitRegistration', troopId: '0100', troopName: '第一百旅深資童軍團',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec',
    apiKey: 'K1', contact: 'a@b.hk', note: '想埋進度', mainSystemUrl: 'https://ecportal.vercel.app'
  });
  const sent = JSON.parse(calls[0]?.init?.body || '{}');
  ok('提交申請 → 用同源 proxy 轉發（申請人唔使直接打 GAS）', calls.length === 1 && calls[0].target === ADMIN, calls[0]?.target);
  ok('收件匣目的地由伺服器端固定（前端改唔到）',
    (await post({ action: 'submitRegistration', troopId: '0100', adminUrl: 'https://evil.example.com/exec',
      scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' }))
      && calls[calls.length - 1].target === ADMIN);
  ok('轉發 payload 帶 appType=82venture ＋ appName（同 VSBADGE 共用收件匣，可以分辨）',
    sent.appType === '82venture' && sent.appName === '執委管理系統', JSON.stringify({ appType: sent.appType, appName: sent.appName }));
  ok('轉發 payload 帶齊旅團編號／名稱／後端／API Key／聯絡人／主系統網址',
    sent.troopId === '0100' && sent.troopName === '第一百旅深資童軍團'
    && /\/exec$/.test(sent.scriptUrl) && sent.apiKey === 'K1' && sent.contact === 'a@b.hk'
    && sent.mainSystemUrl === 'https://ecportal.vercel.app' && /^\d{4}-\d{2}-\d{2}T/.test(sent.at || ''));
  ok('收件匣回 JSON → proxy 當送到（success:true，唔聲稱有回執）',
    good.statusCode === 200 && good.body?.success === true && good.body?.receipt === false);
  /* 收件匣唔會回執：回 HTML／空白都要當送到（ADMIN 系統收到就 OK） */
  const htmlPage = await (upstreamRaw = '<html>已收到</html>', post({ action: 'submitRegistration', troopId: '0100', troopName: 'X',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' }));
  ok('收件匣唔回 JSON（HTML／空白）→ 照當送到（唔會誤報失敗）',
    htmlPage.statusCode === 200 && htmlPage.body?.success === true, JSON.stringify(htmlPage.body));
  const blank = await (upstreamRaw = ' ', post({ action: 'submitRegistration', troopId: '0100', troopName: 'X',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' }));
  ok('收件匣回空白 → 同樣當送到', blank.statusCode === 200 && blank.body?.success === true);
  /* 但收件匣真係話收唔到，就照當失敗 */
  upstreamRaw = null;
  const refused = await (upstreamJson = { success: false, error: '唔收呢類申請' },
    post({ action: 'submitRegistration', troopId: '0100', troopName: 'X',
      scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' }));
  ok('收件匣明確回 success:false → 當失敗（唔會呃申請人）',
    refused.statusCode === 502 && /唔收呢類申請/.test(refused.body?.error || ''), JSON.stringify(refused.body));
  upstreamJson = { success: true, message: '申請已提交' };
  /* 連線唔通 → 失敗 */
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async () => { const e = new Error('boom'); e.name = 'TimeoutError'; throw e; };
  const down = await post({ action: 'submitRegistration', troopId: '0100', troopName: 'X',
    scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' });
  ok('連線／逾時 → 回 504（呢個先算送唔到）', down.statusCode === 504, JSON.stringify(down.body));
  globalThis.fetch = realFetch2;
  ok('proxy 只接受 POST', (await (async () => {
    const r = proxyRes(); await proxyHandler({ method: 'GET' }, r); return r;
  })()).statusCode === 405);
  ok('唔喺白名單嘅 action 會被擋',
    (await post({ action: 'deleteEverything', troopId: '0082' })).statusCode === 400);
  globalThis.fetch = realFetch;
}

console.log(`\n──────── API 測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
process.exit(fail ? 1 : 0);
