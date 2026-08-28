// watch 镜像实测：订阅 /api/chat/watch，再从「另一台客户端」发消息，验证双端消息原样到达
import fs from 'node:fs';
const pin = JSON.parse(fs.readFileSync('.mobile-srv/settings.json', 'utf8')).pin || '';
const BASE = 'http://127.0.0.1:3190';
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

// 1) 订阅 watch（模拟手机页的 EventSource）
const res = await fetch(`${BASE}/api/chat/watch?pin=${encodeURIComponent(pin)}`, { headers: { accept: 'text/event-stream' } });
console.log(ts(), 'watch HTTP', res.status, res.headers.get('content-type'));
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let assistantFinal = false;

// 2) 1.5 秒后从另一客户端发消息（模拟电脑端 GUI 或手机输入框）
setTimeout(async () => {
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tt-pin': pin },
    body: JSON.stringify({ message: '请用一句话回答：现在还是流式测试吗？不要修改文件。' }),
  }).then(r => r.json());
  console.log(ts(), 'POST /api/chat →', r.ok ? 'ok' : JSON.stringify(r));
}, 1500);

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const f = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
    if (!f.startsWith('data: ')) continue;
    const j = JSON.parse(f.slice(6));
    if (j.t === 'message') {
      console.log(ts(), `message(${j.role}, seq=${j.seq}):`, j.text.slice(0, 60).replace(/\n/g, ' '));
      if (j.role === 'assistant' && /流式/.test(j.text)) assistantFinal = true;
      if (assistantFinal) { console.log('RESULT: watch 镜像双端消息 OK'); process.exit(0); }
    } else if (j.t === 'partial' && j.text) {
      console.log(ts(), `partial(${j.text.length}):`, j.text.slice(-30).replace(/\n/g, ' '));
    } else if (j.t === 'hello') console.log(ts(), 'hello');
  }
}
