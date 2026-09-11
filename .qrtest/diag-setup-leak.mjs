// diag-setup-leak.mjs — 取证：导出手机专属会话的真实用户消息，诊断注入剥离为何失手。
// 只读诊断，不改任何数据。运行：node .qrtest/diag-setup-leak.mjs
import { readFileSync } from 'node:fs';
import { parseInstruction } from '../chat-setup.mjs';

const SETTINGS = new URL('../.mobile-srv/settings.json', import.meta.url);
const DSH_API = process.env.DSH_API_URL || 'http://127.0.0.1:3080';

const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
const sid = settings.chatSessionId;
console.log('chatSessionId =', sid || '(none)');
if (!sid) process.exit(2);

const instruction = parseInstruction(readFileSync(new URL('../TTPROMPT.md', import.meta.url), 'utf8'));
console.log('current instruction length =', instruction.length);
console.log('instruction head =', JSON.stringify(instruction.slice(0, 60)));

const SEP_NEW = '〔以上是系统设定；以下是用户消息〕';
const SEP_OLD = '（以上为系统设定。下面是用户消息：）';

const res = await fetch(`${DSH_API}/api/session.history`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    type: 'client-request',
    rpcId: 'diag-setup-leak-' + Date.now(),
    method: 'session.history',
    payload: { sessionId: sid, maxMessages: 60 },
  }),
});
if (!res.ok) { console.log('[FAIL] dsh http', res.status); process.exit(1); }
const body = await res.json();
const r = body?.result;
if (!r?.ok) { console.log('[FAIL] rpc error:', r?.error?.message); process.exit(1); }
const evs = (r.value?.events ?? []).map((e) => e.event).filter(Boolean);
console.log('total events =', evs.length);

let idx = 0;
for (const e of evs) {
  if (e.type !== 'user/message') continue;
  idx++;
  const content = e.data?.message?.content ?? e.data?.content;
  const text = Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b?.text ?? '').join('') : '';
  if (!text) continue;
  const head = text.slice(0, 120).replace(/\n/g, '\\n');
  const startsWithInstr = text.startsWith(instruction);
  const hasNew = text.includes(SEP_NEW);
  const hasOld = text.includes(SEP_OLD);
  console.log(`--- user#${idx} seq=${e.seq ?? '?'} len=${text.length} markerNew=${hasNew} markerOld=${hasOld} startsWithInstr=${startsWithInstr}`);
  console.log('    head=' + JSON.stringify(head));
  if (startsWithInstr) {
    console.log('    tail-after-instr=' + JSON.stringify(text.slice(instruction.length, instruction.length + 80).replace(/\n/g, '\\n')));
  }
}
if (idx === 0) console.log('no user/message events found');
