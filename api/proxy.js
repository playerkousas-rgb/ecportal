// Vercel 同源 Proxy — 82venture 多旅團 GAS 安全轉發層
//
// 架構：
//   瀏覽器 ──同源 POST──▶ /api/proxy ──伺服器端──▶ 已登記旅團的 GAS /exec ──▶ Google Sheet
//
// 安全原則：
//   1. 前端可提交 unitCode，由伺服器端 Registry 安全解析真實 GAS URL
//   2. 只接受白名單 action (ping, status, sync, claim, loan, noticeSignup, notices, submitRegistration)
//   3. 永不在 log 記錄密碼／apiKey／payload 機密
//
// 同時兼容前端直接打 GAS 或透過同源 proxy 轉發。

import { getTrustedUnit, isTrustedExecUrl } from './_registry.js';

export const config = { maxDuration: 60 };

const UPSTREAM_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.V82_PROXY_TIMEOUT_MS || process.env.VSBADGE_PROXY_TIMEOUT_MS || '45000', 10);
  if (Number.isNaN(v)) return 45000;
  return Math.max(1000, Math.min(55000, v));
})();
const MAX_DATA_BYTES = 4 * 1024 * 1024; // 單次請求上限 4MB

// 中央管理員收件匣（新旅團接入申請）—— 目的地係伺服器端常數，前端改唔到。
// 呢個收件匣同 VSBADGE 共用（用 appType 分辨：82venture / vsbadge）。
// 注意：收件匣**唔會回執** —— 申請人 App 唔會知 ADMIN 收唔收到，
// 所以只要 POST 過得去（有回應）就當送到，只有連線／逾時先當失敗。
const SCOUT_ADMIN_API = process.env.SCOUT_ADMIN_API ||
  'https://script.google.com/macros/s/AKfycbxj5BDDGgjs559smkK4Z5aYImWYeXbN5af8U1ObON0z9WnsN6QJW4I1XWolhs5kQ_H-UQ/exec';

const ALLOWED_ACTIONS = new Set([
  'ping', 'status', 'test', 'sync', 'claim', 'loan', 'noticeSignup',
  /* 整份資料庫讀／寫 —— app 嘅真正儲存（換機／清 cache 都唔會冇咗） */
  'saveDb', 'loadDb', 'dbInfo',
  /* 公開通告：免登入讀旅團自己後端嘅「通告全文」（只回已發布） */
  'notices',
  'submitRegistration'
]);

/* 呢啲 action 會夾帶成個資料庫上去，body 可以幾 MB —— 唔可以當普通 action 咁限死 */
const BIG_BODY_ACTIONS = new Set(['saveDb', 'sync']);

function sendJson(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).json(obj);
}

function safeLog(fields) {
  try { console.log(JSON.stringify({ svc: 'ecportal-proxy', ...fields })); } catch (e) { /* ignore */ }
}

async function readRawBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_DATA_BYTES + 1024) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return null; }
}

async function callUpstream(url, payload) {
  const init = {
    method: 'POST',
    redirect: 'follow',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload || {})
  };
  const up = await fetch(url, init);
  const text = await up.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
  return { status: up.status, json, raw: text };
}

export default async function handler(req, res) {
  const t0 = Date.now();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { success: false, error: '此 API 只接受 POST 請求' });
  }

  const body = await readRawBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { success: false, error: '請求格式錯誤' });
  }

  const action = String(body.action || (body.tables ? 'sync' : ''));
  const unitCode = String(body.unit || body.troopId || '').trim();

  if (!ALLOWED_ACTIONS.has(action)) {
    safeLog({ result: 'bad_action', action: action.slice(0, 40), ms: Date.now() - t0 });
    return sendJson(res, 400, { success: false, error: '不支援的操作' });
  }

  // ===== 特殊：新旅團接入申請（轉發去中央管理員收件匣）=====
  if (action === 'submitRegistration') {
    if (!isTrustedExecUrl(SCOUT_ADMIN_API)) {
      safeLog({ result: 'admin_api_misconfig', ms: Date.now() - t0 });
      return sendJson(res, 500, { success: false, error: '伺服器設定錯誤，請聯絡管理員' });
    }
    const regPayload = {
      troopId: String(body.troopId || body.unit || '').substring(0, 32),
      troopName: String(body.troopName || '').substring(0, 100),
      scriptUrl: String(body.scriptUrl || '').substring(0, 300),
      apiKey: String(body.apiKey || '').substring(0, 120),
      appType: '82venture',
      appName: '執委管理系統',
      contact: String(body.contact || '').substring(0, 120),
      mainSystemUrl: String(body.mainSystemUrl || '').substring(0, 300),
      note: String(body.note || '').substring(0, 500),
      at: new Date().toISOString()
    };
    try {
      const up = await callUpstream(SCOUT_ADMIN_API, regPayload);
      /* 收件匣冇回執機制：POST 過得去就當送到（ADMIN 系統收到就 OK）。
         唯一例外：收件匣真係回咗 JSON 而且話 success:false，就照當失敗。 */
      const said = (up.json && typeof up.json === 'object') ? up.json : null;
      if (said && said.success === false) {
        safeLog({ result: 'admin_upstream_refused', status: up.status, ms: Date.now() - t0 });
        return sendJson(res, 502, { success: false, error: said.error || '管理員收件匣話收唔到呢張申請' });
      }
      safeLog({ result: 'registration_sent', status: up.status, json: !!up.json, ms: Date.now() - t0 });
      return sendJson(res, 200, { success: true, message: '申請已提交', delivered: 'sent', receipt: false });
    } catch (e) {
      const timeout = e && e.name === 'TimeoutError';
      return sendJson(res, timeout ? 504 : 502, { success: false, error: timeout ? '提交逾時，請稍後重試' : '申請未能送達管理員' });
    }
  }

  // ===== 一般旅團 action =====
  if (!/^[0-9A-Za-z_-]{1,32}$/.test(unitCode)) {
    return sendJson(res, 400, { success: false, error: '旅團編號格式不正確' });
  }

  const unit = getTrustedUnit(unitCode);
  if (!unit) {
    safeLog({ result: 'unknown_unit', unitCode, ms: Date.now() - t0 });
    return sendJson(res, 404, { success: false, error: '找不到此旅團或後端網址未設定' });
  }

  const payload = { ...body, action };
  if (unit.apiKey && !payload.apiKey) payload.apiKey = unit.apiKey;

  try {
    const up = await callUpstream(unit.gasUrl, payload);
    if (!up.json) {
      safeLog({ result: 'upstream_bad_response', unitCode, action, status: up.status, ms: Date.now() - t0 });
      const msg = up.status >= 400
        ? `旅團後端暫時無法使用（HTTP ${up.status}）`
        : '旅團後端回應格式異常，請檢查 Apps Script 部署';
      return sendJson(res, 502, { success: false, error: msg });
    }

    safeLog({ result: 'ok', unitCode, action, status: up.status, ms: Date.now() - t0 });
    return sendJson(res, 200, up.json);
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    safeLog({ result: timeout ? 'upstream_timeout' : 'upstream_fetch_error', unitCode, action, ms: Date.now() - t0 });
    return sendJson(res, timeout ? 504 : 502, {
      success: false,
      error: timeout ? '旅團後端回應逾時' : '無法連接旅團後端，請稍後重試'
    });
  }
}
