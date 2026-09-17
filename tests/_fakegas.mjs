/* ============================================================
   tests/_fakegas.mjs — 假 Apps Script（/exec）＋ dev-server 代理
   ------------------------------------------------------------
   行為同真 Code.gs 一樣（saveDb / loadDb / dbInfo 分段存拼），
   但存喺記憶體，方便測試「換機」情境而唔使真係去 Google。
   用法：node tests/_fakegas.mjs <port>
   ============================================================ */

import http from 'node:http';

const PORT = Number(process.argv[2] || 8799);
const DB_CHUNK = 45000;

/* 模擬 Sheet：一行一段 [unit, seq, text, at, version] */
let sheet = [];

function saveDb(body) {
  const unit = String(body.unit || 'UNKNOWN');
  const text = JSON.stringify(body.db);
  sheet = sheet.filter(r => r[0] !== unit);            // 刪走舊段
  const now = new Date().toISOString();
  const version = body.db?.meta?.updatedAt || now;
  for (let p = 0, i = 1; p < text.length; p += DB_CHUNK, i++) {
    sheet.push([unit, i, text.substring(p, p + DB_CHUNK), now, version]);
  }
  return { ok: true, success: true, bytes: text.length, chunks: Math.ceil(text.length / DB_CHUNK), at: now, version };
}

function loadDb(unit) {
  const parts = sheet.filter(r => !unit || r[0] === unit).sort((a, b) => a[1] - b[1]);
  if (!parts.length) return { ok: true, success: true, found: false, db: null };
  const text = parts.map(r => r[2]).join('');
  try {
    const db = JSON.parse(text);
    return { ok: true, success: true, found: true, db, at: parts[0][3], version: parts[0][4], bytes: text.length };
  } catch (e) {
    return { ok: false, success: false, found: true, db: null, error: '資料庫內容壞咗' };
  }
}

function dbInfo(unit) {
  const r = loadDb(unit);
  if (!r.found) return { ok: true, success: true, found: false };
  const db = r.db || {};
  return {
    ok: true, success: true, found: true, at: r.at, version: r.version, bytes: r.bytes,
    counts: {
      members: (db.members || []).length,
      transactions: (db.transactions || []).length,
      meetings: (db.meetings || []).length,
      notices: (db.notices || []).length,
      invItems: (db.invItems || []).length,
      accounts: (db.accounts || []).length
    }
  };
}

/* 後端如果設咗 API_KEY（真 Code.gs 行完 initializeSheets 就一定會有），
   saveDb / loadDb / dbInfo 就要條 key 啱先做得 —— 呢個正正係
   「app 條 key 留空 → 寫唔入」嗰個真實故障。
   用法：FAKEGAS_APIKEY=xxx node tests/_fakegas.mjs <port> */
const EXPECTED_KEY = process.env.FAKEGAS_APIKEY || '';

http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    let out;
    const a = body.action || '';
    const key = body.apiKey || body.apikey || '';
    const needsKey = a === 'saveDb' || a === 'loadDb' || a === 'dbInfo';

    if (EXPECTED_KEY && needsKey && key !== EXPECTED_KEY) {
      out = { ok: false, success: false, error: '未授權：API Key 唔正確' };
    } else if (a === 'saveDb') out = saveDb(body);
    else if (a === 'loadDb') out = loadDb(String(body.unit || ''));
    else if (a === 'dbInfo') out = dbInfo(String(body.unit || ''));
    else if (a === 'sync') {
      out = { ok: true, success: true, msg: '已寫入總表', counts: {} };
      if (body.db) {
        if (EXPECTED_KEY && key !== EXPECTED_KEY) out.db = { saved: false, error: '未授權：API Key 唔正確' };
        else out.db = { saved: saveDb(body).success };
      }
    } else if (a === 'status' || a === 'ping') out = { ok: true, success: true, msg: 'pong' };
    else out = { ok: false, success: false, error: '未知 action：' + a };

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(out));
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`fake-gas listening on ${PORT}`);
});
