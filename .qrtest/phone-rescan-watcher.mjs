// phone-rescan-watcher.mjs — 手机重扫核实监视器（2026-09-11 隧道换址后挂起）
// 背景：隧道换址 taste-newbie-textile-discs 后，手机 APP 需重扫+重登录，课前提醒链路
// 在「扫码+登录+计划重排」完成前处于失效窗口。服务端无访问日志、watch/WS 连接瞬态，
// 唯一持久化证据 = settings.json 的 sessions[]（仅 登录/登出/改密 时写盘，含 createdAt）。
// 判定：出现基线中没有的 token = 有人在新地址用密码登录成功（旧地址已死，能登录必经新隧道）。
// 纪律：只打印 token 前 8 位指纹与时间，绝不打印完整 token/密码哈希；读文件瞬时失败静默下轮重试。
// 退出：检测到新会话 → exit 0（主动汇报）；MAX_MS 超时 → exit 1（转入提醒流程）。
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), '..', '.mobile-srv', 'settings.json');
const POLL_MS = 60_000;
const MAX_MS = 12 * 3600_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => new Date(ms).toLocaleString('sv-SE', { hour12: false }); // sv-SE = ISO 形态本地时
const readSessions = () => {
  try {
    const j = JSON.parse(readFileSync(SETTINGS, 'utf8'));
    return (Array.isArray(j.sessions) ? j.sessions : []).filter((s) => s && typeof s.token === 'string');
  } catch {
    return null; // 原子写换新瞬间/编码竞争 → 下轮重试
  }
};

const started = Date.now();
const base = new Map();
for (const s of readSessions() || []) base.set(s.token, s.createdAt || 0);
console.log(`[watch] baseline sessions=${base.size}, poll=${POLL_MS / 1000}s, max=${MAX_MS / 3600000}h, settings=${SETTINGS}`);

let hit = null;
while (Date.now() - started < MAX_MS) {
  await sleep(POLL_MS);
  const list = readSessions();
  if (!list) continue;
  const fresh = list.filter((s) => !base.has(s.token));
  if (fresh.length) {
    hit = fresh;
    break;
  }
}

if (hit) {
  for (const s of hit) {
    console.log(`[HIT] new login session token=${s.token.slice(0, 8)}… createdAt=${fmt(s.createdAt || 0)} lastSeen=${fmt(s.lastSeen || s.createdAt || 0)}`);
  }
  console.log(`[watch] RESULT: rescan+login VERIFIED at ${fmt(Date.now())} (new session count: ${hit.length})`);
  process.exitCode = 0;
} else {
  console.log(`[watch] TIMEOUT after ${MAX_MS / 3600000}h: no new login session — phone likely NOT rescanned yet, switch to reminder flow`);
  process.exitCode = 1;
}
