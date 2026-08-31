#!/usr/bin/env node
/*
 * mobile-server.mjs — 「本日日程」手机扫码访问 · 独立服务（与 dsh-pocket 完全分离）
 *
 * 职责：
 *   1. 托管手机端页面 mobile.html + 外链脚本（/mobile-app.js、/occur.js）
 *   2. 提供 /api/schedule 读 / 写接口（直接读写同目录 schedule.json，不经 worktable、不经 dsh-pocket）
 *   3. 提供 /api/status 状态接口（本机访问地址）与手机端 DSH 对话桥 / watch 镜像
 *
 * 分层：本文件是服务层 + 进程入口（settings / pin 会话存储调用方 / DSH 对话桥 / Web Push
 * 调度 / MUX 镜像 / watch 流 / WebSocket 传输 / main() 启动）；HTTP 路由分发与纯逻辑
 * （限流桶 / pin 校验 / loopback 判定 / 响应工具）在 ./server-routes.mjs——后者可被
 * 单测独立 import 而不触发本文件的 main()。
 *
 * 用法：
 *   node mobile-server.mjs                 # 监听 0.0.0.0（局域网 / 公网 IP 直连，凭安全密码防护）
 *   node mobile-server.mjs --port 3195
 *
 * 端口说明：默认 3190 起（dsh web 固定 3080；dsh-pocket 代理固定从 3081 起自动占用 3081-3090，
 * 本服务从 3190 起并只向上试探，与两者永不冲撞）。
 */

import http from 'node:http';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, open, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { withSetup, stripSetup } from './chat-setup.mjs';
import TTOccur from './occur.js'; // 共享领域判定核心（与网页端 / Python timetable_core.py 同一语义）
import {
  createRouteDispatcher, checkPin, clientIpOf, pinIsSet, hashPin, isLoopbackHostname,
  sendJSON,
} from './server-routes.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEDULE_PATH = join(HERE, 'schedule.json');
const MOBILE_HTML_PATH = join(HERE, 'mobile.html');
const OCCUR_JS_PATH = join(HERE, 'occur.js'); // 手机页 <script src="/occur.js"> 的静态托管来源
const MOBILE_APP_JS_PATH = join(HERE, 'mobile-app.js'); // 手机页主脚本（自 mobile.html 内联抽离）
// 运行时数据目录：默认 .mobile-srv；TT_DATA_DIR 环境变量可整体重定向
// （settings/subs/fired/port/tunnel-port/tunnel.json/tunnel.log 全部跟随——
//  F-2 等测试用它跑隔离实例，不污染生产目录；schedule.json 属项目数据，不随迁）。
const BIN_CACHE_DIR = process.env.TT_DATA_DIR ? resolve(process.env.TT_DATA_DIR) : join(HERE, '.mobile-srv');
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

/** 到期自动归档（保留 3 个月）：把「截止日期已过满 3 个月」的日程移入 data.archive
 *  （附 archivedAt 时间戳，不再删除数据——判定/搬移走共享纯函数 TTOccur.archiveFor）。 */
async function purgeExpired() {
  try {
    const now = new Date();
    // 日历月往前推 3 个月（Date 自动处理月份下溢；月末溢出如 05-31→02-31 会顺延到 03-03，宁晚勿早）
    const cutoffDate = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
    const cutoff = srvFmtDate(cutoffDate);
    const data = JSON.parse(await readFile(SCHEDULE_PATH, 'utf8'));
    const before = (data.events ?? []).length;
    const next = TTOccur.archiveFor(data, cutoff); // 原样返回同一引用 = 无可归档项
    if (next === data) return 0;
    await atomicWriteFile(SCHEDULE_PATH, JSON.stringify(next, null, 2) + '\n');
    scheduleCache = { at: 0, data: null }; // 失效缓存，下次读取拿新数据
    console.log(`[purge] 已归档 ${before - next.events.length} 条过期满 3 个月（截止早于 ${cutoff}）的日程（剩余 ${next.events.length} 条）`);
    return before - next.events.length;
  } catch (e) {
    console.error('[purge] 到期归档失败:', e?.message || e);
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
    const pinOk = checkPin(req, settings); // 鉴权纯逻辑在 server-routes.mjs
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

  // 路由分发：HTTP 层全部交给 server-routes.mjs（含直连收口 / 静态 / api 各组），
  // 服务层经 deps 注入；TUNNEL_URL/TUNNEL_PORT/chatBusy 为模块级可变量，以 getter 提供。
  const dispatch = createRouteDispatcher({
    port, viaTunnel, HERE, MOBILE_HTML_PATH, SCHEDULE_PATH, OCCUR_JS_PATH, MOBILE_APP_JS_PATH,
    loadSettings, saveSettings,
    getTunnelUrl: () => TUNNEL_URL,
    getTunnelPort: () => TUNNEL_PORT,
    selectLanIPv4: () => selectLanIPv4(networkInterfaces()),
    chatBusy: () => chatBusy,
    ensureChatSession, chatWithDsh, chatHistoryMessages, resetChatSession, dshRpc, DSH_API,
    buildChatContent,
    MUX, watchSessionStream, sseKeepalive, sseAdmit,
    webpush, ensureVapid, loadSubs, saveSubs, safePushEndpoint,
    atomicWriteFile, TTOccur,
  });
  const server = http.createServer(dispatch);
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
  console.log(`  功能端口（本机）: 127.0.0.1:${TUNNEL_PORT || port}（隧道回连 + 管理接口）${TUNNEL_URL ? `，公网地址: ${TUNNEL_URL}` : ''}（LAN ${lanIp || '无'}）`);
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
