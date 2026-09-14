// tunnel-probe.mjs — cloudflared 僵尸态探测器（守护 start-cloudflared.cmd 每循环调用）
// 退出码：0 = 健康/无法判定（URL 未知、本机服务掉线——不动作）；2 = 僵尸确认（进程在但公网侧
// 直连+代理两条路全部超时/失败，连续两轮判定）→ 守护据此 taskkill cloudflared 触发重拉。
// 用法：node tunnel-probe.mjs   （读 127.0.0.1:3191/api/status 获取当前隧道 URL）
// 注意：结尾用 process.exitCode 而非 process.exit——exit 会打断未关闭的 fetch 句柄触发
// libuv 断言崩溃（win/async.c），exitCode 让事件循环自然排空后以正确码退出。
const STATUS = 'http://127.0.0.1:3191/api/status';
console.log('[probe] start pid=' + process.pid);
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); // ESM 下 require 未定义，裸 require 会静默禁用代理双路（2026-09-14 修复）
let agent = null;
try {
  agent = new (require('C:/Users/ycwan/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/https-proxy-agent').HttpsProxyAgent)('http://127.0.0.1:7897');
} catch {}

async function probe(url) {
  // 健康判据 = 200 且【不是】直连收口引导页（2026-09-14 端口漂移事故的故障签名）。
  // 不能要求 body 含 "tunnel"：/api/status 对公网来访者按 M-2 加固只回 {ok,port} 精简体。
  try {
    const r = await fetch(url + '/api/status', { signal: AbortSignal.timeout(6000) });
    if (r.ok && !String(await r.text()).includes('安全地址')) return true;
  } catch {}
  if (agent) {
    try {
      const code = await new Promise((resolve, reject) => {
        const req = require('https').get(url + '/api/status', { agent }, (res) => {
          let body = '';
          res.on('data', (c) => { if (body.length < 4096) body += c; });
          res.on('end', () => resolve(res.statusCode === 200 && !body.includes('安全地址') ? 200 : res.statusCode));
        });
        req.on('error', reject);
        req.setTimeout(6000, () => req.destroy(new Error('timeout')));
      });
      if (code === 200) return true;
    } catch {}
  }
  return false;
}

const j = await fetch(STATUS, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);
const url = j && j.tunnel && j.tunnel.url;
console.log('[probe] status fetched, url =', url);
if (!url) {
  console.log('[probe] tunnel url unknown (server down / not registered) - no action');
  process.exitCode = 0;
} else {
  let healthy = false;
  for (let round = 0; round < 2 && !healthy; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 4000));
    healthy = await probe(url);
  }
  if (healthy) {
    process.exitCode = 0;
  } else {
    console.log('[zombie] public URL unreachable via direct+proxy (2 rounds): ' + url);
    process.exitCode = 2;
  }
}
