/* ============================================================
   tests/_authstub.mjs — 超管核對（真係行 api/auth.js 嘅 handler）
   ------------------------------------------------------------
   2026-09-20 起超管密碼核對搬咗上伺服器端（api/auth.js），
   靜態部署／環境變數未設 → 超管登入關閉（fail closed）。
   所以測試要自己裝一個「有設環境變數嘅伺服器」。

   呢度**唔係**假嘢：直接 import 真嘅 handler 行，
   所以 env 未設、密碼錯、token 簽發呢啲行為都係真嘅。

   ⚠️ TEST_SUPER_PASSWORD 淨係測試 fixture。正式環境嘅密碼
      只存喺 Vercel 環境變數 SUPER_ADMIN_HASH，repo 入面冇。
   ============================================================ */
import crypto from 'node:crypto';
import authHandler from '../api/auth.js';

export const TEST_SUPER_USER = 'sheep';
export const TEST_SUPER_PASSWORD = '0728';
export const TEST_SUPER_SALT = 'v82:super';
export const TEST_SUPER_HASH = crypto.createHash('sha256')
  .update(`${TEST_SUPER_SALT}::${TEST_SUPER_PASSWORD}`).digest('hex');

/** 把 `api/auth` 接去真 handler。回一個還原函數。 */
export function installSuperAuth(prevFetch) {
  process.env.SUPER_ADMIN_USER = TEST_SUPER_USER;
  process.env.SUPER_ADMIN_SALT = TEST_SUPER_SALT;
  process.env.SUPER_ADMIN_HASH = TEST_SUPER_HASH;
  process.env.SESSION_SECRET = 'test-session-secret-not-for-production';
  const prev = prevFetch || globalThis.fetch;
  const realLog = console.log;
  globalThis.fetch = async (url, init = {}) => {
    const clean = String(url).split('?')[0].replace(/^\.?\//, '');
    if (clean !== 'api/auth') return prev(url, init);
    let out = null, code = 200;
    const res = {
      setHeader() { return this; },
      status(c) { code = c; return this; },
      json(o) { out = o; return this; }
    };
    console.log = () => {};                       // handler 會 safeLog，唔好污染測試輸出
    try {
      await authHandler({ method: 'POST', body: init.body ? JSON.parse(init.body) : {} }, res);
    } finally { console.log = realLog; }
    return { ok: code < 400, status: code, text: async () => JSON.stringify(out), json: async () => out };
  };
  return () => { globalThis.fetch = prev; };
}

/** 完全唔設環境變數（驗 fail closed） */
export function disableSuperAuth() {
  delete process.env.SUPER_ADMIN_HASH;
  delete process.env.SESSION_SECRET;
}
