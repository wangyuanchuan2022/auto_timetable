// 隧道端口（127.0.0.1:3191）安全行为验证：cf 头可信域隔离 / 管理禁用 / Secure Cookie / CORS
import http from 'node:http';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const DIRECT = 'http://127.0.0.1:3190';
const TUNNEL = 'http://127.0.0.1:3191';
const PIN = JSON.parse(fs.readFileSync('.mobile-srv/settings.json', 'utf8')).pin || '';
const COOKIE = 'tt_pin_v2=' + createHash('sha256').update('tt-cookie:' + PIN).digest('hex');

let pass = 0, fail = 0;
function t(name, cond, extra) { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : '')); }
function raw(opts, body) {
  return new Promise((resolve, reject) => {
    const rq = http.request({ agent: false, ...opts }, resolve);
    rq.on('error', reject); rq.setTimeout(6000, () => rq.destroy(new Error('timeout')));
    rq.end(body ?? '');
  });
}

// T-1 隧道端口页面可达 + CSP
let r = await fetch(`${TUNNEL}/`);
t('T-1 隧道端口页面可达（200）', r.status === 200, 'status=' + r.status);

// T-2 管理接口在隧道端口整体禁用（即使 socket=loopback、Host 伪造 loopback、无 Origin）
r = await fetch(`${TUNNEL}/api/admin/pin`, { method: 'POST', headers: { 'content-type': 'application/json', host: '127.0.0.1:3191' }, body: '{"pin":"short"}' });
t('T-2 隧道端口 /api/admin/pin 禁用（403）', r.status === 403, 'status=' + r.status);
let rr = await raw({ host: '127.0.0.1', port: 3191, path: '/api/admin/shutdown', method: 'POST', headers: { host: '127.0.0.1:3191' } });
t('T-2 隧道端口 /api/admin/shutdown 禁用（403）', rr.statusCode === 403, 'status=' + rr.statusCode);

// T-3 cf-connecting-ip 独立限流桶：cf-ip A 连续 5 败 → 锁；cf-ip B 仍可正常失败（未连坐）
for (let i = 0; i < 5; i++) {
  await fetch(`${TUNNEL}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.1' }, body: '{"pin":"bad-' + i + '"}' }).catch(() => {});
}
r = await fetch(`${TUNNEL}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.1' }, body: '{"pin":"bad-again"}' });
t('T-3 同一 cf-ip 第 6 次失败 → 429 锁定', r.status === 429, 'status=' + r.status);
r = await fetch(`${TUNNEL}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.2' }, body: '{"pin":"bad-other"}' });
t('T-3 另一 cf-ip 不被连坐（401 而非 429）', r.status === 401, 'status=' + r.status);

// T-4 直击隧道端口不带 cf 头 → tunnel-unknown 桶（本地伪造无法冒充他人 IP）
r = await fetch(`${TUNNEL}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"pin":"bad-nocf"}' });
t('T-4 无 cf 头直击隧道端口 → 正常 401（tunnel-unknown 桶）', r.status === 401, 'status=' + r.status);

// T-5 隧道端口登录成功 → Cookie 带 Secure；直连端口 → 不带
r = await fetch(`${TUNNEL}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.3' }, body: JSON.stringify({ pin: PIN }) });
const scT = r.headers.get('set-cookie') || '';
t('T-5 隧道端口 Cookie 带 Secure', r.status === 200 && /Secure/i.test(scT), scT.replace(/tt_pin_v2=[a-f0-9]+/, 'tt_pin_v2=<redacted>'));
r = await fetch(`${DIRECT}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
const scD = r.headers.get('set-cookie') || '';
t('T-5 直连端口 Cookie 不带 Secure（兼容 http）', r.status === 200 && !/Secure/i.test(scD));

// T-6 模拟隧道域名请求：Host/Origin = tt.example.com → CORS 同源回显 + status 最小化
rr = await raw({ host: '127.0.0.1', port: 3191, path: '/api/status', headers: { host: 'tt.example.com', origin: 'https://tt.example.com' } });
const body6 = await new Promise((res) => { let b = ''; rr.on('data', (c) => { b += c; }); rr.on('end', () => res(b)); });
const j6 = JSON.parse(body6);
t('T-6 隧道域名 CORS 同源回显', rr.headers['access-control-allow-origin'] === 'https://tt.example.com', 'acao=' + rr.headers['access-control-allow-origin']);
t('T-6 隧道视角 status 最小化（无 lanIp/pinSet/tunnel）', !('lanIp' in j6) && !('pinSet' in j6) && !('tunnel' in j6), body6.slice(0, 80));

// T-7 直连端口本机视角 status 含 tunnel 字段（url 未配置 → null）
r = await fetch(`${DIRECT}/api/status`);
const j7 = await r.json();
t('T-7 本机 status 含 tunnel.port=3191', j7.tunnel && j7.tunnel.port === 3191 && j7.tunnel.url === null, JSON.stringify(j7.tunnel));

// T-8 隧道端口 WS 未授权 → 401（checkPin 走 cf-ip 桶）
const wsStat = await new Promise((resolve) => {
  const s = http.request({ host: '127.0.0.1', port: 3191, path: '/api/chat/watch', headers: { host: 'tt.example.com', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
  s.on('response', (r2) => { resolve(String(r2.statusCode)); r2.resume(); });
  s.on('upgrade', () => { resolve('101'); });
  s.on('error', () => resolve('error'));
  s.end();
});
t('T-8 隧道端口 WS 未授权被拒（401）', wsStat === '401', 'status=' + wsStat);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
