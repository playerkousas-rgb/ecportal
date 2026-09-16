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
const reg = getRegistry();
ok('Registry 讀取到 0082 旅團', !!reg['0082'], Object.keys(reg).join(','));
ok('0082 旅團包含 code 與名稱', reg['0082']?.code === '0082' && reg['0082']?.name === '第八十二旅深資童軍團');

const trusted = getTrustedUnit('0082');
ok('getTrustedUnit 取得 0082 可信後端', !!trusted && !!trusted.gasUrl);
ok('非白名單旅團回傳 null', getTrustedUnit('9999') === null);

// 3. listPublicUnits
const pub = listPublicUnits();
ok('公開清單包含 0082', !!pub['0082']);
ok('公開清單絕不外洩 gasUrl / apiKey', pub['0082'].gasUrl === undefined && pub['0082'].apiKey === undefined);

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
ok('unitsHandler 回傳 units 物件', !!resJson?.units?.['0082']);

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
  ok('收件匣回 JSON 成功 → 前端攞到真回執（success:true）', good.statusCode === 200 && good.body?.success === true);
  ok('收件匣唔係 JSON（例：HTML 錯誤頁）→ 唔可以當成功，回 502',
    (upstreamRaw = '<html>error</html>', true)
    && (await post({ action: 'submitRegistration', troopId: '0100', troopName: 'X',
      scriptUrl: 'https://script.google.com/macros/s/AKfycbTESTTESTTESTTESTTESTTESTTESTTEST/exec' })).statusCode === 502);
  upstreamRaw = null;
  ok('proxy 只接受 POST', (await (async () => {
    const r = proxyRes(); await proxyHandler({ method: 'GET' }, r); return r;
  })()).statusCode === 405);
  ok('唔喺白名單嘅 action 會被擋',
    (await post({ action: 'deleteEverything', troopId: '0082' })).statusCode === 400);
  globalThis.fetch = realFetch;
}

console.log(`\n──────── API 測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
process.exit(fail ? 1 : 0);
