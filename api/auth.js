// api/auth.js — 超級管理員登入（伺服器端核對）
//
// ============================================================
//  點解要呢個檔
// ------------------------------------------------------------
//  以前 auth.js 係咁寫嘅：
//
//      const SUPER = { username: 'sheep', salt: 'v82:super:sheep',
//                      hash: '652debbf…' };
//      …
//      const ok = (await sha256Hex(SUPER.salt + '::' + p)) === SUPER.hash
//                 || p === '0728';        // ← 寫死嘅後門密碼
//
//  問題：呢個係**靜態網站**，個 hash 同一條後門密碼都隨 JavaScript
//  一齊送到瀏覽器。repo 一係 public，任何人都讀到 username ＋ 密碼，
//  然後登入你任何旅團做超級管理員。
//
//  做法（呢個檔）：密碼核對搬上伺服器端。
//    · 明文密碼**永遠唔落瀏覽器、亦唔落 repo**
//    · repo 入面只剩「點樣核對」嘅程式碼，冇任何秘密
//    · 環境變數冇設 → 超管登入**完全關閉**（fail closed，唔會靜靜地放行）
//
// ============================================================
//  Vercel 環境變數（Settings → Environment Variables）
// ------------------------------------------------------------
//    SUPER_ADMIN_HASH   必填。sha256( `${SUPER_ADMIN_SALT}::<你嘅密碼>` ) 嘅 hex。
//                       冇設 → 超管登入關閉。
//    SUPER_ADMIN_USER   選填，預設 'sheep'。
//    SUPER_ADMIN_SALT   選填，預設 'v82:super'。改 salt 就要重新計 hash。
//    SESSION_SECRET     必填。用嚟簽發登入 token（HMAC）。冇設 → 拒絕登入。
//                       要夠隨機，例如：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
//  點樣計 SUPER_ADMIN_HASH（喺你自己部機行，唔好喺線上工具貼密碼）：
//    node -e "const c=require('crypto');const pw=process.argv[1];const salt=process.argv[2]||'v82:super';
//             console.log(c.createHash('sha256').update(salt+'::'+pw).digest('hex'))" '你嘅密碼'
//
// ============================================================
//  ⚠️ 呢個做法保護到乜、保護唔到乜（一定要知）
// ------------------------------------------------------------
//  保護到：**密碼**。冇人可以由公開 repo 讀到佢，亦冇人可以離線爆佢。
//
//  保護唔到：**「超管」呢個身份本身**。因為個 App 係靜態網站，
//  `isSuper()` 只係讀 localStorage 嘅 session —— 識得開 DevTools 嘅人
//  可以人手寫 `{"role":"super"}` 落去，照樣見到超管先至見到嘅畫面。
//  而家超管淨係 gate 咗 UI（accounts.js 嘅 MOCK tab、docs.js 嘅開新旅團教學、
//  「開新旅團」掣），冇一個真正嘅伺服器端特權操作，所以呢個漏洞暫時冇實質損失。
//  如果將來超管要做真正敏感嘅嘢（改 registry、清後端、讀人哋旅團），
//  **嗰個操作本身一定要放喺伺服器端，並且驗呢度簽發嘅 token** ——
//  呢個檔已經預留咗 `verifySuperToken()` 畀你用。
// ============================================================

import crypto from 'node:crypto';

export const config = { maxDuration: 15 };

/* ★ 環境變數一定要喺**請求嗰陣**先讀，唔好喺 module 頂層讀死。
   頂層讀嘅話：① 測試冇辦法喺 import 之後先設 env；
              ② Vercel 上面如果變數係部署之後先加，舊 instance 會一路用舊值。
   所以呢度每次 handler 行嗰陣先攞。 */
function cfg() {
  return {
    salt: process.env.SUPER_ADMIN_SALT || 'v82:super',
    user: (process.env.SUPER_ADMIN_USER || 'sheep').trim().toLowerCase(),
    hash: String(process.env.SUPER_ADMIN_HASH || '').trim().toLowerCase(),
    secret: String(process.env.SESSION_SECRET || '')
  };
}
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;   // 8 小時

/* 極簡速率限制。**注意**：Vercel serverless 每個 instance 各自計數，
   所以呢個只係擋「同一個 instance 上面嘅連環爆」，唔係真正嘅全局限流。
   要真正限流要用 Upstash／Vercel KV 之類。寫清楚，唔好令人以為佢好勁。 */
const hits = new Map();
function rateLimited(key, max = 8, windowMs = 5 * 60 * 1000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

function send(res, status, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(status).json(obj);
}

/** 常數時間比對（唔好用 === ：長度同首幾個字元會洩漏資訊） */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** 驗 token（export 出嚟畀將來嘅伺服器端特權操作用）
 *  @param {string} token  `<exp>.<sig>`
 *  @returns {{ok:boolean, exp?:number, reason?:string}} */
export function verifySuperToken(token) {
  const { secret } = cfg();
  if (!secret) return { ok: false, reason: 'no_secret' };
  const m = /^(\d+)\.([a-f0-9]{64})$/.exec(String(token || ''));
  if (!m) return { ok: false, reason: 'bad_format' };
  if (!safeEqual(sign(m[1], secret), m[2])) return { ok: false, reason: 'bad_signature' };
  if (Number(m[1]) < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, exp: Number(m[1]) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { ok: false, error: '只接受 POST' });
  }

  const { salt, user: wantUser, hash, secret } = cfg();

  /* fail closed：環境變數冇設 → 超管登入成條路關閉。
     寧願你自己一時入唔到，都好過留一條任何人都入到嘅門。 */
  if (!hash) {
    return send(res, 503, {
      ok: false, disabled: true,
      error: '超級管理員登入已關閉（伺服器未設 SUPER_ADMIN_HASH）',
      hint: '平台管理員喺 Vercel 加 SUPER_ADMIN_HASH ＋ SESSION_SECRET，再 Redeploy。計算方法見 api/auth.js 頂部註解。'
    });
  }
  if (!secret) {
    return send(res, 503, {
      ok: false, disabled: true,
      error: '伺服器設定不完整（未設 SESSION_SECRET）—— 無法簽發登入憑證',
      hint: '平台管理員喺 Vercel 加 SESSION_SECRET（隨機 32 bytes hex），再 Redeploy。'
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return send(res, 400, { ok: false, error: '請求格式錯誤' });

  const user = String(body.user || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (rateLimited('super')) {
    return send(res, 429, { ok: false, error: '試太多次，請 5 分鐘後再試' });
  }
  /* 連密碼都唔使比：username 唔啱就即刻回，唔好俾人用嚟確認邊個 username 存在 */
  if (!safeEqual(user, wantUser)) {
    return send(res, 401, { ok: false, error: '帳號或密碼不正確' });
  }
  const got = crypto.createHash('sha256').update(`${salt}::${password}`).digest('hex');
  if (!safeEqual(got, hash)) {
    return send(res, 401, { ok: false, error: '帳號或密碼不正確' });
  }

  const exp = Date.now() + TOKEN_TTL_MS;
  const token = `${exp}.${sign(String(exp), secret)}`;
  /* ⚠️ 只 log metadata。密碼、hash、salt、token 一律唔入 log。 */
  try { console.log(JSON.stringify({ svc: 'ecportal-auth', result: 'ok', user, exp })); } catch { /* ignore */ }
  /* 只回 token ＋ 到期時間。密碼、hash、salt 一律唔回。 */
  return send(res, 200, { ok: true, token, exp, user: wantUser });
}
