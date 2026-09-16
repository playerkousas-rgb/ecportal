/* ============================================================
   onboard.js — 新旅團申請接入與部署協助
   流程（旅團嗰邊）：
     1. 登入前直接下載 Code.gs（毋須登入）
     2. 建自己嘅 Google Sheet → 執行 initializeSheets → 複製 API Key
     3. 部署做 Web App（執行身分：我；存取權：任何人）
     4. 填寫申請表提交 URL 與 API Key，或由 Git 負責人加進 data/units.json 與 Vercel 作登記
   ============================================================ */

import { registry } from './units.js';
import { gasTemplate } from './gastemplate.js';
import { download } from './exporter.js';
import { toast, icon } from './util.js';

export const APP_TYPE = '82venture';

/** 登入前／任何時候直接下載 Code.gs */
export function downloadCodeGs() {
  download('Code.gs', gasTemplate(), 'text/plain;charset=utf-8');
  toast('已下載 Code.gs（Apps Script 後端程式碼）', 'ok');
}

/** 管理員收件匣（Apps Script /exec） */
export function adminInbox() {
  const a = registry()?.admin || {};
  const url = String(a.submitUrl || '').trim();
  return { name: a.name || '平台管理員收件匣', url, configured: /^https:\/\/script\.google\.com\/macros\/s\//i.test(url) };
}

const EXEC_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,}\/exec\/?$/i;
const ID_RE = /^[0-9A-Za-z_-]{1,32}$/;

/**
 * 驗證申請內容。
 * @returns {{ok:boolean, errors:string[], payload:object}}
 */
export function validateApplication(input = {}) {
  const errors = [];
  const troopId = String(input.troopId || '').trim();
  const troopName = String(input.troopName || '').trim();
  const scriptUrl = String(input.scriptUrl || '').trim();
  const apiKey = String(input.apiKey || '').trim();
  const contact = String(input.contact || '').trim();
  const note = String(input.note || '').trim();

  if (!troopId) errors.push('請填旅團編號（例：0100）');
  else if (!ID_RE.test(troopId)) errors.push('旅團編號只可以用英數／-_，最長 32 字');
  if (!troopName) errors.push('請填旅團名稱');
  if (!scriptUrl) errors.push('請填你嘅 Apps Script /exec 網址');
  else if (!EXEC_RE.test(scriptUrl)) errors.push('後端網址要係 Google Apps Script 嘅 /exec 正式部署網址（https://script.google.com/macros/s/…/exec）');

  let mainSystemUrl = '';
  try { mainSystemUrl = globalThis.location?.origin || ''; } catch (e) { mainSystemUrl = ''; }

  const payload = {
    troopId: troopId.substring(0, 32),
    troopName: troopName.substring(0, 100),
    scriptUrl: scriptUrl.substring(0, 300),
    apiKey: apiKey.substring(0, 120),
    appType: APP_TYPE,
    mainSystemUrl,
    contact: contact.substring(0, 120),
    note: note.substring(0, 500),
    at: new Date().toISOString()
  };
  return { ok: errors.length === 0, errors, payload };
}

/**
 * 把申請 POST 去管理員收件匣。
 */
export async function submitApplication(input = {}, timeoutMs = 20000) {
  const v = validateApplication(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  const box = adminInbox();
  if (!box.configured) {
    return { ok: false, errors: ['未設定管理員收件匣（data/units.json → admin.submitUrl）'] };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    await fetch(box.url, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(v.payload),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    return { ok: true, ms: Date.now() - t0, payload: v.payload };
  } catch (e) {
    clearTimeout(timer);
    const aborted = e?.name === 'AbortError';
    return {
      ok: false,
      ms: Date.now() - t0,
      errors: [aborted ? `提交逾時（${Math.round(timeoutMs / 1000)} 秒冇回應）` : (e?.message || String(e))],
      payload: v.payload
    };
  }
}

/** 管理員收到申請之後要做嘅嘢（用嚟顯示／複製） */
export function adminChecklist(troopId = '<編號>') {
  return [
    `82venture → data/units.json：喺 units 加 "${troopId}" entry（code / name / dataPath / backend.gasUrl / backend.apiKey / progress）`,
    `82venture → 建 data/units/${troopId}/ 資料夾（unit.json / members.json / constitution.json / finance.json / inventory.json）`,
    `VSBADGE → data/troops.json：加 "${troopId}": { name, backend, portalOrigin, portalRoles }`,
    `VSBADGE → 或者用環境變數 TROOP_${troopId}_BACKEND / TROOP_${troopId}_APIKEY（優先於檔案）`,
    '兩邊都 deploy 一次，再用 portal 連結實測（應該免登入直接入到）'
  ];
}
