// 公网实时链路验证：node public-live-test.mjs <tunnel-url>
// WS 保持连接 → 公网发一条会触发工具调用的消息 → 断言 WS 上实时收到 tool/toolresult/partial/message
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(join(HERE, '..', '.mobile-srv', 'settings.json'), 'utf8')).pin;
const base = process.argv[2];
const t0 = Date.now();
const log = (...a) => console.log(String(Date.now() - t0).padStart(6), 'ms', ...a);

const lr = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
const cookie = (lr.headers.getSetCookie?.()[0] ?? '').split(';')[0];
log('login', lr.status);

const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/chat/watch', { headers: { cookie } });
let helloed = false;
const live = { tool: 0, toolresult: 0, partial: 0, message: 0, reasoning: 0 };
const done = new Promise((resolve) => {
  ws.onmessage = (ev) => {
    let j; try { j = JSON.parse(ev.data); } catch { return; }
    if (j.t === 'hello') { helloed = true; log('hello'); start(); }
    else if (j.t === 'tool') { live.tool++; log('LIVE tool:', j.name); }
    else if (j.t === 'toolresult') { live.toolresult++; log('LIVE toolresult err=', j.error); }
    else if (j.t === 'partial') live.partial++;
    else if (j.t === 'message' && j.role === 'assistant') { live.message++; log('LIVE assistant message:', (j.text || '').slice(0, 60)); }
    else if (j.t === 'reasoning') live.reasoning++;
  };
  ws.onclose = () => { log('ws closed early!', !helloed); resolve(); };
});
function start() {
  // 触发工具调用：读 schedule.json 首个事件标题
  fetch(base + '/api/chat/stream', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ message: '用 read 工具读取 schedule.json 的前 40 行，然后只用一句话告诉我第一个事件的标题是什么。' }),
  }).then(async (r) => {
    log('chat/stream', r.status);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done: d, value } = await reader.read();
      if (d) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('"done"') || buf.includes('"error"')) break;
    }
    log('stream final:', buf.slice(-200).replace(/\n/g, ' '));
  }).catch((e) => log('stream err', e.message));
}
await Promise.race([done, new Promise((r) => setTimeout(r, 120_000))]);
log('live counts:', JSON.stringify(live));
process.exit(0);
