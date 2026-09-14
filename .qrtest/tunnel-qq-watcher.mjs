// tunnel-qq-watcher.mjs — 隧道换址监视器（2026-09-14 用户要求：监视快速公网隧道，换址后经主会话推 QQ）
// 分工：守护 v2.1（30s 循环）负责一切 remediation（进程不在→拉起 / 僵尸→杀+重拉）；
//       本监视器只做两件事：①URL 变化且新地址健康 → 退出通知主会话（主会话发 QQ）；
//       ②兜底：URL 死亡持续 >4min 且 tunnel.log 无新出生（= 守护本身疑似死亡，正常守护 65s 内必重拉）
//         → 经 spawn-via-worktable 重新拉起守护（10 分钟节流，防抖）。
// 探活：直连 + 本机代理双路（照抄 tunnel-probe 模式）；URL 来源：/api/status 优先，tunnel.log 兜底。
// 退出码：0=检测到换址（主会话发 QQ 后重启本监视器）；2=24h 无变化（主会话静默重启即可）。
// 进程枚举不使用（沙箱 CIM 不可用 + dsh-pocket 有一条 3081 独立 cloudflared 会污染计数，勿按进程数判断）。
import { readFileSync, openSync, closeSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url); // ESM 下加载 CJS 依赖（https-proxy-agent）

const HERE = dirname(fileURLToPath(import.meta.url));
const TUNNEL_LOG = join(HERE, '..', '.mobile-srv', 'tunnel.log');
const STATUS = 'http://127.0.0.1:3191/api/status';
const SHIM = 'C:\\Users\\ycwan\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\start-cloudflared.cmd';
const SPAWNER = join(HERE, 'spawn-via-worktable.mjs');
const POLL_MS = 60_000;
const MAX_MS = 24 * 3600_000;
const DEAD_GRACE_MS = 4 * 60_000;   // 死亡持续超此值且无新出生 → 判守护失能
const KICK_THROTTLE_MS = 10 * 60_000;

let proxyAgent = null;
try {
  proxyAgent = new (require('C:/Users/ycwan/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/https-proxy-agent').HttpsProxyAgent)('http://127.0.0.1:7897');
} catch {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => new Date(ms).toLocaleString('sv-SE', { hour12: false });

async function probe(url) {
  // 健康判据 = 200 且【不是】直连收口引导页（2026-09-14 端口漂移事故的故障签名）。
  // 不能要求 body 含 "tunnel"：/api/status 对公网来访者按 M-2 加固只回 {ok,port} 精简体。
  try {
    const r = await fetch(url + '/api/status', { signal: AbortSignal.timeout(8000) });
    if (r.ok && !String(await r.text()).includes('安全地址')) return true;
  } catch {}
  if (proxyAgent) {
    try {
      const code = await new Promise((resolve, reject) => {
        const req = require('https').get(url + '/api/status', { agent: proxyAgent }, (res) => {
          let body = '';
          res.on('data', (c) => { if (body.length < 4096) body += c; });
          res.on('end', () => resolve(res.statusCode === 200 && !body.includes('安全地址') ? 200 : res.statusCode));
        });
        req.on('error', reject);
        req.setTimeout(8000, () => req.destroy(new Error('timeout')));
      });
      if (code === 200) return true;
    } catch {}
  }
  return false;
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
  if (url && (await probe(url))) {
    if (startUrl && url !== startUrl) {
      console.log(`[watch] RESULT: tunnel URL CHANGED ${startUrl} -> ${url} (healthy) at ${fmt(Date.now())}`);
      process.exitCode = 0;
      break;
    }
    if (deadSince) console.log(`[watch] ${fmt(Date.now())} recovered with same url (transient) — continue`);
    deadSince = 0;
    continue;
  }
  // 死亡分支
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
