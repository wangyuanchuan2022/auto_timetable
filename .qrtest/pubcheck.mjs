// 公网面非破坏性安全检查 —— 目标 http://101.5.187.121:3190（本机公网 IP，来源视角=非 loopback）
// 纪律：认证失败总数 ≤4（锁定阈值 5），末尾用正确密码登录成功 → rateClear 清零，全程不触发锁定。
// PIN 仅在脚本内从 settings.json 读取，绝不打印。
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

const HOST = '101.5.187.121';
const B = `http://${HOST}:3190`;
const PIN = JSON.parse(fs.readFileSync('.mobile-srv/settings.json', 'utf8')).pin || '';

let pass = 0, fail = 0;
function t(name, cond, extra) {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
}
function rawRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const rq = http.request({ agent: false, ...opts }, resolve);
    rq.on('error', reject);
    rq.setTimeout(6000, () => { rq.destroy(new Error('timeout')); });
    rq.end(body ?? '');
  });
}
function wsProbe() {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port: 3190 }, () => {
      s.write(`GET /api/chat/watch HTTP/1.1\r\nHost: ${HOST}:3190\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('utf8');
      const m = buf.match(/^HTTP\/1\.1 (\d+)/);
      if (m) { resolve(m[1]); s.destroy(); }
    });
    s.on('error', () => resolve('conn-error'));
    const to = setTimeout(() => { resolve('timeout:' + buf.slice(0, 60)); s.destroy(); }, 6000);
    to.unref?.();
  });
}

// ---------- P-1 首页与响应头 ----------
let r = await fetch(`${B}/`);
t('P-1 服务可达（200）', r.status === 200, 'status=' + r.status);
const csp = r.headers.get('content-security-policy') || '';
t('P-1 CSP 含 frame-ancestors none', /frame-ancestors\s+'none'/.test(csp), csp.slice(0, 100));
t('P-1 x-content-type-options: nosniff', (r.headers.get('x-content-type-options') || '') === 'nosniff');
t('P-1 cache-control: no-store', /no-store/.test(r.headers.get('cache-control') || ''));
const html = await r.text();
t('P-1 页面无内嵌密钥/密码', !/pin\s*[:=]\s*['"][^'"]{6,}/i.test(html) && !/(privateKey|apiKey|secret)\s*[:=]\s*['"][^'"]{8,}/i.test(html));

// ---------- P-2 信息最小化 / CORS ----------
r = await fetch(`${B}/api/status`, { headers: { origin: 'http://evil.example.com' } });
const j = await r.json().catch(() => ({}));
t('P-2 外部视角 status 最小化（无 lanIp/pinSet）', r.status === 200 && !('lanIp' in j) && !('pinSet' in j), JSON.stringify(j));
t('P-2 恶意 Origin 无 CORS 回显', !r.headers.get('access-control-allow-origin'));
r = await fetch(`${B}/api/chat`, { method: 'OPTIONS', headers: { origin: 'http://evil.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
t('P-2 预检恶意 Origin 无 CORS 头', !r.headers.get('access-control-allow-origin'), 'status=' + r.status);

// ---------- P-3 管理栅栏（来源=公网 IP，非 loopback；不耗限流额度） ----------
r = await fetch(`${B}/api/admin/pin`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' }, body: '{"pin":"short"}' });
t('P-3 admin 拒绝外部来源（403）', r.status === 403, 'status=' + r.status);
let rr = await rawRequest({ host: HOST, port: 3190, path: '/api/admin/pin', method: 'POST', headers: { 'content-type': 'application/json', host: '127.0.0.1:3190' } }, '{"pin":"short"}');
t('P-3 admin 拒绝公网来源+伪造 loopback Host（403）', rr.statusCode === 403, 'status=' + rr.statusCode);
rr = await rawRequest({ host: HOST, port: 3190, path: '/api/admin/shutdown', method: 'POST', headers: { host: '127.0.0.1:3190' } });
t('P-3 shutdown 不可从公网触发（403）', rr.statusCode === 403, 'status=' + rr.statusCode);

// ---------- P-4 未认证数据接口（失败 #1、#2） ----------
r = await fetch(`${B}/api/schedule`);
t('P-4 schedule 无凭据 → 401', r.status === 401, 'status=' + r.status);
r = await fetch(`${B}/api/schedule?pin=12345678`);
t('P-4 ?pin= 查询参数已失效（401）', r.status === 401, 'status=' + r.status);

// ---------- P-5 登录行为（失败 #3） ----------
r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'definitely-wrong-xyz' }) });
const scFail = r.headers.get('set-cookie') || '';
t('P-5 错误密码 401 且不种 Cookie', r.status === 401 && !scFail, 'status=' + r.status + ' set-cookie=' + (scFail || '(none)'));

// ---------- P-6 WS 升级未授权（失败 #4，最后一次失败） ----------
const wsStat = await wsProbe();
t('P-6 WS /api/chat/watch 未授权被拒（401）', wsStat === '401', 'status=' + wsStat);

// ---------- P-7 正确密码登录（清空失败计数；不打印任何敏感值） ----------
r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
const setCookie = r.headers.get('set-cookie') || '';
const cookie = (setCookie.match(/tt_pin_v2=([a-f0-9]+)/) || [])[1] || '';
t('P-7 正确密码 200 + HttpOnly + SameSite=Strict', r.status === 200 && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), setCookie.replace(/tt_pin_v2=[a-f0-9]+/, 'tt_pin_v2=<redacted>'));
r = await fetch(`${B}/api/schedule`, { headers: { cookie: `tt_pin_v2=${cookie}` } });
t('P-7 Cookie 可访问数据接口（200）', r.status === 200, 'status=' + r.status);

// ---------- P-8 路径与未知接口 ----------
r = await fetch(`${B}/api/nonexistent`);
t('P-8 未知接口 404', r.status === 404, 'status=' + r.status);
r = await fetch(`${B}/%2e%2e/mobile-server.mjs`);
t('P-8 路径遍历尝试被拒（404）', r.status === 404, 'status=' + r.status);
r = await fetch(`${B}/icon-192.png`);
t('P-8 静态图标正常（200）', r.status === 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
