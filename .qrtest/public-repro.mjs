// 公网复现脚本：node .qrtest/public-repro.mjs <tunnel-url>
// 模拟手机浏览器经公网隧道访问：登录 → schedule → 并发 watch SSE → 发消息
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(join(HERE, '..', '.mobile-srv', 'settings.json'), 'utf8')).pin;
const base = process.argv[2] || process.env.TUNNEL_URL;
if (!base) { console.error('usage: node public-repro.mjs https://xxx.trycloudflare.com'); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// 1. 登录拿 cookie
const lr = await fetch(base + '/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }),
});
log('login:', lr.status);
const setCookie = lr.headers.getSetCookie?.()[0] ?? '';
const cookie = setCookie.split(';')[0];
if (!cookie) { console.error('no cookie'); process.exit(1); }
const H = { cookie, 'content-type': 'application/json' };

// 2. schedule
const sr = await fetch(base + '/api/schedule', { headers: { cookie } });
log('schedule:', sr.status);

// 3. watch SSE：并发开 4 条（模拟手机页 watch + 发消息 stream + EventSource 重连残留）
const results = await Promise.all(Array.from({ length: 4 }, async (_, i) => {
  try {
    const r = await fetch(base + '/api/chat/watch', { headers: { cookie } });
    if (r.status !== 200) return `watch#${i}: HTTP ${r.status} ${await r.text().catch(() => '')}`;
    const reader = r.body.getReader();
    const first = await reader.read();
    const txt = new TextDecoder().decode(first.value ?? new Uint8Array());
    const hello = txt.includes('"hello"');
    setTimeout(() => { try { reader.cancel(); } catch {} }, 500);
    return `watch#${i}: 200 first-frame-hello=${hello}`;
  } catch (e) { return `watch#${i}: ERR ${e.cause?.code || e.message}`; }
}));
results.forEach((x) => log(x));

// 4. 发一条消息（POST /api/chat/stream，SSE）
try {
  const r = await fetch(base + '/api/chat/stream', { method: 'POST', headers: H, body: JSON.stringify({ message: '只回复两个字：收到' }) });
  log('chat/stream:', r.status);
  if (r.status === 200) {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', frames = 0, done = '';
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const { done: d, value } = await Promise.race([reader.read(), new Promise((r2) => setTimeout(() => r2({ done: true }), 90_000))]);
      if (d) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const f = buf.slice(0, idx); buf = buf.slice(idx + 2); frames++;
        if (f.includes('"done"')) { done = f; break; }
        if (f.includes('"error"')) { done = f; break; }
      }
      if (done) break;
    }
    log('chat frames:', frames, 'final:', (done || '(no done in window)').slice(0, 300));
    try { await reader.cancel(); } catch {}
  } else { log('chat/stream body:', (await r.text()).slice(0, 200)); }
} catch (e) { log('chat/stream: ERR', e.cause?.code || e.message); }
process.exit(0);
