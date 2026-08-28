// Web Push 端点与静态资源验证
import fs from 'node:fs';
const PIN = JSON.parse(fs.readFileSync('.mobile-srv/settings.json', 'utf8')).pin || '';
const B = 'http://127.0.0.1:3190';
let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : '')); };

const cookie = (await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: PIN }) })
  .then(r => (r.headers.get('set-cookie').match(/tt_pin_v2=[a-f0-9]+/) || [])[0]));

const key = await fetch(`${B}/api/push/key`, { headers: { cookie } }).then(r => r.json());
t('GET /api/push/key 返回 VAPID 公钥', key.ok && /^[A-Za-z0-9_-]{80,}$/.test(key.publicKey || ''), (key.publicKey || '').slice(0, 20) + '…');

const r1 = await fetch(`${B}/api/push/key`);
t('push/key 未登录 401', r1.status === 401, 'status=' + r1.status);

const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint-1', keys: { p256dh: 'BTest', auth: 'ATest' } };
const s1 = await fetch(`${B}/api/push/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ subscription: sub }) }).then(r => r.json());
t('POST /api/push/subscribe 登记成功', s1.ok && s1.count === 1, JSON.stringify(s1));
// 幂等：重复登记不重复
const s2 = await fetch(`${B}/api/push/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ subscription: sub }) }).then(r => r.json());
t('重复订阅幂等', s2.ok && s2.count === 1, JSON.stringify(s2));

const sw = await fetch(`${B}/sw.js`);
t('GET /sw.js 200 + service-worker-allowed', sw.status === 200 && (sw.headers.get('service-worker-allowed') === '/'), 'status=' + sw.status);
const mf = await fetch(`${B}/manifest.webmanifest`);
t('GET /manifest.webmanifest 200', mf.status === 200, 'status=' + mf.status);
const ic = await fetch(`${B}/icon-192.png`);
t('GET /icon-192.png 200 image/png', ic.status === 200 && ic.headers.get('content-type') === 'image/png', ic.headers.get('content-type'));

// 订阅清理
const u1 = await fetch(`${B}/api/push/unsubscribe`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ endpoint: sub.endpoint }) }).then(r => r.json());
t('POST /api/push/unsubscribe 清理', u1.ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
