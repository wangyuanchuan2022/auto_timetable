// 端到端（Cookie 认证版）：watch 收 思考/工具/问题 帧 → 代答 → 会话继续
import fs from 'node:fs';
const PIN = JSON.parse(fs.readFileSync('.mobile-srv/settings.json', 'utf8')).pin || '';
const B = 'http://127.0.0.1:3190';
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

// 1) 登录拿 Cookie
const lr = await fetch(`${B}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pin: PIN }),
});
const cookie = (lr.headers.get('set-cookie').match(/tt_pin_v2=[a-f0-9]+/)||[])[0];
console.log(ts(), 'login', lr.status, cookie ? 'cookie ok' : 'NO COOKIE');

// 2) 订阅 watch（携带 Cookie，模拟手机页）
const res = await fetch(`${B}/api/chat/watch`, { headers: { accept: 'text/event-stream', cookie } });
console.log(ts(), 'watch', res.status);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let sawReasoning = false, sawTool = false, answered = false;

// 3) 让 DSH 做一次「会思考 + 会调工具 + 会提问」的轮次
setTimeout(() => {
  fetch(`${B}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ message: '请先用 read 工具看一眼 schedule.json 的事件个数，然后用 ask_user_question 问我：要把某个日程改期吗？选项：是/否。等我回答。' }),
  }).then(r => r.json()).then(j => console.log(ts(), 'chat post →', j.ok ? 'ok' : JSON.stringify(j).slice(0, 150)));
}, 1000);

const timer = setTimeout(() => { console.log('TIMEOUT', { sawReasoning, sawTool, answered }); process.exit(1); }, 120000);
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const f = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
    if (!f.startsWith('data: ')) continue;
    const j = JSON.parse(f.slice(6));
    if (j.t === 'reasoning' && !sawReasoning) { sawReasoning = true; console.log(ts(), 'REASONING frame (' + j.text.length + ' chars):', j.text.slice(-40).replace(/\n/g, ' ')); }
    else if (j.t === 'tool') { sawTool = true; console.log(ts(), 'TOOL frame:', j.name); }
    else if (j.t === 'question') {
      console.log(ts(), 'QUESTION:', (j.questions[0]||{}).question);
      const answer = j.questions.map(q => ({ id: q.id, selected: [(q.options && q.options[0] ? q.options[0].label : '否')] }));
      const r = await fetch(`${B}/api/respond`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ rpcId: j.rpcId, kind: 'question', answer }),
      }).then(r => r.json());
      console.log(ts(), 'answered →', JSON.stringify(r).slice(0, 80));
      answered = true;
    } else if (j.t === 'resolved') console.log(ts(), 'RESOLVED', j.kind, j.outcome);
    else if (j.t === 'message' && answered && j.role === 'assistant') {
      clearTimeout(timer);
      console.log(ts(), 'DSH continued:', j.text.slice(0, 60));
      console.log('RESULT:', sawReasoning && sawTool ? '思考+工具+问答 全部同步 OK' : ('缺帧 reasoning=' + sawReasoning + ' tool=' + sawTool));
      process.exit(sawReasoning && sawTool ? 0 : 1);
    }
  }
}
