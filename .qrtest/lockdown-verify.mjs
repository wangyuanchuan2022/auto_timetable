// 临时验证脚本：3190 全量收口 + 3191 功能端口 + 隧道端到端 + watch 通道
const log = (...a) => console.log(...a);
const os = await import('node:os');
function publicIpv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(127\.|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      return a.address;
    }
  }
  return null;
}
const PUB = publicIpv4();
log('0  public ip:', PUB);
// --- 3190 全量收口 ---
let r = await fetch('http://127.0.0.1:3190/');
let h = await r.text();
log('1  3190 loopback GET / -> notice:', /text\/html/.test(r.headers.get('content-type') || '') && (/trycloudflare\.com|暂不可用/.test(h)) ? 'yes' : 'NO');
r = await fetch('http://127.0.0.1:3190/api/admin/pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
log('2  3190 loopback admin -> 403:', r.status);
if (PUB) {
  r = await fetch(`http://${PUB}:3190/`, { signal: AbortSignal.timeout(8000) }).catch((e) => ({ status: 'ERR:' + e.cause?.code, text: async () => '' }));
  h = await r.text();
  log('3  3190 public GET / -> notice:', /trycloudflare\.com|暂不可用/.test(h) ? 'yes' : 'NO', '(status=' + r.status + ')');
  r = await fetch(`http://${PUB}:3190/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch((e) => ({ status: 'ERR:' + e.cause?.code }));
  log('4  3190 public login -> 403:', r.status);
}
// --- 3191 功能端口 ---
r = await fetch('http://127.0.0.1:3190/');
h = await r.text();
const url = (h.match(/https:\/\/[a-z-]+\.trycloudflare\.com/) || [])[0] || '';
r = await fetch('http://127.0.0.1:3191/api/status', { headers: { origin: 'http://127.0.0.1:3080' } });
let j = await r.json();
log('5  3191 status full:', j.ok === true && !!j.lanIp, 'tunnel=' + ((j.tunnel || {}).url));
r = await fetch('http://127.0.0.1:3191/api/admin/pin', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' }, body: JSON.stringify({ pin: 'short' }) });
j = await r.json().catch(() => ({}));
log('6  3191 admin loopback reaches validation (400):', r.status === 400 && /8-64/.test(j.error || ''));
r = await fetch('http://127.0.0.1:3191/api/admin/pin', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: '{}' });
log('7  3191 admin with CF marker -> 403:', r.status);
// --- 隧道端到端 ---
if (url) {
  r = await fetch(url + '/api/status', { signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (r) { j = await r.json(); log('8  tunnel status minimal:', j.ok === true && !('lanIp' in j)); } else log('8  tunnel status: ERR');
  r = await fetch(url + '/', { signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (r) { h = await r.text(); log('9  tunnel GET / -> mobile.html:', h.includes('chatLog') ? 'yes' : 'NO'); } else log('9  tunnel GET /: ERR');
}
// --- watch SSE 通道（功能端口）---
r = await fetch('http://127.0.0.1:3191/api/chat/watch', { headers: { 'x-tt-pin': '2233wesdxc', 'accept': 'text/event-stream' } });
const reader = r.body.getReader();
const { value } = await reader.read();
const first = Buffer.from(value).toString('utf8');
log('10 watch SSE first frame hello:', /"t":"hello"|t=hello/.test(first), first.slice(0, 60).replace(/\n/g, ' '));
await reader.cancel().catch(() => {});
