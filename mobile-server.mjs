#!/usr/bin/env node
/*
 * mobile-server.mjs — 「本日日程」手机扫码访问 · 独立服务（与 dsh-pocket 完全分离）
 *
 * 职责：
 *   1. 托管手机端页面 mobile.html（http://<本机IP>:<port>/）
 *   2. 提供 /api/schedule 读 / 写接口（直接读写同目录 schedule.json，不经 worktable、不经 dsh-pocket）
 *   3. 提供 /api/status 状态接口（本机访问地址）
 *
 * 用法：
 *   node mobile-server.mjs                 # 监听 0.0.0.0（局域网 / 公网 IP 直连，凭安全密码防护）
 *   node mobile-server.mjs --port 3195
 *
 * 端口说明：默认 3190 起（dsh web 固定 3080；dsh-pocket 代理固定从 3081 起自动占用 3081-3090，
 * 本服务从 3190 起并只向上试探，与两者永不冲撞）。
 */

import http from 'node:http';
import { createHash, timingSafeEqual, scryptSync, randomBytes, randomInt } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { withSetup, stripSetup } from './chat-setup.mjs';
import TTOccur from './occur.js'; // 共享领域判定核心（与网页端 / Python timetable_core.py 同一语义）

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEDULE_PATH = join(HERE, 'schedule.json');
const MOBILE_HTML_PATH = join(HERE, 'mobile.html');
const OCCUR_JS_PATH = join(HERE, 'occur.js'); // 手机页 <script src="/occur.js"> 的静态托管来源
const BIN_CACHE_DIR = join(HERE, '.mobile-srv');
const SETTINGS_PATH = join(BIN_CACHE_DIR, 'settings.json'); // 安全密码仅存本机此文件
const SUBS_PATH = join(BIN_CACHE_DIR, 'push-subscriptions.json'); // Web Push 订阅（每设备一条）
const FIRED_PATH = join(BIN_CACHE_DIR, 'remind-fired.json'); // 服务端已推送的提醒键（48h 清理）

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const BASE_PORT = portArg > -1 ? (parseInt(args[portArg + 1], 10) || 3190) : 3190;
const hostArg = args.indexOf('--host');
const BIND_HOST = hostArg > -1 ? String(args[hostArg + 1] || '0.0.0.0') : '0.0.0.0'; // 可 --host 127.0.0.1 仅本机

// 隧道回连监听（main() 启动后赋值）：cloudflared ingress 指向 127.0.0.1:TUNNEL_PORT。
// 该端口的请求带 __viaTunnel 标记：cf-connecting-ip 可信、Cookie 加 Secure；
// 管理接口（/api/admin/*）也只在此端口开放——直连端口已全量收口（只回引导页），
// 且经 CF 边缘的流量必带 cf-connecting-ip/cf-ray，被 trustedLocalRequest 拒于管理面之外。
let TUNNEL_PORT = 0;
let TUNNEL_URL = null; // named tunnel 固定公网地址（.mobile-srv/tunnel.json 的 url，启动时读一次）

// ---------- 局域网 IPv4 选择（私网优先 / 物理网卡加分 / VPN 虚拟网卡减分） ----------
const PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const PHYSICAL_IFACE_RE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d|以太网|有线|无线|本地连接)/i;
const VPN_IFACE_RE = /(?:radmin|tailscale|zerotier|easytier|et_|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge)/i;

function selectLanIPv4(interfaces) {
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const ip = addr.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      let score = 0;
      if (PRIVATE_IPV4_RE.test(ip)) score += 100;
      if (PHYSICAL_IFACE_RE.test(name)) score += 20;
      else if (VPN_IFACE_RE.test(name)) score -= 50;
      candidates.push({ ip, score, order: candidates.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.ip ?? null;
}

// ---------- 安全密码（仅存本机 .mobile-srv/settings.json，不进 URL / 二维码 / 日志） ----------
async function loadSettings() {
  try { return JSON.parse(await readFile(SETTINGS_PATH, 'utf8')); } catch { return {}; }
}
/** 隧道公网信息（.mobile-srv/tunnel.json：{ "url": "https://tt.example.com" }；无则未配置）。 */
async function loadTunnelInfo() {
  try { return JSON.parse(await readFile(join(BIN_CACHE_DIR, 'tunnel.json'), 'utf8')); } catch { return null; }
}

// ---- Quick Tunnel 公网地址发现：cloudflared（独立常驻进程）把日志写入 tunnel.log，
//      增量扫描其中的 https://*.trycloudflare.com，取最新一条作为当前公网地址。
//      静态 tunnel.json（named tunnel 固定域名）优先；存在时不再扫日志。
const TUNNEL_LOG_PATH = join(BIN_CACHE_DIR, 'tunnel.log');
let tunnelLogOffset = 0;
let tunnelStaticUrl = null;
async function scanTunnelLog() {
  if (tunnelStaticUrl) return; // named tunnel 固定地址，无需扫描
  let fh;
  try { fh = await open(TUNNEL_LOG_PATH, 'r'); } catch { return; /* 无日志文件 */ }
  try {
    const size = (await fh.stat()).size;
    if (size < tunnelLogOffset) tunnelLogOffset = 0; // 日志被清理/轮转 → 从头扫
    const len = size - tunnelLogOffset;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, tunnelLogOffset);
      tunnelLogOffset = size;
      const urls = [...String(buf).matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi)].map((m) => m[0]);
      if (urls.length && urls[urls.length - 1] !== TUNNEL_URL) {
        TUNNEL_URL = urls[urls.length - 1];
        console.log(`mobile-server: 隧道公网地址 ${TUNNEL_URL}（quick tunnel，进程重启后会变化）`);
      }
    }
  } catch { /* 读取失败下轮再试 */ } finally { try { await fh.close(); } catch { /* 忽略 */ } }
}
/** 原子写：同目录临时文件写完 rename 覆盖——写一半崩溃/并发读不会截断正文
 *  （SCHEDULE_PATH / SETTINGS_PATH / SUBS_PATH / FIRED_PATH 全部走这里）。 */
async function atomicWriteFile(path, data) {
  const tmp = join(dirname(path), `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, path);
}
async function saveSettings(s) {
  await mkdir(BIN_CACHE_DIR, { recursive: true });
  await atomicWriteFile(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

// ---------- 认证与防爆破（参照 dsh-pocket #13/#18/#33/#40 与 dsh api-request-trust 栅栏） ----------
const COOKIE_NAME = 'tt_pin_v2'; // HttpOnly 登录 Cookie（SameSite=Strict）：现承载服务端随机会话 token（可吊销/登出）
const SESSION_MAX = 20;                 // 会话 token 上限（登录时惰性清理，砍最旧）
const SESSION_TTL = 30 * 24 * 3600e3;   // 会话 30 天滚动过期（lastSeen 起算）

/** 是否已设密码：新版存 pinHash（scrypt 加盐哈希），旧版遗留明文 pin 迁移期同样视为已设。 */
function pinIsSet(settings) { return !!settings.pinHash || !!settings.pin; }

/** scrypt 加盐哈希（N=16384）：存 {salt,hash}（hex），明文不落盘。 */
function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(pin), salt, 32, { N: 16384 }).toString('hex');
  return { salt, hash };
}

/** 时序安全比对明文 pin 与存储形态（新 pinHash / 旧明文 pin 兼容迁移期）。所有比较统一走这里。 */
function verifyPinSync(given, settings) {
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
function pruneSessions(settings) {
  const now = Date.now();
  let list = (Array.isArray(settings.sessions) ? settings.sessions : [])
    .filter((s) => s && typeof s.token === 'string' && now - (s.lastSeen || s.createdAt || 0) < SESSION_TTL);
  list.sort((a, b) => (a.lastSeen || a.createdAt || 0) - (b.lastSeen || b.createdAt || 0));
  if (list.length > SESSION_MAX) list = list.slice(list.length - SESSION_MAX);
  return list;
}
/** 签发新会话 token（调用方负责落盘）。 */
function issueSession(settings) {
  const list = pruneSessions(settings);
  const token = randomBytes(32).toString('hex');
  list.push({ token, createdAt: Date.now(), lastSeen: Date.now() });
  settings.sessions = list;
  return token;
}
/** 按 token 验会话：命中且未过期 → 更新内存 lastSeen 并返回 true。
 *  lastSeen 只更新内存不逐请求落盘（30 天滚动窗口足够宽容，落盘时机=登录/登出/改密）。 */
function touchSession(settings, token) {
  if (!token) return false;
  const s = (Array.isArray(settings.sessions) ? settings.sessions : [])
    .find((x) => x && typeof x.token === 'string' && x.token === token);
  if (!s) return false;
  if (Date.now() - (s.lastSeen || s.createdAt || 0) >= SESSION_TTL) return false;
  s.lastSeen = Date.now();
  return true;
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// 客户端真实 IP：
// · 直连端口（0.0.0.0:3190）：socket 对端地址即真实来源，**不采信任何转发头**
//   （cf-connecting-ip / x-forwarded-for 等可被任意客户端伪造，曾可借此换「新 IP」绕过限流锁定）。
// · 隧道端口（127.0.0.1:tunnelPort，仅 cloudflared 回连）：请求经 CF 边缘到达，
//   cf-connecting-ip 由边缘强制覆写、不可经隧道伪造 → 按真实访客 IP 计数。
//   本地进程直击隧道端口所带的伪造头会落入 'tunnel-unknown' 单独桶（无害）。
function clientIpOf(req) {
  if (req.__viaTunnel) {
    const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(cf) || /^[0-9a-f:]+$/i.test(cf)) return cf;
    return 'tunnel-unknown';
  }
  let ip = String(req.socket.remoteAddress ?? '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv6 映射 IPv4 归一化，保证限流桶一致
  return ip || 'unknown';
}

/** 每 IP 密码尝试限速：60 秒窗口 5 次；连续触限指数升级锁定（10 分钟起，翻倍封顶 24 小时）。
 *  另设全局慢速闸（60 秒内全网合计 30 次失败 → 暂缓受理登录 60 秒）：端口直接暴露在
 *  公网 IP 上，攻击者可轮换来源 IP 绕过单 IP 桶，全局闸拖慢任何分布式爆破（不影响正确密码）。 */
const RATE = { hits: new Map(), globalFails: 0, globalResetAt: 0, globalHoldUntil: 0 };
function rateState(ip) {
  const now = Date.now();
  let r = RATE.hits.get(ip);
  if (!r || now > r.resetAt) { r = { count: 0, resetAt: now + 60_000, lockedUntil: 0, strikes: 0 }; RATE.hits.set(ip, r); }
  return r;
}
function rateLocked(ip) {
  const r = rateState(ip);
  const now = Date.now();
  return r.lockedUntil > now ? Math.ceil((r.lockedUntil - now) / 1000) : 0;
}
function globalHoldSeconds() {
  const now = Date.now();
  if (RATE.globalResetAt <= now) { RATE.globalFails = 0; RATE.globalResetAt = now + 60_000; }
  return RATE.globalHoldUntil > now ? Math.ceil((RATE.globalHoldUntil - now) / 1000) : 0;
}
function rateFail(ip) {
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
function rateClear(ip) { RATE.hits.delete(ip); }
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of RATE.hits) if (now > r.resetAt && now > r.lockedUntil) RATE.hits.delete(ip);
}, 60_000).unref();

/**
 * 校验请求凭据：登录 Cookie（HttpOnly，首选）或 X-TT-Pin 头（兼容）。
 * 已移除 ?pin= 查询参数（避免进入浏览器历史/日志）。失败计限速。
 * 返回 {ok:true} | {ok:false,status,retryAfter,error}。
 */
function checkPin(req, settings) {
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
function guardPin(req, res, settings, extraHeaders = {}) {
  const r = checkPin(req, settings);
  if (r.ok) return true;
  sendJSON(res, r.status, { ok: false, error: r.error }, {
    ...(r.retryAfter ? { 'retry-after': String(r.retryAfter) } : {}),
    ...extraHeaders,
  });
  return false;
}

/**
 * 本机管理栅栏（参照 dsh api-request-trust）：Host 必须是 loopback 权威，
 * sec-fetch-site 不得为 cross-site，Origin（若带）主机名须为 loopback 或与 Host 同权威
 * （允许 PC 面板 127.0.0.1:3080 跨端口访问 127.0.0.1:3190）。
 * 仅靠 remoteAddress=127.0.0.1 不足以防本机恶意网页与 DNS rebinding。
 */
function trustedLocalRequest(req) {
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

/** CORS：仅对 loopback 来源或与 Host 同源的 Origin 回显（PC 面板跨端口访问）；其余不给 CORS 头。 */
function corsHeaders(req) {
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

/** loopback 地址判定（IPv4 / IPv6 / IPv4-mapped IPv6）。 */
function isLoopbackAddr(ra) {
  const a = String(ra ?? '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** loopback 判定：/api/admin/* 与直连端口安全收口的网络层硬闸（见 trustedLocalRequest）。 */
function isLoopback(req) {
  return isLoopbackAddr(req.socket.remoteAddress);
}

/**
 * 直连端口引导页（安全收口）：明文直连端口不提供任何功能，仅提示改走 HTTPS 隧道。
 * 隧道地址只对本机来源（PC 面板/本机浏览器换设备登录）展示；公网扫描者只见通用引导
 * 文案，不奉送入口 URL。
 */
function directNoticePage(req) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const url = isLoopback(req) ? TUNNEL_URL : null;
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

// ---------- DSH 对话桥：以 loopback 身份调用本机 dsh web 的共享 /api RPC ----------
// 手机端输入框 → 本服务 POST /api/chat → session.prompt 送入电脑端 DSH 专属会话
// （cwd = 本目录，即可直接编辑 schedule.json）→ 轮询 session.history 取助手回复。
// 系统设定注入/剥离见 chat-setup.mjs（宿主 RPC 无 instructions 通道，只能内联首条消息）。
const DSH_API = process.env.DSH_API_URL || `http://127.0.0.1:${process.env.DSH_PORT || 3080}`;
let rpcCounter = 0;
let chatBusy = false;

async function dshRpc(method, payload) {
  const res = await fetch(`${DSH_API}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'mobile-server-' + Date.now() + '-' + (++rpcCounter),
      method,
      payload,
    }),
  });
  if (!res.ok) throw new Error(`dsh /api HTTP ${res.status}`);
  const body = await res.json();
  const r = body?.result;
  if (!r?.ok) throw new Error(r?.error?.message || `${method} failed`);
  return r.value;
}

/** 新建会话后应用用户选择的默认模型（会话重建不丢手机端/本地的模型选择）。 */
async function applyDefaultModel(sid, settings) {
  const sel = settings.chatDefaultModel;
  if (!sel?.provider || !sel?.model) return;
  try {
    await dshRpc('session.selectModel', { sessionId: sid, provider: sel.provider, model: sel.model });
  } catch { /* 所选模型不可用时沿用宿主默认 */ }
}

/** 取（或创建）专属 DSH 会话；无效时自动重建。存于本机 settings.json。 */
async function ensureChatSession(settings) {
  const sid = settings.chatSessionId;
  if (sid) {
    try {
      await dshRpc('session.history', { sessionId: sid, maxMessages: 1 });
      return { sid, inited: !!settings.chatInited };
    } catch { /* 会话失效 → 重建 */ }
  }
  const created = await dshRpc('session.create', { cwd: HERE });
  settings.chatSessionId = created.sessionId;
  settings.chatInited = false;
  await saveSettings(settings);
  await applyDefaultModel(created.sessionId, settings); // 修复：重建不丢已选模型
  // 修复：仍绑在旧会话上的手机 watch 连接立即改绑并收到 reset 帧，
  // 否则它们过滤旧 sessionId 一帧收不到（手机端表现为"无流式响应，刷新才可见"）
  notifySessionReset(sid, created.sessionId);
  return { sid: created.sessionId, inited: false };
}

/** 历史尾部最大事件序号（空日志为 -1），用作「本条消息之后」的标记。 */
async function lastSeqOf(sessionId) {
  const h = await dshRpc('session.history', { sessionId, maxMessages: 1 });
  const evs = (h?.events ?? []).map((e) => e?.event?.seq ?? 0);
  return evs.length ? Math.max(...evs) : -1;
}

/** 从 assistant/message 事件提取纯文本。 */
function assistantText(ev) {
  const content = ev?.data?.message?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b?.text ?? '').join('').trim();
}

// ---- 模型切换：带图消息需要视觉模型（如 glm-5v-turbo），纯文本用会话默认模型 ----
const VISION_MODEL_RE = /(?:^|[-.])(?:glm-[\d.]*v[\d.-]*|[^"']*vision[^"']*|-vl-|-4v)/i;

async function sessionModels(sid) {
  return dshRpc('session.models', { sessionId: sid });
}

/** 确保会话模型满足本次消息形态；首次切换前把默认选择记入 settings 以便还原。 */
async function ensureModelShape(sid, settings, wantVision) {
  const info = await sessionModels(sid);
  const cur = info.current || {};
  const isVision = VISION_MODEL_RE.test(cur.model || '');
  if (wantVision && !isVision) {
    if (!settings.chatDefaultModel) {
      settings.chatDefaultModel = { provider: cur.provider, model: cur.model, ...(cur.reasoningEffort ? { reasoningEffort: cur.reasoningEffort } : {}) };
      await saveSettings(settings);
    }
    if (!settings.chatVisionModel) {
      const cand = (info.groups ?? []).flatMap((g) => (g.models ?? []).map((m) => ({ provider: g.id, model: m.id })))
        .find((m) => VISION_MODEL_RE.test(m.model));
      if (!cand) throw new Error('当前 DSH 无可用视觉模型，无法处理图片消息');
      settings.chatVisionModel = cand;
      await saveSettings(settings);
    }
    await dshRpc('session.selectModel', { sessionId: sid, ...settings.chatVisionModel });
  } else if (!wantVision && isVision && settings.chatDefaultModel) {
    await dshRpc('session.selectModel', { sessionId: sid, ...settings.chatDefaultModel });
  }
}

/** 从 marker 之后的事件里找模型/请求层报错（chunk finish.reason.kind === 'error'）。 */
function findStreamError(evs, marker) {
  for (const e of evs) {
    if ((e.seq ?? 0) <= marker || e.type !== 'assistant/chunk') continue;
    const c = e.data?.chunk;
    if (c?.type === 'finish' && c.reason?.kind === 'error') {
      return c.reason.failure?.message || c.reason.kind || 'model error';
    }
  }
  return null;
}

/** 会话被图片事件「污染」后纯文本模型无法重放历史的典型错误（1210）。 */
const POISON_RE = /content\.type|code.{0,4}1210|image input/i;

/** 丢弃并重建专属会话（历史含图片块且模型不支持时自愈 / 手机端新建对话）。 */
async function resetChatSession(settings) {
  const oldSid = settings.chatSessionId;
  settings.chatSessionId = undefined;
  settings.chatInited = false;
  await saveSettings(settings);
  const created = await dshRpc('session.create', { cwd: HERE });
  settings.chatSessionId = created.sessionId;
  settings.chatInited = false;
  await saveSettings(settings);
  await applyDefaultModel(created.sessionId, settings); // 修复：重建不丢已选模型
  notifySessionReset(oldSid, created.sessionId); // 旧会话的手机连接改绑 + 旧会话未答交互请求作废
  return created.sessionId;
}

/** 发送消息（可带图片）并等待 DSH 的最终回复（稳定收尾或超时返回已收集文本）。 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES = 4;
const MAX_IMAGE_B64 = 7 * 1024 * 1024; // 单图 base64 上限（约 5MB 原始字节）

function buildChatContent(text, images) {
  const content = [];
  const t = String(text ?? '').trim();
  if (t) content.push({ type: 'text', text: t });
  for (const img of images) {
    if (!img || typeof img !== 'object') throw new Error('invalid image');
    const mediaType = String(img.mediaType ?? '');
    const data = String(img.data ?? '');
    if (!IMAGE_TYPES.has(mediaType)) throw new Error(`不支持的图片类型：${mediaType || '(空)'}`);
    if (!data || data.length > MAX_IMAGE_B64) throw new Error('图片为空或超过 5MB');
    content.push({ type: 'image', mediaType, data, ...(img.name ? { name: String(img.name).slice(0, 120) } : {}) });
  }
  if (!content.length) throw new Error('消息内容为空');
  return content;
}

/** 单次尝试（不复位会话）。onPartial：流式回调，参数为当前未完成 step 的已累计文本。 */
async function chatOnce(message, images, onPartial) {
  const settings = await loadSettings();
  const { sid, inited } = await ensureChatSession(settings);
  await ensureModelShape(sid, settings, images.length > 0);
  const marker = await lastSeqOf(sid);
  // 新会话首条消息内联注入系统设定（见 chat-setup.mjs）；镜像回手机时剥离设定前缀
  const plainText = inited ? String(message) : withSetup(message);
  const content = buildChatContent(plainText, images);
  try {
    await dshRpc('session.prompt', { sessionId: sid, mode: 'queue', content });
  } catch (err) {
    // 提交即被拒（历史含图片而模型纯文本等）→ 重建会话重试一次
    if (POISON_RE.test(String(err?.message ?? ''))) throw Object.assign(new Error(String(err.message)), { poisoned: true });
    throw err;
  }
  if (!inited) { settings.chatInited = true; await saveSettings(settings); }
  onPartial?.('');

  // 轮询收尾：出现 marker 之后的 assistant/message 且 3 秒无新事件 → 完成；最长等 120 秒
  let collected = '';
  let stable = 0;
  let lastSeen = -1;
  let lastPartial = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const h = await dshRpc('session.history', { sessionId: sid, maxMessages: 30 });
    const evs = (h?.events ?? []).map((e) => e.event).filter(Boolean);
    const tail = Math.max(-1, ...evs.map((e) => e.seq ?? 0));
    const replies = evs.filter((e) => e.type === 'assistant/message' && (e.seq ?? 0) > marker);
    const latest = replies.length ? assistantText(replies[replies.length - 1]) : '';
    if (latest) collected = latest;
    // 流式：当前未完成 step（最后一条 message 边界之后）的 text-delta 累计
    if (onPartial) {
      const boundary = Math.max(marker, ...evs.filter((e) => e.type === 'assistant/message' || e.type === 'user/message').map((e) => e.seq ?? 0));
      let partial = '';
      for (const e of evs) {
        if ((e.seq ?? 0) <= boundary) continue;
        const c = e.type === 'assistant/chunk' ? e.data?.chunk : null;
        if (c?.type === 'text-delta' && typeof c.text === 'string') partial += c.text;
      }
      if (partial !== lastPartial) { lastPartial = partial; onPartial(partial); }
    }
    // 模型/请求层报错：turn 已结束且不会有 assistant/message → 立刻失败，别干等超时
    const streamErr = findStreamError(evs, marker);
    if (streamErr && !collected) {
      const err = new Error(`DSH 处理失败：${streamErr}`);
      if (POISON_RE.test(streamErr)) err.poisoned = true;
      throw err;
    }
    if (tail === lastSeen && collected) { stable++; if (stable >= 2) return { reply: collected }; }
    else stable = 0;
    lastSeen = tail;
  }
  if (collected) return { reply: collected, timeout: true };
  throw new Error('DSH 未在 120 秒内回复');
}

async function chatWithDsh(message, images = [], onPartial) {
  if (chatBusy) throw new Error('busy');
  if (images.length > MAX_IMAGES) throw new Error(`一次最多 ${MAX_IMAGES} 张图片`);
  chatBusy = true;
  try {
    try {
      return await chatOnce(message, images, onPartial);
    } catch (err) {
      // 会话被历史中的图片事件「污染」→ 丢弃重建；纯文本消息自动重试一次
      if (err?.poisoned) {
        const settings = await loadSettings();
        await resetChatSession(settings);
        if (!images.length) return await chatOnce(message, images, onPartial);
      }
      throw err;
    }
  } finally {
    chatBusy = false;
  }
}

/** 从会话历史提取 user/assistant 消息（原样文本，升序）。 */
async function chatHistoryMessages(sid) {
  const h = await dshRpc('session.history', { sessionId: sid, maxMessages: 40 });
  const evs = (h?.events ?? []).map((e) => e.event).filter(Boolean).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const out = [];
  for (const e of evs) {
    if (e.type !== 'user/message' && e.type !== 'assistant/message') continue;
    const content = e.data?.message?.content ?? e.data?.content;
    if (!Array.isArray(content)) continue;
    const text = content.filter((b) => b?.type === 'text').map((b) => b?.text ?? '').join('').trim();
    if (!text) continue;
    out.push({ role: e.type === 'user/message' ? 'user' : 'assistant', text: e.type === 'user/message' ? stripSetup(text) : text, seq: e.seq ?? 0 });
  }
  return out;
}

/**
 * 完整过程快照（与电脑端 GUI 看到的一致）：消息、思考过程、工具调用（入参）与工具输出，
 * 按 seq 升序输出为 watch 帧序列（每帧带 seq，手机端按 seq 幂等去重）。
 * 思考过程按 (turn,step) 分组，在该步骤首个落面事件（消息/工具）前一次性补齐。
 */
async function chatHistoryFrames(sid) {
  const h = await dshRpc('session.history', { sessionId: sid, maxMessages: 40 });
  const evs = (h?.events ?? []).map((e) => e.event).filter(Boolean).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const frames = [];
  const pendingReasoning = new Map(); // `${turn}:${step}` → 已累计 reasoning 文本
  const flushReasoning = (turn, step) => {
    const key = `${turn}:${step}`;
    const text = pendingReasoning.get(key);
    if (text && text.trim()) frames.push({ t: 'reasoning', text, fresh: true });
    pendingReasoning.delete(key);
  };
  let lastToolId = ''; // 快照里 tool/result 常无顶层 callId：按序配对到最近的 tool/call
  for (const e of evs) {
    const d = e.data ?? {};
    if (e.type === 'user/message' || e.type === 'assistant/message') {
      flushReasoning(d.turn, d.step);
      const content = d.message?.content ?? d.content;
      const text = Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b?.text ?? '').join('').trim() : '';
      if (text) frames.push({ t: 'message', role: e.type === 'user/message' ? 'user' : 'assistant', text: e.type === 'user/message' ? stripSetup(text) : text, seq: e.seq ?? 0 });
    } else if (e.type === 'tool/call') {
      flushReasoning(d.turn, d.step);
      lastToolId = String(d.callId ?? '');
      frames.push({ t: 'tool', id: lastToolId, name: String(d.name ?? 'tool'), args: strSlice(d.arguments, 4000), seq: e.seq ?? 0 });
    } else if (e.type === 'tool/result') {
      flushReasoning(d.turn, d.step);
      frames.push({ t: 'toolresult', id: toolCallIdOf(d) || lastToolId, text: toolResultText(d).slice(0, 8000), error: !!d.error, seq: e.seq ?? 0 });
    } else if (e.type === 'assistant/chunk' && d.chunk?.type === 'reasoning-delta' && typeof d.chunk.text === 'string') {
      const key = `${d.turn}:${d.step}`;
      pendingReasoning.set(key, (pendingReasoning.get(key) ?? '') + d.chunk.text);
    }
  }
  return frames;
}

// ---------- 系统级通知：Web Push + 服务端提醒调度（后台可送达，不依赖手机页面存活） ----------
let webpush = null;
try { webpush = require('web-push'); } catch { webpush = null; } // 未安装时降级：仅前台页面内提醒

async function ensureVapid(settings) {
  if (!webpush) return null;
  if (settings.vapid?.publicKey && settings.vapid?.privateKey) return settings.vapid;
  const keys = webpush.generateVAPIDKeys();
  settings.vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  await saveSettings(settings);
  console.log('mobile-server: Web Push VAPID 密钥已生成（仅存本机）');
  return settings.vapid;
}

/** Push endpoint 安全校验：必须 https，且不得指向 loopback / 私网 / 链路本地段
 *  （防认证后 SSRF：服务端会在提醒触发时向 endpoint 发 POST）。 */
function safePushEndpoint(endpoint) {
  let u;
  try { u = new URL(String(endpoint ?? '')); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (!h || h === 'localhost' || h === '[::1]' || isLoopbackHostname(h)) return false;
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|0\.|127\.)/.test(h)) return false;
  if (h.startsWith('[') && (/^\[(?:fe80|fc|fd)/i.test(h) || h === '[::]')) return false; // IPv6 链路本地 / ULA / 全零
  return true;
}

async function loadSubs() {
  try { return JSON.parse(await readFile(SUBS_PATH, 'utf8')); } catch { return []; }
}
async function saveSubs(list) {
  await mkdir(BIN_CACHE_DIR, { recursive: true });
  await atomicWriteFile(SUBS_PATH, JSON.stringify(list, null, 2));
}

/** 向全部订阅推送。返回是否「已处理」：全部送达成功、或死订阅(404/410)清理完毕都算已处理；
 *  任一网络级异常 → false（调用方不标 fired，20 秒后自动重试；通知 tag 去重防重复弹窗）。 */
async function pushToAll(payloadObj) {
  const subs = await loadSubs();
  if (!subs.length || !webpush) return false;
  const vapid = await ensureVapid(await loadSettings());
  if (!vapid) return false;
  const dead = [];
  let allHandled = true;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(s, JSON.stringify(payloadObj), {
        vapidDetails: { subject: 'mailto:auto-timetable@local', publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: 3600,
      });
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(s); // 订阅失效 → 移除（视为已处理）
      else allHandled = false; // 网络异常等 → 未处理，允许重试
    }
  }));
  if (dead.length) await saveSubs(subs.filter((s) => !dead.includes(s)));
  return allHandled;
}

// —— 服务端事件判定：统一走共享领域模块 occur.js（单一实现；与手机端/桌面端/Python 同语义） ——
const srvFmtDate = TTOccur.fmtDate;
const srvToMin = TTOccur.parseHHMM;
const srvOccursOn = TTOccur.occursOn;

async function loadFired() { try { return JSON.parse(await readFile(FIRED_PATH, 'utf8')); } catch { return {}; } }
async function saveFired(m) {
  await mkdir(BIN_CACHE_DIR, { recursive: true });
  await atomicWriteFile(FIRED_PATH, JSON.stringify(m));
}

let scheduleCache = { at: 0, data: null };
async function loadSchedule() {
  try {
    const stat = await import('node:fs/promises').then((m) => m.stat(SCHEDULE_PATH));
    if (scheduleCache.data && Date.now() - scheduleCache.at < 20_000 && Math.abs(stat.mtimeMs - scheduleCache.mtime) < 1) return scheduleCache.data;
    const data = JSON.parse(await readFile(SCHEDULE_PATH, 'utf8'));
    scheduleCache = { at: Date.now(), mtime: stat.mtimeMs, data };
    return data;
  } catch { return scheduleCache.data ?? { events: [] }; }
}

/** 清除判定：过期即失效（渲染/提醒立即停止），但数据保留——截止日期早于「今天往前推 3 个月」才清除。 */
function isPurgeableEvent(ev, cutoff) {
  let dl = (typeof ev.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ev.deadline)) ? ev.deadline : null;
  if (!dl && ev.type === 'once') dl = (typeof ev.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ev.date)) ? ev.date : null;
  if (!dl && ev.type === 'custom' && ev.repeat && typeof ev.repeat.until === 'string') dl = ev.repeat.until;
  return !!dl && dl < cutoff;
}

/** 到期自动清理（保留 3 个月）：把「截止日期已过满 3 个月」的日程从 schedule.json 删除（2 空格缩进风格）。 */
async function purgeExpired() {
  try {
    const now = new Date();
    // 日历月往前推 3 个月（Date 自动处理月份下溢；月末溢出如 05-31→02-31 会顺延到 03-03，宁晚勿早）
    const cutoffDate = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
    const cutoff = srvFmtDate(cutoffDate);
    const data = JSON.parse(await readFile(SCHEDULE_PATH, 'utf8'));
    const before = (data.events ?? []).length;
    const kept = (data.events ?? []).filter(ev => !isPurgeableEvent(ev, cutoff));
    if (kept.length === before) return 0;
    data.events = kept;
    await atomicWriteFile(SCHEDULE_PATH, JSON.stringify(data, null, 2) + '\n');
    scheduleCache = { at: 0, data: null }; // 失效缓存，下次读取拿新数据
    console.log(`[purge] 已清除 ${before - kept.length} 条过期满 3 个月（截止早于 ${cutoff}）的日程（剩余 ${kept.length} 条）`);
    return before - kept.length;
  } catch (e) {
    console.error('[purge] 到期清理失败:', e?.message || e);
    return 0;
  }
}

/** 每 20 秒扫描：事件落在 [start-remindLead, start) 且未推送过 → Web Push 系统通知。 */
function startReminderScheduler() {
  setInterval(async () => {
    try {
      const subs = await loadSubs();
      if (!subs.length) return; // 无订阅不扫（前台提醒由手机页自己负责）
      const data = await loadSchedule();
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
      const fired = await loadFired();
      let changed = false;
      const today = srvFmtDate(now);
      for (const ev of (data.events ?? [])) {
        for (const day of [now, new Date(now.getTime() + 864e5)]) {
          if (!srvOccursOn(ev, day)) continue;
          const lead = TTOccur.leadMinutes(ev); // 显式 0 = 不提醒；非法/缺失才默认 20
          if (!(lead > 0)) continue;
          const s = srvToMin(ev.start), e = srvToMin(ev.end);
          if (e <= s) continue;
          const isToday = srvFmtDate(day) === today;
          const fireAt = s - lead;
          const inWindow = isToday
            ? (nowMin >= fireAt && nowMin < s)
            : (fireAt < 0 && nowMin >= fireAt + 1440 && nowMin < s);
          if (!inWindow) continue;
          const key = `${ev.id || ev.title}|${srvFmtDate(day)}|${ev.start}`;
          if (fired[key]) continue;
          // 先发后标：推送成功（或死订阅已清理）才写 fired；失败不标记，20 秒后自动重试
          // （重试会对已成功的设备重发同 tag 通知，系统按 tag 去重不会弹两次）
          const handled = await pushToAll({
            title: '⏰ 日程提醒',
            body: `${ev.title || '(未命名)'} ${ev.start}–${ev.end}${ev.location ? ' · ' + ev.location : ''}（约 ${Math.max(1, Math.round(s - nowMin))} 分钟后开始）`,
            tag: key,
            url: '/',
          });
          if (handled) { fired[key] = Date.now(); changed = true; }
        }
      }
      // 清理 48h 前的记录
      const cut = Date.now() - 48 * 3600e3;
      for (const k of Object.keys(fired)) if (fired[k] < cut) { delete fired[k]; changed = true; }
      if (changed) await saveFired(fired);
    } catch (e) { /* 调度轮次失败不影响服务 */ }
  }, 20_000).unref?.();
}

// ---------- 会话事件镜像（dsh-pocket 同思路：订阅宿主 mux 事件流，过滤后转发给手机） ----------
// 宿主在 ws://127.0.0.1:<dshPort>/api/events.mux（loopback 受信）单向推送全部会话的
// session/event 帧；这里按手机端关注的会话过滤，原样镜像到 /api/chat/watch 的 SSE。
const MUX = { ws: null, listeners: new Set(), backoff: 0, pending: new Map() }; // pending: rpcId → 交互请求（手机未连时暂存）

/** 会话重建后：旧会话未答的提问/批准作废；仍绑旧会话的手机 watch 连接
 *  ①立即改绑到新会话（重连完成前实时帧也不中断），②下发 reset 帧让手机端
 *  清空按会话去重的 seq 表并重连拿新会话快照（seq 是每会话独立编号，撞号会误丢帧）。 */
function notifySessionReset(oldSid, newSid) {
  if (!oldSid || oldSid === newSid) return;
  for (const [rid, p] of MUX.pending) if (p.sessionId === oldSid) MUX.pending.delete(rid);
  for (const l of MUX.listeners) {
    if (l.sid !== oldSid) continue;
    try { l.send({ t: 'reset', sid: newSid }); } catch (e) { /* 该连接已死则等其自行重连 */ }
    l.sid = newSid;
    l.acc = ''; l.accR = '';
  }
}

function muxDispatch(payload, rpcId) {
  if (!payload) return;
  // ---- 交互请求（问题 / 批准）：原样转发给手机，答复经 POST /api/respond 回传宿主 ----
  if (payload.type === 'question/requested' || payload.type === 'approval/requested') {
    // 手机未在线时暂存；resolved 时清除
    MUX.pending.set(rpcId, payload);
    for (const l of MUX.listeners) {
      if (l.sid !== payload.sessionId) continue;
      if (payload.type === 'question/requested') l.send({ t: 'question', rpcId, questions: payload.questions ?? [] });
      else l.send({ t: 'approval', rpcId, approvalId: payload.approvalId, toolName: payload.toolName, reason: payload.reason ?? '' });
    }
    return;
  }
  if (payload.type === 'question/resolved' || payload.type === 'approval/resolved') {
    MUX.pending.delete(payload.questionRpcId ?? payload.approvalId);
    for (const l of MUX.listeners) {
      if (l.sid !== payload.sessionId) continue;
      l.send({
        t: 'resolved',
        kind: payload.type.startsWith('question') ? 'question' : 'approval',
        rpcId: payload.questionRpcId ?? payload.approvalId,
        outcome: payload.outcome ?? '',
      });
    }
    return;
  }
  if (payload.type !== 'session/event') return;
  for (const l of MUX.listeners) {
    if (l.sid !== payload.sessionId) continue;
    const ev = payload.event;
    if (!ev) continue;
    if (ev.type === 'user/message' || ev.type === 'assistant/message') {
      const content = ev.data?.message?.content ?? ev.data?.content;
      const text = Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b?.text ?? '').join('').trim() : '';
      l.acc = '';
      l.accR = '';
      // 用户消息剥离内联系统设定前缀（手机不显示设定原文，且回显文本与本地气泡一致以便原位采纳）
      if (text) l.send({ t: 'message', role: ev.type === 'user/message' ? 'user' : 'assistant', text: ev.type === 'user/message' ? stripSetup(text) : text, seq: ev.seq ?? 0 });
      return;
    }
    // 完整过程：工具调用（含入参）与工具输出（含错误态）随生成实时镜像到手机端
    if (ev.type === 'tool/call') {
      l.send({ t: 'tool', id: String(ev.data?.callId ?? ''), name: String(ev.data?.name ?? 'tool'), args: strSlice(ev.data?.arguments, 4000) });
      return;
    }
    if (ev.type === 'tool/result') {
      l.send({ t: 'toolresult', id: toolCallIdOf(ev.data), text: toolResultText(ev.data).slice(0, 8000), error: !!ev.data?.error });
      return;
    }
    if (ev.type === 'assistant/chunk') {
      const c = ev.data?.chunk;
      if (c?.type === 'text-delta' && typeof c.text === 'string') {
        l.acc += c.text;
        l.send({ t: 'partial', text: l.acc });
      } else if (c?.type === 'reasoning-delta' && typeof c.text === 'string') {
        l.accR += c.text;
        l.send({ t: 'reasoning', text: l.accR });
      }
    }
  }
}

/** tool/result 事件的 callId：优先顶层，历史事件里常在 message.source.callId。 */
function toolCallIdOf(data) {
  return String(data?.callId ?? data?.message?.source?.callId ?? '');
}

/** 安全截断任意值为字符串（工具入参是 JSON 字符串，其他可能是对象）。 */
function strSlice(v, n) {
  let s;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v) ?? ''; } catch { s = String(v); } }
  return s.length > n ? s.slice(0, n) + '…(截断)' : s;
}

/** 从 tool/result 事件提取输出文本（message.content 文本块，缺省回落 JSON 摘要）。 */
function toolResultText(data) {
  const content = data?.message?.content;
  if (Array.isArray(content)) {
    const text = content.filter((b) => b?.type === 'text').map((b) => b?.text ?? '').join('').trim();
    if (text) return text;
  }
  if (data?.error) return `[${data.error.name || 'error'}] ${data.error.code || ''}`;
  return strSlice(data?.meta ?? data?.message ?? '', 2000);
}

function muxEnsure() {
  if (MUX.ws && (MUX.ws.readyState === 1)) return true;
  try {
    const url = `${DSH_API.replace(/^http/, 'ws')}/api/events.mux`;
    const ws = new WebSocket(url);
    MUX.ws = ws;
    ws.onmessage = (ev) => {
      MUX.backoff = 0;
      try {
        const full = JSON.parse(String(ev.data));
        if (full?.type === 'server-request') muxDispatch(full.payload, full.rpcId);
      } catch { /* 忽略坏帧 */ }
    };
    const drop = () => {
      if (MUX.ws === ws) MUX.ws = null;
      for (const l of MUX.listeners) l.send({ t: 'bye' });
      MUX.backoff = Math.min(MUX.backoff + 1, 6);
      // 修复：mux 掉线后自动重连（此前只靠新 watch 连接触发，掉线期间问题/批准帧会整段丢失）
      if (MUX.listeners.size > 0) {
        const delay = Math.min(500 * MUX.backoff, 5000);
        setTimeout(() => { if (MUX.listeners.size > 0) muxEnsure(); }, delay).unref?.();
      }
    };
    ws.onclose = drop;
    ws.onerror = () => { try { ws.close(); } catch (e) {} drop(); };
    return true;
  } catch { MUX.ws = null; return false; }
}

// ---------- watch 流共用逻辑（SSE 与 WebSocket 共享）：快照 + 暂存补发 + 卡答提示 + 兜底轮询 ----------
/** SSE 心跳：每 15 秒下发 `: ping` 注释行（防 NAT/代理空闲超时静默掐线，dsh-pocket PR#41 同思路）
 *  + 一条 data 帧 ping（手机端用它检测静默僵尸连接：长时间收不到任何帧即主动重连）。 */
function sseKeepalive(req, res, isClosed, onDead) {
  const timer = setInterval(() => {
    if (isClosed()) { clearInterval(timer); return; }
    try { res.write(': ping\ndata: {"t":"ping"}\n\n'); } catch (e) { clearInterval(timer); onDead?.(); }
  }, 15_000);
  timer.unref?.();
  return timer;
}

/**
 * 启动一条 watch 会话流（已通过鉴权与限流）。
 * @returns 停止函数（清理兜底轮询与 listener 注册由调用方负责 listener 注册外的部分）
 */
async function watchSessionStream(sid, send, listener) {
  // 先 hello（携带会话 id）：手机端据 sid 变化清空按会话去重的 seq 表，再收快照——
  // 顺序不能反，否则会话重建后的快照帧先到、被旧表的撞号 seq 误丢
  send({ t: 'hello', sid });
  // 连接即快照：完整过程（消息 / 思考 / 工具入参与输出）按 seq 下发（手机端按 seq 去重，幂等）
  try {
    for (const f of await chatHistoryFrames(sid)) send(f);
  } catch (e) { send({ t: 'error', error: String(e?.message ?? e) }); }
  MUX.listeners.add(listener);
  // 手机晚连接：补发暂存的交互请求（问题/批准）
  for (const [rid, p] of MUX.pending) {
    if (p.sessionId !== sid) continue;
    if (p.type === 'question/requested') send({ t: 'question', rpcId: rid, questions: p.questions ?? [] });
    else send({ t: 'approval', rpcId: rid, approvalId: p.approvalId, toolName: p.toolName, reason: p.reason ?? '' });
  }
  // 历史里卡住的 ask_user_question（rpcId 已不可得，无法代答）→ 提示 + 可取消本轮
  try {
    const h2 = await dshRpc('session.history', { sessionId: sid, maxMessages: 8 });
    const evs2 = (h2?.events ?? []).map((e) => e.event).filter(Boolean);
    let lastCall = null;
    for (const e of evs2) {
      if (e.type === 'tool/call') lastCall = { name: e.data?.name, seq: e.seq ?? 0 };
      else if (e.type === 'tool/result' && lastCall && (e.seq ?? 0) > lastCall.seq) lastCall = null;
    }
    if (lastCall && lastCall.name === 'ask_user_question') {
      send({ t: 'note', text: 'DSH 正在等待一个更早的提问被答复（该提问早于手机连接，需在电脑端回答；或点下方按钮取消本轮后重新发送）', cancellable: true });
    }
  } catch (e) { /* 忽略 */ }
  muxEnsure();
  // 兜底：mux 断开时每 4 秒①尝试重连、②轮询历史补漏（帧按 seq 去重）、③补发暂存的待答问题/批准（按 rpcId 幂等）
  const timer = setInterval(async () => {
    if (listener.closed) return;
    if (MUX.ws && MUX.ws.readyState === 1) return; // mux 在线：实时帧走 mux
    muxEnsure();
    try { for (const f of await chatHistoryFrames(sid)) send(f); } catch (e) { /* 忽略 */ }
    for (const [rid, p] of MUX.pending) {
      if (p.sessionId !== sid) continue;
      if (p.type === 'question/requested') send({ t: 'question', rpcId: rid, questions: p.questions ?? [] });
      else send({ t: 'approval', rpcId: rid, approvalId: p.approvalId, toolName: p.toolName, reason: p.reason ?? '' });
    }
  }, 4000);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---------- 最小 WebSocket 服务端（无第三方依赖） ----------
// watch 优先走 WebSocket：移动网络中间设备可能缓冲 / 掐断无 Content-Length 的 GET SSE
// 流式响应；WebSocket 帧不被缓冲，且支持协议层心跳（Ping/Pong）保活——
// 蜂窝网络下长时间保持实时镜像更可靠（公网 IP 直连场景同样适用）。
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 服务端→客户端帧（不掩码）。 */
function wsEncodeFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

/** 解析客户端帧（必掩码）：返回 {opcode, payload} 或 null（数据不完整）。 */
function wsDecodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  let mask = null;
  if (masked) { if (buf.length < off + 4) return null; mask = buf.subarray(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, consumed: off + len };
}

/**
 * 处理 /api/chat/watch 的 WebSocket upgrade（与 SSE 端点同协议帧、同鉴权）。
 * @param server http.Server（监听 /api/chat/watch 的 upgrade 事件）
 */
function attachWatchWebSocket(server, sseAdmitLike, viaTunnel = false) {
  server.on('upgrade', async (req, socket, head) => {
    if (viaTunnel) req.__viaTunnel = true;
    let pathname = '/';
    try { pathname = new URL(req.url ?? '/', 'http://x').pathname; } catch { /* 忽略 */ }
    if (pathname !== '/api/chat/watch') { try { socket.destroy(); } catch (e) {} return; }
    // 直连端口已全量收口（只回指路牌）：WebSocket 升级一律拒绝，watch 只走回连端口
    if (!viaTunnel) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\ncontent-type: application/json\r\n\r\n{"ok":false,"error":"direct port serves the tunnel address only"}');
      try { socket.destroy(); } catch (e) {}
      return;
    }
    const key = String(req.headers['sec-websocket-key'] ?? '');
    if (!key) { try { socket.destroy(); } catch (e) {} return; }
    // 鉴权与限流（Cookie 随同源 WS 握手自动携带；按 socket 对端 IP 计数）
    const settings = await loadSettings();
    const pinOk = checkPin(req, settings);
    if (!pinOk.ok) {
      socket.write(`HTTP/1.1 ${pinOk.status ?? 401} Unauthorized\r\nConnection: close\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ ok: false, error: pinOk.error ?? 'unauthorized' })}`);
      try { socket.destroy(); } catch (e) {}
      return;
    }
    if (!sseAdmitLike(req, socket)) { try { socket.destroy(); } catch (e) {} return; }
    // 握手
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay?.(true);
    if (head?.length) { /* 客户端握手后立即发的首帧，留给下面的缓冲解析 */ }
    const { sid } = await ensureChatSession(settings).catch(() => ({ sid: null }));
    if (!sid) { try { socket.destroy(); } catch (e) {} return; }
    let closed = false;
    const sendRaw = (frame) => {
      if (closed || socket.destroyed) return;
      try { socket.write(frame); } catch (e) { closed = true; }
    };
    const send = (obj) => sendRaw(wsEncodeFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')));
    const listener = { sid, send, acc: '', accR: '' };
    const stop = await watchSessionStream(sid, send, listener);
    // 入站帧解析：Close(8)→回 Close 并断开；Ping(9)→回 Pong；Pong/其他→记为活跃
    let inBuf = Buffer.from(head ?? []);
    socket.on('data', (chunk) => {
      inBuf = Buffer.concat([inBuf, chunk]);
      for (;;) {
        const f = wsDecodeFrame(inBuf);
        if (!f) break;
        inBuf = inBuf.subarray(f.consumed);
        if (f.opcode === 8) { sendRaw(wsEncodeFrame(0x8, Buffer.alloc(0))); cleanup(); return; }
        if (f.opcode === 9) sendRaw(wsEncodeFrame(0xA, f.payload));
      }
    });
    // 心跳（dsh-pocket PR#41 同思路）：25 秒协议层 Ping，浏览器网络栈自动回 Pong；
    // 连续 2 个周期零入站字节（链路被静默丢弃）→ 主动断开让浏览器触发重连。
    // 同时下发应用层 ping 帧：手机端 JS 可感知（协议 Pong 对 JS 不可见），
    // 长时间收不到任何帧即判定连接已死并主动重连（运营商 NAT 静默丢映射场景）。
    let alive = true;
    const hb = setInterval(() => {
      if (closed) return;
      if (!alive) { cleanup(); return; }
      alive = false;
      sendRaw(wsEncodeFrame(0x9, Buffer.alloc(0)));
      send({ t: 'ping' });
    }, 25_000);
    hb.unref?.();
    socket.on('data', () => { alive = true; });
    const cleanup = () => {
      if (closed) return;
      closed = true;
      listener.closed = true;
      clearInterval(hb);
      stop();
      MUX.listeners.delete(listener);
      try { socket.destroy(); } catch (e) {}
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}
function sendJSON(res, status, obj, extraHeaders = {}) {
  send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
}
function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function createServer(port, viaTunnel = false) {
  // 流式连接上限（SSE + WebSocket 统一计数）：单 IP ≤4、全局 ≤16（防慢速连接耗尽资源）。
  // IP 按 socket 对端地址计（不采信可伪造的转发头）。
  const sseCount = { perIp: new Map(), total: 0 };
  function admitStream(req, onReject) {
    const ip = clientIpOf(req);
    const n = sseCount.perIp.get(ip) ?? 0;
    if (sseCount.total >= 16 || n >= 4) {
      onReject(ip);
      return null;
    }
    sseCount.perIp.set(ip, n + 1);
    sseCount.total += 1;
    const release = () => {
      const c = (sseCount.perIp.get(ip) ?? 1) - 1;
      if (c <= 0) sseCount.perIp.delete(ip); else sseCount.perIp.set(ip, c);
      sseCount.total = Math.max(0, sseCount.total - 1);
    };
    return release;
  }
  function sseAdmit(req, res) {
    const release = admitStream(req, () => sendJSON(res, 503, { ok: false, error: 'too many streams' }));
    if (!release) return false;
    res.on('close', release);
    return true;
  }
  function wsAdmit(req, socket) {
    const release = admitStream(req, () => {
      socket.write('HTTP/1.1 503 Too Many Streams\r\nConnection: close\r\ncontent-type: application/json\r\n\r\n{"ok":false,"error":"too many streams"}');
      try { socket.destroy(); } catch (e) {}
    });
    if (!release) return false;
    socket.on('close', release);
    return true;
  }
  const server = http.createServer(async (req, res) => {
    if (viaTunnel) req.__viaTunnel = true; // 隧道端口标记：cf 头可信域 / 管理禁用 / Secure Cookie
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    try {
      // ---- 安全收口（全量）：直连端口不承载任何功能，对一切来源（含本机）只回"指路牌" ----
      // GET/HEAD 任意路径 → 显示当前 Cloudflare 隧道地址的引导页；其余方法 → 403 + 地址。
      // 功能入口只剩两条：HTTPS 隧道（外网）与回连端口 127.0.0.1:3191（本机，管理接口也在此）。
      if (!viaTunnel) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          return send(res, 200, req.method === 'HEAD' ? '' : directNoticePage(req), {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          });
        }
        // 403 响应里的隧道地址同样只给本机来源；公网来源不泄露入口 URL
        return sendJSON(res, 403, { ok: false, error: 'direct port serves the tunnel address only', ...(isLoopback(req) ? { url: TUNNEL_URL || null } : {}) });
      }
      if (req.method === 'GET' && (pathname === '/' || pathname === '/mobile.html' || pathname === '/index.html')) {
        const html = await readFile(MOBILE_HTML_PATH);
        return send(res, 200, html, {
          'content-type': 'text/html; charset=utf-8',
          // CSP：限制连接源为本站（防外泄），图片允许 data:/blob:（压缩预览）；拒绝被嵌入 iframe
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
        });
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

      // ---- 管理接口：本机栅栏（Host/Origin/sec-fetch-site）+ 变更需旧密码 ----
      if (pathname.startsWith('/api/admin/')) {
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
          return;
        }
        return sendJSON(res, 404, { ok: false, error: 'not found' });
      }

      // ---- 登录：验证密码后签发服务端随机会话 token（HttpOnly Cookie 承载） ----
      const settings = await loadSettings();
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

      // ---- 登出：吊销当前会话 token 并清 Cookie（Cookie 名沿用，前端无感） ----
      if (req.method === 'POST' && pathname === '/api/logout') {
        if (!guardPin(req, res, settings)) return;
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

      // ---- Web Push：公钥下发 / 订阅登记 / 取消订阅（系统级通知，后台可送达） ----
      if (req.method === 'GET' && pathname === '/api/push/key') {
        if (!guardPin(req, res, settings)) return;
        if (!webpush) return sendJSON(res, 503, { ok: false, error: '服务端未安装 web-push（npm i web-push）' });
        const vapid = await ensureVapid(settings);
        return sendJSON(res, 200, { ok: true, publicKey: vapid.publicKey });
      }
      if (req.method === 'POST' && pathname === '/api/push/subscribe') {
        if (!guardPin(req, res, settings)) return;
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
        if (!guardPin(req, res, settings)) return;
        const body = JSON.parse(await readBody(req, 64 * 1024));
        const subs = await loadSubs();
        const next = subs.filter((s) => s.endpoint !== body?.endpoint);
        if (next.length !== subs.length) await saveSubs(next);
        return sendJSON(res, 200, { ok: true });
      }
      // ---- PWA 静态资源：Service Worker / manifest / 图标 / 共享领域模块 ----
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
      // ---- 手机端对话入口（流式）：SSE 逐帧推送 DSH 的增量回复 ----
      if (req.method === 'POST' && pathname === '/api/chat/stream') {
        if (!guardPin(req, res, settings)) return;
        if (!sseAdmit(req, res)) return;
        const body = JSON.parse(await readBody(req, 12 * 1024 * 1024));
        const message = String(body.message ?? '').trim();
        const images = Array.isArray(body.images) ? body.images : [];
        if (!message && !images.length) return sendJSON(res, 400, { ok: false, error: 'missing message' });
        if (chatBusy) return sendJSON(res, 429, { ok: false, error: 'DSH 正在处理上一条消息，请稍候' });
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
        return;
      }
      // ---- 手机端对话镜像：SSE 原样推送专属会话的完整过程（EventSource 可直接订阅） ----
      if (req.method === 'GET' && pathname === '/api/chat/watch') {
        if (!guardPin(req, res, settings)) return;
        if (!sseAdmit(req, res)) return;
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
        return;
      }
      if (req.method === 'GET' && pathname === '/api/chat/log') {
        if (!guardPin(req, res, settings)) return;
        const { sid } = await ensureChatSession(settings);
        return sendJSON(res, 200, { ok: true, sessionId: sid, messages: await chatHistoryMessages(sid) });
      }
      // ---- 手机端切换模型：列出 / 选择专属会话的模型（选择结果记为默认，纯文本消息沿用） ----
      if (req.method === 'GET' && pathname === '/api/chat/models') {
        if (!guardPin(req, res, settings)) return;
        const { sid } = await ensureChatSession(settings);
        const v = await dshRpc('session.models', { sessionId: sid });
        return sendJSON(res, 200, { ok: true, current: v.current, groups: v.groups, failures: v.failures ?? [] });
      }
      if (req.method === 'POST' && pathname === '/api/chat/model') {
        if (!guardPin(req, res, settings)) return;
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
      // ---- 手机端取消当前卡住的轮次（session.cancel） ----
      if (req.method === 'POST' && pathname === '/api/chat/cancel') {
        if (!guardPin(req, res, settings)) return;
        const { sid } = await ensureChatSession(settings);
        await dshRpc('session.cancel', { sessionId: sid });
        return sendJSON(res, 200, { ok: true });
      }
      // ---- 手机端新建对话：尽力中止旧轮次，另建全新会话（旧会话历史仍保留在宿主/电脑端） ----
      if (req.method === 'POST' && pathname === '/api/chat/reset') {
        if (!guardPin(req, res, settings)) return;
        const old = settings.chatSessionId;
        if (chatBusy && old) {
          try { await dshRpc('session.cancel', { sessionId: old }); } catch (e) { /* 尽力中止，失败不阻塞新建 */ }
        }
        const sid = await resetChatSession(settings); // 复用既有重建逻辑：session.create + 恢复默认模型 + 旧连接改绑通知
        return sendJSON(res, 200, { ok: true, sessionId: sid });
      }
      // ---- 手机端答复 DSH 的问题 / 批准：回传宿主 POST /api/respond（client-response 信封） ----
      if (req.method === 'POST' && pathname === '/api/respond') {
        if (!guardPin(req, res, settings)) return;
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
        if (!guardPin(req, res, settings)) return;
        const body = JSON.parse(await readBody(req, 12 * 1024 * 1024)); // 文本 + 图片（base64）
        const message = String(body.message ?? '').trim();
        const images = Array.isArray(body.images) ? body.images : [];
        if (!message && !images.length) return sendJSON(res, 400, { ok: false, error: 'missing message' });
        if (chatBusy) return sendJSON(res, 429, { ok: false, error: 'DSH 正在处理上一条消息，请稍候' });
        let content;
        try { content = buildChatContent(message, images); }
        catch (e) { return sendJSON(res, 400, { ok: false, error: String(e.message || e) }); }
        const result = await chatWithDsh(message, images);
        return sendJSON(res, 200, { ok: true, reply: result.reply, timeout: !!result.timeout });
      }
      if (req.method === 'GET' && pathname === '/api/schedule') {
        if (!guardPin(req, res, settings)) return;
        const raw = await readFile(SCHEDULE_PATH, 'utf8');
        return sendJSON(res, 200, JSON.parse(raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw));
      }
      if (req.method === 'POST' && pathname === '/api/schedule') {
        if (!guardPin(req, res, settings)) return;
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
      if (req.method === 'GET' && pathname === '/api/status') {
        // M-2：完整信息（lanIp / 公网地址 / pinSet）只给「Host 为 loopback 且 Origin 可信」的请求；
        // 源 IP 是否 127.0.0.1 不作为依据（本机恶意网页/DNS rebinding 同样来自 loopback IP）
        const cors = corsHeaders(req);
        const local = trustedLocalRequest(req);
        const lanIp = local ? selectLanIPv4(networkInterfaces()) : null;
        return sendJSON(res, 200, {
          ok: true,
          port,
          ...(local ? {
            lanIp,
            lanUrl: lanIp ? `http://${lanIp}:${port}` : null,
            pinSet: pinIsSet(settings),
            // 隧道信息仅本机视角可见：url 为 named tunnel 固定地址（面板据此生成手机二维码）
            ...(TUNNEL_PORT ? { tunnel: { port: TUNNEL_PORT, url: TUNNEL_URL } } : {}),
          } : {}),
        }, cors);
      }
      return sendJSON(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  });
  // WebSocket 通道（/api/chat/watch upgrade）：公网隧道下的首选实时通道（GET SSE 会被 CF 边缘缓冲）
  attachWatchWebSocket(server, wsAdmit, viaTunnel);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, viaTunnel ? '127.0.0.1' : BIND_HOST, () => resolve(server));
  });
}

async function main() {
  // 首启强制随机密码（fail-closed）：从未设置过密码（新部署 / 旧部署无 pin）→ 自动生成
  // 12 位随机字母数字密码，scrypt 哈希落盘；明文只在启动日志展示一次（可经 PC 面板「手机访问」修改）。
  {
    const s = await loadSettings();
    if (!pinIsSet(s)) {
      const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // 去掉易混淆字符（0O1lI）的字母数字表
      let pin = '';
      for (let i = 0; i < 12; i++) pin += abc[randomInt(0, abc.length)];
      s.pinHash = hashPin(pin);
      s.sessions = [];
      await saveSettings(s);
      console.log('mobile-server: 未检测到安全密码，已自动生成随机密码（手机端登录用；可经 PC 面板修改）：');
      console.log(`  安全密码：${pin}`);
    }
  }

  let server = null, port = 0;
  for (let p = BASE_PORT; p < BASE_PORT + 10; p++) {
    try { server = await createServer(p); port = p; break; }
    catch (err) { if (err?.code !== 'EADDRINUSE') throw err; }
  }
  if (!server) { console.error(`mobile-server: 端口 ${BASE_PORT}-${BASE_PORT + 9} 均被占用，启动失败`); process.exit(1); }

  // 隧道回连监听：独立 loopback 端口（默认 3191 起），cloudflared 的 ingress 指向这里。
  // 与直连端口分开，保证「转发头可信域」隔离：cf-connecting-ip 只在此端口被采信。
  for (let p = BASE_PORT + 1; p < BASE_PORT + 10; p++) {
    if (p === port) continue;
    try {
      const ts = await createServer(p, true);
      TUNNEL_PORT = p;
      ts.once('close', () => { TUNNEL_PORT = 0; });
      break;
    } catch (err) { if (err?.code !== 'EADDRINUSE') throw err; }
  }
  TUNNEL_URL = (await loadTunnelInfo())?.url ?? null;
  tunnelStaticUrl = TUNNEL_URL; // named tunnel 固定地址优先；quick tunnel 走日志扫描
  await scanTunnelLog();
  setInterval(scanTunnelLog, 10_000).unref?.();

  // 功能端口落盘（回连端口——管理/关停接口所在处）：DSH 插件据此发送 HTTP shutdown 回收本服务。
  // 直连端口只回引导页（无 API），写功能端口而非直连端口。
  try {
    await mkdir(BIN_CACHE_DIR, { recursive: true });
    const funcPort = TUNNEL_PORT || port;
    await writeFile(join(BIN_CACHE_DIR, 'port'), String(funcPort), 'utf8');
    if (TUNNEL_PORT) await writeFile(join(BIN_CACHE_DIR, 'tunnel-port'), String(TUNNEL_PORT), 'utf8');
  } catch (e) { /* 忽略 */ }

  const lanIp = selectLanIPv4(networkInterfaces());
  console.log('mobile-server: 独立手机访问服务已启动（与 dsh-pocket 无关）');
  startReminderScheduler(); // 系统级通知：服务端定时扫描 + Web Push（有订阅时生效）
  purgeExpired(); // 启动即清扫一次「过期满 3 个月」的日程（到期即失效不渲染，数据保留 3 个月再清）
  setInterval(() => { purgeExpired(); }, 6 * 60 * 60 * 1000); // 之后每 6 小时清扫一次
  console.log(`  直连端口 ${port}：已安全收口——任何来源（含本机）只返回当前 Cloudflare 地址引导页`);
  console.log(`  功能端口（本机）: 127.0.0.1:${TUNNEL_PORT || port}（隧道回连 + 管理接口）${TUNNEL_URL ? `，公网地址: ${TUNNEL_URL}` : ''}`);
  console.log('  电脑端 schedule.html → 「手机访问」面板可显示二维码；Ctrl+C 停止。');

  // 优雅退出：SIGTERM/SIGINT 或 stdin 收到 "shutdown" 行（DSH 插件回收时发送）
  const graceful = (why) => {
    console.log(`mobile-server: ${why}，退出`);
    process.exit(0);
  };
  process.on('SIGTERM', () => graceful('收到 SIGTERM'));
  process.on('SIGINT', () => graceful('收到 SIGINT'));
  if (process.stdin && process.stdin.isTTY === false) {
    // 管道 stdin（插件/守护进程方式启动）时监听 shutdown 指令；直接终端运行时不受影响
    createInterface({ input: process.stdin }).on('line', (line) => {
      if (String(line).trim() === 'shutdown') graceful('收到 shutdown 指令');
    });
  }
}

main().catch((err) => { console.error('mobile-server:', err); process.exit(1); });
