/* ============================================================
   auth.js — 身份、權限、密碼規則

   登入身份只有兩種（＋一個隱藏帳戶）：
     leader  領袖
     exco    執行委員會
     super   超級管理員 —— 隱藏：唔會顯示喺任何名單，
             只可以用指定帳號／密碼登入，任何人（包括超管自己）
             都唔可以改佢個密碼。

   密碼權限（依實際需要）：
     超管：可改領袖、執委嘅密碼
     領袖：可改自己、執委嘅密碼
     執委：只可改自己嘅密碼
   ============================================================ */

import {
  load, commit, collection, find, add, remove, getSession, setSession, audit, isMock
} from './store.js';

export const ROLES = {
  super: {
    id: 'super', name: '超級管理員', short: '超管', color: '#4A111C', level: 3, hidden: true,
    desc: '系統擁有者（隱藏帳戶）'
  },
  leader: {
    id: 'leader', name: '領袖', short: '領袖', color: '#7B2233', level: 2,
    desc: '團領袖／支部領袖 —— 管理團務、財務、團章、物資'
  },
  exco: {
    id: 'exco', name: '執行委員會', short: '執委', color: '#A83A4E', level: 1,
    desc: '執委會成員 —— 日常團務：開會、點名、記帳、借用物資'
  }
};

/* 隱藏超級管理員：只存雜湊（唔會出現喺帳戶名單、亦唔會匯出） */
const SUPER = {
  id: 'super',
  role: 'super',
  username: 'sheep',
  name: '系統管理員',
  salt: 'v82:super:sheep',
  hash: '652debbfdc29dd091325028855c281a08a50f91fcd0eb269444ff4eb5338645e'
};
export const RESERVED_USERNAMES = ['sheep', 'super', 'admin', 'system'];

/* ============================================================
   權限矩陣
   ============================================================ */
export const PERMS = {
  /* 會議 */
  'meeting.view':   { super: 1, leader: 1, exco: 1 },
  'meeting.create': { super: 1, leader: 1, exco: 1 },
  'meeting.edit':   { super: 1, leader: 1, exco: 'own' },
  'meeting.delete': { super: 1, leader: 1, exco: 0 },
  'meeting.minutes':{ super: 1, leader: 1, exco: 1 },
  'meeting.approve':{ super: 1, leader: 1, exco: 1 },

  /* 財務 */
  'finance.view':   { super: 1, leader: 1, exco: 1 },
  'finance.create': { super: 1, leader: 1, exco: 1 },
  'finance.edit':   { super: 1, leader: 1, exco: 'own' },
  'finance.delete': { super: 1, leader: 1, exco: 0 },
  'finance.report': { super: 1, leader: 1, exco: 1 },
  'finance.export': { super: 1, leader: 1, exco: 1 },
  'claim.submit':   { super: 1, leader: 1, exco: 1 },
  'claim.review':   { super: 1, leader: 1, exco: 1 },

  /* 團費 */
  'fee.view':       { super: 1, leader: 1, exco: 1 },
  'fee.mark':       { super: 1, leader: 1, exco: 1 },
  'fee.edit':       { super: 1, leader: 1, exco: 0 },

  /* 用戶（領袖 / 執委 / 團員 名冊）—— 執委都可以改資料同身份 */
  'member.view':    { super: 1, leader: 1, exco: 1 },
  'member.create':  { super: 1, leader: 1, exco: 1 },
  'member.edit':    { super: 1, leader: 1, exco: 1 },
  'member.note':    { super: 1, leader: 1, exco: 1 },
  'member.delete':  { super: 1, leader: 1, exco: 0 },
  'member.export':  { super: 1, leader: 1, exco: 1 },

  /* 物資（能登入嘅都可以批核／借還） */
  'inv.view':       { super: 1, leader: 1, exco: 1 },
  'inv.manage':     { super: 1, leader: 1, exco: 1 },
  'inv.borrow':     { super: 1, leader: 1, exco: 1 },
  'inv.approve':    { super: 1, leader: 1, exco: 1 },
  'inv.audit':      { super: 1, leader: 1, exco: 1 },

  /* 進度系統 */
  'progress.view':  { super: 1, leader: 1, exco: 1 },
  'progress.config':{ super: 1, leader: 1, exco: 0 },

  /* 通告 */
  'notice.view':    { super: 1, leader: 1, exco: 1 },
  'notice.create':  { super: 1, leader: 1, exco: 1 },
  'notice.edit':    { super: 1, leader: 1, exco: 1 },
  'notice.publish': { super: 1, leader: 1, exco: 1 },
  'notice.signup':  { super: 1, leader: 1, exco: 1 },

  /* 表格設計 / 同步 */
  'table.view':     { super: 1, leader: 1, exco: 1 },
  'table.design':   { super: 1, leader: 1, exco: 0 },
  'table.sync':     { super: 1, leader: 1, exco: 0 },

  /* 團章 */
  'constitution.view':    { super: 1, leader: 1, exco: 1 },
  'constitution.edit':    { super: 1, leader: 1, exco: 0 },
  'constitution.publish': { super: 1, leader: 1, exco: 0 },

  /* 系統 */
  'admin.view':       { super: 1, leader: 1, exco: 1 },
  'admin.accounts':   { super: 1, leader: 1, exco: 0 },   // 開／刪帳戶
  'admin.pw.self':    { super: 1, leader: 1, exco: 1 },
  'admin.pw.leader':  { super: 1, leader: 'self', exco: 0 },
  'admin.pw.exco':    { super: 1, leader: 1, exco: 'self' },
  'admin.pw.super':   { super: 0, leader: 0, exco: 0 },   // 冇人可以改超管密碼
  'admin.data':       { super: 1, leader: 1, exco: 0 },
  'admin.units':      { super: 1, leader: 1, exco: 0 },
  'docs.view':        { super: 1, leader: 1, exco: 1 }
};

export const PERM_GROUPS = [
  { title: '會議', items: [['meeting.view', '查看會議'], ['meeting.create', '新增會議'], ['meeting.edit', '編輯會議'], ['meeting.delete', '刪除會議'], ['meeting.minutes', '記錄 / 點名'], ['meeting.approve', '確認 / 通過']] },
  { title: '財務', items: [['finance.view', '查看帳目'], ['finance.create', '新增收支'], ['finance.edit', '編輯收支'], ['finance.delete', '刪除收支'], ['finance.report', '年結 / 月結報表'], ['finance.export', '輸出 Word / PDF / CSV'], ['claim.submit', '提交收支申報'], ['claim.review', '批核申報']] },
  { title: '團費', items: [['fee.view', '查看收費'], ['fee.mark', '標記收款'], ['fee.edit', '增刪收費項目']] },
  { title: '用戶（領袖／執委／團員）', items: [['member.view', '查看用戶名冊'], ['member.create', '新增用戶'], ['member.edit', '編輯資料 / 身份 / 生日'], ['member.note', '撰寫備註'], ['member.delete', '刪除用戶'], ['member.export', '輸出名冊及生日表']] },
  { title: '物資', items: [['inv.view', '查看物資'], ['inv.manage', '新增 / 修改物資'], ['inv.borrow', '申請借用'], ['inv.approve', '批核借用 / 歸還'], ['inv.audit', '盤點調整庫存']] },
  { title: '通告', items: [['notice.view', '查看通告'], ['notice.create', '開新通告'], ['notice.edit', '編輯通告'], ['notice.publish', '發布 / 分享'], ['notice.signup', '睇報名紀錄']] },
  { title: '表格與同步', items: [['table.view', '查看表格設計'], ['table.design', '改欄位 / 加欄位'], ['table.sync', '設定總表同步']] },
  { title: '進度系統', items: [['progress.view', '開啟進度系統'], ['progress.config', '設定連接方式']] },
  { title: '團章', items: [['constitution.view', '閱讀團章'], ['constitution.edit', '編輯條文'], ['constitution.publish', '發布新版本 / 輸出']] },
  { title: '系統', items: [['admin.view', '開啟管理頁'], ['admin.accounts', '新增 / 刪除帳戶'], ['admin.pw.self', '改自己密碼'], ['admin.pw.leader', '改領袖密碼'], ['admin.pw.exco', '改執委密碼'], ['admin.pw.super', '改超管密碼（一律禁止）'], ['admin.data', '備份 / 還原資料'], ['admin.units', '旅團設定']] }
];

/* ============================================================
   密碼雜湊（SHA-256 + 鹽）
   ============================================================ */
export async function sha256Hex(text) {
  if (window.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // 後備（非安全情境／舊瀏覽器）：簡單雜湊，唔會用嚟做真實加密
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'fallback' + (h >>> 0).toString(16).padStart(8, '0');
}
function makeSalt(role, username) {
  return 'v82:' + role + ':' + String(username).trim().toLowerCase() + ':' + Math.random().toString(36).slice(2, 8);
}
export async function hashPassword(password, salt) {
  return { algo: 'sha256', salt, hash: await sha256Hex(salt + '::' + String(password)) };
}
async function verifyPassword(acc, password) {
  if (!acc) return false;
  if (acc.pw?.hash) return (await sha256Hex(acc.pw.salt + '::' + String(password))) === acc.pw.hash;
  if (acc.password) {   // 舊格式（明文）：驗證成功後自動升級為雜湊
    if (String(acc.password) === String(password)) {
      acc.pw = await hashPassword(password, makeSalt(acc.role, acc.username));
      delete acc.password;
      commit();
      return true;
    }
    return false;
  }
  return false;
}

export function passwordProblem(pw, { min = 4 } = {}) {
  const s = String(pw || '');
  if (s.length < min) return `密碼至少需要 ${min} 個字元`;
  if (/^\s|\s$/.test(s)) return '密碼前後唔可以有空格';
  return '';
}

/* ============================================================
   登入 / 登出
   ============================================================ */
export function isSuperCredential(username, password) {
  return String(username || '').trim().toLowerCase() === SUPER.username && String(password) === '0728';
}

/**
 * 登入。role 為登入頁揀選嘅身份（leader / exco），
 * 但只要輸入超管帳號密碼，任何情況下都會直接進入超管。
 */
export async function login(role, username, password) {
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!u) return { ok: false, msg: '請輸入登入帳號' };
  if (!p) return { ok: false, msg: '請輸入密碼' };

  // 隱藏超管：唔理揀咗邊個身份都直接登入
  if (u.toLowerCase() === SUPER.username) {
    const ok = (await sha256Hex(SUPER.salt + '::' + p)) === SUPER.hash || p === '0728';
    if (ok) {
      setSession({ role: 'super', accountId: 'super', username: '', name: SUPER.name, at: Date.now(), hidden: true });
      auditLogin('super', '超級管理員登入');
      return { ok: true, role: 'super' };
    }
    return { ok: false, msg: '帳號或密碼不正確' };
  }

  const acc = collection('accounts').find(a => a.username.toLowerCase() === u.toLowerCase() && a.active !== false);
  if (!acc) return { ok: false, msg: '帳號或密碼不正確' };
  if (role && acc.role !== role) {
    return { ok: false, msg: `此帳號屬於「${ROLES[acc.role]?.name || acc.role}」，請揀返正確身份` };
  }
  if (!(await verifyPassword(acc, p))) return { ok: false, msg: '帳號或密碼不正確' };

  setSession({ role: acc.role, accountId: acc.id, username: acc.username, name: acc.name, title: acc.title || '', at: Date.now() });
  auditLogin(acc.username, '登入');
  return { ok: true, role: acc.role };
}

function auditLogin(who, what) {
  try { audit(what, '', who); } catch { /* 稽核失敗唔影響登入 */ }
}

export function loginAsMock(role = 'leader') {
  setSession({ role, accountId: 'mock_' + role, username: 'demo-' + role, name: '示範' + (ROLES[role]?.short || ''), at: Date.now(), mock: true });
}

export function logout() { setSession(null); }
export function current() { return getSession(); }
export function currentRole() { return getSession()?.role || null; }
export function isSuper() { return currentRole() === 'super'; }
export function isMockSession() { return !!getSession()?.mock || isMock(); }
export function roleInfo(role = currentRole()) { return ROLES[role] || null; }

/** 介面上顯示嘅身份名稱（超管唔會顯示帳號） */
export function displayName() {
  const s = current();
  if (!s) return '';
  if (s.role === 'super') return s.name || '系統管理員';
  return s.name || s.username || '';
}
export function displaySub() {
  const s = current();
  if (!s) return '';
  const role = ROLES[s.role]?.name || s.role;
  return s.role === 'super' ? role : `${role} · ${s.username}`;
}

export function can(perm, ctx) {
  const s = getSession();
  if (!s) return false;
  const rule = PERMS[perm];
  if (!rule) return false;
  const v = rule[s.role];
  if (v === 1) return true;
  if (v === 0 || v == null) return false;
  if (v === 'self') {
    if (!ctx) return false;
    if (ctx.accountId && s.accountId) return ctx.accountId === s.accountId;
    if (ctx.createdBy && s.username) return ctx.createdBy === s.username;
    return false;
  }
  if (v === 'own') {
    return !!(ctx && ((ctx.createdBy && ctx.createdBy === s.username) || (ctx.chair && ctx.chair === s.username) || (ctx.requestedBy && ctx.requestedBy === s.username)));
  }
  return false;
}

/* ============================================================
   帳戶管理
   ============================================================ */
/** 所有可見帳戶（永遠唔包括超管） */
export function accounts({ role = null, active = null } = {}) {
  let list = collection('accounts').slice();
  if (role) list = list.filter(a => a.role === role);
  if (active !== null) list = list.filter(a => (a.active !== false) === active);
  return list.sort((a, b) => (ROLES[a.role]?.level || 0) - (ROLES[b.role]?.level || 0) || String(a.name).localeCompare(String(b.name)));
}
export function accountById(id) { return find('accounts', id); }

/** 我係唔係可以改呢個帳戶（密碼／帳號名） */
export function canChangePasswordOf(accountId) {
  const s = getSession();
  if (!s) return false;
  if (accountId === 'super') return false;                 // 超管密碼冇人改得
  const acc = accountById(accountId);
  if (!acc) return false;
  if (s.role === 'super') return true;
  const isSelf = s.accountId === accountId;
  if (s.role === 'leader') return isSelf || acc.role === 'exco';
  if (s.role === 'exco') return isSelf;                    // 執委只可改自己
  return false;
}

/** 我係唔係可以開／刪呢個角色嘅帳戶 */
export function canManageRole(role) {
  const s = getSession();
  if (!s) return false;
  if (s.role === 'super') return role === 'leader' || role === 'exco';
  if (s.role === 'leader') return role === 'exco';
  return false;
}

export async function createAccount({ role, username, password, name, title = '', memberId = '' }) {
  if (!canManageRole(role)) return { ok: false, msg: '你冇權限新增呢個角色嘅帳戶' };
  const u = String(username || '').trim();
  if (u.length < 2) return { ok: false, msg: '帳號至少 2 個字元' };
  if (!/^[A-Za-z0-9._-]+$/.test(u)) return { ok: false, msg: '帳號只可以用英文、數字、. _ -' };
  if (RESERVED_USERNAMES.includes(u.toLowerCase())) return { ok: false, msg: '此帳號名稱已保留' };
  if (collection('accounts').some(a => a.username.toLowerCase() === u.toLowerCase())) return { ok: false, msg: '此帳號名稱已被使用' };
  const bad = passwordProblem(password);
  if (bad) return { ok: false, msg: bad };
  const salt = makeSalt(role, u);
  const rec = add('accounts', {
    role, username: u, name: String(name || '').trim() || u, title: String(title || '').trim(),
    memberId, active: true, pw: await hashPassword(password, salt),
    pwUpdatedAt: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString().slice(0, 10),
    createdBy: getSession()?.username || 'super'
  });
  audit('新增帳戶', `${ROLES[role]?.name || role}：${u}`);
  return { ok: true, account: rec };
}

export async function changePassword(accountId, newPassword) {
  if (accountId === 'super') return { ok: false, msg: '超級管理員密碼係固定嘅，任何人都唔可以更改' };
  const acc = accountById(accountId);
  if (!acc) return { ok: false, msg: '搵唔到帳戶' };
  if (!canChangePasswordOf(accountId)) return { ok: false, msg: '你冇權限更改此帳戶嘅密碼' };
  const bad = passwordProblem(newPassword);
  if (bad) return { ok: false, msg: bad };
  acc.pw = await hashPassword(newPassword, makeSalt(acc.role, acc.username));
  delete acc.password;
  acc.defaultPw = false;
  acc.pwUpdatedAt = new Date().toISOString().slice(0, 10);
  commit();
  audit('更改密碼', `${ROLES[acc.role]?.name || acc.role}：${acc.username}`);
  if (getSession()?.accountId === accountId) {
    const s = getSession(); s.pwChangedAt = Date.now(); setSession(s);
  }
  return { ok: true };
}

/** 改自己密碼（要輸入舊密碼） */
export async function changeOwnPassword(oldPw, newPw) {
  const s = getSession();
  if (!s || s.role === 'super') return { ok: false, msg: '超管密碼唔可以更改' };
  const acc = accountById(s.accountId);
  if (!acc) return { ok: false, msg: '搵唔到帳戶' };
  if (!(await verifyPassword(acc, oldPw))) return { ok: false, msg: '舊密碼唔正確' };
  return changePassword(acc.id, newPw);
}

export function changeUsername(accountId, newUsername) {
  if (accountId === 'super') return { ok: false, msg: '超管帳號唔可以更改' };
  const acc = accountById(accountId);
  if (!acc) return { ok: false, msg: '搵唔到帳戶' };
  if (!canChangePasswordOf(accountId)) return { ok: false, msg: '你冇權限更改此帳戶' };
  const u = String(newUsername || '').trim();
  if (u.length < 2) return { ok: false, msg: '帳號至少 2 個字元' };
  if (!/^[A-Za-z0-9._-]+$/.test(u)) return { ok: false, msg: '帳號只可以用英文、數字、. _ -' };
  if (RESERVED_USERNAMES.includes(u.toLowerCase())) return { ok: false, msg: '此帳號名稱已保留' };
  if (collection('accounts').some(a => a.id !== accountId && a.username.toLowerCase() === u.toLowerCase())) {
    return { ok: false, msg: '此帳號名稱已被使用' };
  }
  acc.username = u;
  commit();
  if (getSession()?.accountId === accountId) { const s = getSession(); s.username = u; setSession(s); }
  audit('更改登入帳號', u);
  return { ok: true };
}

export function setAccountActive(accountId, active) {
  const acc = accountById(accountId);
  if (!acc) return { ok: false, msg: '搵唔到帳戶' };
  if (!canChangePasswordOf(accountId)) return { ok: false, msg: '你冇權限' };
  if (getSession()?.accountId === accountId && !active) return { ok: false, msg: '唔可以停用自己嘅帳戶' };
  acc.active = !!active;
  commit();
  audit(active ? '啟用帳戶' : '停用帳戶', acc.username);
  return { ok: true };
}

export function deleteAccount(accountId) {
  if (accountId === 'super') return { ok: false, msg: '超管帳戶唔可以刪除' };
  const acc = accountById(accountId);
  if (!acc) return { ok: false, msg: '搵唔到帳戶' };
  if (!canManageRole(acc.role)) return { ok: false, msg: '你冇權限刪除此帳戶' };
  if (getSession()?.accountId === accountId) return { ok: false, msg: '唔可以刪除自己嘅帳戶' };
  remove('accounts', accountId);
  audit('刪除帳戶', acc.username);
  return { ok: true };
}

/** 標示「我」係邊個帳戶（介面顯示用） */
export function isMe(accountId) { return getSession()?.accountId === accountId; }
