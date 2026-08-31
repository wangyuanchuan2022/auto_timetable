// live-refresh-test.mjs — 回归测试⑤：实时链路自愈（修复"无流式响应、新日程不渲染、刷新才可见"）。
// 用法：node .qrtest/live-refresh-test.mjs <mobile.html 路径>
// 覆盖：hello 携带 sid 且会话变化时清 seq 表（重建会话 seq 撞号不丢帧）、
//       同会话重连快照重放去重（不清表不重复）、reset 帧清状态并重连换绑、
//       工具结果触发日程节流刷新（不等最终消息）、ping 心跳帧无副作用。
import { loadPage } from './page-harness.mjs';

const pagePath = process.argv[2];
if (!pagePath) { console.error('用法: node .qrtest/live-refresh-test.mjs <mobile.html>'); process.exit(2); }

const { byId, calls, send, ws, flush, log } = loadPage(pagePath);
const bubbles = (text) => log.children.filter(c => c.classList.contains('bBot') && c.textContent === text);
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };
const schedCalls = () => calls.filter(u => u === '/api/schedule').length;

console.log('1) hello 携带 sid：首次绑定');
send({ t: 'hello', sid: 'sess-A' });
send({ t: 'message', role: 'assistant', text: '会话A消息', seq: 5 });
await flush(); await flush();
check('会话A seq=5 正常渲染', bubbles('会话A消息').length === 1);

console.log('2) 同会话重连：快照重放按 seq 去重（不重复渲染）');
send({ t: 'hello', sid: 'sess-A' });
send({ t: 'message', role: 'assistant', text: '会话A消息', seq: 5 });
await flush(); await flush();
check('同 sid 同 seq 重放不重复', bubbles('会话A消息').length === 1);

console.log('3) 会话重建（hello sid 变化）：新会话 seq 与旧表撞号不再丢帧');
send({ t: 'hello', sid: 'sess-B' });
send({ t: 'message', role: 'assistant', text: '会话B消息', seq: 5 });
await flush(); await flush();
check('撞号 seq=5 渲染成功（修复点）', bubbles('会话B消息').length === 1);

console.log('4) reset 帧：清状态并立即重连（绑定新会话）');
const wsOld = ws();
send({ t: 'reset', sid: 'sess-C' });
await new Promise(r => setTimeout(r, 450)); // 客户端 300ms 后 openWatch
check('已重开 watch（新 WS 实例）', !!ws() && ws() !== wsOld);
send({ t: 'hello', sid: 'sess-C' });
send({ t: 'message', role: 'assistant', text: '会话C消息', seq: 1 });
await flush(); await flush();
check('重连后新会话消息渲染', bubbles('会话C消息').length === 1);

console.log('5) 工具结果触发日程刷新（节流 ≥2s）');
const before = schedCalls();
send({ t: 'tool', id: 'call-1', name: 'edit', args: '{"file_path":"schedule.json"}' });
send({ t: 'toolresult', id: 'call-1', text: 'ok', seq: 2 });
await flush(); await flush();
check('写文件工具完成后请求 /api/schedule', schedCalls() === before + 1);
send({ t: 'toolresult', id: 'call-2', text: 'ok2', seq: 3 });
await flush(); await flush();
check('2 秒内节流不重复请求', schedCalls() === before + 1);

console.log('6) ping 心跳帧无副作用');
const kidsBefore = log.children.length;
send({ t: 'ping' });
await flush();
check('ping 不产生气泡/卡片', log.children.length === kidsBefore);

console.log(`\n${pagePath}\n  通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
