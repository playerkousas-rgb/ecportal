// Vercel Serverless Function — 旅團清單 API
// 資料來源：data/units.json + TROOP_{ID}_* 環境變數
// 安全：只回傳公開資訊，不外洩 gasUrl / apiKey

import { listPublicUnits } from './_registry.js';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(405).json({ success: false, error: '此 API 只接受 GET 請求' });
  }
  const units = listPublicUnits();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json({
    units,
    _note: '82venture 多旅團 Registry，所有後端同步存取請經同源 /api/proxy'
  });
}
