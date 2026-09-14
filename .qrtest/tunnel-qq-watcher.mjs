// tunnel-qq-watcher.mjs — 隧道换址/故障监视器（2026-09-14 用户要求：每分钟检查，异常主动报警）
// 分工：守护 v2.1（30s 循环）负责一切 cloudflared 层 remediation；本监视器只做检测与报警：
//   ① URL 变化且新地址健康 → exit 0（主会话发 QQ 通知新地址）；
//   ② 公网 200 但回直连收口引导页（源站内容故障，2026-09-14 端口漂移事故签名）→ 立即 exit 3
//     （主会话报警处置——此故障杀 cloudflared 无疗效，绝不重拉轮换 URL）；
//   ③ 公网彻底失联（dead）→ 4 分钟宽限后仍无新隧道出生（= 守护本身失能）→ 经 worktable
//     重拉守护（10 分钟节流）；守护活着时 65s 内必自愈，无需本监视器插手。
// 探活：直连 + 本机代理双路；URL 来源：/api/status 优先，tunnel.log 兜底。
// 退出码：0=换址（主会话发 QQ 后重启本监视器）；3=源站引导页态（主会话报警处置后重启）；2=24h 无变化。
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url); // ESM 下裸 require 未定义会静默禁用代理路（2026-09-14 修复）
const HERE = dirname(fileURLToPath(import.meta.url));
const TUNNEL_LOG = join(HERE, '..', '.mobile-srv', 'tunnel.log');
const STATUS = 'http://127.0.0.1:3191/api/status';
const SHIM = 'C:\\Users\\ycwan\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\start-cloudflared.cmd';
const SPAWNER = join(HERE, 'spawn-via-worktable.mjs');
const POLL_MS = 60_000;
const MAX_MS = 24 * 3600_000;
const DEAD_GRACE_MS = 4 * 60_000;
const KICK_THROTTLE_MS = 10 * 60_000;

let proxyAgent = null;
try {
  proxyAgent = new (require('C:/Users/ycwan/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/https-proxy-agent').HttpsProxyAgent)('http://127.0.0.1:7897');
} catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => new Date(ms).toLocaleString('sv-SE', { hour12: false });

// 'ok' | 'notice' | 'dead'（健康判据 = 200 且非引导页；与 tunnel-probe 同语义）
async function probe(url) {
  const verdict = (status, body) => {
    if (status !== 200) return 'dead';
    return String(body).includes('安全地址') ? 'notice' : 'ok';
  };
  try {
    const r = await fetch(url + '/api/status', { signal: AbortSignal.timeout(8000) });
    const v = verdict(r.status, await r.text());
    if (v !== 'dead') return v;
  } catch {}
  if (proxyAgent) {
    try {
      return await new Promise((resolve, reject) => {
        const req = require('https').get(url + '/api/status', { agent: proxyAgent }, (res) => {
          let body = '';
          res.on('data', (c) => { if (body.length < 4096) body += c; });
          res.on('end', () => resolve(verdict(res.statusCode, body)));
        });
        req.on('error', () => resolve('dead'));
        req.setTimeout(8000, () => req.destroy(new Error('timeout')));
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

const started = Date.now();
let startUrl = await currentUrl();
console.log(`[watch] baseline url=${startUrl || '(none)'} poll=${POLL_MS / 1000}s max=${MAX_MS / 3600000}h`);
let deadSince = 0;
let lastKick = 0;

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
    if (deadSince) console.log(`[watch] ${fmt(Date.now())} recovered with same url (transient) — continue`);
    deadSince = 0;
    continue;
  }
  if (v === 'notice') {
    console.log(`[watch] RESULT: ORIGIN FAULT at ${fmt(Date.now())} - public ${url} serves the notice page (200); cloudflared/edge fine, mobile-server side fault; ALARM (do not respawn cloudflared)`);
    process.exitCode = 3;
    break;
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
  }
}

if (process.exitCode === undefined || process.exitCode === null) {
  console.log(`[watch] TIMEOUT 24h: no url change (last=${startUrl}) — relaunch to continue watching`);
  process.exitCode = 2;
}
