// WS watch 通道测试：node ws-watch-test.mjs <base-url>（http/https 均可）
// 验证：握手鉴权、快照（消息/工具/思考）、hello、实时帧、心跳不影响数据
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(join(HERE, '..', '.mobile-srv', 'settings.json'), 'utf8')).pin;
const base = process.argv[2];
const t0 = Date.now();
const log = (...a) => console.log(String(Date.now() - t0).padStart(6), 'ms', ...a);

if (typeof WebSocket !== 'function') { console.error('node lacks WebSocket client'); process.exit(1); }
const lr = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
const cookie = (lr.headers.getSetCookie?.()[0] ?? '').split(';')[0];
log('login', lr.status, 'cookie?', !!cookie);

// node WebSocket 不自动带 cookie：把 cookie 塞进握手头（浏览器同源会自动带）
const url = base.replace(/^http/, 'ws') + '/api/chat/watch';
const ws = new WebSocket(url, { headers: { cookie } });
const counts = {};
const deadline = setTimeout(() => { log('timeout waiting hello'); process.exit(1); }, 20000);
ws.onmessage = (ev) => {
  let j; try { j = JSON.parse(ev.data); } catch { return; }
  counts[j.t] = (counts[j.t] ?? 0) + 1;
  if (j.t === 'hello') {
    clearTimeout(deadline);
    log('HELLO; frames so far:', JSON.stringify(counts));
    // 保持 5 秒观察心跳与实时帧（若此时电脑端有活动会继续计数）
    setTimeout(() => { log('final counts:', JSON.stringify(counts)); try { ws.close(); } catch {} setTimeout(() => process.exit(0), 300); }, 5000);
  } else if (j.t === 'tool') log('tool:', j.name, 'args?', (j.args || '').slice(0, 60));
  else if (j.t === 'toolresult') log('toolresult id=', j.id, 'err=', j.error, 'text?', (j.text || '').slice(0, 60));
};
ws.onerror = (e) => { log('ws error', e.message ?? e.type); };
ws.onclose = (e) => { log('ws close', e.code, e.reason); };
