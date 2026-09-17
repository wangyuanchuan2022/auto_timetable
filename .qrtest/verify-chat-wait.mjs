// verify-chat-wait.mjs — 部署验证：/api/chat/stream 端到端（带凭据真实一轮对话）。
// 验证「长思考不误报失败」改动上线后对话链路完好：帧序列 open → (partial*) → done，
// done.reply 非空；若出现 error 帧，打印完整帧（soft=true 应为 ⏳ 等待类提示而非失败）。
// 另核验 /mobile-app.js 已带 soft 帧处理（页面层经服务器下发，手机刷新即生效）。
// 用法：node .qrtest/verify-chat-wait.mjs
import { readFileSync } from 'node:fs';

const SETTINGS = 'D:/tools/auto_timetable/.mobile-srv/settings.json';
const BASE = 'http://127.0.0.1:3191';
const s = JSON.parse(readFileSync(SETTINGS, 'utf8'));
const sess = (s.sessions || []).find((x) => x && typeof x.token === 'string');
if (!sess) { console.log('[FAIL] settings.json 无可用会话 token'); process.exit(2); }
const COOKIE = { cookie: `tt_pin_v2=${sess.token}`, 'content-type': 'application/json', accept: 'text/event-stream' };

// 0) 页面层部署核验：/mobile-app.js 已含 soft 帧分支与 429 稍候分支
{
  const r = await fetch(`${BASE}/mobile-app.js`);
  const src = await r.text();
  const hasSoft = src.includes("j.soft ? '⏳ ' : '发送失败：'");
  const has429 = src.includes('err.softBusy = (r.status === 429)');
  console.log(`[check] /mobile-app.js soft 帧分支: ${hasSoft ? 'OK' : 'FAIL'}；429 稍候分支: ${has429 ? 'OK（页面层经服务端下发，手机刷新页面即生效）' : 'FAIL（旧文件）'}`);
  if (!hasSoft || !has429) process.exit(2);
}

// --page-only：只核验页面层部署，不发真实对话（免打扰手机会话）
if (process.argv.includes('--page-only')) { console.log('[OK] 页面层部署核验通过（--page-only）'); process.exit(0); }

// 1) 真实一轮流式对话
const t0 = Date.now();
const r = await fetch(`${BASE}/api/chat/stream`, {
  method: 'POST', headers: COOKIE,
  body: JSON.stringify({ message: '部署自检（可忽略本条）：请只回复两个字母 OK，不要使用任何工具。' }),
});
console.log(`[check] POST /api/chat/stream -> HTTP ${r.status}`);
if (!r.ok) { console.log('[FAIL] 非 200：' + (await r.text()).slice(0, 200)); process.exit(2); }

const reader = r.body.getReader();
const dec = new TextDecoder();
let buf = '';
let sawOpen = false, sawDone = false, reply = '', hardError = null, softNotice = null;
const WATCHDOG = setTimeout(() => { console.log('[FAIL] 150s 看门狗超时'); process.exit(2); }, 150_000);
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 2);
    if (!frame.startsWith('data: ')) continue;
    let j; try { j = JSON.parse(frame.slice(6)); } catch { continue; }
    if (j.t === 'open') { sawOpen = true; console.log(`[frame] open @${((Date.now() - t0) / 1000).toFixed(1)}s`); }
    else if (j.t === 'partial') { console.log(`[frame] partial ${String(j.text || '').length}ch @${((Date.now() - t0) / 1000).toFixed(1)}s`); }
    else if (j.t === 'done') { sawDone = true; reply = String(j.reply || ''); console.log(`[frame] done @${((Date.now() - t0) / 1000).toFixed(1)}s reply=${JSON.stringify(reply.slice(0, 80))} timeout=${!!j.timeout}`); }
    else if (j.t === 'error') {
      if (j.soft) { softNotice = String(j.error || ''); console.log(`[frame] error(soft) @${((Date.now() - t0) / 1000).toFixed(1)}s: ${softNotice}`); }
      else { hardError = String(j.error || ''); console.log(`[frame] error(hard): ${hardError}`); }
    }
  }
}
clearTimeout(WATCHDOG);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (hardError) { console.log(`[FAIL] 硬错误帧：${hardError}`); process.exit(1); }
if (!sawOpen || !sawDone || !reply) { console.log(`[FAIL] 帧序列不完整 open=${sawOpen} done=${sawDone} replyLen=${reply.length}`); process.exit(1); }
console.log(`[OK] 端到端 ${secs}s：open→done，reply 非空${softNotice ? '（期间出现 soft 等待提示，属预期行为）' : ''}`);
