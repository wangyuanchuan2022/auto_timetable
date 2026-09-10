// test-auth.mjs — dsh-worktable 鉴权补丁的隔离验证（不触碰真实 ~/.dsh/storages）
// 用法：node patches/dsh-worktable/test-auth.mjs
import { writeFileSync, readFileSync, rmSync } from 'node:fs';

const AUTH_FILE = new URL('./.tmp-worktable-auth.json', import.meta.url);
process.env.DSH_WORKTABLE_AUTH_FILE = decodeURIComponent(AUTH_FILE.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
rmSync(process.env.DSH_WORKTABLE_AUTH_FILE, { force: true });

const PIN = 'unit-test-pin-42';
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  [OK] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? ' | ' + String(extra).slice(0, 200) : '')); }
};

const mod = await import(new URL('./lib/index.js', import.meta.url).href);

// ---- mock 宿主 ----
const registered = []; const upgrades = [];
const webServer = {
  register: (x) => registered.push(x),
  registerUpgrade: (x) => upgrades.push(x),
};
const ctx = { webServer, effect: (fn) => fn(), logger: { info: () => {}, warn: () => {} } };
mod.apply(ctx);

const route = (path) => registered.find((r) => r.path === path);
const mkReq = (o = {}) => ({
  method: o.method || 'GET',
  url: o.url || '/',
  headers: o.headers || {},
  socket: { remoteAddress: o.ra ?? '127.0.0.1' },
  async *[Symbol.asyncIterator]() { yield Buffer.from(o.body ?? ''); },
});
const mkRes = () => {
  const r = { status: null, headers: {}, body: '', writeHead(s, h) { r.status = s; r.headers = h || {}; return r; }, end(b) { r.body = String(b ?? ''); return r; } };
  return r;
};

// ---- 1. health 不设门禁 ----
{
  const res = mkRes();
  await route('/api/worktable/health').handler(mkReq(), res);
  check('health 无凭据 200（保活探针不设门禁）', res.status === 200 && JSON.parse(res.body).ok === true);
}
// ---- 2. write 无凭据 401 且不落盘 ----
{
  const res = mkRes();
  await route('/api/worktable/write').handler(mkReq({ method: 'POST', url: '/api/worktable/write' }), res);
  check('write 无凭据 401', res.status === 401 && JSON.parse(res.body).ok === false);
}
// ---- 3. file 无凭据 + 浏览器导航 → 401 + 登录页 HTML ----
{
  const res = mkRes();
  await route('/api/worktable/file').handler(mkReq({ url: '/api/worktable/file?path=C:/x', headers: { accept: 'text/html' } }), res);
  check('file 无凭据 GET+text/html → 登录页', res.status === 401 && res.body.includes('worktable 访问密码'));
}
// ---- 4. 首次登录即设置密码：200 + Cookie + token ----
let token = '';
{
  const res = mkRes();
  await route('/api/worktable/login').handler(mkReq({ method: 'POST', url: '/api/worktable/login', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: PIN }) }), res);
  const setCookie = res.headers['set-cookie'] || '';
  token = (setCookie.match(/tt_wt_v2=([0-9a-f]+)/) || [])[1] || JSON.parse(res.body).token;
  check('login 首设密码：200 + Set-Cookie + token', res.status === 200 && /tt_wt_v2=/.test(setCookie) && !!token, res.body);
}
// ---- 5. X-TT-Pin 头放行 ----
const WRITE_TARGET = decodeURIComponent(new URL('./.tmp-written.json', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
{
  const res = mkRes();
  await route('/api/worktable/write').handler(mkReq({
    method: 'POST', url: '/api/worktable/write',
    headers: { 'x-tt-pin': PIN, 'content-type': 'application/json' },
    body: JSON.stringify({ path: WRITE_TARGET, content: '{"ok":1}' }),
  }), res);
  check('write + 正确 X-TT-Pin → 200', res.status === 200 && JSON.parse(res.body).ok === true, res.status + ' ' + res.body);
  check('写入内容落盘', readFileSync(WRITE_TARGET, 'utf8') === '{"ok":1}');
}
// ---- 6. Cookie 会话放行 ----
{
  const res = mkRes();
  await route('/api/worktable/fs').handler(mkReq({ method: 'POST', url: '/api/worktable/fs', headers: { cookie: `tt_wt_v2=${token}` } }), res);
  check('fs + Cookie 会话 → 200', res.status === 200 && JSON.parse(res.body).path !== undefined, res.status + ' ' + res.body);
}
// ---- 7. auth 查询参数放行（WS 同源语义）----
{
  const res = mkRes();
  await route('/api/worktable/workspaces').handler(mkReq({ url: `/api/worktable/workspaces?auth=${token}` }), res);
  check('workspaces + ?auth=token → 200', res.status === 200, res.status + ' ' + res.body.slice(0, 120));
}
// ---- 8. 错误密码限速：换独立 IP（127.0.0.2）连错 5 次 → 锁定 ----
{
  const mkBodyReq = (pin, ra) => mkReq({
    method: 'POST', url: '/api/worktable/login',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }), ra,
  });
  const res401 = mkRes();
  await route('/api/worktable/login').handler(mkBodyReq('wrong-0', '127.0.0.2'), res401);
  check('login 错误密码 401', res401.status === 401, res401.status + ' ' + res401.body);
  for (let i = 1; i < 5; i++) await route('/api/worktable/login').handler(mkBodyReq('wrong-' + i, '127.0.0.2'), mkRes());
  const res429 = mkRes();
  await route('/api/worktable/login').handler(mkBodyReq('wrong-x', '127.0.0.2'), res429);
  check('同 IP 第 6 次尝试 → 429 锁定（未到闸前不会）', res429.status === 429, res429.status + ' ' + res429.body);
  const resCookie = mkRes();
  await route('/api/worktable/fs').handler(mkReq({ method: 'POST', url: '/api/worktable/fs', headers: { cookie: `tt_wt_v2=${token}` } }), resCookie);
  check('锁定期间 Cookie 会话不受影响', resCookie.status === 200);
  const resOtherIp = mkRes();
  await route('/api/worktable/write').handler(mkReq({
    method: 'POST', url: '/api/worktable/write', ra: '127.0.0.3',
    headers: { 'x-tt-pin': PIN }, body: JSON.stringify({ path: WRITE_TARGET, content: 'y' }),
  }), resOtherIp);
  check('限速按 IP 隔离：他 IP 正确 pin 仍 200', resOtherIp.status === 200, 'status=' + resOtherIp.status);
}
// ---- 9. file 读（有凭据）----
{
  const tmpData = new URL('./.tmp-readme.txt', import.meta.url);
  writeFileSync(tmpData, 'hello-auth');
  const res = mkRes();
  await route('/api/worktable/file').handler(mkReq({ url: '/api/worktable/file?path=' + encodeURIComponent(decodeURIComponent(tmpData.pathname).replace(/^\/([A-Za-z]:)/, '$1')), headers: { 'x-tt-pin': PIN } }), res);
  check('file + pin 头 → 读到内容', res.status === 200 && res.body === 'hello-auth', res.status);
  rmSync(tmpData, { force: true });
}
// ---- 10. term 升级门禁（若 ws/pty 可用而注册）----
if (upgrades.length) {
  const destroyed = { v: false };
  const fakeSocket = { destroyedFlag: false, write() { destroyed.v = true; }, destroy() { destroyed.v = true; } };
  await upgrades[0].handler(mkReq({ url: '/api/worktable/term?cwd=.' }), fakeSocket, null);
  await new Promise((r) => setTimeout(r, 300));
  check('term WS 无凭据 → 401 并断开', destroyed.v);
} else {
  console.log('  [--] term 未注册（ws/node-pty 在隔离环境不可用），升级门禁留待宿主重启后实测');
}

// ---- 收尾：确认 auth 文件落在重定向路径（未污染真实配置）----
const saved = JSON.parse(readFileSync(process.env.DSH_WORKTABLE_AUTH_FILE, 'utf8'));
check('会话/哈希落盘在重定向路径', !!saved.pinHash?.hash && (saved.sessions?.length ?? 0) >= 1);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
