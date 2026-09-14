// tunnel-probe.mjs — 隧道健康三态探测器（守护 start-cloudflared.cmd 每循环调用）
// 退出码：0 = 健康/无法判定（URL 未知——不动作）；
//        2 = cloudflared 僵尸（公网侧直连+代理两轮全败：边缘/注册层故障）→ 守护 taskkill 重拉；
//        3 = 源站内容故障（公网 200 但回的是直连收口引导页——cloudflared 与边缘都正常，病根在
//            mobile-server 侧，如 2026-09-14 端口漂移事故）→ 守护【不得】杀 cloudflared：重拉只会
//            轮换 URL 逼用户重新配对，对源站故障无疗效，应走报警（watcher / 主会话）。
// 健康判据：200 且 body 不含引导页签名「安全地址」（引导页与正常页同为 200，只看状态码会漏判——
// 2026-09-14 事故教训；公网侧 /api/status 按 M-2 加固只回 {ok,port} 精简体，不能要求含 "tunnel"）。
// 用法：node tunnel-probe.mjs   （读 127.0.0.1:3191/api/status 获取当前隧道 URL）
// 注意：结尾用 process.exitCode 而非 process.exit——exit 会打断未关闭的 fetch 句柄触发
// libuv 断言崩溃（win/async.c），exitCode 让事件循环自然排空后以正确码退出。
const STATUS = 'http://127.0.0.1:3191/api/status';
console.log('[probe] start pid=' + process.pid);
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); // ESM 下裸 require 未定义会静默禁用代理双路（2026-09-14 修复）
let agent = null;
try {
  agent = new (require('C:/Users/ycwan/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/https-proxy-agent').HttpsProxyAgent)('http://127.0.0.1:7897');
} catch {}

const NOTICE_MARK = '安全地址'; // 直连收口引导页签名

// 返回 'ok' | 'notice' | 'dead'（直连与代理双路，任一路得出非 dead 结论即采信）
async function probe(url) {
  const verdict = (status, body) => {
    if (status !== 200) return 'dead';
    return String(body).includes(NOTICE_MARK) ? 'notice' : 'ok';
  };
  try {
    const r = await fetch(url + '/api/status', { signal: AbortSignal.timeout(6000) });
    const v = verdict(r.status, await r.text());
    if (v !== 'dead') return v;
  } catch {}
  if (agent) {
    try {
      return await new Promise((resolve, reject) => {
        const req = require('https').get(url + '/api/status', { agent }, (res) => {
          let body = '';
          res.on('data', (c) => { if (body.length < 4096) body += c; });
          res.on('end', () => resolve(verdict(res.statusCode, body)));
        });
        req.on('error', () => resolve('dead'));
        req.setTimeout(6000, () => req.destroy(new Error('timeout')));
      });
    } catch {}
  }
  return 'dead';
}

const j = await fetch(STATUS, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null);
const url = j && j.tunnel && j.tunnel.url;
console.log('[probe] status fetched, url =', url);
if (!url) {
  console.log('[probe] tunnel url unknown (server down / not registered) - no action');
  process.exitCode = 0;
} else {
  let sawOk = false, sawNotice = false;
  for (let round = 0; round < 2; round++) {
    if (round > 0) await new Promise((r) => setTimeout(r, 4000));
    const v = await probe(url);
    if (v === 'ok') { sawOk = true; break; }
    if (v === 'notice') sawNotice = true;
  }
  if (sawOk) {
    process.exitCode = 0;
  } else if (sawNotice) {
    console.log('[origin-fault] public URL serves the notice page (200) - cloudflared/edge are FINE, do NOT respawn; alarm upstream (mobile-server side)');
    process.exitCode = 3;
  } else {
    console.log('[zombie] public URL unreachable via direct+proxy (2 rounds): ' + url);
    process.exitCode = 2;
  }
}
