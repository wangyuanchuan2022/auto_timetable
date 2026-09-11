// server-routes-test.mjs — server-routes.mjs 纯逻辑层单测（F-2：限流桶 / pin 会话 / checkPin /
// clientIpOf / CORS / 直连引导页 / 杂项纯函数）。直接 import 无副作用（仅一个 unref 清理定时器）。
// 用法：node .qrtest/server-routes-test.mjs
import {
  RATE, rateState, rateFail, rateLocked, rateClear, globalHoldSeconds,
  pinIsSet, hashPin, verifyPinSync, issueSession, touchSession, pruneSessions,
  checkPin, guardPin, clientIpOf, corsHeaders, directNoticePage,
  parseCookies, isLoopbackHostname, isLoopbackAddr, isPurgeableEvent,
  buildPlanItems,
  COOKIE_NAME, SESSION_MAX, SESSION_TTL,
} from '../server-routes.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' | ' + extra : '')); }
};
const section = (n) => console.log('\n' + n);

const resetRate = () => { RATE.hits.clear(); RATE.globalFails = 0; RATE.globalResetAt = 0; RATE.globalHoldUntil = 0; };
const mkReq = (o = {}) => ({
  method: o.method || 'GET', url: o.url || '/api/schedule',
  headers: o.headers || {},
  socket: { remoteAddress: o.ra ?? '127.0.0.1' },
  __viaTunnel: o.tunnel,
  on() {}, destroy() {},
});
const mkRes = () => {
  const r = { status: null, headers: {}, body: '',
    writeHead(s, h) { r.status = s; r.headers = h || {}; return r; },
    end(b) { r.body = String(b ?? ''); return r; } };
  return r;
};

// ========== A. 限流桶（单 IP 指数升级 + 全局慢速闸） ==========
section('A) 限流桶');
resetRate();
check('A1 全新 IP：count/locked/strikes 归零', (() => { const r = rateState('ip-a'); return r.count === 0 && r.lockedUntil === 0 && r.strikes === 0; })());
check('A2 同 IP 复用同一桶对象', rateState('ip-a') === rateState('ip-a'));
rateFail('ip-a'); rateFail('ip-a'); rateFail('ip-a'); rateFail('ip-a');
check('A3 60 秒窗口内 4 次失败：不锁定', rateLocked('ip-a') === 0);
rateFail('ip-a');
const lock1 = rateLocked('ip-a');
check('A4 第 5 次失败触发锁定（10 分钟起步）', lock1 > 500 && lock1 <= 600, `lock=${lock1}s`);
rateClear('ip-a');
check('A5 rateClear 清桶（锁定解除、桶删除）', (() => { const has = RATE.hits.has('ip-a'); const locked = rateLocked('ip-a'); return locked === 0 && !has; })());
resetRate();
for (let i = 0; i < 5; i++) rateFail('ip-b');
for (let i = 0; i < 5; i++) rateFail('ip-b');
const lock2 = rateLocked('ip-b');
check('A6 指数升级：二连触限 → 20 分钟档', lock2 > 1100 && lock2 <= 1200, `lock=${lock2}s`);
resetRate();
rateState('ip-cap').strikes = 29;
for (let i = 0; i < 5; i++) rateFail('ip-cap');
const lockCap = rateLocked('ip-cap');
check('A7 锁定封顶 24 小时', lockCap > 80000 && lockCap <= 86400, `lock=${lockCap}s`);
resetRate();
check('A8 全局闸初始关闭', globalHoldSeconds() === 0);
for (let g = 0; g < 8; g++) for (let i = 0; i < 4; i++) rateFail('g-' + g); // 8 IP × 4 次 = 32 ≥ 30（单 IP 不触锁）
const hold = globalHoldSeconds();
check('A9 全局慢速闸：60 秒内全网 30 次失败 → 暂缓 60 秒', hold > 0 && hold <= 60, `hold=${hold}s`);
resetRate();
rateFail('ip-x');
check('A10 桶按 IP 隔离', rateLocked('ip-x') === 0 && rateLocked('ip-y') === 0);

// ========== B. pin 与会话 ==========
section('B) pin / 会话');
const PIN = 'unit-test-pin-42';
const hashed = hashPin(PIN);
// 注：pinIsSet(undefined) 会抛 TypeError（server-routes.mjs L136 无入参防护）——已按会议纪律上报产品 bug，不在测试中断言
check('B1 pinIsSet：pinHash / 旧明文两形态均视为已设，空对象未设', pinIsSet({ pinHash: hashed }) && pinIsSet({ pin: 'legacy' }) && !pinIsSet({}));
check('B2 hashPin：salt 32 hex + hash 64 hex，不含明文', /^[0-9a-f]{32}$/.test(hashed.salt) && /^[0-9a-f]{64}$/.test(hashed.hash) && !hashed.hash.includes(PIN));
check('B3 verifyPinSync：正确通过 / 错误拒绝 / 空拒绝', verifyPinSync(PIN, { pinHash: hashed }) === true && verifyPinSync('wrong', { pinHash: hashed }) === false && verifyPinSync('', { pinHash: hashed }) === false);
check('B4 verifyPinSync 旧明文形态兼容（时序安全比对）', verifyPinSync('legacy', { pin: 'legacy' }) === true && verifyPinSync('nope', { pin: 'legacy' }) === false);
const st = { sessions: [] };
const t1 = issueSession(st);
const t2 = issueSession(st);
check('B5 issueSession：64 hex token、两次不同、入列', /^[0-9a-f]{64}$/.test(t1) && t1 !== t2 && st.sessions.length === 2);
const before = Date.now();
st.sessions[0].lastSeen = before - 5000;
check('B6 touchSession 命中并滚动 lastSeen', touchSession(st, st.sessions[0].token) === true && st.sessions[0].lastSeen > before - 1000);
check('B7 touchSession：未知 token / 空 token / 过期 token 均拒绝',
  touchSession(st, 'bogus') === false && touchSession(st, '') === false
  && (() => { st.sessions.push({ token: 'expired', createdAt: 1, lastSeen: 1 }); return touchSession(st, 'expired') === false; })());
const NOWMS = Date.now();
const st21 = { sessions: Array.from({ length: SESSION_MAX + 1 }, (_, i) => ({ token: 't' + i, createdAt: NOWMS - (SESSION_MAX + 1 - i) * 1000, lastSeen: NOWMS - (SESSION_MAX + 1 - i) * 1000 })) };
const pruned = pruneSessions(st21);
check('B8 pruneSessions：超上限砍最旧、保最新 20', pruned.length === SESSION_MAX && !pruned.some((s) => s.token === 't0') && pruned.some((s) => s.token === 't' + SESSION_MAX));
check('B9 SESSION_TTL 为 30 天滚动窗口', SESSION_TTL === 30 * 24 * 3600e3);

// ========== C. checkPin / guardPin ==========
section('C) checkPin / guardPin');
const lbHeaders = { host: '127.0.0.1:39191' };
check('C1 无 pin fail-closed：loopback 可信请求放行（面板设密码场景）', checkPin(mkReq({ headers: lbHeaders }), {}).ok === true);
check('C2 无 pin fail-closed：非 loopback 一律 503 引导先设密码', (() => { const r = checkPin(mkReq({ ra: '203.0.113.5', headers: lbHeaders }), {}); return r.ok === false && r.status === 503; })());
check('C3 无 pin + 伪造 CF 标记：loopback 也不给管理面语义（503）', (() => { const r = checkPin(mkReq({ headers: { host: '127.0.0.1:39191', 'cf-connecting-ip': '203.0.113.9' } }), {}); return r.ok === false && r.status === 503; })());
const PINSET = { pinHash: hashed, sessions: [] };
check('C4 X-TT-Pin 头正确 → 放行', checkPin(mkReq({ headers: { ...lbHeaders, 'x-tt-pin': PIN } }), PINSET).ok === true);
resetRate();
const badIp = '198.51.100.23';
const mkBad = () => mkReq({ ra: badIp, headers: { ...lbHeaders, 'x-tt-pin': 'wrong-pin' } });
let saw401 = 0, saw429 = null;
for (let i = 0; i < 5; i++) { const r = checkPin(mkBad(), PINSET); if (r.status === 401) saw401++; if (r.status === 429) saw429 = r; }
check('C5 错误凭据：前 4 次 401、第 5 次 429+retryAfter', saw401 === 4 && !!saw429 && saw429.retryAfter > 0, `401×${saw401} 429=${JSON.stringify(saw429)}`);
check('C6 锁定期间正确密码仍放行（闸门只拦失败者）且成功即清桶',
  (() => { const r = checkPin(mkReq({ ra: badIp, headers: { ...lbHeaders, 'x-tt-pin': PIN } }), PINSET); return r.ok === true && rateLocked(badIp) === 0; })());
const tokenC = issueSession(PINSET);
check('C7 Cookie 会话 token 放行（touchSession 路径）', checkPin(mkReq({ headers: { ...lbHeaders, cookie: `${COOKIE_NAME}=${tokenC}` } }), PINSET).ok === true);
resetRate();
const resFail = mkRes();
check('C8 guardPin 失败：写 JSON 响应并返回 false', guardPin(mkReq({ ra: '203.0.113.77', headers: { ...lbHeaders, 'x-tt-pin': 'bad' } }), resFail, PINSET) === false && resFail.status === 401 && resFail.body.includes('pin required'));
const resOk = mkRes();
check('C9 guardPin 成功：返回 true 且不写响应', guardPin(mkReq({ headers: { ...lbHeaders, 'x-tt-pin': PIN } }), resOk, PINSET) === true && resOk.status === null);
// 回归防护（2026-08-31 线上事故）：旧版确定性 Cookie 在会话 token 升级后失效，
// 手机页自动请求（日程/watch/4s 轮询）带旧 Cookie 刷满失败阈值 → 用户首次密码登录被 429 堵死。
// 修复语义：无效 Cookie / 无凭据 ≠ 密码尝试，不计数不锁定。
resetRate();
const legacyIp = '198.51.100.99';
const mkLegacyCookie = () => mkReq({ ra: legacyIp, headers: { ...lbHeaders, cookie: `${COOKIE_NAME}=deadbeef${'0'.repeat(56)}` } }); // 旧确定性形态 hex
let legacy401 = 0;
for (let i = 0; i < 12; i++) { const r = checkPin(mkLegacyCookie(), PINSET); if (r.status === 401) legacy401++; }
check('C10 无效 Cookie 连打 12 次仍全 401、不触发锁定（残留凭据≠密码尝试）', legacy401 === 12 && rateLocked(legacyIp) === 0, `401×${legacy401} locked=${rateLocked(legacyIp)}`);
check('C11 无效 Cookie 风暴后，同 IP 正确密码仍立即放行', checkPin(mkReq({ ra: legacyIp, headers: { ...lbHeaders, 'x-tt-pin': PIN } }), PINSET).ok === true);
resetRate();
let anon401 = 0;
for (let i = 0; i < 10; i++) { const r = checkPin(mkReq({ ra: legacyIp, headers: { ...lbHeaders } }), PINSET); if (r.status === 401) anon401++; }
check('C12 无凭据请求 ×10 全 401、不计数（不构成密码爆破）', anon401 === 10 && rateLocked(legacyIp) === 0);

// ========== D. clientIpOf（直连 socket / 隧道 cf 头 / tunnel-unknown） ==========
section('D) clientIpOf');
check('D1 直连：socket 对端地址', clientIpOf(mkReq({ ra: '127.0.0.1' })) === '127.0.0.1');
check('D2 直连：IPv6 映射 IPv4 归一化', clientIpOf(mkReq({ ra: '::ffff:192.168.1.5' })) === '192.168.1.5');
check('D3 直连：伪造 cf 头不采信（防换 IP 绕过锁定）', clientIpOf(mkReq({ ra: '10.1.2.3', headers: { 'cf-connecting-ip': '1.2.3.4' } })) === '10.1.2.3');
check('D4 隧道：cf-connecting-ip 可信', clientIpOf(mkReq({ ra: '127.0.0.1', tunnel: true, headers: { 'cf-connecting-ip': '203.0.113.7' } })) === '203.0.113.7');
check('D5 隧道：无 cf 头落 tunnel-unknown 桶', clientIpOf(mkReq({ ra: '127.0.0.1', tunnel: true, headers: {} })) === 'tunnel-unknown');
check('D6 隧道：非法 cf 串同样落 tunnel-unknown', clientIpOf(mkReq({ ra: '127.0.0.1', tunnel: true, headers: { 'cf-connecting-ip': 'garbage!' } })) === 'tunnel-unknown');

// ========== E. corsHeaders ==========
section('E) corsHeaders');
const h3080 = corsHeaders(mkReq({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:39191' } }));
check('E1 loopback Origin：回显 ACAO + vary', h3080['access-control-allow-origin'] === 'http://127.0.0.1:3080' && h3080.vary === 'origin');
check('E2 异源 Origin：不给 CORS 头', Object.keys(corsHeaders(mkReq({ headers: { origin: 'http://evil.example.com', host: '127.0.0.1:39191' } }))).length === 0);
const same = corsHeaders(mkReq({ headers: { origin: 'http://192.168.1.5:3190', host: '192.168.1.5:3190' } }));
check('E3 同源 Origin：回显', same['access-control-allow-origin'] === 'http://192.168.1.5:3190');
check('E4 无 Origin / 畸形 Origin：不给', Object.keys(corsHeaders(mkReq({ headers: {} }))).length === 0 && Object.keys(corsHeaders(mkReq({ headers: { origin: 'http://' } }))).length === 0);
check('E5 localhost 主机名同样放行', corsHeaders(mkReq({ headers: { origin: 'http://localhost:3190', host: '127.0.0.1:39191' } }))['access-control-allow-origin'] === 'http://localhost:3190');

// ========== F. directNoticePage（直连引导页模板） ==========
section('F) directNoticePage');
const TURL = 'https://tt-unit-test.trycloudflare.com';
const pgLb = directNoticePage(mkReq({ ra: '127.0.0.1' }), TURL);
check('F1 loopback + 隧道地址：展示 URL 链接 + 3 秒 refresh', pgLb.includes(`href="${TURL}"`) && pgLb.includes(`url=${TURL}`));
const pgPub = directNoticePage(mkReq({ ra: '203.0.113.5' }), TURL);
check('F2 公网来源：不奉送入口 URL（无链接无 refresh）', !pgPub.includes(TURL) && !pgPub.includes('refresh'));
check('F3 loopback + 隧道未就绪：提示暂不可用', directNoticePage(mkReq({ ra: '127.0.0.1' }), null).includes('暂不可用'));
check('F4 公网 + 隧道未就绪：通用引导文案', (() => { const p = directNoticePage(mkReq({ ra: '8.8.4.4' }), null); return !p.includes('trycloudflare') && p.includes('请联系管理员'); })());
check('F5 tunnelUrl HTML 转义（防注入）', (() => { const p = directNoticePage(mkReq({ ra: '127.0.0.1' }), 'https://x/<script>alert(1)</script>'); return !p.includes('<script>') && p.includes('&lt;script&gt;'); })());

// ========== G. 杂项纯函数 ==========
section('G) 杂项');
check('G1 parseCookies：多值 / 空 / undefined', (() => { const c = parseCookies('a=1; b=2'); return c.a === '1' && c.b === '2' && Object.keys(parseCookies('')).length === 0 && Object.keys(parseCookies(undefined)).length === 0; })());
check('G2 isLoopbackHostname：localhost/[::1]/127.x 真，越界与私网假',
  isLoopbackHostname('localhost') && isLoopbackHostname('[::1]') && isLoopbackHostname('127.0.0.1')
  && !isLoopbackHostname('127.0.0.999') && !isLoopbackHostname('10.0.0.1'));
check('G3 isLoopbackAddr：IPv4 / IPv6 / IPv4-mapped', isLoopbackAddr('127.0.0.1') && isLoopbackAddr('::1') && isLoopbackAddr('::ffff:127.0.0.1') && !isLoopbackAddr('8.8.8.8'));
check('G4 isPurgeableEvent：deadline / once date / custom until 三来源', (() => {
  const cutoff = '2026-06-01';
  return isPurgeableEvent({ deadline: '2026-01-01' }, cutoff) === true
    && isPurgeableEvent({ type: 'once', date: '2026-01-15' }, cutoff) === true
    && isPurgeableEvent({ type: 'custom', repeat: { until: '2026-02-01' } }, cutoff) === true
    && isPurgeableEvent({ type: 'weekly', weekday: 1 }, cutoff) === false;
})());
check('G5 COOKIE_NAME 为 v2 会话 Cookie', COOKIE_NAME === 'tt_pin_v2');

// ========== H. POST /api/worktable/write 兼容路由（dispatcher 级端到端） ==========
// 背景：schedule.html 固定 POST /api/worktable/write 保存——在 mobile-server 源打开时由此
// 路由承接。安全契约：body.path 一律忽略（防「任意路径写入」端点暴露公网隧道）、guardPin
// 鉴权、校验/原子写与 POST /api/schedule 完全同一管线。
section('H) /api/worktable/write 兼容路由');
{
  const { createRouteDispatcher } = await import('../server-routes.mjs');
  const TTOccur = (await import('../occur.js')).default;
  const FAKE_SCHEDULE_PATH = 'S:/fake-unit/schedule.json';
  const writes = [];
  const noop = () => {};
  const dispatch = createRouteDispatcher({
    port: 39191, viaTunnel: true,
    HERE: 'S:/fake-unit', MOBILE_HTML_PATH: 'S:/fake-unit/mobile.html',
    SCHEDULE_PATH: FAKE_SCHEDULE_PATH, OCCUR_JS_PATH: 'S:/fake-unit/occur.js',
    MOBILE_APP_JS_PATH: 'S:/fake-unit/mobile-app.js',
    loadSettings: async () => ({ pinHash: hashed, sessions: [] }),
    saveSettings: noop, getTunnelUrl: () => null, getTunnelPort: () => null,
    selectLanIPv4: () => null, chatBusy: () => false,
    ensureChatSession: noop, chatWithDsh: noop,
    resetChatSession: noop, dshRpc: noop, DSH_API: 'http://127.0.0.1:3080',
    buildChatContent: () => ({}), MUX: {},
    watchSessionStream: noop, sseKeepalive: noop, sseAdmit: () => true,
    webpush: null, ensureVapid: noop, loadSubs: () => [], saveSubs: noop, safePushEndpoint: noop,
    atomicWriteFile: async (p, c) => { writes.push({ path: p, content: c }); },
    TTOccur,
  });
  const mkPostReq = (url, headers, body) => {
    const ls = {};
    const req = {
      method: 'POST', url, headers,
      socket: { remoteAddress: '127.0.0.1' },
      on(ev, fn) { (ls[ev] ||= []).push(fn); return req; },
      destroy() {},
    };
    process.nextTick(() => {
      (ls.data || []).forEach((f) => f(Buffer.from(body)));
      (ls.end || []).forEach((f) => f());
    });
    return req;
  };
  const post = async (url, headers, body) => {
    const res = mkRes();
    await dispatch(mkPostReq(url, headers, body), res);
    return res;
  };
  const lbPin = { host: '127.0.0.1:39191', 'x-tt-pin': PIN, 'content-type': 'application/json' };
  const validDoc = JSON.stringify({ meta: { title: 'unit' }, events: [
    { type: 'once', id: 'e1', title: '测试', start: '08:00', end: '09:00', date: '2026-09-01', deadline: '2026-09-01' },
  ] });

  resetRate();
  const r1 = await post('/api/worktable/write', { host: '127.0.0.1:39191', 'content-type': 'application/json' }, JSON.stringify({ path: 'x', content: validDoc }));
  check('H1 无凭据：401 且不写盘', r1.status === 401 && writes.length === 0, `status=${r1.status}`);

  const r2 = await post('/api/worktable/write', lbPin, JSON.stringify({ path: 'C:/Windows/Temp/evil.json', content: validDoc }));
  check('H2 body.path 被忽略：只写 SCHEDULE_PATH、不落攻击者路径',
    r2.status === 200 && writes.length === 1 && writes[0].path === FAKE_SCHEDULE_PATH
    && writes[0].content === validDoc && !writes.some((w) => w.path.includes('evil')),
    `status=${r2.status} writes=${JSON.stringify(writes.map((w) => w.path))}`);

  const badDoc = JSON.stringify({ events: [{ type: 'custom', id: 'x', title: '无repeat', start: '08:00', end: '09:00' }] });
  writes.length = 0;
  const r3 = await post('/api/worktable/write', lbPin, JSON.stringify({ path: 'x', content: badDoc }));
  check('H3 结构错误：400 明细且不写盘', r3.status === 400 && JSON.parse(r3.body).problems?.length > 0 && writes.length === 0, `status=${r3.status}`);

  writes.length = 0;
  const r4 = await post('/api/worktable/write', lbPin, JSON.stringify({ path: 'x', content: 'not-json{{{', }));
  check('H4 非法 JSON：400 invalid schedule', r4.status === 400 && JSON.parse(r4.body).error === 'invalid schedule', `status=${r4.status}`);

  const r5 = await post('/api/worktable/write', lbPin, JSON.stringify({ path: 'x' }));
  check('H5 缺 content：400 missing content', r5.status === 400 && JSON.parse(r5.body).error === 'missing content', `status=${r5.status}`);

  writes.length = 0;
  const r6 = await post('/api/schedule', lbPin, JSON.stringify({ content: validDoc }));
  check('H6 POST /api/schedule 回归：共用管线仍 200 且写同一目标',
    r6.status === 200 && writes.length === 1 && writes[0].path === FAKE_SCHEDULE_PATH && writes[0].content === validDoc,
    `status=${r6.status} writes=${writes.length}`);
}

// ========== I. buildPlanItems + GET /api/plan（APP 课前提醒数据源） ==========
section('I) /api/plan 课前提醒计划');
{
  const now = new Date(2026, 8, 15, 10, 0, 0); // 2026-09-15 10:00 本地时间（固定注入，不依赖真实时钟）
  const d = (offset) => {
    const x = new Date(2026, 8, 15 + offset);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  };
  const wd = ((new Date(2026, 8, 15).getDay() + 6) % 7) + 1; // 当日 ISO 星期（周一=1）
  const events = [
    { id: 'w1', type: 'weekly', title: '高数', weekday: wd, start: '14:00', end: '15:40', location: 'A101' }, // 今天命中（默认 lead 20）
    { id: 'o1', type: 'once', title: '英语', start: '08:00', end: '09:40', date: d(1), remindLead: 30 },       // 明天，lead 30
    { id: 't1', type: 'task', title: '大作业', deadline: d(3) },                                              // task 不参与时刻提醒
    { id: 'z1', type: 'once', title: '不提醒', start: '09:00', end: '10:00', date: d(2), remindLead: 0 },     // 显式 0 = 不提醒
    { id: 'x1', type: 'once', title: '跨午夜', start: '23:00', end: '01:00', date: d(1) },                    // end<start 与调度器同语义跳过
    { id: 'p1', type: 'once', title: '已过期', start: '08:00', end: '09:00', date: d(0) },                    // remindAt 07:40 已过
    { id: 's1', type: 'once', title: '停课', start: '10:30', end: '11:30', date: d(2), skip: [d(2)] },        // 例外日期
    { id: 'd1', type: 'once', title: '截止当日', start: '16:00', end: '17:00', date: d(1), deadline: d(1) },  // deadline 到期当日仍发生
  ];
  const items = buildPlanItems(events, now, 7);
  check('I1 weekly 今天命中：remindAt=14:00−20min（默认 lead）', items.some((it) =>
    it.key === `w1|${d(0)}|14:00` && it.lead === 20 && it.remindAt === new Date(2026, 8, 15, 13, 40).getTime() && it.location === 'A101'));
  check('I2 task 与 remindLead=0 不出现', !items.some((it) => it.key.startsWith('t1|') || it.key.startsWith('z1|')));
  check('I3 跨午夜(end<start) 与已过期提醒不返回', !items.some((it) => it.key.startsWith('x1|') || it.key.startsWith('p1|')));
  check('I4 skip 例外日期不提醒、deadline 到期当日仍提醒',
    !items.some((it) => it.key.startsWith('s1|')) && items.some((it) => it.key.startsWith('d1|')));
  check('I5 once lead=30：remindAt=07:30、body 完整', (() => {
    const it = items.find((x) => x.key === `o1|${d(1)}|08:00`);
    return !!it && it.remindAt === new Date(2026, 8, 16, 7, 30).getTime()
      && it.body.includes('英语') && it.body.includes('30 分钟后开始');
  })());
  check('I6 升序排列', items.every((it, i) => i === 0 || items[i - 1].remindAt <= it.remindAt));
  check('I7 days=1 截断：只含今天', buildPlanItems(events, now, 1).every((it) => it.date === d(0)));

  // dispatcher 级端到端：GET /api/plan（guardPin 鉴权 + days clamp）——临时课表文件走真实 readFile
  const { createRouteDispatcher } = await import('../server-routes.mjs');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmpPath = path.join(os.tmpdir(), 'tt-plan-test-schedule.json');
  await fs.writeFile(tmpPath, JSON.stringify({ events }), 'utf8');
  const noop = () => {};
  const dispatch = createRouteDispatcher({
    port: 39191, viaTunnel: true,
    HERE: 'S:/fake-unit', MOBILE_HTML_PATH: 'S:/fake-unit/mobile.html',
    SCHEDULE_PATH: tmpPath, OCCUR_JS_PATH: 'S:/fake-unit/occur.js',
    MOBILE_APP_JS_PATH: 'S:/fake-unit/mobile-app.js',
    loadSettings: async () => ({ pinHash: hashed, sessions: [] }),
    saveSettings: noop, getTunnelUrl: () => null, getTunnelPort: () => null,
    selectLanIPv4: () => null, chatBusy: () => false,
    ensureChatSession: noop, chatWithDsh: noop,
    resetChatSession: noop, dshRpc: noop, DSH_API: 'http://127.0.0.1:3080',
    buildChatContent: () => ({}), MUX: {},
    watchSessionStream: noop, sseKeepalive: noop, sseAdmit: () => true,
    webpush: null, ensureVapid: noop, loadSubs: () => [], saveSubs: noop, safePushEndpoint: noop,
    atomicWriteFile: noop, TTOccur: (await import('../occur.js')).default,
  });
  const get = async (url, headers) => {
    const res = mkRes();
    await dispatch(mkReq({ url, headers }), res);
    return res;
  };
  const res401 = await get('/api/plan', {});
  check('I8 无凭据 401', res401.status === 401, `status=${res401.status}`);
  const resOk = await get('/api/plan?days=99', { host: '127.0.0.1:39191', 'x-tt-pin': PIN });
  const j = JSON.parse(resOk.body);
  check('I9 有凭据 200：days clamp 到 14、items 升序非空', resOk.status === 200 && j.ok === true && j.days === 14
    && Array.isArray(j.items) && j.items.length > 0, `status=${resOk.status} days=${j && j.days} n=${j && j.items && j.items.length}`);
  await fs.rm(tmpPath, { force: true });
}

console.log(`\nserver-routes.mjs\n  通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
