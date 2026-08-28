// 对比 watch SSE 首帧时延：node watch-timing.mjs <base-url>
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
const r = await fetch(base + '/api/chat/watch', { headers: { cookie } });
log('watch status', r.status);
if (r.status === 200) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let got = 0;
  try {
    while (got < 200) {
      const { done, value } = await Promise.race([reader.read(), new Promise((rr) => setTimeout(() => rr({ timeout: true }), 20_000))]);
      if (!value && done !== false) { log('read end/timeout'); break; }
      if (done) { log('stream done'); break; }
      const txt = dec.decode(value, { stream: true });
      got += txt.length;
      log('chunk', JSON.stringify(txt.slice(0, 80)));
      if (txt.includes('hello')) break;
    }
  } catch (e) { log('err', e.message); }
  try { await reader.cancel(); } catch {}
}
process.exit(0);
