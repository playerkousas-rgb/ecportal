#!/usr/bin/env node
/* ============================================================
   dev-server.mjs — 本機開發伺服器（零依賴）
   ------------------------------------------------------------
   本系統係純靜態網站（HTML + JS），本來用 `python3 -m http.server` 就夠。
   但「進度系統直接接駁」需要一個同源嘅伺服器端 API（Vercel 上係 /api/progress），
   所以呢個 script 會：
     1) 當普通靜態伺服器serve 成個 repo
     2) 將 /api/<name> 交俾 api/<name>.js（同 Vercel Serverless Function 一樣嘅 handler）

   用法：
     node dev-server.mjs            # http://localhost:8000
     PORT=3000 node dev-server.mjs
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.doc': 'application/msword'
};

/** 將 Node 嘅 res 包成 Vercel 風格（res.status().json()） */
function wrapRes(res) {
  let statusCode = 200;
  res.status = (code) => { statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.headersSent) res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    if (!res.headersSent) res.statusCode = statusCode;
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
    return res;
  };
  return res;
}

async function handleApi(req, res, name) {
  const file = path.join(ROOT, 'api', `${name}.js`);
  if (!file.startsWith(path.join(ROOT, 'api')) || !fs.existsSync(file)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: `冇呢個 API：${name}` }));
    return;
  }
  const qIdx = req.url.indexOf('?');
  req.query = Object.fromEntries(new URLSearchParams(qIdx >= 0 ? req.url.slice(qIdx + 1) : '').entries());
  try {
    const mod = await import(url.pathToFileURL(file).href + `?t=${Date.now()}`);
    const handler = mod.default;
    if (typeof handler !== 'function') throw new Error(`${name}.js 冇 default handler`);
    await handler(req, wrapRes(res));
  } catch (e) {
    console.error(`[api/${name}] error:`, e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ ok: false, error: '伺服器內部錯誤：' + (e?.message || String(e)) }));
  }
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (pathname === '/') pathname = '/index.html';
  let file = path.join(ROOT, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end('Forbidden'); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file = file + '.html';   // 對應 vercel cleanUrls
  if (!fs.existsSync(file)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end('<h1>404</h1><p>搵唔到檔案。</p>');
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname.startsWith('/api/')) {
    const name = pathname.replace(/^\/api\//, '').replace(/\/+$/, '').replace(/\.js$/, '');
    return handleApi(req, res, name || 'index');
  }
  return serveStatic(req, res);
}).listen(PORT, HOST, () => {
  console.log(`執委管理系統（本機）→ http://localhost:${PORT}/?u=0082`);
  console.log(`示範資料 → http://localhost:${PORT}/?mock=1`);
  console.log(`API（進度接駁）→ http://localhost:${PORT}/api/progress`);
});
