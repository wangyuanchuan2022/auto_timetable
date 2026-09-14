// diag-plan-auth.mjs — 诊断 /api/plan 凭据校验：读磁盘 settings 的会话 token 实测，
// 打印 401/200 响应体原文，定位「磁盘 token 被运行实例拒绝」的真实原因。只读不写。
import { readFileSync } from 'node:fs';

const SETTINGS = 'D:/tools/auto_timetable/.mobile-srv/settings.json';
const BASE = 'http://127.0.0.1:3191';
const s = JSON.parse(readFileSync(SETTINGS, 'utf8'));
const sessions = (s.sessions || []).filter((x) => x && typeof x.token === 'string');
console.log('[diag] pinHash set:', !!s.pinHash, '| sessions on disk:', sessions.length);
for (const sess of sessions) {
  const ageDays = sess.lastSeen || sess.createdAt
    ? Math.round((Date.now() - (sess.lastSeen || sess.createdAt)) / 86400000.0 * 10) / 10
    : '?';
  console.log(`[diag] token ${sess.token.slice(0, 8)}… age=${ageDays}d lastSeen=${sess.lastSeen || '-'} createdAt=${sess.createdAt || '-'}`);
}

const test = async (label, headers) => {
  try {
    const r = await fetch(`${BASE}/api/plan?days=1`, { headers });
    const body = await r.text();
    console.log(`[diag] ${label} -> HTTP ${r.status} ${body.slice(0, 140)}`);
    return r.status;
  } catch (e) {
    console.log(`[diag] ${label} -> FETCH ERR ${e.message}`);
    return -1;
  }
};

await test('no-auth     ', {});
for (const sess of sessions.slice(0, 3)) {
  const st = await test(`cookie ${sess.token.slice(0, 8)}…`, { cookie: `tt_pin_v2=${sess.token}` });
  if (st === 200) { console.log('[diag] VALID token found:', sess.token.slice(0, 8) + '…'); break; }
}
