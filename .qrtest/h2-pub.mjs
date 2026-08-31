// H-2 锁定回归（公网来源视角）：伪造转发头绕不开按 socket 对端 IP 的限流锁定。
// 副作用：把来源 IP 101.5.187.121 锁 10 分钟（127.0.0.1 与手机 IP 不受影响）。
// 先等 75 秒：让 fixcheck 触发的全局慢速闸（60s）彻底过期，避免干扰本测试。
import fs from 'node:fs';

const B = 'http://101.5.187.121:3190';
const PIN = JSON.parse(fs.readFileSync('.mobile-srv/settings.json', 'utf8')).pin || '';
import { createHash } from 'node:crypto';
const COOKIE = 'tt_pin_v2=' + createHash('sha256').update('tt-cookie:' + PIN).digest('hex');

let pass = 0, fail = 0;
function t(name, cond, extra) { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : '')); }

console.log('等待 75s（全局慢速闸窗口过期）…');
await new Promise((r) => setTimeout(r, 75_000));

// 连续 6 次失败登录，每次带不同的伪造 cf-connecting-ip（若服务采信转发头即可换桶绕过锁定）
for (let i = 0; i < 6; i++) {
  const r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${i}` }, body: JSON.stringify({ pin: 'bad-' + i }) }).catch(() => ({ status: 0 }));
  console.log(`  失败登录 #${i + 1}（伪造 cf-connecting-ip=198.51.100.${i}）→ ${r.status}`);
}
// 正确密码也应被锁（429 + retryAfter）—— 证明锁定按真实 socket IP 计数，伪造头无效
let r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.99' }, body: JSON.stringify({ pin: PIN }) });
let j = await r.json().catch(() => ({}));
t('H-2 伪造转发头绕不开锁定（正确密码仍 429）', r.status === 429 && !!j.retryAfter, `status=${r.status} retryAfter=${j.retryAfter || '-'}`);

// 已持 Cookie 的合法访问不受该源 IP 锁定连坐（checkPin 凭据前置）
r = await fetch(`${B}/api/schedule`, { headers: { cookie: COOKIE } });
t('H-2 锁定期间 Cookie 访问不受连坐（200）', r.status === 200, 'status=' + r.status);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
