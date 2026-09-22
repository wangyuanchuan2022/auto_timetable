// tunnel-qq-watcher.mjs — 隧道换址/故障监视器（2026-09-14 用户要求：每分钟检查，异常主动报警）
// 分工：守护 v2.1（30s 循环）负责一切 cloudflared 层 remediation；本监视器只做检测与报警：
//   ① URL 变化且新地址健康 → exit 0（主会话发 QQ 通知新地址）；
//   ② 源站侧故障（判据 v3，2026-09-15 收紧）——本地源站不可达/非 200、公网 200 回引导页、
//     公网非 200 但边缘可达（502/504…）→ 连续 2 轮仍故障才 exit 3 报警（宽限避开 mobile-server
//     重启窗口误报）；此档一律不 kick、不重拉——杀 cloudflared 只会轮换 URL 逼用户重扫码；
//   ③ 公网彻底失联（dead）→ 4 分钟宽限后仍无新隧道出生（= 守护本身失能）→ 经 worktable
//     重拉守护（10 分钟节流）；守护活着时 65s 内必自愈，无需本监视器插手。
//   ④ kick 兜底升级（2026-09-14 用户要求，源自 13:38-13:52 坏脚本被兜底原样重拉事故）：kick 后
//     5 分钟仍非健康 → lastgood 备份与守护脚本不同则自动回退 + 重 kick 一次（再给 5 分钟）；
//     回退后仍不健康 / 无备份 / 备份与主脚本相同 → exit 4 显式报警（兜底失效不许静默）。
// 探活：直连 + 本机代理双路；URL 来源：/api/status 优先，tunnel.log 兜底。
// 退出码：0=换址（主会话发 QQ 后重启本监视器）；3=源站引导页态（主会话报警处置后重启）；
//         2=24h 无变化；4=kick 兜底升级失败（主会话立即人工介入报警，修复后重启监视器）。
// 自检：node tunnel-qq-watcher.mjs --selftest 跑升级决策表驱动断言（不探活不拉起不写日志）。
import { readFileSync, appendFileSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url); // ESM 下裸 require 未定义会静默禁用代理路（2026-09-14 修复）
const HERE = dirname(fileURLToPath(import.meta.url));
const TUNNEL_LOG = join(HERE, '..', '.mobile-srv', 'tunnel.log');
const STATUS = 'http://127.0.0.1:3191/api/status';
const SHIM = join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'start-cloudflared.cmd'); // 启动文件夹 shim（路径经 homedir() 拼接，避免硬编码用户名）
const SPAWNER = join(HERE, 'spawn-via-worktable.mjs');
const POLL_MS = 60_000;
const MAX_MS = 24 * 3600_000;
const DEAD_GRACE_MS = 4 * 60_000;
const KICK_THROTTLE_MS = 10 * 60_000;
const KICK_ESCALATE_MS = 5 * 60_000;   // kick 后仍不健康的升级观察窗（2026-09-14 用户要求）
const GUARDIAN = 'D:\\tools\\auto_timetable\\.mobile-srv\\start-cloudflared.cmd';
const GUARDIAN_BAK = GUARDIAN + '.lastgood';
const RESTART_LOG = join(HERE, '..', '.mobile-srv', 'tunnel-restart.log');
const ALARM_LOG = join(HERE, '..', '.mobile-srv', 'watcher-alarm.log');
const TUNNEL_ERR_RE = /Error 1033|Argo Tunnel error/i; // CF 隧道层未连接错误页特征（隧道层故障，可 kick）
const NOTICE_GRACE_MS = 2 * 60_000;                   // 源站侧故障宽限：连续 2 轮仍故障才报警（避开 mobile-server 重启窗口误报）

let proxyAgent = null;
try {
  // DSH 全局安装内的 https-proxy-agent（路径经 os.homedir() 拼接，避免硬编码用户名）
  const dshAgent = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'https-proxy-agent');
  proxyAgent = new (require(dshAgent).HttpsProxyAgent)('http://127.0.0.1:7897');
} catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => new Date(ms).toLocaleString('sv-SE', { hour12: false });

// 三态判据 v3（与 tunnel-probe 同语义，2026-09-15 用户要求收紧）：
//   'ok'     = 本地源站 200 且公网 200 非引导页
//   'notice' = 【源站侧故障】本地源站不可达/非 200、公网 200 引导页、公网非 200 但边缘可达(502/504…)
//              → 只报警不 kick（杀 cloudflared 只会轮换 URL 逼用户重扫码）
//   'dead'   = 【隧道层故障】本地源站健康，但公网完全无 HTTP 响应 / CF 隧道错误页 → 等守护重拉
function classifyPublic(local, pub) {
  if (local !== 200) return 'notice';
  if (pub.status === 200) return String(pub.body).includes('安全地址') ? 'notice' : 'ok';
  if (pub.status !== null) return TUNNEL_ERR_RE.test(String(pub.body)) ? 'dead' : 'notice';
  return 'dead';
}

async function probe(url) {
  // 本地源站探针：不通即源站侧故障（mobile-server 崩溃/重启/繁忙超时都属此类，不该 kick）
  let localStatus = null;
  try {
    const r = await fetch('http://127.0.0.1:3191/api/status', { signal: AbortSignal.timeout(4000) });
    localStatus = r.status;
  } catch {}
  if (localStatus !== 200) return 'notice';
  const verdict = (status, body) => classifyPublic(localStatus, { status, body });
  try {
    const r = await fetch(url + '/api/status', { signal: AbortSignal.timeout(8000) });
    const v = verdict(r.status, await r.text());
    if (v !== 'dead') return v;
  } catch {}
  if (proxyAgent) {
    try {
      return await new Promise((resolve) => {
        const req = require('https').get(url + '/api/status', { agent: proxyAgent }, (res) => {
          let body = '';
          res.on('data', (c) => { if (body.length < 4096) body += c; });
          res.on('end', () => resolve(verdict(res.statusCode, body)));
        });
        req.on('error', () => resolve('dead'));
        req.setTimeout(8000, () => { req.destroy(); resolve('dead'); });
      });
    } catch {}
  }
  return 'dead';
}

function urlFromLog() {
  try {
    const txt = readFileSync(TUNNEL_LOG, 'utf8');
    const m = txt.match(/https:\/\/[a-z-]+\.trycloudflare\.com/g);
    return m ? m[m.length - 1] : null;
  } catch { return null; }
}

async function currentUrl() {
  try {
    const j = await fetch(STATUS, { signal: AbortSignal.timeout(4000) }).then((r) => r.json());
    if (j && j.tunnel && j.tunnel.url) return j.tunnel.url;
  } catch {}
  return urlFromLog();
}

function lastBirthMs() {
  try {
    const txt = readFileSync(TUNNEL_LOG, 'utf8');
    const re = /"time":"([^"]+)","message":"Requesting new quick Tunnel/g;
    let last = null, m;
    while ((m = re.exec(txt))) last = m[1];
    return last ? Date.parse(last) : null;
  } catch { return null; }
}

function kickGuardian(why) {
  console.log(`[watch] ${fmt(Date.now())} KICK guardian via worktable (${why})`);
  try {
    spawn(process.execPath, [SPAWNER, SHIM], { stdio: 'ignore' });
  } catch (e) {
    console.log(`[watch] kick spawn failed: ${e.message}`);
  }
}

// kick 升级决策（纯函数，--selftest 表驱动覆盖）：null=继续观察 / 'rollback'=回退重kick / 'alarm'=exit 4
function decideEscalation({ kickAt, reverted, diff, now = Date.now() }) {
  if (!kickAt || now - kickAt < KICK_ESCALATE_MS) return null;
  if (!reverted && diff) return 'rollback';
  return 'alarm';
}

// 三态：true=内容不同（可回退）/ false=相同（回退无意义）/ null=读不到（备份缺失等）
function filesDiffer(a, b) {
  try {
    const ha = createHash('sha256').update(readFileSync(a)).digest('hex');
    const hb = createHash('sha256').update(readFileSync(b)).digest('hex');
    return ha !== hb;
  } catch { return null; }
}

function appendLog(file, line) {
  try { appendFileSync(file, line + '\n'); } catch {}
}

function escalate(url, reason) {
  const line = `[${new Date().toISOString()}] ESCALATION exit4 url=${url || 'none'} lastKick=${lastKick ? fmt(lastKick) : '-'} :: ${reason}`;
  console.error(`[watch] RESULT: ESCALATION ALARM at ${fmt(Date.now())} - ${reason} — manual intervention required (see ${ALARM_LOG})`);
  appendLog(ALARM_LOG, line);
  process.exitCode = 4;
}

// --selftest：升级决策表驱动断言（含负向：未到期不动、回退仅一次、坏备份/缺备份直通报警）
if (process.argv.includes('--selftest')) {
  const T = 1_000_000;
  const cases = [
    [{ kickAt: T, reverted: false, diff: true, now: T + 1000 }, null, 'not yet due'],
    [{ kickAt: T, reverted: false, diff: true, now: T + KICK_ESCALATE_MS }, 'rollback', 'due + backup differs'],
    [{ kickAt: T, reverted: true, diff: true, now: T + KICK_ESCALATE_MS }, 'alarm', 'already rolled back once'],
    [{ kickAt: T, reverted: false, diff: null, now: T + KICK_ESCALATE_MS }, 'alarm', 'no usable backup'],
    [{ kickAt: T, reverted: false, diff: false, now: T + KICK_ESCALATE_MS }, 'alarm', 'backup identical to script'],
    [{ kickAt: 0, reverted: false, diff: true, now: T + KICK_ESCALATE_MS }, null, 'no kick outstanding'],
  ];
  let fail = 0;
  for (const [input, want, why] of cases) {
    const got = decideEscalation(input);
    if (got !== want) { console.error(`[selftest] FAIL ${why}: want=${want} got=${got}`); fail++; }
  }
  // 三态分类（源站侧一律 'notice'，绝不落入可 kick 的 'dead'）
  const pubCases = [
    [200, { status: 200, body: '{"ok":true}' }, 'ok', 'healthy'],
    [200, { status: 200, body: '请使用安全地址访问' }, 'notice', 'notice page => origin side'],
    [200, { status: 502, body: 'Bad gateway' }, 'notice', 'origin 502 => origin side, never kick'],
    [200, { status: 504, body: 'timeout' }, 'notice', 'origin 504 => origin side'],
    [null, { status: null, body: '' }, 'notice', 'local origin down => origin side'],
    [200, { status: 530, body: 'Error 1033 Argo Tunnel error' }, 'dead', 'CF tunnel error => tunnel layer'],
    [200, { status: null, body: '' }, 'dead', 'no response + local healthy => tunnel layer'],
  ];
  for (const [local, pub, want, why] of pubCases) {
    const got = classifyPublic(local, pub);
    if (got !== want) { console.error(`[selftest] FAIL ${why}: want=${want} got=${got}`); fail++; }
  }
  if (fail) { console.error(`[selftest] ${fail} FAILURES`); process.exit(1); }
  console.log(`[selftest] all ${cases.length} escalation + ${pubCases.length} classify cases pass`);
  process.exit(0);
}

const started = Date.now();
let startUrl = await currentUrl();
console.log(`[watch] baseline url=${startUrl || '(none)'} poll=${POLL_MS / 1000}s max=${MAX_MS / 3600000}h`);
let deadSince = 0;
let lastKick = 0;
let kickAt = 0;        // 本次 kick 的升级观察窗起点（恢复健康即清零）
let reverted = false;  // lastgood 回退只做一次，回退后仍失败直接报警
let noticeSince = 0;   // 源站侧故障起始时刻（连续 2 轮仍故障才报警）

while (Date.now() - started < MAX_MS) {
  await sleep(POLL_MS);
  const url = await currentUrl();
  const v = url ? await probe(url) : 'dead';
  if (v === 'ok') {
    if (startUrl && url !== startUrl) {
      console.log(`[watch] RESULT: tunnel URL CHANGED ${startUrl} -> ${url} (healthy) at ${fmt(Date.now())}`);
      process.exitCode = 0;
      break;
    }
    if (deadSince || kickAt || noticeSince) console.log(`[watch] ${fmt(Date.now())} recovered healthy (same url) — escalation window cleared`);
    deadSince = 0;
    kickAt = 0;
    reverted = false;
    noticeSince = 0;
    continue;
  }
  if (v === 'notice') {
    // 源站侧故障宽限：连续 2 轮仍故障才报警（避开 mobile-server 重启/抖动窗口的误报）
    if (!noticeSince) {
      noticeSince = Date.now();
      console.log(`[watch] ${fmt(Date.now())} origin-side fault detected (local origin unreachable / notice page / edge-reachable error) — grace ${NOTICE_GRACE_MS / 60000}min before alarm`);
    } else if (Date.now() - noticeSince >= NOTICE_GRACE_MS) {
      console.log(`[watch] RESULT: ORIGIN FAULT at ${fmt(Date.now())} - origin-side fault persisted ${Math.round((Date.now() - noticeSince) / 1000)}s (url=${url}); cloudflared/edge presumed FINE; ALARM (do not respawn cloudflared)`);
      process.exitCode = 3;
      break;
    }
    continue;
  }
  // dead 分支
  if (!deadSince) {
    deadSince = Date.now();
    console.log(`[watch] ${fmt(Date.now())} tunnel DEAD (url=${url || 'none'}) — guardian should remediate within ~65s`);
  }
  const down = Date.now() - deadSince;
  const birth = lastBirthMs();
  const noFreshBirth = !birth || birth < deadSince - 60_000;
  if (down > DEAD_GRACE_MS && noFreshBirth && Date.now() - lastKick > KICK_THROTTLE_MS) {
    kickGuardian(`dead ${Math.round(down / 1000)}s with no new tunnel birth — guardian presumed dead`);
    lastKick = Date.now();
    kickAt = Date.now();
    console.log(`[watch] ${fmt(Date.now())} escalation window armed: healthy restore expected within ${KICK_ESCALATE_MS / 60000}min or auto-rollback/alarm`);
  }

  // ④ kick 兜底升级：观察窗到期仍非健康 → 回退 lastgood 重 kick 一次，仍失败或无法回退 → exit 4
  if (kickAt) {
    const diff = filesDiffer(GUARDIAN, GUARDIAN_BAK);
    const action = decideEscalation({ kickAt, reverted, diff });
    if (action === 'rollback') {
      try {
        copyFileSync(GUARDIAN_BAK, GUARDIAN);
        appendLog(RESTART_LOG, `[${new Date().toISOString()}] watcher rollback: post-kick still unhealthy, restored start-cloudflared.cmd from lastgood, re-kicking`);
        console.log(`[watch] ${fmt(Date.now())} post-kick still unhealthy - guardian script differed from lastgood: ROLLED BACK, re-kick`);
        reverted = true;
        kickAt = Date.now();
        kickGuardian('re-kick after lastgood rollback');
      } catch (e) {
        escalate(url, `rollback attempt failed: ${e.message}`);
        break;
      }
    } else if (action === 'alarm') {
      escalate(url, diff === null
        ? 'post-kick still unhealthy and no usable lastgood backup - guardian script presumed broken, rollback impossible'
        : `post-${reverted ? 'rollback' : 'kick'} still unhealthy with backup identical/present - deeper fault (cloudflared binary / network / probe chain)`);
      break;
    }
  }
}

if (process.exitCode === undefined || process.exitCode === null) {
  console.log(`[watch] TIMEOUT 24h: no url change (last=${startUrl}) — relaunch to continue watching`);
  process.exitCode = 2;
}
