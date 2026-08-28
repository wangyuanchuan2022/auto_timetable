#!/usr/bin/env node
/*
 * mobile-server.mjs — 「本日日程」手机扫码访问 · 独立服务（与 dsh-pocket 完全分离）
 *
 * 职责：
 *   1. 托管手机端页面 mobile.html（http://<局域网IP>:<port>/）
 *   2. 提供 /api/schedule 读 / 写接口（直接读写同目录 schedule.json，不经 worktable、不经 dsh-pocket）
 *   3. 提供 /api/status 状态接口（局域网地址；--public 时附带自建 cloudflared 公网隧道地址）
 *
 * 用法：
 *   node mobile-server.mjs            # 局域网模式
 *   node mobile-server.mjs --public   # 额外开启公网隧道（cloudflared，缓存独立于 dsh-pocket）
 *   node mobile-server.mjs --port 3195
 *
 * 端口说明：默认 3190 起（dsh web 固定 3080；dsh-pocket 代理固定从 3081 起自动占用 3081-3090，
 * 本服务从 3190 起并只向上试探，与两者永不冲撞）。
 */

import http from 'node:http';
import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEDULE_PATH = join(HERE, 'schedule.json');
const MOBILE_HTML_PATH = join(HERE, 'mobile.html');
const BIN_CACHE_DIR = join(HERE, '.mobile-srv');
const SETTINGS_PATH = join(BIN_CACHE_DIR, 'settings.json'); // 安全密码仅存本机此文件
const SUBS_PATH = join(BIN_CACHE_DIR, 'push-subscriptions.json'); // Web Push 订阅（每设备一条）
const FIRED_PATH = join(BIN_CACHE_DIR, 'remind-fired.json'); // 服务端已推送的提醒键（48h 清理）

const args = process.argv.slice(2);
const WANT_PUBLIC = args.includes('--public');
const portArg = args.indexOf('--port');
const BASE_PORT = portArg > -1 ? (parseInt(args[portArg + 1], 10) || 3190) : 3190;
const hostArg = args.indexOf('--host');
const BIND_HOST = hostArg > -1 ? String(args[hostArg + 1] || '0.0.0.0') : '0.0.0.0'; // 可 --host 127.0.0.1 仅本机

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
async function saveSettings(s) {
  await mkdir(BIN_CACHE_DIR, { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf8');
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
const COOKIE_NAME = 'tt_pin_v2'; // HttpOnly 登录 Cookie（SameSite=Strict），取代 URL 携带密码
const PIN_COOKIE = (pin) => createHash('sha256').update('tt-cookie:' + String(pin)).digest('hex');

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// 客户端真实 IP（参照 dsh-pocket proxy.mjs clientIp()）：公网经 cloudflared 隧道时，
// 所有连接在 socket 层都来自 cloudflared 的本机回环地址——若按 remoteAddress 计数，
// 全部公网访客会挤进同一个「127.0.0.1」桶（SSE 每 IP 上限 / 登录限速全部共享，互相锁死）。
// cloudflared 会把 Cloudflare 边缘见到的真实客户端 IP 写入 cf-connecting-ip（可信、不可伪造），
// 优先取它；**不信任客户端自带的 x-forwarded-for**（可伪造）。
function clientIpOf(req) {
  const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
  if (cf) return cf;
  return String(req.socket.remoteAddress ?? '') || 'unknown';
}

/** 每 IP 密码尝试限速：60 秒窗口 5 次，超限锁定 10 分钟（429 + 剩余秒数）。 */
const RATE = { hits: new Map() };
function rateState(ip) {
  const now = Date.now();
  let r = RATE.hits.get(ip);
  if (!r || now > r.resetAt) { r = { count: 0, resetAt: now + 60_000, lockedUntil: 0 }; RATE.hits.set(ip, r); }
  return r;
}
function rateLocked(ip) {
  const r = rateState(ip);
  const now = Date.now();
  return r.lockedUntil > now ? Math.ceil((r.lockedUntil - now) / 1000) : 0;
}
function rateFail(ip) {
  const r = rateState(ip);
  r.count += 1;
  if (r.count >= 5) { r.lockedUntil = Date.now() + 600_000; r.count = 0; }
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
  if (!settings.pin) return { ok: true }; // 未设密码 → 放行
  const ip = clientIpOf(req);
  const retryAfter = rateLocked(ip);
  if (retryAfter > 0) return { ok: false, status: 429, retryAfter, error: `尝试次数过多，请 ${retryAfter} 秒后再试` };
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME] ?? '';
  const header = String(req.headers['x-tt-pin'] ?? '');
  const expect = PIN_COOKIE(settings.pin);
  const expectPin = createHash('sha256').update(String(settings.pin)).digest('hex');
  let ok = false;
  if (cookie) {
    const a = createHash('sha256').update(String(cookie)).digest();
    const b = createHash('sha256').update(expect).digest();
    ok = timingSafeEqual(a, b);
  } else if (header) {
    const a = createHash('sha256').update(String(header)).digest('hex');
    ok = timingSafeEqual(Buffer.from(a), Buffer.from(expectPin));
  }
  if (ok) { rateClear(ip); return { ok: true }; }
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

/** 旧版 loopback IP 判定（保留用于日志/兜底）。 */
function isLoopback(req) {
  const ra = String(req.socket.remoteAddress ?? '');
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

// ---------- cloudflared（可选公网隧道；缓存目录独立，不用 dsh-pocket 的缓存） ----------
const TUNNEL = { process: null, url: null, detail: '', phase: 'idle' };

function findInPath(bin) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, [bin], { timeout: 4000 }, (err, stdout) => {
      resolve(!err && stdout ? stdout.split(/\r?\n/)[0].trim() : null);
    });
  });
}

// M-4：下载加固——仅允许 GitHub 域（含重定向目标）、100MB 上限、120 秒超时
const GITHUB_HOST_RE = /(^|\.)github(usercontent)?\.com$/i;
const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

function httpsDownload(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    let u;
    try { u = new URL(url); } catch { return reject(new Error('invalid url')); }
    if (u.protocol !== 'https:' || !GITHUB_HOST_RE.test(u.hostname)) {
      return reject(new Error(`download host not allowed: ${u.hostname}`));
    }
    const req = https.get(url, { headers: { 'User-Agent': 'auto-timetable-mobile-server' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        if (!GITHUB_HOST_RE.test(new URL(next).hostname)) { req.destroy(); return reject(new Error(`redirect host not allowed: ${new URL(next).hostname}`)); }
        clearTimeout(timer);
        return resolve(httpsDownload(next, dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); clearTimeout(timer); return reject(new Error('download failed: HTTP ' + res.statusCode)); }
      const declared = parseInt(res.headers['content-length'] ?? '0', 10);
      if (declared > DOWNLOAD_MAX_BYTES) { res.destroy(); clearTimeout(timer); return reject(new Error('download too large')); }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > DOWNLOAD_MAX_BYTES) { res.destroy(); clearTimeout(timer); return reject(new Error('download too large')); }
        chunks.push(c);
      });
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    }).on('error', (e) => { clearTimeout(timer); reject(e); });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('download timeout')); }, 120_000);
  });
}

async function ensureCloudflared() {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const fromPath = await findInPath(exe);
  if (fromPath) return fromPath;
  const cached = join(BIN_CACHE_DIR, exe);
  try { await access(cached); return cached; } catch { /* 未缓存 */ }
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const plat = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${plat}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;
  console.log(`mobile-server: 首次下载 cloudflared（约 20MB，缓存于 ${BIN_CACHE_DIR}）…`);
  TUNNEL.phase = 'downloading';
  const buf = await httpsDownload(url, cached);
  await mkdir(BIN_CACHE_DIR, { recursive: true });
  await writeFile(cached, buf);
  return cached;
}

async function startTunnel(port) {
  if (TUNNEL.process || TUNNEL.phase === 'starting' || TUNNEL.phase === 'registering' || TUNNEL.phase === 'downloading') return;
  TUNNEL.phase = 'starting';
  TUNNEL.detail = '启动隧道进程…';
  const bin = await ensureCloudflared();
  const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  TUNNEL.process = child;
  TUNNEL.phase = 'registering';
  TUNNEL.detail = '连接 Cloudflare 边缘（通常 5-30 秒）…';
  const onLog = (chunk) => {
    const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m && !TUNNEL.url) {
      TUNNEL.url = m[0];
      TUNNEL.phase = 'ready';
      TUNNEL.detail = '隧道就绪';
      console.log(`mobile-server: 公网隧道就绪 ${TUNNEL.url}`);
    }
  };
  child.stdout.on('data', onLog);
  child.stderr.on('data', onLog);
  child.on('exit', (code) => {
    TUNNEL.process = null;
    TUNNEL.url = null;
    TUNNEL.phase = 'error';
    TUNNEL.detail = `隧道进程退出（code=${code}）`;
  });
}

function stopTunnel() {
  if (TUNNEL.process) {
    try { TUNNEL.process.kill(); } catch { /* 忽略 */ }
    TUNNEL.process = null;
  }
  TUNNEL.url = null;
  TUNNEL.phase = 'idle';
  TUNNEL.detail = '';
}

// ---------- DSH 对话桥：以 loopback 身份调用本机 dsh web 的共享 /api RPC ----------
// 手机端输入框 → 本服务 POST /api/chat → session.prompt 送入电脑端 DSH 专属会话
// （cwd = 本目录，即可直接编辑 schedule.json）→ 轮询 session.history 取助手回复。
const DSH_API = process.env.DSH_API_URL || `http://127.0.0.1:${process.env.DSH_PORT || 3080}`;
const CHAT_INSTRUCTION =
  '你是「智能时间表」的日程管理助手（由手机端对话入口调用）。工作目录就是日程表所在目录，' +
  '你的任务：按用户指示查看与编辑 schedule.json（事件分 weekly/once/custom 三类，字段说明见 README.md），' +
  '可直接读写文件。回复要求：用简短中文（手机屏幕阅读），只说明你做了什么修改或直接回答日程问题，不要输出多余内容。';
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

/** 丢弃并重建专属会话（历史含图片块且模型不支持时自愈）。 */
async function resetChatSession(settings) {
  settings.chatSessionId = undefined;
  settings.chatInited = false;
  await saveSettings(settings);
  const created = await dshRpc('session.create', { cwd: HERE });
  settings.chatSessionId = created.sessionId;
  settings.chatInited = false;
  await saveSettings(settings);
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
  const plainText = inited ? String(message) : `${CHAT_INSTRUCTION}\n\n（以上为系统设定。下面是用户消息：）\n${message}`;
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
    out.push({ role: e.type === 'user/message' ? 'user' : 'assistant', text, seq: e.seq ?? 0 });
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
      if (text) frames.push({ t: 'message', role: e.type === 'user/message' ? 'user' : 'assistant', text, seq: e.seq ?? 0 });
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

async function loadSubs() {
  try { return JSON.parse(await readFile(SUBS_PATH, 'utf8')); } catch { return []; }
}
async function saveSubs(list) {
  await mkdir(BIN_CACHE_DIR, { recursive: true });
  await writeFile(SUBS_PATH, JSON.stringify(list, null, 2), 'utf8');
}

async function pushToAll(payloadObj) {
  const subs = await loadSubs();
  if (!subs.length || !webpush) return;
  const vapid = await ensureVapid(await loadSettings());
  if (!vapid) return;
  const dead = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(s, JSON.stringify(payloadObj), {
        vapidDetails: { subject: 'mailto:auto-timetable@local', publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: 3600,
      });
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(s); // 订阅失效 → 移除
    }
  }));
  if (dead.length) await saveSubs(subs.filter((s) => !dead.includes(s)));
}

// —— 服务端事件判定（与手机端同规则：weekly / once / custom；本地墙上时间） ——
function srvIsoWeekday(d) { return (d.getDay() + 6) % 7 + 1; }
function srvFmtDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function srvToMin(hhmm) { const p = String(hhmm || '0:0').split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
function srvFmtMin(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function srvParseDate(s) { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function srvOccursOn(ev, day) {
  const ds = srvFmtDate(day);
  const type = ev.type || 'once';
  if (type === 'weekly') return srvIsoWeekday(day) === (ev.weekday || 1);
  if (type === 'once') return ev.date === ds;
  if (type === 'custom') {
    const r = ev.repeat || {};
    if (!r.start || ds < r.start) return false;
    if (r.until && ds > r.until) return false;
    const s = srvParseDate(r.start);
    const diffDays = Math.round((day - s) / 86400000);
    if (diffDays < 0) return false;
    const interval = Math.max(1, parseInt(r.interval, 10) || 1);
    const unit = r.unit || 'day';
    if (unit === 'day') return diffDays % interval === 0;
    if (unit === 'week') {
      const weekDiff = Math.floor(diffDays / 7);
      if (weekDiff % interval !== 0) return false;
      if (Array.isArray(r.days) && r.days.length) return r.days.indexOf(srvIsoWeekday(day)) !== -1;
      return srvIsoWeekday(day) === srvIsoWeekday(s);
    }
    if (unit === 'month') {
      const months = (day.getFullYear() - s.getFullYear()) * 12 + (day.getMonth() - s.getMonth());
      if (months % interval !== 0) return false;
      return day.getDate() === s.getDate();
    }
  }
  return false;
}

async function loadFired() { try { return JSON.parse(await readFile(FIRED_PATH, 'utf8')); } catch { return {}; } }
async function saveFired(m) {
  await mkdir(BIN_CACHE_DIR, { recursive: true });
  await writeFile(FIRED_PATH, JSON.stringify(m), 'utf8');
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
          const lead = Number.isFinite(parseFloat(ev.remindLead)) && parseFloat(ev.remindLead) > 0 ? parseFloat(ev.remindLead) : 20;
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
          fired[key] = Date.now();
          changed = true;
          await pushToAll({
            title: '⏰ 日程提醒',
            body: `${ev.title || '(未命名)'} ${ev.start}–${ev.end}${ev.location ? ' · ' + ev.location : ''}（约 ${Math.max(1, Math.round(s - nowMin))} 分钟后开始）`,
            tag: key,
            url: '/',
          });
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
      if (text) l.send({ t: 'message', role: ev.type === 'user/message' ? 'user' : 'assistant', text, seq: ev.seq ?? 0 });
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
/** SSE 心跳：每 15 秒下发 `: ping` 注释行——防 NAT/代理空闲超时静默掐线（dsh-pocket PR#41 同思路的 SSE 版）。 */
function sseKeepalive(req, res, isClosed, onDead) {
  const timer = setInterval(() => {
    if (isClosed()) { clearInterval(timer); return; }
    try { res.write(': ping\n\n'); } catch (e) { clearInterval(timer); onDead?.(); }
  }, 15_000);
  timer.unref?.();
  return timer;
}

/**
 * 启动一条 watch 会话流（已通过鉴权与限流）。
 * @returns 停止函数（清理兜底轮询与 listener 注册由调用方负责 listener 注册外的部分）
 */
async function watchSessionStream(sid, send, listener) {
  // 连接即快照：完整过程（消息 / 思考 / 工具入参与输出）按 seq 下发（手机端按 seq 去重，幂等）
  try {
    for (const f of await chatHistoryFrames(sid)) send(f);
  } catch (e) { send({ t: 'error', error: String(e?.message ?? e) }); }
  send({ t: 'hello' });
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

// ---------- 最小 WebSocket 服务端（无第三方依赖；dsh-pocket 用 WS 过 Cloudflare 隧道推送实时流） ----------
// 为什么公网必须走 WS：实测 quick tunnel 会缓冲无 Content-Length 的 GET SSE 流式响应体
// （首帧延迟可达 100 秒以上，手机端长时间收不到任何数据）；WebSocket 帧不被缓冲，
// 且支持协议层心跳（Ping/Pong）保活——与 dsh-pocket 透传 /api/events.mux 的做法一致。
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
function attachWatchWebSocket(server, sseAdmitLike) {
  server.on('upgrade', async (req, socket, head) => {
    let pathname = '/';
    try { pathname = new URL(req.url ?? '/', 'http://x').pathname; } catch { /* 忽略 */ }
    if (pathname !== '/api/chat/watch') { try { socket.destroy(); } catch (e) {} return; }
    const key = String(req.headers['sec-websocket-key'] ?? '');
    if (!key) { try { socket.destroy(); } catch (e) {} return; }
    // 鉴权与限流（Cookie 随同源 WS 握手自动携带；cf-connecting-ip 已纳入真实 IP 计数）
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
    // 连续 2 个周期零入站字节（链路被静默丢弃）→ 主动断开让浏览器触发重连
    let alive = true;
    const hb = setInterval(() => {
      if (closed) return;
      if (!alive) { cleanup(); return; }
      alive = false;
      sendRaw(wsEncodeFrame(0x9, Buffer.alloc(0)));
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
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
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

async function createServer(port) {
  // 流式连接上限（SSE + WebSocket 统一计数）：单 IP ≤4、全局 ≤16（防慢速连接耗尽资源）。
  // IP 取 cf-connecting-ip 优先（公网隧道下每个真实访客独立配额；cloudflared 本机回环不再共享一个桶）。
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
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    try {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/mobile.html' || pathname === '/index.html')) {
        const html = await readFile(MOBILE_HTML_PATH);
        return send(res, 200, html, {
          'content-type': 'text/html; charset=utf-8',
          // CSP：限制连接源为本站（防外泄），图片允许 data:/blob:（压缩预览）
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'",
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
          if (pin && !/^\S{6,64}$/.test(pin)) return sendJSON(res, 400, { ok: false, error: '密码需为 6-64 位、不含空格' });
          // 已设密码时，设置/清除都必须先验证旧密码（防本机恶意页面篡改）
          if (settings.pin) {
            const oldOk = String(body.oldPin ?? '') === settings.pin;
            if (!oldOk) return sendJSON(res, 403, { ok: false, error: '需要提供当前密码才能修改或清除' });
          }
          if (pin) settings.pin = pin; else delete settings.pin; // 空串 = 清除密码
          await saveSettings(settings);
          console.log(`mobile-server: 安全密码已${pin ? '设置' : '清除'}（仅存本机）`);
          return sendJSON(res, 200, { ok: true, pinSet: !!pin }, corsHeaders(req));
        }
        if (req.method === 'POST' && pathname === '/api/admin/tunnel') {
          const body = JSON.parse(await readBody(req, 64 * 1024));
          if (body.on === true) {
            if (!settings.pin) return sendJSON(res, 400, { ok: false, error: '请先设置安全密码再开启公网隧道' });
            await startTunnel(port);
          } else {
            stopTunnel();
          }
          return sendJSON(res, 200, { ok: true }, corsHeaders(req));
        }
        if (req.method === 'POST' && pathname === '/api/admin/shutdown') {
          // DSH 插件回收时调用（loopback 栅栏保护）：先关隧道再优雅退出
          sendJSON(res, 200, { ok: true }, corsHeaders(req));
          setTimeout(() => {
            try { stopTunnel(); } catch (e) { /* 忽略 */ }
            console.log('mobile-server: 收到 shutdown 请求，退出');
            process.exit(0);
          }, 100);
          return;
        }
        return sendJSON(res, 404, { ok: false, error: 'not found' });
      }

      // ---- 登录：验证密码后种 HttpOnly Cookie（取代 ?pin= 与 localStorage 存密码） ----
      const settings = await loadSettings();
      if (req.method === 'POST' && pathname === '/api/login') {
        const body = JSON.parse(await readBody(req, 16 * 1024));
        const given = String(body.pin ?? '');
        if (!settings.pin) return sendJSON(res, 400, { ok: false, error: '未设置安全密码' });
        const ip = clientIpOf(req);
        const lock = rateLocked(ip);
        if (lock > 0) return sendJSON(res, 429, { ok: false, error: `尝试次数过多，请 ${lock} 秒后再试`, retryAfter: lock }, { 'retry-after': String(lock) });
        const a = createHash('sha256').update(given).digest('hex');
        const b = createHash('sha256').update(String(settings.pin)).digest('hex');
        if (!given || !timingSafeEqual(Buffer.from(a), Buffer.from(b))) {
          rateFail(ip);
          const left = rateLocked(ip);
          return sendJSON(res, left > 0 ? 429 : 401, { ok: false, error: left > 0 ? `密码错误次数过多，锁定 ${left} 秒` : '密码错误' , ...(left > 0 ? { retryAfter: left } : {}) }, left > 0 ? { 'retry-after': String(left) } : {});
        }
        rateClear(ip);
        return send(res, 200, JSON.stringify({ ok: true }), {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': `${COOKIE_NAME}=${PIN_COOKIE(settings.pin)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 3600}`,
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
      // ---- PWA 静态资源：Service Worker / manifest / 图标 ----
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
        await writeFile(SCHEDULE_PATH, body.content, 'utf8');
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
            pinSet: !!settings.pin,
            public: { running: !!TUNNEL.url, url: TUNNEL.url, phase: TUNNEL.phase, detail: TUNNEL.detail },
          } : {}),
        }, cors);
      }
      return sendJSON(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  });
  // WebSocket 通道（/api/chat/watch upgrade）：公网隧道下的首选实时通道（GET SSE 会被 CF 边缘缓冲）
  attachWatchWebSocket(server, wsAdmit);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, () => resolve(server));
  });
}

async function main() {
  let server = null, port = 0;
  for (let p = BASE_PORT; p < BASE_PORT + 10; p++) {
    try { server = await createServer(p); port = p; break; }
    catch (err) { if (err?.code !== 'EADDRINUSE') throw err; }
  }
  if (!server) { console.error(`mobile-server: 端口 ${BASE_PORT}-${BASE_PORT + 9} 均被占用，启动失败`); process.exit(1); }

  // 实际监听端口落盘：DSH 插件据此发送 HTTP shutdown 回收本服务
  try { await mkdir(BIN_CACHE_DIR, { recursive: true }); await writeFile(join(BIN_CACHE_DIR, 'port'), String(port), 'utf8'); } catch (e) { /* 忽略 */ }

  const lanIp = selectLanIPv4(networkInterfaces());
  console.log('mobile-server: 独立手机访问服务已启动（与 dsh-pocket 无关）');
  startReminderScheduler(); // 系统级通知：服务端定时扫描 + Web Push（有订阅时生效）
  console.log(`  局域网地址: ${lanIp ? `http://${lanIp}:${port}` : '（未检测到可用局域网 IPv4）'}`);
  if (WANT_PUBLIC) {
    const settings = await loadSettings();
    if (!settings.pin) {
      console.warn('mobile-server: 尚未设置安全密码，公网隧道不自动开启；请先在电脑端面板设置密码，再点「打开公网隧道」');
    } else {
      try { await startTunnel(port); } catch (err) {
        TUNNEL.phase = 'error';
        TUNNEL.detail = String(err?.message ?? err);
        console.error('mobile-server: 公网隧道启动失败:', TUNNEL.detail);
      }
    }
  } else {
    console.log('  公网隧道: 未开启（面板按钮或 --public 开启；开启前需设置安全密码）');
  }
  console.log('  电脑端 schedule.html → 「手机访问」面板可显示两个二维码；Ctrl+C 停止。');

  // 优雅退出：SIGTERM/SIGINT 或 stdin 收到 "shutdown" 行（DSH 插件回收时发送）
  // ——先关公网隧道（避免 cloudflared 孤儿进程）再退出
  const graceful = (why) => {
    console.log(`mobile-server: ${why}，关闭公网隧道并退出`);
    try { stopTunnel(); } catch (e) { /* 忽略 */ }
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
