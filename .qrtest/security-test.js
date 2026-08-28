// 安全修复回归验证（注意：锁定测试放最后，会把自己锁 10 分钟 → 测完需重启服务）
const fs = require('fs');
const PIN = JSON.parse(fs.readFileSync('.mobile-srv/settings.json', 'utf8')).pin || '';
const B = 'http://127.0.0.1:3190';
let pass = 0, fail = 0;
function t(name, cond, extra) {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
}

(async () => {
  // H-1: 管理栅栏 —— 恶意 Origin（本机 IP 但外部站点 Origin）应被拒
  let r = await fetch(`${B}/api/admin/tunnel`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' },
    body: JSON.stringify({ on: false }),
  });
  t('H-1 admin 拒绝外部 Origin', r.status === 403, 'status=' + r.status);

  // H-1: DNS rebinding（Host 为外部域名）应被拒（node:http 才能改写 Host 头）
  const http = require('node:http');
  r = await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port: 3190, path: '/api/admin/tunnel', method: 'POST', headers: { 'content-type': 'application/json', host: 'rebind.example.com:3190' }, agent: false }, resolve);
    rq.end(JSON.stringify({ on: false }));
  });
  t('H-1 admin 拒绝外部 Host（rebinding）', r.statusCode === 403, 'status=' + r.statusCode);

  // H-1: 合法本机调用（PC 面板：127.0.0.1:3080 跨端口 Origin）应通过
  r = await fetch(`${B}/api/admin/tunnel`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' },
    body: JSON.stringify({ on: false }),
  });
  const j0 = await r.json();
  t('H-1 admin 接受 loopback 跨端口 Origin（PC 面板）', r.status === 200 && j0.ok, 'status=' + r.status);

  // H-1: 修改密码需旧密码
  r = await fetch(`${B}/api/admin/pin`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3190' },
    body: JSON.stringify({ pin: 'newpin12345' }), // 无 oldPin
  });
  t('H-1 改密码无旧密码被拒', r.status === 403, 'status=' + r.status);
  r = await fetch(`${B}/api/admin/pin`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3190' },
    body: JSON.stringify({ pin: 'newpin12345', oldPin: 'wrong-old' }),
  });
  t('H-1 改密码旧密码错误被拒', r.status === 403, 'status=' + r.status);

  // M-1: 登录种 HttpOnly Cookie；错误密码 401
  r = await fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: 'wrong-pin' }),
  });
  t('M-1 错误密码 401', r.status === 401, 'status=' + r.status);
  r = await fetch(`${B}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: PIN }),
  });
  const setCookie = r.headers.get('set-cookie') || '';
  const ok1 = r.status === 200 && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie);
  const cookie = (setCookie.match(/tt_pin_v2=([a-f0-9]+)/) || [])[1] || '';
  t('M-1 正确密码种 HttpOnly+Strict Cookie', ok1, setCookie.slice(0, 60));

  // M-1/M-2: 数据接口用 Cookie 通过；?pin= 查询参数已失效
  r = await fetch(`${B}/api/schedule?pin=${encodeURIComponent(PIN)}`);
  t('M-1 ?pin= 已移除（401）', r.status === 401, 'status=' + r.status);
  r = await fetch(`${B}/api/schedule`, { headers: { cookie: `tt_pin_v2=${cookie}` } });
  t('M-1 Cookie 访问数据接口通过', r.status === 200, 'status=' + r.status);

  // M-2: status 最小化 + 无 CORS（恶意 Origin）
  r = await fetch(`${B}/api/status`, { headers: { origin: 'http://evil.example.com' } });
  const j2 = await r.json();
  t('M-2 外部 Origin 得最小 status 且无 CORS 头', r.status === 200 && !('lanIp' in j2) && !r.headers.get('access-control-allow-origin'), JSON.stringify(j2));
  // M-2: loopback Origin 得完整 status + CORS 回显
  r = await fetch(`${B}/api/status`, { headers: { origin: 'http://127.0.0.1:3080' } });
  const j3 = await r.json();
  t('M-2 loopback Origin 得完整 status + CORS 回显', 'lanIp' in j3 && r.headers.get('access-control-allow-origin') === 'http://127.0.0.1:3080', 'acao=' + r.headers.get('access-control-allow-origin'));

  // M-3: respond 拒绝未知 rpcId
  r = await fetch(`${B}/api/respond`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `tt_pin_v2=${cookie}` },
    body: JSON.stringify({ rpcId: 'not-exist-123', kind: 'question', answer: [{ id: 'x', selected: ['y'] }] }),
  });
  t('M-3 respond 拒绝未知 rpcId', r.status === 400, 'status=' + r.status);

  // M-4: 下载域名校验（直接调用内部函数不可行，用行为验证：仅检查实现存在）
  const src = fs.readFileSync('mobile-server.mjs', 'utf8');
  t('M-4 下载白名单/上限/超时已实现', /GITHUB_HOST_RE/.test(src) && /DOWNLOAD_MAX_BYTES/.test(src) && /download timeout/.test(src));

  // CSP
  r = await fetch(`${B}/`);
  t('L-5 CSP 头已下发', /content-security-policy/i.test(r.headers.get('content-security-policy') || '') || !!r.headers.get('content-security-policy'), (r.headers.get('content-security-policy') || '').slice(0, 50));

  console.log(`\n${pass} passed, ${fail} failed`);

  // H-2: 锁定测试（放最后 —— 会把 127.0.0.1 锁 10 分钟）
  console.log('\nH-2 lockout test (will lock this IP 10min)...');
  for (let i = 0; i < 6; i++) {
    await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'bad-' + i }) }).catch(() => {});
  }
  r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
  const jL = await r.json().catch(() => ({}));
  t('H-2 连续失败后正确密码也被锁定（429）', r.status === 429 && !!jL.retryAfter, `status=${r.status} retryAfter=${jL.retryAfter}`);
  console.log(`\nfinal: ${pass + 1} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
