/* ============================================================
   model.js — 共用業務邏輯
   （會議狀態、團員／生日、財務統計、物資庫存、團章）
   ============================================================ */

import { load, collection, find } from './store.js';
import { todayISO, parseBirthday, daysUntilBirthday, ageFrom, turningAge } from './dates.js';
import { agmIsDefault, unitFYOf, scoutFYLabel, scoutFYRange, inRange } from './fiscal.js';
export * from './fiscal.js';

/* ---------------- 基本 ---------------- */
export function settings() { return load().settings || {}; }
export function profile() { return load().profile || load().unit || {}; }
export function currency() { return settings().currency || 'HK$'; }
export function money(n) {
  const v = Number(n) || 0;
  return currency() + v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/* ---------------- 公開頁連結（成員免登入用） ----------------
   entry.html      手機記一筆（收支申報）
   borrow.html     物資借用申請
   notice.html     通告 + 回覆出席與否
   constitution.html 團章
   全部都可以喺「帳號與系統 → 旅團設定」或者「成員連結」頁改做自己嘅網址。 */
export function publicPageUrl(file, params = {}) {
  const s = settings().publicLinks || {};
  const origin = (typeof location !== 'undefined' && location.origin && location.origin !== 'null')
    ? location.origin + String(location.pathname).replace(/[^/]*$/, '')
    : '';
  const target = s[file] || s.base || (origin ? origin + file : file);
  let url;
  try { url = new URL(target, origin || undefined); }
  catch { return target; }
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  return url.toString();
}
/** 成員用嘅公開連結清單（「成員連結」頁同 QR 都用呢個） */
export function memberLinks() {
  const code = load().unitCode;
  const out = [
    {
      id: 'entry', icon: 'camera', label: '收支申報（手機記一筆）',
      desc: '成員影相 → 揀欄目 → 金額 → 送出，司庫批核後自動入帳（取代 Google Form）',
      url: publicPageUrl('entry.html', { u: code })
    },
    {
      id: 'borrow', icon: 'grid', label: '物資借用申請',
      desc: '成員自己申請借物資，執委喺 APP 批核；借出／歸還自動加減庫存',
      url: publicPageUrl('borrow.html', { u: code })
    },
    {
      id: 'constitution', icon: 'book', label: '團章（公開閱讀）',
      desc: '免登入閱讀最新版團章，可輸出 Word / PDF',
      url: publicPageUrl('constitution.html', { u: code })
    }
  ];
  collection('notices').filter(n => n.status === 'published').slice(0, 40).forEach(n => {
    out.push({
      id: 'notice:' + n.id, icon: 'megaphone', label: `通告：${n.title?.zh || n.id}`,
      desc: `免登入閱讀${n.needSignup ? '＋回覆出席與否' : ''}${n.deadline ? `（截止 ${n.deadline}）` : ''}`,
      url: publicPageUrl('notice.html', { u: code, n: n.id })
    });
  });
  return out;
}

/* ---------------- 會議 ---------------- */
export const MEETING_STATUS = {
  draft:     { label: '草稿',   cls: 'b-grey' },
  pending:   { label: '待處理', cls: 'b-warn' },
  confirmed: { label: '已確定', cls: 'b-info' },
  done:      { label: '已完成', cls: 'b-ok' },
  cancelled: { label: '已取消', cls: 'b-danger' }
};
export const MEETING_TYPES = { exco: '執委會會議', agm: '團員大會', activity: '活動會議', other: '其他' };
export const ATTEND = {
  present: { label: '出席', cls: 'b-ok' },
  late:    { label: '遲到', cls: 'b-warn' },
  apology: { label: '請假', cls: 'b-info' },
  absent:  { label: '缺席', cls: 'b-danger' }
};
export function statusLabel(s) { return (MEETING_STATUS[s] || MEETING_STATUS.draft).label; }
export function statusBadge(s) {
  const m = MEETING_STATUS[s] || MEETING_STATUS.draft;
  return `<span class="badge ${m.cls}"><span class="dot"></span>${m.label}</span>`;
}

/* ---------------- 團員 / 用戶 ---------------- */
/**
 * 身份（呢個系統管嘅係「用戶」：領袖、執委、團員都可能喺名冊入面）
 * identity = 系統身份（決定權限層級、顯示）
 * role     = 團內職位（自由文字，例：主席 / 司庫 / 小隊長）
 */
export const IDENTITIES = {
  leader: { l: '領袖', short: '領袖', c: 'b-brand', level: 3 },
  exco:   { l: '執委', short: '執委', c: 'b-info', level: 2 },
  member: { l: '團員', short: '團員', c: 'b-grey', level: 1 }
};
export function identityLabel(m) {
  const k = m?.identity || 'member';
  return (IDENTITIES[k] || IDENTITIES.member).l;
}
export function identityOf(m) {
  const k = m?.identity || 'member';
  return IDENTITIES[k] ? k : 'member';
}
/** 由舊資料／職位文字推算身份（升級舊資料庫用） */
export function guessIdentity(m) {
  if (m?.identity && IDENTITIES[m.identity]) return m.identity;
  const t = `${m?.role || ''} ${(m?.tags || []).join(' ')}`.toLowerCase();
  if (/(團長|領袖|leader|scouter|隊長)/.test(t)) return 'leader';
  if (/(執委|執行委員會|exco|committee|主席|司庫|文書)/.test(t)) return 'exco';
  return 'member';
}
export function membersByIdentity(k) { return members().filter(m => identityOf(m) === k); }

export function members() { return collection('members'); }
export function member(id) { return find('members', id); }
export function memberName(id) { return member(id)?.name || '—'; }
export function activeMembers() { return members().filter(m => m.status !== 'alumni'); }

/* ---------- 跨系統身份 key（同進度追蹤等外部系統對人用） ----------
   對方（VSBADGE）嘅身份規則：**成員用 YMIS（10 位數字），領袖用 Email**。
   （佢登入頁：「成員：YMIS 10位數字 + 密碼；領袖：Email + 密碼」）
   所以唔可以一刀切要求所有人都有 YMIS —— 領袖本來就唔會有，
   把領袖當「未填 YMIS」係計錯。呢度按身份揀啱嘅 key。 */

/** 呢位用戶**應該**用邊種外部 key（領袖→email，其他→ymis） */
export function expectedKeyKind(m) { return identityOf(m) === 'leader' ? 'email' : 'ymis'; }

/** 用戶嘅跨系統 key（按身份揀：領袖 email 優先，團員／執委 YMIS 優先） */
export function memberKey(m) {
  const ymis = String(m?.ymis || '').trim();
  const email = String(m?.email || '').trim().toLowerCase();
  const order = expectedKeyKind(m) === 'email'
    ? [['email', email], ['ymis', ymis]]
    : [['ymis', ymis], ['email', email]];
  for (const [kind, v] of order) if (v) return { key: v, kind };
  const sys = String(m?.systemId || '').trim();
  if (sys) return { key: sys, kind: 'systemId' };   // 對方認唔到，只係本系統 fallback
  return { key: '', kind: '' };
}
/**
 * 名冊嘅身份 key 覆蓋率。
 * 「對得上」＝有對方認得嘅 key（團員有 YMIS / 領袖有 Email）。
 * systemId 只係本系統 fallback，對方認唔到，所以唔算「對得上」。
 */
export function keyCoverage(list = members()) {
  const total = list.length;
  const leaders = list.filter(m => identityOf(m) === 'leader');
  const youth = list.filter(m => identityOf(m) !== 'leader');
  const withYmis = list.filter(m => String(m.ymis || '').trim()).length;
  const withEmail = list.filter(m => String(m.email || '').trim()).length;
  const withSystemId = list.filter(m => String(m.systemId || '').trim()).length;
  const youthOk = youth.filter(m => String(m.ymis || '').trim());
  const leaderOk = leaders.filter(m => String(m.email || '').trim());
  const matched = youthOk.length + leaderOk.length;
  const unmatched = total - matched;
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
  return {
    total, withYmis, withEmail, withSystemId,
    youthTotal: youth.length, leaderTotal: leaders.length,
    youthWithYmis: youthOk.length, leaderWithEmail: leaderOk.length,
    matched, unmatched,
    /** 整體「對方認得到」嘅比例 */
    percent: pct(matched, total),
    youthPercent: pct(youthOk.length, youth.length),
    leaderPercent: pct(leaderOk.length, leaders.length),
    /** 兼容舊寫法：團員嘅 YMIS 覆蓋率 */
    ymisPercent: pct(youthOk.length, youth.length),
    ready: total > 0 && unmatched === 0,
    /** 未對得上嘅人（用嚟列出嚟提示補返） */
    unmatchedList: list.filter(m => {
      const need = expectedKeyKind(m);
      return !(need === 'email' ? String(m.email || '').trim() : String(m.ymis || '').trim());
    }).map(m => ({ id: m.id, name: m.name, identity: identityOf(m), need: expectedKeyKind(m) }))
  };
}
/** 用 key 搵人（YMIS / Email / systemId） */
export function findByKey(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  const kl = k.toLowerCase();
  return members().find(m => String(m.ymis || '').trim() === k
    || String(m.email || '').trim().toLowerCase() === kl
    || String(m.systemId || '').trim() === k) || null;
}
export function memberStatus() {
  return { active: { l: '現役', c: 'b-ok' }, leave: { l: '休假', c: 'b-warn' }, alumni: { l: '舊團員', c: 'b-grey' } };
}
export function memberAge(m) { return ageFrom(m?.birthday); }
export function memberBirthdayText(m) {
  const p = parseBirthday(m?.birthday);
  if (!p) return '—';
  return p.hasYear ? `${p.iso}（${p.m} 月 ${p.d} 日）` : `${p.m} 月 ${p.d} 日（年份待補）`;
}

export function attendanceStats(memberId) {
  const ms = collection('meetings').filter(m => m.status === 'done');
  let present = 0, late = 0, apology = 0, absent = 0;
  ms.forEach(m => {
    const s = (m.attendance || {})[memberId];
    if (s === 'present') present++;
    else if (s === 'late') { late++; present++; }
    else if (s === 'apology') apology++;
    else if (s === 'absent') absent++;
  });
  const total = Math.max(ms.length, 1);
  return { present, late, apology, absent, total: ms.length, rate: Math.round(present / total * 100) };
}

/* ---------------- 生日 ---------------- */
/** 所有團員依「距離下次生日」排序 */
export function birthdayList({ includeAlumni = false } = {}) {
  return members()
    .filter(m => !includeAlumni ? m.status !== 'alumni' : true)
    .filter(m => parseBirthday(m.birthday))
    .map(m => ({
      member: m, name: m.name, id: m.id, birthday: m.birthday,
      days: daysUntilBirthday(m.birthday), age: ageFrom(m.birthday), turning: turningAge(m.birthday),
      md: parseBirthday(m.birthday).md
    }))
    .sort((a, b) => a.days - b.days);
}

/** 生日喺 n 日內（包括今日） */
export function birthdaysWithin(days = 7, opts) {
  return birthdayList(opts).filter(x => x.days !== null && x.days <= days);
}

/** 今個月生日 */
export function birthdaysThisMonth(month = new Date().getMonth() + 1, opts) {
  const mm = String(month).padStart(2, '0');
  return birthdayList(opts).filter(x => x.md.startsWith(mm)).sort((a, b) => Number(a.md.slice(3)) - Number(b.md.slice(3)));
}

export function birthdaySummary() {
  const s = settings().birthday || {};
  return {
    today: birthdaysWithin(0),
    in7: birthdaysWithin(Number(s.remindDaysBefore || 7)),
    month: birthdaysThisMonth(),
    unknown: members().filter(m => !parseBirthday(m.birthday) && m.status !== 'alumni').map(m => m.name)
  };
}

/* ---------------- 財務 ---------------- */
export function tx() { return collection('transactions'); }
export function claims() { return collection('claims'); }
export function fees() { return collection('fees'); }
export function budgets() { return collection('budgets'); }
export function categories(type) { return (load().categories || {})[type] || []; }
export function methods() { return load().methods || ['現金']; }

export function sumBy(list, type) {
  return list.filter(t => t.type === type).reduce((s, t) => s + (Number(t.amount) || 0), 0);
}
export function balance(list = tx()) { return sumBy(list, 'income') - sumBy(list, 'expense'); }
export function monthStats(key) {
  const list = tx().filter(t => String(t.date).slice(0, 7) === key);
  return { income: sumBy(list, 'income'), expense: sumBy(list, 'expense'), net: balance(list), count: list.length };
}
export function allMonths() {
  const set = new Set(tx().map(t => String(t.date).slice(0, 7)));
  set.add(todayISO().slice(0, 7));
  return [...set].sort().reverse();
}
export function categoryBreakdown(list, type) {
  const map = {};
  list.filter(t => t.type === type).forEach(t => {
    const k = t.category || '其他';
    map[k] = (map[k] || 0) + (Number(t.amount) || 0);
  });
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}
/* ============================================================
   期初結餘（逐年）
   ------------------------------------------------------------
   每一個財政年度都有自己嘅期初結餘：
     2025-26 期初 8,803.28 → 期末 7,846.64
     2026-27 期初 7,846.64（= 上年度期末）→ 加減本年度收支 = 現在結餘
   所以「期初結餘」唔可以得一個全域數字，否则會把上年度嘅期初
   當成本年度嘅期初（見 2026-09-15 修正）。

   來源優先次序：
     1) settings.openingBalances[年度]      ← 明確填咗嘅（例：2026-27 = 7846.64）
     2) 結轉：全期起點 + 該年度開始前所有帳目   ← 有舊帳就自動計到
   ============================================================ */

/** 全期起點（舊欄位，即「由頭開始嗰陣有幾多錢」） */
export function legacyOpening() { return Number(settings().openingBalance || 0); }

/** 明確設定咗嘅逐年期初結餘表 { '2026-27': 7846.64 } */
export function openingBalances() { return settings().openingBalances || {}; }

/** 而家所屬嘅年度（童軍年度 4/1–3/31；同旅年度標籤一致時最簡單） */
export function currentFY() {
  const s = settings();
  return scoutFYLabel(todayISO(), Number(s.scoutFYStartMonth || 4));
}
export function currentFYRange() {
  const s = settings();
  return scoutFYRange(currentFY(), Number(s.scoutFYStartMonth || 4), Number(s.scoutFYStartDay || 1));
}
/** 上一個年度標籤（例：2026-27 → 2025-26） */
export function prevFYKey(yearKey = currentFY()) {
  const y = Number(String(yearKey).split('-')[0]);
  return `${y - 1}-${pad2y(y % 100)}`;
}
function pad2y(n) { return String(n).padStart(2, '0'); }

/** 結轉：某年度開始之前嘅累計（全期起點 + 之前所有帳目） */
export function carriedForward(startISO) {
  const before = tx().filter(t => String(t.date).slice(0, 10) < startISO);
  return legacyOpening() + balance(before);
}
/** 某段期間嘅結餘（全期起點 + 該日之前所有帳目） */
export function balanceAt(startISO) { return carriedForward(startISO); }

/**
 * 某年度嘅期初結餘。
 * @param {string} yearKey 例 '2026-27'（預設＝本年度）
 * @param {object} [range] 該年度範圍（冇傳就用童軍年度計）
 */
export function openingOf(yearKey = currentFY(), range = null) {
  const map = openingBalances();
  if (map[yearKey] !== undefined && map[yearKey] !== null && map[yearKey] !== '') {
    return { amount: Number(map[yearKey]), year: yearKey, explicit: true, date: (range || yearRange(yearKey)).start };
  }
  const r = range || yearRange(yearKey);
  return { amount: carriedForward(r.start), year: yearKey, explicit: false, date: r.start };
}
/** 由年度標籤攞範圍（童軍年度） */
export function yearRange(yearKey) {
  const s = settings();
  return scoutFYRange(yearKey, Number(s.scoutFYStartMonth || 4), Number(s.scoutFYStartDay || 1));
}

/** 兼容舊寫法：而家回傳「本年度」嘅期初結餘（唔再係全域單一數字） */
export function openingBalance() {
  const o = openingOf();
  return { amount: o.amount, date: o.date, year: o.year, explicit: o.explicit };
}

/* ---------- 現在結餘（首頁顯示用） ----------
   現在結餘 = **本年度**期初結餘 + **本年度**收入 − **本年度**支出。
   上年度嘅帳目已經計入「上年度期末 → 本年度期初」，唔會重複加。 */
export function currentBalance() {
  const r = currentFYRange();
  const o = openingOf(r.key, r);
  const rows = tx().filter(t => inRange(t.date, r.start, r.end));
  return o.amount + balance(rows);
}
/** 結餘拆解（本年度），用嚟顯示同解釋負數 */
export function balanceBreakdown() {
  const s = settings();
  const r = currentFYRange();
  const list = tx().filter(t => inRange(t.date, r.start, r.end));
  const inc = sumBy(list, 'income');
  const exp = sumBy(list, 'expense');
  const o = openingOf(r.key, r);
  const now = o.amount + inc - exp;
  const prevKey = prevFYKey(r.key);
  const prevRange = yearRange(prevKey);
  const prevRows = tx().filter(t => inRange(t.date, prevRange.start, prevRange.end));
  const prev = openingOf(prevKey, prevRange);
  const ref = load().reference || {};
  const refOpen = Number(ref.openingBalance || 0);
  const refInc = sumBy(ref.transactions || [], 'income');
  const refExp = sumBy(ref.transactions || [], 'expense');
  const refClose = ref.check?.closing ?? (refOpen + refInc - refExp);
  return {
    year: r.key, range: r,
    opening: o.amount, openingDate: o.date, openingExplicit: o.explicit,
    income: inc, expense: exp, now, count: list.length,
    hasOpening: o.explicit || legacyOpening() !== 0,
    /** 上年度（用嚟對數：上年度期末應該等於本年度期初） */
    prevYear: prevKey, prevOpening: prev.amount,
    prevClosing: prev.amount + balance(prevRows), prevCount: prevRows.length,
    /** 舊帳參考（你嘅 Google Sheet 分頁） */
    referenceOpening: refOpen, referenceClosing: Number(refClose) || 0,
    referenceYear: refYearKey(ref),
    likelyMissingOpening: now < 0 && !o.explicit && legacyOpening() === 0 && refOpen > 0,
    /** 有舊帳參考但未入帳 → 提示去匯入 */
    hasUnimportedReference: (ref.transactions || []).length > 0 && tx().length === 0,
    /** 本年度期初 同 舊帳期末 唔同 → 提示核對 */
    openingMismatch: o.explicit && refOpen > 0 && Math.abs(o.amount - Number(refClose)) > 0.005,
    scoutFYStartMonth: Number(s.scoutFYStartMonth || 4)
  };
}
/** 由參考資料推算佢屬於邊個年度（由帳目日期計，唔靠分頁名） */
export function refYearKey(ref = load().reference || {}) {
  const dates = (ref.transactions || []).map(t => String(t.date).slice(0, 10)).filter(Boolean).sort();
  if (!dates.length) return '';
  return scoutFYLabel(dates[dates.length - 1], Number(settings().scoutFYStartMonth || 4));
}
export function pendingClaims() { return claims().filter(c => (c.status || 'pending') === 'pending'); }

/* 團費 */
export function feeSummary(list = fees()) {
  const paid = list.filter(f => f.paid);
  const unpaid = list.filter(f => !f.paid);
  return {
    total: list.length, paidCount: paid.length, unpaidCount: unpaid.length,
    collected: paid.reduce((s, f) => s + (Number(f.amount) || 0), 0),
    outstanding: unpaid.reduce((s, f) => s + (Number(f.amount) || 0), 0),
    expected: list.reduce((s, f) => s + (Number(f.amount) || 0), 0),
    rate: list.length ? Math.round(paid.length / list.length * 100) : 0
  };
}
export function overdueFees() {
  const today = todayISO();
  return fees().filter(f => !f.paid && f.due && f.due < today);
}

/* ---------- 團費（金額可改，唔係寫死） ---------- */
/** 標準團費（每位團員每年）—— 由 settings.feePerYear 讀，可隨時改 */
export function standardFee() { return Number(settings().feePerYear ?? 360); }
/** 海外／優惠團費（預設標準嘅 1/4） */
export function overseasFee() {
  const v = settings().feeOverseas;
  if (v === undefined || v === null || v === '') return Math.round(standardFee() / 4);
  return Number(v);
}
/** 團費預設到期日（例：年度首年 9 月 30 日） */
export function defaultFeeDue(period = feePeriodOf(todayISO())) {
  const tpl = settings().feeDueTemplate;
  const y = String(period).slice(0, 4);
  return (tpl || `${y}-09-30`).replace(/[{]y[}]/g, y);
}

/** 由日期推算團費期別（跟童軍年度，例如 2025-12-07 → 2025-26） */
export function feePeriodOf(dateISO) {
  return scoutFYLabel(dateISO || todayISO(), Number(settings().scoutFYStartMonth || 4));
}
/** 所有出現過嘅期別（由新到舊），並確保「本年度」一定在列 */
export function feePeriods() {
  const list = [...new Set(fees().map(f => f.period).filter(Boolean))];
  const cur = feePeriodOf(todayISO());
  if (!list.includes(cur)) list.push(cur);
  return list.sort().reverse();
}
/** 某位團員某期嘅收費紀錄 */
export function feeOf(memberId, period) {
  return fees().find(f => f.memberId === memberId && f.period === period) || null;
}
/** 團費收款表：每位（非舊團員）團員 × 某一期 */
export function feeGrid(period = feePeriodOf(todayISO()), { includeAlumni = false } = {}) {
  const fallback = standardFee();
  return members()
    .filter(m => includeAlumni || m.status !== 'alumni')
    .map(m => {
      const f = feeOf(m.id, period);
      return {
        member: m, id: f?.id || null,
        amount: Number(f?.amount ?? fallback),
        paid: !!f?.paid, paidDate: f?.paidDate || '', method: f?.method || '',
        ref: f?.ref || '', due: f?.due || '', note: f?.note || '',
        txId: f?.txId || '', exists: !!f
      };
    })
    .sort((a, b) => (a.paid === b.paid ? String(a.member.name).localeCompare(String(b.member.name), 'zh-Hant') : a.paid ? 1 : -1));
}
/** 團費統計（某人／某期） */
export function feeStats(period = feePeriodOf(todayISO())) {
  const rows = feeGrid(period);
  const paid = rows.filter(r => r.paid), unpaid = rows.filter(r => !r.paid);
  const today = todayISO();
  return {
    period, rows, total: rows.length, paidCount: paid.length, unpaidCount: unpaid.length,
    collected: paid.reduce((s, r) => s + r.amount, 0),
    outstanding: unpaid.reduce((s, r) => s + r.amount, 0),
    expected: rows.reduce((s, r) => s + r.amount, 0),
    rate: rows.length ? Math.round(paid.length / rows.length * 100) : 0,
    overdue: unpaid.filter(r => r.due && r.due < today).length,
    noRecord: rows.filter(r => !r.exists).length
  };
}
/** 喺文字入面搵吓有冇團員名（用嚟由「曉莉 團費」對應到團員） */
export function matchMemberByName(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const list = members();
  // 1) 全名包含喺文字入面
  const full = list.find(m => m.name && t.includes(m.name));
  if (full) return full;
  // 2) 文字本身係花名／名字一部分（例：日彤 → 劉日彤、天蔚 → 方天蔚）
  const short = list
    .filter(m => m.name && m.name.length >= 3 && t.length >= 2 && m.name.includes(t))
    .sort((a, b) => a.name.length - b.name.length)[0];
  if (short) return short;
  // 3) 英文名
  return list.find(m => m.eng && t.toLowerCase().includes(String(m.eng).toLowerCase())) || null;
}

/* ---------------- 物資 ---------------- */
export function invItems() { return collection('invItems'); }
export function invLoans() { return collection('invLoans'); }
export function invAudits() { return collection('invAudits'); }
export function invItem(id) { return find('invItems', id); }
export function invCategories() { return settings().inventory?.categories || []; }

const OPEN_LOAN = ['approved', 'out'];
export function itemTotals(itemId) {
  const item = invItem(itemId);
  if (!item) return { total: 0, adjusted: 0, out: 0, reserved: 0, available: 0 };
  const adjusted = Number(item.total || 0) + invAudits()
    .filter(a => a.itemId === itemId)
    .reduce((s, a) => s + Number(a.delta || 0), 0);
  const out = invLoans().filter(l => l.itemId === itemId && OPEN_LOAN.includes(l.status))
    .reduce((s, l) => s + Number(l.qty || 0), 0);
  const reserved = invLoans().filter(l => l.itemId === itemId && l.status === 'requested')
    .reduce((s, l) => s + Number(l.qty || 0), 0);
  return { total: Number(item.total || 0), adjusted, out, reserved, available: adjusted - out };
}
export function availableQty(itemId) { return itemTotals(itemId).available; }
export function nextItemCode() {
  const db = load();
  const n = invItems().length + 1;
  return db.invNextCode && !invItems().some(i => i.code === db.invNextCode)
    ? db.invNextCode
    : 'G-' + String(n).padStart(3, '0');
}
export function loansByStatus(status) { return invLoans().filter(l => l.status === status); }
export function pendingLoans() { return invLoans().filter(l => l.status === 'requested'); }
export function activeLoans() { return invLoans().filter(l => OPEN_LOAN.includes(l.status)); }
export function overdueLoans() {
  const t = todayISO();
  return invLoans().filter(l => OPEN_LOAN.includes(l.status) && l.dueDate && l.dueDate < t);
}
export function loanStatus() {
  return {
    requested: { l: '待批核', c: 'b-warn' },
    approved:  { l: '已批核（待取）', c: 'b-info' },
    out:       { l: '借出中', c: 'b-brand' },
    returned:  { l: '已歸還', c: 'b-ok' },
    rejected:  { l: '已拒絕', c: 'b-danger' },
    cancelled: { l: '已取消', c: 'b-grey' }
  };
}
export function stockSummary() {
  const items = invItems();
  return {
    kinds: items.length,
    units: items.reduce((s, i) => s + Number(i.total || 0), 0),
    out: activeLoans().reduce((s, l) => s + Number(l.qty || 0), 0),
    pending: pendingLoans().length,
    overdue: overdueLoans().length,
    low: items.filter(i => itemTotals(i.id).available <= 0)
  };
}

/* ---------------- 團章 ---------------- */
export function constitution() { return load().constitution || {}; }
export function articleCount(c = constitution()) {
  return (c.chapters || []).reduce((s, ch) => s + (ch.articles?.length || 0) + (ch.articles || []).reduce((t, a) => t + (a.items?.length || 0), 0), 0);
}

/* ---------------- 待辦 / 日程 ---------------- */
export function openActions() {
  const out = [];
  collection('meetings').forEach(m => {
    (m.decisions || []).forEach(d => { if (!d.done) out.push({ ...d, meetingId: m.id, meetingTitle: m.title }); });
  });
  return out.sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')));
}
export function upcomingMeetings(n = 4) {
  const today = todayISO();
  return collection('meetings')
    .filter(m => String(m.date).slice(0, 10) >= today && m.status !== 'done' && m.status !== 'cancelled')
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(0, n);
}
export function pendingMeetings() { return collection('meetings').filter(m => m.status === 'pending'); }

/* ---------------- 通知中心（儀表板用） ---------------- */
export function notices() {
  const out = [];
  const b = birthdaySummary();
  b.today.forEach(x => out.push({ kind: 'birthday', level: 'ok', text: `今日係 ${x.name} 生日 🎂`, link: '#/members/birthdays' }));
  b.in7.filter(x => x.days > 0).forEach(x => out.push({
    kind: 'birthday', level: 'warn',
    text: `${x.name} ${x.days} 日後生日（${Number(x.md.slice(0, 2))} 月 ${Number(x.md.slice(3))} 日${x.turning ? `，將滿 ${x.turning} 歲` : ''}）`,
    link: '#/members/birthdays'
  }));
  overdueFees().forEach(f => out.push({ kind: 'fee', level: 'danger', text: `團費逾期未收：${memberName(f.memberId)}（${money(f.amount)}，到期 ${f.due}）`, link: '#/finance/fees' }));
  pendingClaims().forEach(c => out.push({ kind: 'claim', level: 'info', text: `收支申報待批：${c.byName || ''} ${c.item}（${money(c.amount)}）`, link: '#/finance/claims' }));
  pendingLoans().forEach(l => out.push({ kind: 'loan', level: 'info', text: `物資借用待批：${l.borrowerName || ''} 借 ${invItem(l.itemId)?.name || ''} ×${l.qty}`, link: '#/inventory/loans' }));
  overdueLoans().forEach(l => out.push({ kind: 'loan', level: 'danger', text: `物資逾期未還：${l.borrowerName || ''} · ${invItem(l.itemId)?.name || ''}（應還 ${l.dueDate}）`, link: '#/inventory/loans' }));
  openActions().filter(a => a.due && a.due < todayISO()).forEach(a => out.push({ kind: 'action', level: 'warn', text: `會議行動逾期：${a.text}`, link: '#/meetings' }));
  // 每年一次：AGM 日期（旅財政年度起點）未確認
  const fy = unitFYOf(todayISO(), settings().agmDates || []);
  if (agmIsDefault(fy.agmYear, settings().agmDates || [])) {
    out.push({ kind: 'agm', level: 'info',
      text: `${fy.agmYear} 年 AGM 日期未確認（現用 ${fy.start}）—— 旅財政年度由此起計，請逐年輸入實際日期`,
      link: '#/finance/reports' });
  }
  return out;
}
