/* 團員入口登入狀態（YMIS＋密碼），同執委 session 分開 */
const key = code => 'v82.hub.auth.' + String(code || '');

export function loadHubAuth(code) {
  try {
    const o = JSON.parse(sessionStorage.getItem(key(code)) || 'null');
    if (!o || !o.id) return null;
    return o;
  } catch { return null; }
}

export function saveHubAuth(code, rec) {
  try {
    if (!rec) sessionStorage.removeItem(key(code));
    else sessionStorage.setItem(key(code), JSON.stringify({
      id: rec.id, name: rec.name || '', ymis: rec.ymis || '',
      identity: rec.identity || 'member', at: Date.now()
    }));
  } catch { /* */ }
}

export function clearHubAuth(code) {
  saveHubAuth(code, null);
}
