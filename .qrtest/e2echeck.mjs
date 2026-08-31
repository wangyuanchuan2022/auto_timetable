// 端到端验证：真实 Cloudflare quick tunnel（流量出公网经 CF 边缘回环）
// 从 .mobile-srv/tunnel.log 读取当前隧道地址（与服务端发现逻辑一致）
import fs from 'node:fs';

const log = fs.readFileSync('.mobile-srv/tunnel.log', 'utf8');
const B = ([...log.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi)].map((m) => m[0])).pop();
if (!B) { console.error('no tunnel URL in log'); process.exit(2); }
console.log('tunnel:', B);
const PIN = JSON.parse(fs.readFileSync('.mobile-srv/settings.json', 'utf8')).pin || '';

let pass = 0, fail = 0;
function t(name, cond, extra) { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : '')); }

let r = await fetch(`${B}/`);
t('E-1 隧道页面可达（200 TLS）', r.status === 200, `status=${r.status} server=${r.headers.get('server') || '-'} cf-ray=${!!r.headers.get('cf-ray')}`);

r = await fetch(`${B}/api/status`);
const j = await r.json();
t('E-1 隧道视角 status 最小化（无 lanIp/pinSet/tunnel）', r.status === 200 && !('lanIp' in j) && !('pinSet' in j) && !('tunnel' in j), JSON.stringify(j));

r = await fetch(`${B}/api/admin/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pin":"short"}' });
t('E-2 经隧道访问管理接口被禁用（403）', r.status === 403, 'status=' + r.status);

r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'wrong-e2e' }) });
t('E-3 错误密码 401', r.status === 401, 'status=' + r.status);

r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
const sc = r.headers.get('set-cookie') || '';
const ck = (sc.match(/tt_pin_v2=([a-f0-9]+)/) || [])[1] || '';
t('E-4 正确密码 200 + HttpOnly + Secure', r.status === 200 && /HttpOnly/i.test(sc) && /Secure/i.test(sc), sc.replace(/tt_pin_v2=[a-f0-9]+/, 'tt_pin_v2=<redacted>'));

r = await fetch(`${B}/api/schedule`, { headers: { cookie: `tt_pin_v2=${ck}` } });
t('E-5 Cookie 经隧道访问数据接口（200）', r.status === 200, 'status=' + r.status);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
