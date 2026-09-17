// tunnel-probe.mjs — 隧道健康三态探测器（守护 start-cloudflared.cmd 每循环调用）
//
// 分档判据 v3（2026-09-15 用户要求收紧）——核心原则：【源站侧问题绝不击杀 cloudflared】。
//   背景：v2 判据把「非 200」一律算 dead → 源站 5xx（CF 回 502/504）会被误判为 cloudflared 僵尸
//   而被击杀重拉，每次电脑端服务重启/抖动都可能轮换 URL、逼用户重新扫码（2026-09-15 00:05 疑似案例）。
//
//   本地源站探针（127.0.0.1:3191/api/status）是分档主体：
//     - 本地不通 / 非 200 → 源站侧故障 → exit 3（只报警不击杀）
//       （mobile-server 崩溃、重启窗口、繁忙超时均属此类；重拉 cloudflared 无疗效且会换址）
//     - 本地 200 → 继续判公网
//   公网判据：
//     - 200 且 body 不含引导页签名 → 健康（exit 0）
//     - 200 且含引导页签名「安全地址」→ 源站内容故障（exit 3）
//     - 非 200 但【收到 HTTP 状态码】= 边缘可达、病根在源站/转发层 → exit 3（不击杀）
//     - 例外：Cloudflare 隧道错误页（Error 1033 / Argo Tunnel）= 隧道层未连接
//     - 完全无 HTTP 响应（直连 + 代理两轮皆失败/超时）= 隧道层失联
//       以上两种隧道层情形**不立即击杀**，而是走跨轮窗口（见下）。
//
// 隧道层击杀窗口（v3.1，2026-09-17 用户要求）：守护每 30 秒调用本脚本一次，隧道层失败需
//   **连续 ≥6 轮 且 首败至今 ≥3 分钟**（状态存 .mobile-srv/probe-state.json）才 exit 2 授权击杀；
//   未达阈值一律 exit 0（hold，不动作）——用于吸收公网抖动、代理短暂不可用、边缘连接重建期，
//   消灭 2026-09-15 00:05 那类「十几秒抖动 → 击杀 → 换址 → 用户被迫重扫码」的误杀
//   （v3 之前单次调用内约 10 秒全败即判僵尸——比 30 秒循环更短的窗口）。
//   击杀授权后计数清零，避免连环击杀（v2 曾每 30 秒连杀，见 09-10 22:11 记录）。
//
// 诊断落盘：每次运行输出单行摘要；守护把 stdout/stderr 覆盖写 .mobile-srv/probe.log，
//   供事后回溯「上次为什么这样分档」（v2 输出被重定向到 nul，2026-09-15 事故无法回溯的教训）。
// 自检：node tunnel-probe.mjs --selftest（表驱动跑 classify 分档，含负向用例）。
// 注意：结尾用 process.exitCode 而非 process.exit——exit 会打断未关闭的 fetch 句柄触发
// libuv 断言崩溃（win/async.c），exitCode 让事件循环自然排空后以正确码退出。
import { createRequire } from 'node:module';
import { appendFileSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUS = 'http://127.0.0.1:3191/api/status';
const NOTICE_MARK = '安全地址';                     // 直连收口引导页签名
const TUNNEL_ERR_RE = /Error 1033|Argo Tunnel error/i; // CF 隧道层未连接错误页特征
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 诊断落盘：probe 自己写（不依赖守护重定向——2026-09-15 事故中输出被重定向到 nul，无法回溯分档）
// 每轮一行，超 256KB 清空重写（保留最近约 2000 轮 ≈ 17 小时）
const PROBE_LOG = join(dirname(fileURLToPath(import.meta.url)), '..', '.mobile-srv', 'probe.log');
function writeProbeLog(line) {
  try {
    try { if (statSync(PROBE_LOG).size > 256 * 1024) writeFileSync(PROBE_LOG, ''); } catch {}
    appendFileSync(PROBE_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

// ---- 隧道层击杀窗口（v3.1）：跨轮累计，吸收短暂抖动 ----
const TUNNEL_FAIL_ROUNDS = 6;              // 连续失败轮数下限（守护 30s 一轮 ≈ 3 分钟）
const TUNNEL_FAIL_WINDOW_MS = 3 * 60_000;  // 首败至今时间窗下限（与轮数双条件，防高频调用误判）
const PROBE_STATE = join(dirname(fileURLToPath(import.meta.url)), '..', '.mobile-srv', 'probe-state.json');

function readState() {
  try { return JSON.parse(readFileSync(PROBE_STATE, 'utf8')) || {}; } catch { return {}; }
}
function writeState(s) {
  try { writeFileSync(PROBE_STATE, JSON.stringify(s)); } catch {}
}
/** 纯函数：隧道层失败累计决策（--selftest 覆盖）；state=上次状态，返回本次判定与累计计数。 */
function decideTunnelKill(state, now = Date.now()) {
  const prev = (state && Number.isFinite(state.fails) && state.fails > 0) ? state : { fails: 0, firstFailAt: 0 };
  const fails = prev.fails + 1;
  const firstFailAt = prev.firstFailAt || now;
  const windowMs = now - firstFailAt;
  const kill = fails >= TUNNEL_FAIL_ROUNDS && windowMs >= TUNNEL_FAIL_WINDOW_MS;
  return { kill, fails, firstFailAt, windowMs };
}

const require = createRequire(import.meta.url); // ESM 下裸 require 未定义会静默禁用代理双路（2026-09-14 修复）
let agent = null;
try {
  agent = new (require('C:/Users/ycwan/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/https-proxy-agent').HttpsProxyAgent)('http://127.0.0.1:7897');
} catch {}

/**
 * 纯函数分档（--selftest 表驱动覆盖）：
 *   local：本地源站 /api/status 的 HTTP 状态码（null = 完全无响应）
 *   pub：公网探测结果 { status: number|null, body: string }
 *   返回 { code, tier, why }：0=健康 / 2=隧道层僵尸（可击杀重拉）/ 3=源站侧故障（只报警）
 */
function classify(local, pub) {
  if (local !== 200) {
    return { code: 3, tier: 'origin', why: `origin-side: local origin status=${local === null ? 'unreachable' : local}` };
  }
  if (pub.status === 200) {
    return String(pub.body).includes(NOTICE_MARK)
      ? { code: 3, tier: 'origin', why: 'origin-side: public serves the notice page (200)' }
      : { code: 0, tier: 'ok', why: 'healthy' };
  }
  if (pub.status !== null) {
    return TUNNEL_ERR_RE.test(String(pub.body))
      ? { code: 2, tier: 'tunnel', why: `tunnel-layer: CF tunnel error page (status ${pub.status})` }
      : { code: 3, tier: 'origin', why: `origin-side: edge reachable but public status ${pub.status}` };
  }
  return { code: 2, tier: 'tunnel', why: 'zombie: no HTTP response via direct+proxy' };
}

// --selftest：分档表驱动断言（含负向：源站侧任一形态都不得落入 exit 2）
if (process.argv.includes('--selftest')) {
  const cases = [
    [200, { status: 200, body: '{"ok":true,"port":3191}' }, 0, 'healthy json'],
    [200, { status: 200, body: '<html>请使用安全地址访问</html>' }, 3, 'notice page'],
    [200, { status: 530, body: '<html>Error 1033 Argo Tunnel error</html>' }, 2, 'CF tunnel error page'],
    [200, { status: null, body: '' }, 2, 'no response at all'],
    [200, { status: 502, body: 'Bad gateway (Error 502)' }, 3, 'origin 502 must NOT be respawned'],
    [200, { status: 504, body: 'gateway timeout' }, 3, 'origin 504 must NOT be respawned'],
    [200, { status: 500, body: 'internal error' }, 3, 'unknown 5xx conservative: origin'],
    [200, { status: 503, body: 'service unavailable' }, 3, 'unknown 503 conservative: origin'],
    [null, { status: null, body: '' }, 3, 'local origin down => origin side, never respawn'],
    [null, { status: 502, body: 'Bad gateway' }, 3, 'local down wins: origin side'],
    [500, { status: 200, body: '{"ok":true}' }, 3, 'local non-200 => origin side'],
    [200, { status: 404, body: 'not found' }, 3, 'edge reachable 404 => origin side'],
  ];
  let fail = 0;
  for (const [local, pub, want, why] of cases) {
    const got = classify(local, pub).code;
    if (got !== want) { console.error(`[selftest] FAIL ${why}: want=${want} got=${got}`); fail++; }
  }
  // 隧道层击杀窗口状态机（含负向：轮数够但窗口不够 / 窗口够但轮数不够，都不得击杀）
  const T = 1_000_000;
  const tk = [
    [{ fails: 0, firstFailAt: 0 }, T, false, 'first tunnel-layer failure holds'],
    [{ fails: 4, firstFailAt: T }, T + 60_000, false, '5th round but 60s window holds'],
    [{ fails: 5, firstFailAt: T }, T + 60_000, false, '6 rounds but window below 3min holds'],
    [{ fails: 5, firstFailAt: T }, T + TUNNEL_FAIL_WINDOW_MS, true, '6 rounds + 3min window authorizes kill'],
    [{ fails: 2, firstFailAt: T }, T + 10 * 60_000, false, 'long window but only 3 rounds holds'],
  ];
  for (const [state, now, want, why] of tk) {
    const got = decideTunnelKill(state, now).kill;
    if (got !== want) { console.error(`[selftest] FAIL ${why}: want=${want} got=${got}`); fail++; }
  }
  if (fail) { console.error(`[selftest] ${fail} FAILURES`); process.exit(1); }
  console.log(`[selftest] all ${cases.length} classify + ${tk.length} tunnel-window cases pass`);
  process.exit(0);
}

/** 公网探测（直连 + 代理双路）：返回 { status, body }；两路皆失败时 status=null。 */
async function probePublic(url) {
  try {
    const r = await fetch(url + '/api/status', { signal: AbortSignal.timeout(6000) });
    return { status: r.status, body: await r.text() };
  } catch {}
  if (agent) {
    try {
      return await new Promise((resolve) => {
        const req = require('https').get(url + '/api/status', { agent }, (res) => {
          let body = '';
          res.on('data', (c) => { if (body.length < 4096) body += c; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', () => resolve({ status: null, body: '' }));
        req.setTimeout(6000, () => { req.destroy(); resolve({ status: null, body: '' }); });
      });
    } catch {}
  }
  return { status: null, body: '' };
}

// ---- 主流程 ----
// 1) 本地源站探针（同时取隧道 URL）
let localStatus = null;
let url = null;
try {
  const r = await fetch(STATUS, { signal: AbortSignal.timeout(4000) });
  localStatus = r.status;
  if (r.status === 200) {
    const j = await r.json().catch(() => null);
    url = j?.tunnel?.url ?? null;
  }
} catch {}

if (localStatus === 200 && !url) {
  // 源站健康但隧道 URL 未注册：可能 cloudflared 正在启动/注册中——不动作（与 v2 语义一致）
  writeState({ fails: 0, firstFailAt: 0 });
  const line = '[probe] local=200 public=n/a verdict=0 (origin healthy, tunnel url not registered yet - no action)';
  console.log(line);
  writeProbeLog(line);
  process.exitCode = 0;
} else if (localStatus !== 200) {
  const v = classify(localStatus, { status: null, body: '' });
  writeState({ fails: 0, firstFailAt: 0 }); // 源站侧故障不计入隧道层失败计数
  const line = `[probe] local=${localStatus === null ? 'unreachable' : localStatus} public=n/a verdict=${v.code} (${v.why})`;
  console.log(line);
  writeProbeLog(line);
  if (v.code === 3) {
    const l2 = '[origin-fault] local origin unreachable/non-200 - mobile-server side fault, do NOT respawn cloudflared; alarm upstream';
    console.log(l2);
    writeProbeLog(l2);
  }
  process.exitCode = v.code;
} else {
  // 2) 公网两轮探测：取「最好」结果（ok > 有响应 > 无响应），避免单次抖动误分档
  let pub = { status: null, body: '' };
  for (let round = 0; round < 2; round++) {
    if (round > 0) await sleep(4000);
    const r = await probePublic(url);
    if (r.status === 200 && !String(r.body).includes(NOTICE_MARK)) { pub = r; break; } // 健康，直接采信
    if (r.status !== null) pub = r;            // 有响应（非 200 / 引导页）：记录，继续下一轮看能否恢复
    else if (pub.status === null) pub = r;     // 仍无响应：保持「无响应」态
  }
  const v = classify(localStatus, pub);
  const line = `[probe] local=${localStatus} public=${pub.status === null ? 'no-response' : pub.status} verdict=${v.code} (${v.why})`;
  console.log(line);
  writeProbeLog(line);
  if (v.code === 3) {
    writeState({ fails: 0, firstFailAt: 0 }); // 源站侧故障：清零隧道层计数（它不属于隧道层问题）
    const l2 = '[origin-fault] origin-side fault (local origin ok but public not healthy) - cloudflared/edge FINE, do NOT respawn; alarm upstream';
    console.log(l2);
    writeProbeLog(l2);
    process.exitCode = 3;
  } else if (v.code === 2) {
    // 隧道层失败：跨轮累计，未达窗口不动作（吸收抖动/边缘重建期）
    const d = decideTunnelKill(readState(), Date.now());
    const base = `[tunnel-layer] ${v.why}`;
    if (d.kill) {
      writeState({ fails: 0, firstFailAt: 0 }); // 授权击杀后清零，避免连环击杀
      const l2 = `${base} | persisted ${d.fails} rounds / ${Math.round(d.windowMs / 1000)}s (>=${TUNNEL_FAIL_ROUNDS} rounds & >=${TUNNEL_FAIL_WINDOW_MS / 60000}min) - KILL+RESPAWN authorized: ${url}`;
      console.log(l2);
      writeProbeLog(l2);
      process.exitCode = 2;
    } else {
      writeState({ fails: d.fails, firstFailAt: d.firstFailAt });
      const l2 = `${base} | round ${d.fails}/${TUNNEL_FAIL_ROUNDS}, window ${Math.round(d.windowMs / 1000)}s/${TUNNEL_FAIL_WINDOW_MS / 1000}s - transient suspected, HOLD (no kill)`;
      console.log(l2);
      writeProbeLog(l2);
      process.exitCode = 0;
    }
  } else {
    writeState({ fails: 0, firstFailAt: 0 }); // 健康：清零计数
    process.exitCode = 0;
  }
}
