// 修复定向验证（loopback 视角）：
//  A. push endpoint SSRF 防护：http/内网/loopback endpoint → 400；合法 https → 200 后清理还原
//  B. 全局闸重排序：cookie 验证前置 → 已登录用户在全局闸触发期间仍可访问；
//     /api/login 失败补全局闸；正确密码不受影响
// 用 127.0.0.2..8（各自独立限流桶）各 5 次失败登录攒满 30 全局失败触发全局闸，不动 127.0.0.1 / 公网 IP 桶。
import http from 'node:http';
import fs from 'node:fs';

const B = 'http://127.0.0.1:3190';
const PIN = JSON.parse(fs.readFileSync('.mobile-srv/settings.json', 'utf8')).pin || '';
import { createHash } from 'node:crypto';
const COOKIE = 'tt_pin_v2=' + createHash('sha256').update('tt-cookie:' + PIN).digest('hex');

let pass = 0, fail = 0;
function t(name, cond, extra) { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : '')); }
function post(path, obj, headers = {}) {
  return fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj) });
}
function rawLogin(localAddr, pin) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ pin });
    const rq = http.request({ host: '127.0.0.1', port: 3190, localAddress: localAddr, method: 'POST', path: '/api/login', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
    rq.on('error', reject); rq.end(body);
  });
}

// ---------- A. SSRF 防护 ----------
const subsBefore = JSON.parse(fs.readFileSync('.mobile-srv/push-subscriptions.json', 'utf8')).length;
let r = await post('/api/push/subscribe', { subscription: { endpoint: 'http://127.0.0.1:9999/x', keys: { p256dh: 'k', auth: 'a' } } }, { cookie: COOKIE });
t('A-1 http+loopback endpoint → 400', r.status === 400, 'status=' + r.status + ' ' + (await r.text()).slice(0, 60));
r = await post('/api/push/subscribe', { subscription: { endpoint: 'https://192.168.1.5/push/x', keys: { p256dh: 'k', auth: 'a' } } }, { cookie: COOKIE });
t('A-2 https+私网 endpoint → 400', r.status === 400, 'status=' + r.status);
r = await post('/api/push/subscribe', { subscription: { endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'k', auth: 'a' } } }, { cookie: COOKIE });
t('A-3 http（即使公网域名）→ 400', r.status === 400, 'status=' + r.status);
const PROBE = 'https://fcm.googleapis.com/fcm/send/fixcheck-probe';
r = await post('/api/push/subscribe', { subscription: { endpoint: PROBE, keys: { p256dh: 'k', auth: 'a' } } }, { cookie: COOKIE });
t('A-4 合法公网 https endpoint → 200', r.status === 200, 'status=' + r.status);
r = await post('/api/push/unsubscribe', { endpoint: PROBE }, { cookie: COOKIE });
t('A-5 探测订阅已清理还原', r.status === 200 && JSON.parse(fs.readFileSync('.mobile-srv/push-subscriptions.json', 'utf8')).length === subsBefore);

// ---------- B. 全局闸重排序 ----------
// 基线：登录成功拿 Cookie
r = await post('/api/login', { pin: PIN });
t('B-1 正常登录 200', r.status === 200);
r = await fetch(B + '/api/schedule', { headers: { cookie: COOKIE } });
t('B-2 基线：Cookie 访问数据接口 200', r.status === 200, 'status=' + r.status);

// 触发全局闸：7 个 127.x 源 × 5 次失败 = 35 次全局失败（≥30 触发 60s 全局闸）
const sources = ['127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5', '127.0.0.6', '127.0.0.7', '127.0.0.8'];
for (const s of sources) for (let i = 0; i < 5; i++) await rawLogin(s, 'wrong-' + s + '-' + i).catch(() => {});
console.log('  （已注入 35 次分布式失败登录以触发全局慢速闸）');

// 已登录用户不受全局闸连坐（checkPin 凭据前置）
r = await fetch(B + '/api/schedule', { headers: { cookie: COOKIE } });
t('B-3 全局闸期间：Cookie 访问仍 200（不再连坐）', r.status === 200, 'status=' + r.status);

// 未认证者被全局闸拦（证明闸确实在生效）
r = await fetch(B + '/api/schedule');
const j1 = await r.json().catch(() => ({}));
t('B-4 全局闸期间：无凭据 → 429 暂缓受理', r.status === 429 && /暂缓受理/.test(j1.error || ''), 'status=' + r.status + ' err=' + (j1.error || '').slice(0, 40));

// /api/login 失败也吃全局闸（原先漏防）
r = await post('/api/login', { pin: 'wrong-under-hold' });
const j2 = await r.json().catch(() => ({}));
t('B-5 全局闸期间：错误密码登录 → 429（登录端点已补闸）', r.status === 429 && /暂缓受理/.test(j2.error || ''), 'status=' + r.status);

// 正确密码不受全局闸影响（验证先于闸门）
r = await post('/api/login', { pin: PIN });
t('B-6 全局闸期间：正确密码登录仍 200', r.status === 200, 'status=' + r.status);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
