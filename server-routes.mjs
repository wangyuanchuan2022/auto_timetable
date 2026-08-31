// server-routes.mjs — mobile-server 的路由分发与纯逻辑层（自 mobile-server.mjs 拆出）
//
// 分层约定：本模块只做「HTTP 路由分发 + 纯函数」，不监听端口、不启动 main()——
// 服务层（settings 读写 / DSH 对话桥 / Web Push / MUX 镜像 / watch 流）仍由
// mobile-server.mjs 组装，经 createRouteDispatcher(deps) 注入；纯逻辑（限流桶、
// pin 校验、loopback 判定、响应工具）可被单测直接 import，不产生副作用。
//
// 行为约定：路由链、响应头 / 状态码 / CSP / 直连端口收口逻辑与拆分前的
// mobile-server.mjs 内联版本完全一致（受控差异仅：chat 系 body 上限 12MB→32MB、
// 新增 /mobile-app.js 静态路由，均见注释）。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';

// ==================== 纯工具（无服务层依赖） ====================

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** loopback 地址判定（IPv4 / IPv6 / IPv4-mapped IPv6）。 */
export function isLoopbackAddr(ra) {
  const a = String(ra ?? '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** loopback 判定：/api/admin/* 与直连端口安全收口的网络层硬闸（见 trustedLocalRequest）。 */
export function isLoopback(req) {
  return isLoopbackAddr(req.socket.remoteAddress);
}

// 客户端真实 IP：
// · 直连端口（0.0.0.0:3190）：socket 对端地址即真实来源，**不采信任何转发头**
//   （cf-connecting-ip / x-forwarded-for 等可被任意客户端伪造，曾可借此换「新 IP」绕过限流锁定）。
// · 隧道端口（127.0.0.1:tunnelPort，仅 cloudflared 回连）：请求经 CF 边缘到达，
//   cf-connecting-ip 由边缘强制覆写、不可经隧道伪造 → 按真实访客 IP 计数。
//   本地进程直击隧道端口所带的伪造头会落入 'tunnel-unknown' 单独桶（无害）。
export function clientIpOf(req) {
  if (req.__viaTunnel) {
    const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(cf) || /^[0-9a-f:]+$/i.test(cf)) return cf;
    return 'tunnel-unknown';
  }
  let ip = String(req.socket.remoteAddress ?? '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv6 映射 IPv4 归一化，保证限流桶一致
  return ip || 'unknown';
}

/** CORS：仅对 loopback 来源或与 Host 同源的 Origin 回显（PC 面板跨端口访问）；其余不给 CORS 头。 */
export function corsHeaders(req) {
  const origin = String(req.headers.origin ?? '');
  if (!origin) return {};
  let o, h;
  try {
    o = new URL(origin);
    h = new URL(`http://${req.headers.host}`);
  } catch { return {}; }
  if (isLoopbackHostname(o.hostname) || o.host === h.host) {
    return { 'access-control-allow-origin': origin, vary: 'origin' };
  }
  return {};
}

/**
 * 本机管理栅栏（参照 dsh api-request-trust）：Host 必须是 loopback 权威，
 * sec-fetch-site 不得为 cross-site，Origin（若带）主机名须为 loopback 或与 Host 同权威
 * （允许 PC 面板 127.0.0.1:3080 跨端口访问 127.0.0.1:3190）。
 * 仅靠 remoteAddress=127.0.0.1 不足以防本机恶意网页与 DNS rebinding。
 */
export function trustedLocalRequest(req) {
  // 直连端口已全量收口（只回隧道地址引导页），管理接口只可能到达回连端口。
  // 经 cloudflared/CF 边缘转发的流量必然带边缘注入的 cf-connecting-ip / cf-ray
  // （隧道客户端既不可伪造也不可剥离）→ 一律不视为本机管理请求；无这些头的
  // 直连本机请求（面板 / curl）才继续走下面的头部纪律。
  // 本地恶意页面伪造 cf 头只会把自己排除出管理面（失败方向是安全的）。
  if (req.headers['cf-connecting-ip'] !== undefined || req.headers['cf-ray'] !== undefined) return false;
  // 网络层硬闸：连接必须真的来自本机回环。公网直连下 Host/Origin 头可被 curl 任意伪造
  // （curl 不发 sec-fetch-site / Origin，仅凭头部判定会放行「Host: 127.0.0.1」的远程请求）。
  if (!isLoopback(req)) return false;
  const host = String(req.headers.host ?? '');
  let hu;
  try { hu = new URL(`http://${host}`); } catch { return false; }
  if (!isLoopbackHostname(hu.hostname)) return false;
  const sfs = req.headers['sec-fetch-site'];
  if (sfs !== undefined && sfs !== 'same-origin' && sfs !== 'same-site' && sfs !== 'none') return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      const ou = new URL(origin);
      return isLoopbackHostname(ou.hostname) || ou.host === hu.host;
    } catch { return false; }
  }
  return true;
}

// ==================== 响应与请求体工具 ====================

/** send/sendJSON 返回 true 表示「响应已写完」——路由 handler 以此与「未命中」（return false）区分，
 *  分发器据此短路，避免穿透到 404 对已结束的响应二次写入。 */
export function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
  return true;
}
export function sendJSON(res, status, obj, extraHeaders = {}) {
  return send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
}
export function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ==================== pin / 会话（纯函数，settings 为参数对象） ====================

export const COOKIE_NAME = 'tt_pin_v2'; // HttpOnly 登录 Cookie（SameSite=Strict）：承载服务端随机会话 token（可吊销/登出）
export const SESSION_MAX = 20;                 // 会话 token 上限（登录时惰性清理，砍最旧）
export const SESSION_TTL = 30 * 24 * 3600e3;   // 会话 30 天滚动过期（lastSeen 起算）

/** 是否已设密码：新版存 pinHash（scrypt 加盐哈希），旧版遗留明文 pin 迁移期同样视为已设。 */
export function pinIsSet(settings) { return !!settings?.pinHash || !!settings?.pin; }

/** scrypt 加盐哈希（N=16384）：存 {salt,hash}（hex），明文不落盘。 */
export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(pin), salt, 32, { N: 16384 }).toString('hex');
  return { salt, hash };
}

/** 时序安全比对明文 pin 与存储形态（新 pinHash / 旧明文 pin 兼容迁移期）。所有比较统一走这里。 */
export function verifyPinSync(given, settings) {
  const g = String(given ?? '');
  if (!g) return false;
  if (settings.pinHash?.salt && settings.pinHash?.hash) {
    const calc = scryptSync(g, String(settings.pinHash.salt), 32, { N: 16384 });
    return timingSafeEqual(calc, Buffer.from(String(settings.pinHash.hash), 'hex'));
  }
  if (settings.pin) {
    const a = createHash('sha256').update(g).digest();
    const b = createHash('sha256').update(String(settings.pin)).digest();
    return timingSafeEqual(a, b);
  }
  return false;
}

/** 会话 token 惰性清理（登录时调用）：剔除过期、超上限砍最旧。 */
export function pruneSessions(settings) {
  const now = Date.now();
  let list = (Array.isArray(settings.sessions) ? settings.sessions : [])
    .filter((s) => s && typeof s.token === 'string' && now - (s.lastSeen || s.createdAt || 0) < SESSION_TTL);
  list.sort((a, b) => (a.lastSeen || a.createdAt || 0) - (b.lastSeen || b.createdAt || 0));
  if (list.length > SESSION_MAX) list = list.slice(list.length - SESSION_MAX);
  return list;
}
/** 签发新会话 token（调用方负责落盘）。 */
export function issueSession(settings) {
  const list = pruneSessions(settings);
  const token = randomBytes(32).toString('hex');
  list.push({ token, createdAt: Date.now(), lastSeen: Date.now() });
  settings.sessions = list;
  return token;
}
/** 按 token 验会话：命中且未过期 → 更新内存 lastSeen 并返回 true。
 *  lastSeen 只更新内存不逐请求落盘（30 天滚动窗口足够宽容，落盘时机=登录/登出/改密）。 */
export function touchSession(settings, token) {
  if (!token) return false;
  const s = (Array.isArray(settings.sessions) ? settings.sessions : [])
    .find((x) => x && typeof x.token === 'string' && x.token === token);
  if (!s) return false;
  if (Date.now() - (s.lastSeen || s.createdAt || 0) >= SESSION_TTL) return false;
  s.lastSeen = Date.now();
  return true;
}

// ==================== 限流桶（模块级单例：直连/隧道两端口共享同一进程内状态） ====================

/** 每 IP 密码尝试限速：60 秒窗口 5 次；连续触限指数升级锁定（10 分钟起，翻倍封顶 24 小时）。
 *  另设全局慢速闸（60 秒内全网合计 30 次失败 → 暂缓受理登录 60 秒）：端口直接暴露在
 *  公网 IP 上，攻击者可轮换来源 IP 绕过单 IP 桶，全局闸拖慢任何分布式爆破（不影响正确密码）。 */
export const RATE = { hits: new Map(), globalFails: 0, globalResetAt: 0, globalHoldUntil: 0 };
export function rateState(ip) {
  const now = Date.now();
  let r = RATE.hits.get(ip);
  if (!r || now > r.resetAt) { r = { count: 0, resetAt: now + 60_000, lockedUntil: 0, strikes: 0 }; RATE.hits.set(ip, r); }
  return r;
}
export function rateLocked(ip) {
  const r = rateState(ip);
  const now = Date.now();
  return r.lockedUntil > now ? Math.ceil((r.lockedUntil - now) / 1000) : 0;
}
export function globalHoldSeconds() {
  const now = Date.now();
  if (RATE.globalResetAt <= now) { RATE.globalFails = 0; RATE.globalResetAt = now + 60_000; }
  return RATE.globalHoldUntil > now ? Math.ceil((RATE.globalHoldUntil - now) / 1000) : 0;
}
export function rateFail(ip) {
  const r = rateState(ip);
  const now = Date.now();
  r.count += 1;
  if (RATE.globalResetAt <= now) { RATE.globalFails = 0; RATE.globalResetAt = now + 60_000; }
  RATE.globalFails += 1;
  if (RATE.globalFails >= 30) RATE.globalHoldUntil = now + 60_000; // 全局慢速闸触发
  if (r.count >= 5) {
    r.strikes += 1; // 指数升级：10min → 20min → 40min … 封顶 24h
    r.lockedUntil = now + Math.min(600_000 * 2 ** (r.strikes - 1), 24 * 3600_000);
    r.count = 0;
  }
}
export function rateClear(ip) { RATE.hits.delete(ip); }
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of RATE.hits) if (now > r.resetAt && now > r.lockedUntil) RATE.hits.delete(ip);
}, 60_000).unref();

/**
 * 校验请求凭据：登录 Cookie（HttpOnly，首选）或 X-TT-Pin 头（兼容）。
 * 已移除 ?pin= 查询参数（避免进入浏览器历史/日志）。失败计限速。
 * 返回 {ok:true} | {ok:false,status,retryAfter,error}。
 */
export function checkPin(req, settings) {
  // 未设密码 → fail-closed：仅本机可信请求（面板设密码等管理面）放行，其余功能一律 503 引导先设密码。
  if (!pinIsSet(settings)) {
    if (trustedLocalRequest(req)) return { ok: true };
    return { ok: false, status: 503, error: '请先在电脑端设置安全密码后再使用手机功能' };
  }
  // 先验凭据：已持有效 Cookie（会话 token）/密码的请求直接放行，不受闸门连坐。
  // （原先闸门在凭据校验之前：公网攻击者刷失败登录可持续触发全局慢速闸，
  //   把已登录的合法手机端一并拒掉——匿名 DoS。闸门只应拦「失败者」。）
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME] ?? '';
  const header = String(req.headers['x-tt-pin'] ?? '');
  let ok = false;
  if (token) ok = touchSession(settings, token);
  if (!ok && header) ok = verifyPinSync(header, settings); // 兼容头：明文 pin 与存储哈希时序安全比对
  if (ok) { rateClear(clientIpOf(req)); return { ok: true }; }
  // 凭据缺失/错误才走闸门：单 IP 锁定 → 全局慢速闸 → 计数
  const ip = clientIpOf(req);
  const retryAfter = rateLocked(ip);
  if (retryAfter > 0) return { ok: false, status: 429, retryAfter, error: `尝试次数过多，请 ${retryAfter} 秒后再试` };
  const hold = globalHoldSeconds();
  if (hold > 0) return { ok: false, status: 429, retryAfter: hold, error: `失败次数过多，服务暂缓受理登录，请 ${hold} 秒后再试` };
  rateFail(ip);
  const left = rateLocked(ip);
  if (left > 0) return { ok: false, status: 429, retryAfter: left, error: `密码错误次数过多，锁定 ${left} 秒` };
  return { ok: false, status: 401, error: 'pin required' };
}

/** 路由用守卫：失败时已写好响应并返回 false。 */
export function guardPin(req, res, settings, extraHeaders = {}) {
  const r = checkPin(req, settings);
  if (r.ok) return true;
  sendJSON(res, r.status, { ok: false, error: r.error }, {
    ...(r.retryAfter ? { 'retry-after': String(r.retryAfter) } : {}),
    ...extraHeaders,
  });
  return false;
}

// ==================== 直连端口引导页（模板纯函数，tunnelUrl 参数化） ====================

/**
 * 直连端口引导页（安全收口）：明文直连端口不提供任何功能，仅提示改走 HTTPS 隧道。
 * 隧道地址只对本机来源（PC 面板/本机浏览器换设备登录）展示；公网扫描者只见通用引导
 * 文案，不奉送入口 URL。
 */
export function directNoticePage(req, tunnelUrl) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const url = isLoopback(req) ? tunnelUrl : null;
  const body = url
    ? `<p>为提升安全性，本端口已停用明文直连服务。</p>
       <p class="url"><a href="${esc(url)}" rel="noopener">${esc(url)}</a></p>
       <p class="tip">3 秒后自动跳转到安全地址（全程 HTTPS；首次访问需输入访问密码）。</p>`
    : isLoopback(req)
      ? '<p>安全隧道暂不可用：请确认电脑端 cloudflared 正在运行，然后刷新本页。</p>'
      : `<p>为提升安全性，本端口已停用明文直连服务。</p>
         <p class="tip">请通过 HTTPS 安全地址访问；如需获取访问地址，请联系管理员。</p>`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${url ? `
<meta http-equiv="refresh" content="3;url=${esc(url)}">` : ''}
<title>智能时间表 · 请使用安全地址访问</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1216;color:#d6dce5;font:15px/1.7 system-ui,sans-serif}
main{max-width:560px;padding:32px 28px;background:#171b22;border:1px solid #2a3140;border-radius:14px;text-align:center}
h1{font-size:17px;margin:0 0 14px}.url a{color:#8ea2ff;font-size:16px;word-break:break-all;text-decoration:none}
.tip{color:#8b93a3;font-size:13px}</style></head>
<body><main><h1>🔒 请使用安全地址访问</h1>${body}</main></body></html>`;
}

// ==================== schedule 清除判定（纯函数） ====================

import TTOccur from './occur.js';

/** 清除判定：过期即失效（渲染/提醒立即停止），但数据保留——截止日期早于「今天往前推 3 个月」才清除。
 *  单一实现于 occur.js（isPurgeable，与 Python timetable_core 对拍一致），此处仅别名导出防双源漂移。 */
export const isPurgeableEvent = TTOccur.isPurgeable;

// ==================== 路由分发（服务层经 deps 注入） ====================

/** chat 系路由 body 上限：4×7MB base64 图片承诺 + 余量（原 12MB 会把多张大图整体拒掉）。 */
const CHAT_BODY_LIMIT = 32 * 1024 * 1024;

/**
 * 创建路由分发器（每个 server 实例一份；per-server 状态经 deps 注入）。
 * deps 契约（均由 mobile-server.mjs 提供）：
 *   port/viaTunnel；HERE/MOBILE_HTML_PATH/SCHEDULE_PATH/OCCUR_JS_PATH/MOBILE_APP_JS_PATH
 *   loadSettings/saveSettings；getTunnelUrl/getTunnelPort；selectLanIPv4；chatBusy()
 *   ensureChatSession/chatWithDsh/chatHistoryMessages/resetChatSession/dshRpc/DSH_API
 *   MUX/watchSessionStream/sseKeepalive/sseAdmit；buildChatContent
 *   webpush/ensureVapid/loadSubs/saveSubs/safePushEndpoint；atomicWriteFile；TTOccur
 *   （selectLanIPv4 传无参包装：内部已注入 networkInterfaces()）
 */
export function createRouteDispatcher(deps) {
  const {
    port, viaTunnel, HERE, MOBILE_HTML_PATH, SCHEDULE_PATH, OCCUR_JS_PATH, MOBILE_APP_JS_PATH,
    loadSettings, saveSettings, getTunnelUrl, getTunnelPort, selectLanIPv4, chatBusy,
    ensureChatSession, chatWithDsh, chatHistoryMessages, resetChatSession, dshRpc, DSH_API,
    buildChatContent,
    MUX, watchSessionStream, sseKeepalive, sseAdmit,
    webpush, ensureVapid, loadSubs, saveSubs, safePushEndpoint,
    atomicWriteFile, TTOccur,
  } = deps;

  // ---- 分组 handler：静态资源（页面 / sw / manifest / 图标 / 共享领域模块） ----
  async function handleStatic(req, res, pathname) {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/mobile.html' || pathname === '/index.html')) {
      const html = await readFile(MOBILE_HTML_PATH);
      return send(res, 200, html, {
        'content-type': 'text/html; charset=utf-8',
        // CSP：限制连接源为本站（防外泄），图片允许 data:/blob:（压缩预览）；拒绝被嵌入 iframe。
        // 脚本已全部外链（/occur.js + /mobile-app.js）→ script-src 只留 'self'（Y-1 收紧）；
        // style 的 'unsafe-inline' 为遗留（页面仍有内联样式），待样式外链化后再收。
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
      });
    }
    if (req.method === 'GET' && pathname === '/mobile-app.js') {
      // 手机页主脚本（自 mobile.html 内联抽离，行为零变化）
      const js = await readFile(MOBILE_APP_JS_PATH, 'utf8').catch(() => '');
      if (!js) return sendJSON(res, 404, { ok: false, error: 'mobile-app.js missing' });
      return send(res, 200, js, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
    }
    if (req.method === 'GET' && pathname === '/occur.js') {
      const js = await readFile(OCCUR_JS_PATH, 'utf8').catch(() => '');
      if (!js) return sendJSON(res, 404, { ok: false, error: 'occur.js missing' });
      return send(res, 200, js, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
    }
    if (req.method === 'GET' && pathname === '/sw.js') {
      const js = await readFile(join(HERE, 'sw.js'), 'utf8').catch(() => '');
      if (!js) return sendJSON(res, 404, { ok: false, error: 'sw.js missing' });
      return send(res, 200, js, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'service-worker-allowed': '/' });
    }
    if (req.method === 'GET' && pathname === '/manifest.webmanifest') {
      const m = await readFile(join(HERE, 'manifest.webmanifest'), 'utf8').catch(() => '');
      if (!m) return sendJSON(res, 404, { ok: false, error: 'manifest missing' });
      return send(res, 200, m, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' });
    }
    if (req.method === 'GET' && (pathname === '/icon-192.png' || pathname === '/icon-512.png')) {
      const png = await readFile(join(HERE, pathname.slice(1))).catch(() => null);
      if (!png) return sendJSON(res, 404, { ok: false, error: 'icon missing' });
      return send(res, 200, png, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
    }
    return false; // 未命中
  }

  // ---- 分组 handler：管理接口（本机栅栏 + 变更需旧密码） ----
  async function handleAdmin(req, res, pathname) {
    if (!pathname.startsWith('/api/admin/')) return false;
    if (!trustedLocalRequest(req)) return sendJSON(res, 403, { ok: false, error: 'admin endpoints accept trusted local requests only' }, corsHeaders(req));
    const settings = await loadSettings();
    if (req.method === 'POST' && pathname === '/api/admin/pin') {
      const body = JSON.parse(await readBody(req, 64 * 1024));
      const pin = String(body.pin ?? '');
      if (pin && !/^\S{8,64}$/.test(pin)) return sendJSON(res, 400, { ok: false, error: '密码需为 8-64 位、不含空格（公网直连暴露，建议长密码）' });
      // 已设密码时，设置/清除都必须先验证旧密码（防本机恶意页面篡改）；
      // 比对统一走 verifyPinSync（时序安全，兼容新旧存储形态）
      if (pinIsSet(settings)) {
        const oldOk = verifyPinSync(String(body.oldPin ?? ''), settings);
        if (!oldOk) return sendJSON(res, 403, { ok: false, error: '需要提供当前密码才能修改或清除' });
      }
      if (pin) {
        settings.pinHash = hashPin(pin); // 新密码：scrypt 加盐哈希落盘，明文不存本机
        delete settings.pin; // 旧明文形态（若有）随之退役
      } else { delete settings.pinHash; delete settings.pin; } // 空串 = 清除密码
      settings.sessions = []; // 改/清密码 → 吊销全部已签发会话 token
      await saveSettings(settings);
      console.log(`mobile-server: 安全密码已${pin ? '设置' : '清除'}（scrypt 哈希落盘，明文不存本机）`);
      return sendJSON(res, 200, { ok: true, pinSet: !!pin }, corsHeaders(req));
    }
    if (req.method === 'POST' && pathname === '/api/admin/shutdown') {
      // DSH 插件回收时调用（loopback 网络层栅栏保护）：优雅退出
      sendJSON(res, 200, { ok: true }, corsHeaders(req));
      setTimeout(() => {
        console.log('mobile-server: 收到 shutdown 请求，退出');
        process.exit(0);
      }, 100);
      return true;
    }
    return sendJSON(res, 404, { ok: false, error: 'not found' });
  }

  // ---- 分组 handler：认证（登录 / 登出） ----
  async function handleAuth(req, res, pathname, settings) {
    if (req.method === 'POST' && pathname === '/api/login') {
      const body = JSON.parse(await readBody(req, 16 * 1024));
      const given = String(body.pin ?? '');
      if (!pinIsSet(settings)) return sendJSON(res, 403, { ok: false, error: 'pin required' }); // 统一 403，不泄露「是否设置过密码」
      const ip = clientIpOf(req);
      const lock = rateLocked(ip);
      if (lock > 0) return sendJSON(res, 429, { ok: false, error: `尝试次数过多，请 ${lock} 秒后再试`, retryAfter: lock }, { 'retry-after': String(lock) });
      if (!given || !verifyPinSync(given, settings)) {
        // 全局慢速闸对登录失败同样生效（此前只在 checkPin 生效，/api/login 自身漏防分布式爆破）。
        // 正确密码在上面已验证通过并 return，不会走到这里，合法登录不受闸门影响。
        const hold = globalHoldSeconds();
        if (hold > 0) return sendJSON(res, 429, { ok: false, error: `失败次数过多，服务暂缓受理登录，请 ${hold} 秒后再试`, retryAfter: hold }, { 'retry-after': String(hold) });
        rateFail(ip);
        const left = rateLocked(ip);
        return sendJSON(res, left > 0 ? 429 : 401, { ok: false, error: left > 0 ? `密码错误次数过多，锁定 ${left} 秒` : '密码错误' , ...(left > 0 ? { retryAfter: left } : {}) }, left > 0 ? { 'retry-after': String(left) } : {});
      }
      rateClear(ip);
      // 兼容迁移：旧明文 pin 首次登录成功 → 就地改写为 scrypt 哈希，明文从此不再落盘
      if (settings.pin) { settings.pinHash = hashPin(settings.pin); delete settings.pin; }
      const token = issueSession(settings); // 随机会话 token：可登出/吊销（改密时全体吊销）
      await saveSettings(settings);
      return send(res, 200, JSON.stringify({ ok: true }), {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}${viaTunnel ? '; Secure' : ''}`,
      });
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      if (!guardPin(req, res, settings)) return true;
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME] ?? '';
      if (token) {
        settings.sessions = (Array.isArray(settings.sessions) ? settings.sessions : []).filter((s) => !s || s.token !== token);
        await saveSettings(settings);
      }
      return send(res, 200, JSON.stringify({ ok: true }), {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${viaTunnel ? '; Secure' : ''}`,
      });
    }
    return false;
  }

  // ---- 分组 handler：Web Push（公钥下发 / 订阅登记 / 取消订阅） ----
  async function handlePush(req, res, pathname, settings) {
    if (req.method === 'GET' && pathname === '/api/push/key') {
      if (!guardPin(req, res, settings)) return true;
      if (!webpush) return sendJSON(res, 503, { ok: false, error: '服务端未安装 web-push（npm i web-push）' });
      const vapid = await ensureVapid(settings);
      return sendJSON(res, 200, { ok: true, publicKey: vapid.publicKey });
    }
    if (req.method === 'POST' && pathname === '/api/push/subscribe') {
      if (!guardPin(req, res, settings)) return true;
      const body = JSON.parse(await readBody(req, 64 * 1024));
      if (!body?.subscription?.endpoint || !body.subscription?.keys?.p256dh) {
        return sendJSON(res, 400, { ok: false, error: 'invalid subscription' });
      }
      if (!safePushEndpoint(body.subscription.endpoint)) {
        return sendJSON(res, 400, { ok: false, error: 'push endpoint 必须为公网 https 地址（不接受 http / 内网 / loopback）' });
      }
      const subs = await loadSubs();
      if (!subs.some((s) => s.endpoint === body.subscription.endpoint)) {
        subs.push(body.subscription);
        await saveSubs(subs);
      }
      return sendJSON(res, 200, { ok: true, count: subs.length });
    }
    if (req.method === 'POST' && pathname === '/api/push/unsubscribe') {
      if (!guardPin(req, res, settings)) return true;
      const body = JSON.parse(await readBody(req, 64 * 1024));
      const subs = await loadSubs();
      const next = subs.filter((s) => s.endpoint !== body?.endpoint);
      if (next.length !== subs.length) await saveSubs(next);
      return sendJSON(res, 200, { ok: true });
    }
    return false;
  }

  // ---- 分组 handler：chat 系（对话 / 流式 / 镜像 / 模型 / 交互答复） ----
  async function handleChat(req, res, pathname, settings) {
    if (req.method === 'POST' && pathname === '/api/chat/stream') {
      if (!guardPin(req, res, settings)) return true;
      if (!sseAdmit(req, res)) return true;
      const body = JSON.parse(await readBody(req, CHAT_BODY_LIMIT)); // 32MB：对齐 4×7MB 图片承诺 + 余量
      const message = String(body.message ?? '').trim();
      const images = Array.isArray(body.images) ? body.images : [];
      if (!message && !images.length) return sendJSON(res, 400, { ok: false, error: 'missing message' });
      if (chatBusy()) return sendJSON(res, 429, { ok: false, error: 'DSH 正在处理上一条消息，请稍候' });
      try { buildChatContent(message, images); } catch (e) { return sendJSON(res, 400, { ok: false, error: String(e.message || e) }); }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let closed = false;
      req.on('close', () => { closed = true; });
      const send = (obj) => {
        if (closed) return;
        try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { closed = true; }
      };
      send({ t: 'open' });
      // 心跳：模型长时间思考无增量时，定期发 SSE 注释行防中间层空闲掐线
      const ka = sseKeepalive(req, res, () => closed, () => { closed = true; });
      chatWithDsh(message, images, (partial) => send({ t: 'partial', text: partial }))
        .then((r) => { clearInterval(ka); send({ t: 'done', reply: r.reply, timeout: !!r.timeout }); try { res.end(); } catch (e) {} })
        .catch((e) => { clearInterval(ka); send({ t: 'error', error: String(e?.message ?? e) }); try { res.end(); } catch (e2) {} });
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/chat/watch') {
      if (!guardPin(req, res, settings)) return true;
      if (!sseAdmit(req, res)) return true;
      const { sid } = await ensureChatSession(settings);
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let closed = false;
      const listener = { sid, send: null, acc: '', accR: '', closed: false };
      req.on('close', () => { closed = true; listener.closed = true; });
      const send = (obj) => { if (!closed) { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { closed = true; } } };
      listener.send = send;
      const ka = sseKeepalive(req, res, () => closed, () => { closed = true; });
      const stop = await watchSessionStream(sid, send, listener);
      const cleanup = () => { closed = true; listener.closed = true; clearInterval(ka); stop(); MUX.listeners.delete(listener); };
      req.on('close', cleanup);
      void closed;
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/chat/log') {
      if (!guardPin(req, res, settings)) return true;
      const { sid } = await ensureChatSession(settings);
      return sendJSON(res, 200, { ok: true, sessionId: sid, messages: await chatHistoryMessages(sid) });
    }
    if (req.method === 'GET' && pathname === '/api/chat/models') {
      if (!guardPin(req, res, settings)) return true;
      const { sid } = await ensureChatSession(settings);
      const v = await dshRpc('session.models', { sessionId: sid });
      return sendJSON(res, 200, { ok: true, current: v.current, groups: v.groups, failures: v.failures ?? [] });
    }
    if (req.method === 'POST' && pathname === '/api/chat/model') {
      if (!guardPin(req, res, settings)) return true;
      const body = JSON.parse(await readBody(req, 16 * 1024));
      const provider = String(body.provider ?? '');
      const model = String(body.model ?? '');
      if (!provider || !model) return sendJSON(res, 400, { ok: false, error: 'missing provider/model' });
      const sel = { provider, model };
      if (body.reasoningEffort) sel.reasoningEffort = String(body.reasoningEffort);
      const { sid } = await ensureChatSession(settings);
      await dshRpc('session.selectModel', { sessionId: sid, ...sel });
      settings.chatDefaultModel = sel; // 记为默认：纯文本消息不再被切走；带图消息仍会临时切视觉模型
      await saveSettings(settings);
      return sendJSON(res, 200, { ok: true, current: sel });
    }
    if (req.method === 'POST' && pathname === '/api/chat/cancel') {
      if (!guardPin(req, res, settings)) return true;
      const { sid } = await ensureChatSession(settings);
      await dshRpc('session.cancel', { sessionId: sid });
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/chat/reset') {
      if (!guardPin(req, res, settings)) return true;
      const old = settings.chatSessionId;
      if (chatBusy() && old) {
        try { await dshRpc('session.cancel', { sessionId: old }); } catch (e) { /* 尽力中止，失败不阻塞新建 */ }
      }
      const sid = await resetChatSession(settings); // 复用既有重建逻辑：session.create + 恢复默认模型 + 旧连接改绑通知
      return sendJSON(res, 200, { ok: true, sessionId: sid });
    }
    if (req.method === 'POST' && pathname === '/api/respond') {
      if (!guardPin(req, res, settings)) return true;
      const body = JSON.parse(await readBody(req, 256 * 1024));
      const rpcId = String(body.rpcId ?? '');
      const kind = body.kind === 'question' ? 'question' : 'approval';
      if (!rpcId) return sendJSON(res, 400, { ok: false, error: 'missing rpcId' });
      const { sid } = await ensureChatSession(settings);
      // M-3：rpcId 必须命中本会话暂存的交互请求；approvalId 以服务端记录为准，不采信客户端
      const pending = MUX.pending.get(rpcId);
      if (!pending || pending.sessionId !== sid) {
        return sendJSON(res, 400, { ok: false, error: '未知或已过期的请求' });
      }
      let value;
      if (kind === 'question') {
        // body.answer = [{id, selected:[label...], custom?}]；宿主契约：{sessionId, answer:{answers:[...]}}
        const validIds = new Set((pending.questions ?? []).map((q) => String(q.id)));
        const answers = (Array.isArray(body.answer) ? body.answer : [])
          .filter((it) => it && typeof it === 'object' && validIds.has(String(it.id)))
          .map((it) => ({
            id: String(it.id),
            selected: (Array.isArray(it.selected) ? it.selected : []).slice(0, 8).map((x) => String(x).slice(0, 120)),
            ...(typeof it.custom === 'string' && it.custom ? { custom: it.custom.slice(0, 500) } : {}),
          }));
        if (!answers.length) return sendJSON(res, 400, { ok: false, error: 'missing answer' });
        value = { sessionId: sid, answer: { answers } };
      } else {
        const outcome = body.outcome === 'allowed-once' ? 'allowed-once' : 'rejected';
        if (!pending.approvalId) return sendJSON(res, 400, { ok: false, error: 'pending approval missing approvalId' });
        value = { sessionId: sid, approvalId: String(pending.approvalId), outcome };
      }
      const host = await fetch(`${DSH_API}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
      });
      const receipt = await host.json().catch(() => null);
      if (host.ok) MUX.pending.delete(rpcId); // 已受理 → 不允许重复作答
      return sendJSON(res, host.ok ? 200 : 502, { ok: host.ok, receipt });
    }
    if (req.method === 'POST' && pathname === '/api/chat') {
      if (!guardPin(req, res, settings)) return true;
      const body = JSON.parse(await readBody(req, CHAT_BODY_LIMIT)); // 文本 + 图片（base64）；32MB 对齐图片承诺
      const message = String(body.message ?? '').trim();
      const images = Array.isArray(body.images) ? body.images : [];
      if (!message && !images.length) return sendJSON(res, 400, { ok: false, error: 'missing message' });
      if (chatBusy()) return sendJSON(res, 429, { ok: false, error: 'DSH 正在处理上一条消息，请稍候' });
      try { buildChatContent(message, images); }
      catch (e) { return sendJSON(res, 400, { ok: false, error: String(e.message || e) }); }
      const result = await chatWithDsh(message, images);
      return sendJSON(res, 200, { ok: true, reply: result.reply, timeout: !!result.timeout });
    }
    return false;
  }

  // ---- 分组 handler：schedule 读写 ----
  async function handleSchedule(req, res, pathname, settings) {
    if (req.method === 'GET' && pathname === '/api/schedule') {
      if (!guardPin(req, res, settings)) return true;
      const raw = await readFile(SCHEDULE_PATH, 'utf8');
      return sendJSON(res, 200, JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw));
    }
    if (req.method === 'POST' && pathname === '/api/schedule') {
      if (!guardPin(req, res, settings)) return true;
      const body = JSON.parse(await readBody(req));
      if (typeof body.content !== 'string') return sendJSON(res, 400, { ok: false, error: 'missing content' });
      const parsed = JSON.parse(body.content); // 必须是合法 JSON 才写盘
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
        return sendJSON(res, 400, { ok: false, error: 'invalid schedule' });
      }
      // P1-2 逐事件结构校验：存在结构性错误（如 custom 缺 repeat、日期格式非法）→ 400 返回明细，不写盘
      const problems = TTOccur.validateSchedule(parsed);
      if (problems.length) {
        return sendJSON(res, 400, { ok: false, error: '日程数据校验失败（未写盘）', problems });
      }
      await atomicWriteFile(SCHEDULE_PATH, body.content);
      return sendJSON(res, 200, { ok: true });
    }
    return false;
  }

  // ---- 分组 handler：状态接口（完整信息只给本机可信请求） ----
  async function handleStatus(req, res, pathname, settings) {
    if (req.method === 'GET' && pathname === '/api/status') {
      // M-2：完整信息（lanIp / 公网地址 / pinSet）只给「Host 为 loopback 且 Origin 可信」的请求；
      // 源 IP 是否 127.0.0.1 不作为依据（本机恶意网页/DNS rebinding 同样来自 loopback IP）
      const cors = corsHeaders(req);
      const local = trustedLocalRequest(req);
      const lanIp = local ? selectLanIPv4() : null;
      return sendJSON(res, 200, {
        ok: true,
        port,
        ...(local ? {
          lanIp,
          lanUrl: lanIp ? `http://${lanIp}:${port}` : null,
          pinSet: pinIsSet(settings),
          // 隧道信息仅本机视角可见：url 为 named tunnel 固定地址（面板据此生成手机二维码）
          ...(getTunnelPort() ? { tunnel: { port: getTunnelPort(), url: getTunnelUrl() } } : {}),
        } : {}),
      }, cors);
    }
    return false;
  }

  // ---- 主分发：横切（收口 / OPTIONS）→ 分组 handler 逐级尝试 ----
  return async function dispatch(req, res) {
    if (viaTunnel) req.__viaTunnel = true; // 隧道端口标记：cf 头可信域 / 管理禁用 / Secure Cookie
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    try {
      // ---- 安全收口（全量）：直连端口不承载任何功能，对一切来源（含本机）只回"指路牌" ----
      // GET/HEAD 任意路径 → 显示当前 Cloudflare 隧道地址的引导页；其余方法 → 403 + 地址。
      // 功能入口只剩两条：HTTPS 隧道（外网）与回连端口 127.0.0.1:3191（本机，管理接口也在此）。
      if (!viaTunnel) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          return send(res, 200, req.method === 'HEAD' ? '' : directNoticePage(req, getTunnelUrl()), {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          });
        }
        // 403 响应里的隧道地址同样只给本机来源；公网来源不泄露入口 URL
        return sendJSON(res, 403, { ok: false, error: 'direct port serves the tunnel address only', ...(isLoopback(req) ? { url: getTunnelUrl() || null } : {}) });
      }
      if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
        // CORS 预检：仅 loopback / 同源 Origin 放行（PC 面板），其余一律不给 CORS 头
        const c = corsHeaders(req);
        if (!c['access-control-allow-origin']) return send(res, 204, '');
        return send(res, 204, '', {
          ...c,
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, x-tt-pin',
        });
      }

      if (await handleStatic(req, res, pathname)) return undefined; // 命中即完成（handler 已写响应）
      if (await handleAdmin(req, res, pathname)) return undefined;

      const settings = await loadSettings();
      if (await handleAuth(req, res, pathname, settings)) return undefined;
      if (await handlePush(req, res, pathname, settings)) return undefined;
      if (await handleChat(req, res, pathname, settings)) return undefined;
      if (await handleSchedule(req, res, pathname, settings)) return undefined;
      if (await handleStatus(req, res, pathname, settings)) return undefined;
      return sendJSON(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  };
}
