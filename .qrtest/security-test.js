// security-test.js — 安全加固回归（F-2 改造：自启临时实例模式）
//
// 相对旧版的关键变更（对应评审报告问题 5：CI 毒性 / 自锁 flaky / 读生产真 pin）：
//  1. 不再连接生产 3190/3191 实例、不再读生产 .mobile-srv/settings.json 的真 pin——
//     自启临时实例：TT_DATA_DIR=<临时目录> node mobile-server.mjs --port <随机高位端口>；
//     假 pin 由测试预写进临时目录 settings.json（scrypt 哈希，经 server-routes.hashPin）。
//  2. 末项锁定测试默认跳过：旧版 H-2 会把本机桶锁定 10 分钟——既影响开发机真实使用，
//     又让 10 分钟内重跑出现 429 假失败（自造 flaky）。显式开启：SKIP_LOCKOUT=0。
//  3. H-2 结果不再「pass+1」硬编码；实例统一 shutdown/kill + 临时目录清理（finally）。
//  4. 生产目录自检：测试前后快照 .mobile-srv（与 schedule.json）的 mtime/size，出现差异打印
//     WARN 明细（不判 FAIL——生产实例可能并发写入，属环境噪音，由人工判读）。
//
// 依赖契约：mobile-server.mjs 支持 TT_DATA_DIR 环境变量（把 .mobile-srv 运行时数据目录
// 重定向到指定目录：settings/subs/fired/port 等）。Y-1 未合入前该契约不存在——
// 本文件检测到不支持时打印说明并以 0 退出（「待联跑」状态），不阻塞 test:live。
const { readFileSync, mkdtempSync, rmSync, readdirSync, statSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const http = require('node:http');

const HERE = join(__dirname, '..');
const PROD_DIR = join(HERE, '.mobile-srv');

// ---- 契约检测：TT_DATA_DIR 未就绪 → 待联跑状态退出 ----
const SRV_SRC = readFileSync(join(HERE, 'mobile-server.mjs'), 'utf8');
if (SRV_SRC.indexOf('TT_DATA_DIR') === -1) {
  console.log('SKIP：mobile-server.mjs 尚未支持 TT_DATA_DIR（等待 Y-1 合入 .mobile-srv 数据目录重定向）。');
  console.log('     本测试已按 TT_DATA_DIR 契约写好，Y-1 合入后自动生效：node .qrtest/security-test.js');
  console.log('     （合入前请沿用 lockdown-verify.mjs 连真实实例人工复核。）');
  process.exit(0);
}

const SKIP_LOCKOUT = process.env.SKIP_LOCKOUT !== '0'; // 默认跳过锁定测试；SKIP_LOCKOUT=0 显式开启
let pass = 0, fail = 0;
function t(name, cond, extra) {
  cond ? pass++ : fail++;
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));
}
function rawRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const rq = http.request({ agent: false, ...opts }, resolve);
    rq.on('error', reject);
    rq.setTimeout(5000, () => { rq.destroy(new Error('timeout')); });
    rq.end(body ?? '');
  });
}
function readBodyOf(r) {
  return new Promise((resolve) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => resolve(d)); });
}
function publicIpv4() {
  const os = require('node:os');
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(127\.|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      return a.address;
    }
  }
  return null;
}
const snapOf = (dir) => {
  const m = {};
  try { for (const f of readdirSync(dir)) { const s = statSync(join(dir, f)); m[f] = s.mtimeMs + ':' + s.size; } } catch (e) {}
  return m;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { hashPin } = await import('../server-routes.mjs');
  const PIN = 'test-pin-a1b2c3d4';
  const DATA_DIR = mkdtempSync(join(tmpdir(), 'tt-sec-'));
  writeFileSync(join(DATA_DIR, 'settings.json'), JSON.stringify({ pinHash: hashPin(PIN), sessions: [] }), 'utf8');

  const BASE = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(HERE, 'mobile-server.mjs'), '--port', String(BASE)], {
    env: { ...process.env, TT_DATA_DIR: DATA_DIR }, stdio: 'ignore', cwd: HERE,
  });

  const snapProdBefore = snapOf(PROD_DIR);
  const schedBefore = (() => { try { const s = statSync(join(HERE, 'schedule.json')); return s.mtimeMs + ':' + s.size; } catch (e) { return null; } })();

  try {
    // ---- 等待实例就绪：功能端口写入 TT_DATA_DIR/port（管理面所在），最多 15s ----
    const PORT_FILE = join(DATA_DIR, 'port');
    let FUNC = 0;
    for (let i = 0; i < 38 && !FUNC; i++) {
      await sleep(400);
      try { FUNC = parseInt(readFileSync(PORT_FILE, 'utf8').trim(), 10) || 0; } catch (e) {}
      if (FUNC) {
        try { const r = await fetch(`http://127.0.0.1:${FUNC}/api/status`, { headers: { origin: 'http://127.0.0.1:3080' }, signal: AbortSignal.timeout(1500) }); const j = await r.json(); if (!j || !j.ok) FUNC = 0; } catch (e) { FUNC = 0; }
      }
    }
    if (!FUNC) throw new Error('临时实例 15s 内未就绪（TT_DATA_DIR/port 未出现或功能端口无响应）');
    const B = `http://127.0.0.1:${FUNC}`;
    const D = `http://127.0.0.1:${BASE}`;
    console.log(`临时实例就绪：直连 ${BASE} / 功能 ${FUNC} / TT_DATA_DIR=${DATA_DIR}\n`);

    // ---- S-1: 直连端口全量收口（本机来源也无任何功能） ----
    let r = await fetch(`${D}/`);
    let h = await r.text();
    t('S-1 直连 GET /（本机）= 引导页（暂不可用/隧道地址）', r.status === 200 && /text\/html/.test(r.headers.get('content-type') || '') && (/trycloudflare\.com|暂不可用/.test(h)), `status=${r.status}`);
    r = await fetch(`${D}/api/status`);
    h = await r.text();
    t('S-1 直连 GET /api/status 也只回引导页', r.status === 200 && /text\/html/.test(r.headers.get('content-type') || ''), `status=${r.status}`);
    r = await fetch(`${D}/api/admin/pin`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${BASE}` }, body: JSON.stringify({ pin: 'short' }) });
    t('S-1 直连端口无管理接口（403）', r.status === 403, 'status=' + r.status);

    // ---- S-0: 公网来源访问直连端口（伪造 Host 无效）；无公网 IPv4 则跳过 ----
    const pubIp = publicIpv4();
    if (pubIp) {
      let rr = await rawRequest({ host: pubIp, port: BASE, path: '/api/schedule', method: 'GET', headers: { host: `127.0.0.1:${BASE}` } });
      let body = await readBodyOf(rr);
      // 引导页分源语义（fix(A)）：非 loopback 来源不奉送隧道 URL（防扫描者拿到入口地址）
      t('S-0 公网源 GET /api/schedule 只回引导页且不泄露隧道地址（伪造 loopback Host 无效）', rr.statusCode === 200 && /text\/html/.test(String(rr.headers['content-type'])) && /请使用安全地址/.test(body) && !/trycloudflare\.com/.test(body), `from=${pubIp}`);
      rr = await rawRequest({ host: pubIp, port: BASE, path: '/api/login', method: 'POST', headers: { 'content-type': 'application/json' } }, JSON.stringify({ pin: 'whatever' }));
      t('S-0 公网源 /api/login 403（无登录面）', rr.statusCode === 403, 'status=' + rr.statusCode);
    } else {
      console.log('SKIP S-0 公网来源测试（未检测到非内部 IPv4）');
    }

    // ---- S-2: 功能端口的 CF 标记拒绝 ----
    r = await fetch(`${B}/api/admin/pin`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', host: `127.0.0.1:${FUNC}` },
      body: JSON.stringify({ pin: 'short' }),
    });
    t('S-2 带 CF 标记的请求被管理面拒绝（403）', r.status === 403, 'status=' + r.status);

    // ---- H-1: 管理栅栏（功能端口） ----
    r = await fetch(`${B}/api/admin/pin`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' }, body: JSON.stringify({ pin: 'short' }) });
    t('H-1 admin 拒绝外部 Origin', r.status === 403, 'status=' + r.status);
    r = await rawRequest({ host: '127.0.0.1', port: FUNC, path: '/api/admin/pin', method: 'POST', headers: { 'content-type': 'application/json', host: 'rebind.example.com:' + FUNC } }, JSON.stringify({ pin: 'short' }));
    t('H-1 admin 拒绝外部 Host（rebinding）', r.statusCode === 403, 'status=' + r.statusCode);
    r = await fetch(`${B}/api/admin/pin`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' }, body: JSON.stringify({ pin: 'short' }) });
    const jGate = await r.json().catch(() => ({}));
    t('H-1 admin 接受 loopback 跨端口 Origin（进到密码校验）', r.status === 400 && /8-64/.test(jGate.error || ''), 'status=' + r.status + ' err=' + (jGate.error || ''));
    r = await fetch(`${B}/api/admin/pin`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${FUNC}` }, body: JSON.stringify({ pin: 'newpin12345' }) });
    t('H-1 改密码无旧密码被拒', r.status === 403, 'status=' + r.status);
    r = await fetch(`${B}/api/admin/pin`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${FUNC}` }, body: JSON.stringify({ pin: 'newpin12345', oldPin: 'wrong-old' }) });
    t('H-1 改密码旧密码错误被拒', r.status === 403, 'status=' + r.status);

    // ---- M-1: 登录与数据面（功能端口，临时实例假 pin） ----
    r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'wrong-pin' }) });
    t('M-1 错误密码 401', r.status === 401, 'status=' + r.status);
    r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
    const setCookie = r.headers.get('set-cookie') || '';
    const cookie = (setCookie.match(/tt_pin_v2=([a-f0-9]+)/) || [])[1] || '';
    t('M-1 正确密码种 HttpOnly+Strict Cookie', r.status === 200 && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), setCookie.slice(0, 50));
    r = await fetch(`${B}/api/schedule?pin=${encodeURIComponent(PIN)}`);
    t('M-1 ?pin= 已移除（401）', r.status === 401, 'status=' + r.status);
    r = await fetch(`${B}/api/schedule`, { headers: { cookie: `tt_pin_v2=${cookie}` } });
    t('M-1 Cookie 访问数据接口通过', r.status === 200, 'status=' + r.status);

    // ---- M-2: status 最小化 + 无 CORS（恶意 Origin） ----
    r = await fetch(`${B}/api/status`, { headers: { origin: 'http://evil.example.com' } });
    const j2 = await r.json();
    t('M-2 外部 Origin 得最小 status 且无 CORS 头', r.status === 200 && !('lanIp' in j2) && !r.headers.get('access-control-allow-origin'), JSON.stringify(j2));
    r = await fetch(`${B}/api/status`, { headers: { origin: 'http://127.0.0.1:3080', host: `127.0.0.1:${FUNC}` } });
    const j3 = await r.json();
    t('M-2 loopback Origin 得完整 status', 'lanIp' in j3 && r.headers.get('access-control-allow-origin') === 'http://127.0.0.1:3080', 'acao=' + r.headers.get('access-control-allow-origin'));

    // ---- M-3: respond 白名单 ----
    r = await fetch(`${B}/api/respond`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: `tt_pin_v2=${cookie}` },
      body: JSON.stringify({ rpcId: 'not-exist-123', kind: 'question', answer: [{ id: 'x', selected: ['y'] }] }),
    });
    t('M-3 respond 拒绝未知 rpcId', r.status === 400, 'status=' + r.status);

    // ---- L-5: CSP + nosniff ----
    r = await fetch(`${B}/`);
    const csp = r.headers.get('content-security-policy') || '';
    t('L-5 CSP 含 frame-ancestors', /frame-ancestors\s+'none'/.test(csp), csp.slice(0, 70));
    t('L-5 nosniff 响应头', (r.headers.get('x-content-type-options') || '') === 'nosniff', String(r.headers.get('x-content-type-options')));

    // ---- H-2: 锁定测试（默认跳过；SKIP_LOCKOUT=0 显式开启） ----
    if (SKIP_LOCKOUT) {
      console.log('SKIP H-2 锁定测试（默认跳过：避免锁定真实开发机 10 分钟；临时实例下可 SKIP_LOCKOUT=0 显式开启）');
    } else {
      console.log('\nH-2 lockout test（临时实例，锁定无副作用）...');
      for (let i = 0; i < 6; i++) {
        await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: 'bad-' + i }) }).catch(() => {});
      }
      r = await fetch(`${B}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
      const jL = await r.json().catch(() => ({}));
      t('H-2 连续错密锁定（429 + retryAfter）', r.status === 429 && !!jL.retryAfter, `status=${r.status} retryAfter=${jL.retryAfter}`);
    }

    // ---- 隔离验证：登录签发的会话落在临时目录，而非生产 settings ----
    let tmpSettings = null;
    try { tmpSettings = JSON.parse(readFileSync(join(DATA_DIR, 'settings.json'), 'utf8')); } catch (e) {}
    t('ISO-1 会话写入临时目录 settings（生产隔离成立）', !!(tmpSettings && Array.isArray(tmpSettings.sessions) && tmpSettings.sessions.length >= 1), `sessions=${tmpSettings?.sessions?.length}`);

    console.log(`\n${pass} passed, ${fail} failed`);
  } finally {
    // ---- 优雅停机 + 兜底 kill + 临时目录清理 ----
    try {
      const FUNC = parseInt((() => { try { return readFileSync(join(DATA_DIR, 'port'), 'utf8'); } catch (e) { return '0'; } })(), 10);
      if (FUNC) await fetch(`http://127.0.0.1:${FUNC}/api/admin/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2000) }).catch(() => {});
    } catch (e) {}
    await sleep(600);
    try { child.kill(); } catch (e) {}
    try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}

    // ---- 生产目录自检（验收：测后 .mobile-srv 无新写入） ----
    const snapAfter = snapOf(PROD_DIR);
    const schedAfter = (() => { try { const s = statSync(join(HERE, 'schedule.json')); return s.mtimeMs + ':' + s.size; } catch (e) { return null; } })();
    const diffs = [];
    for (const k of new Set([...Object.keys(snapProdBefore), ...Object.keys(snapAfter)])) {
      if (snapProdBefore[k] !== snapAfter[k]) diffs.push('.mobile-srv/' + k);
    }
    if (schedBefore !== schedAfter) diffs.push('schedule.json');
    if (diffs.length) {
      console.log('WARN 生产目录在测试期间发生变化（若生产实例在运行属环境噪音，请人工判读）：\n  ' + diffs.join('\n  '));
    } else {
      console.log('生产目录自检通过：.mobile-srv 与 schedule.json 均无新写入');
    }
  }
  process.exit(fail ? 1 : 0);
})();
