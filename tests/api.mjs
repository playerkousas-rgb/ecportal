/* ============================================================
   tests/api.mjs — 測試 Vercel Serverless Function API
   驗證 Registry、Units 清單、Proxy 轉發與安全規則。
   ============================================================ */

import { getRegistry, getTrustedUnit, listPublicUnits, isTrustedExecUrl } from '../api/_registry.js';
import unitsHandler from '../api/units.js';

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

console.log(`\n──────── API 測試結果：${pass} 通過 / ${fail} 失敗 ────────`);
process.exit(fail ? 1 : 0);
