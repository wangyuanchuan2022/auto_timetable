// dup-fix-test.mjs — 回归测试①：手机发送的消息在 watch 流回显（user/message）时不得重复渲染。
// 用法：node .qrtest/dup-fix-test.mjs <mobile.html 路径>
// 原理：加载页面真实内联脚本（page-harness），模拟「手机发送 → 流式气泡出现 →
//       watch 回显 user/message → 助手最终消息」完整链路。旧版（HEAD）应在本测试复现重复 bug。
import { loadPage } from './page-harness.mjs';

const pagePath = process.argv[2];
if (!pagePath) { console.error('用法: node .qrtest/dup-fix-test.mjs <mobile.html>'); process.exit(2); }

const { byId, send, flush, log } = loadPage(pagePath);
const bubbles = (who, text) => log.children.filter(c => c.classList.contains(who === 'user' ? 'bUser' : 'bBot') && c.textContent === text);
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

// ---- 场景 ----
send({ t: 'hello' });
send({ t: 'message', role: 'user', text: '电脑端早前发言', seq: 1 });
send({ t: 'message', role: 'assistant', text: '电脑端回复', seq: 2 });
await flush(); await flush();

console.log('1) 快照回放（历史消息各渲染一次）');
check('user 气泡 1 条', bubbles('user', '电脑端早前发言').length === 1);
check('bot 气泡 1 条', bubbles('bot', '电脑端回复').length === 1);

console.log('2) 手机发送：本地气泡 + 流式气泡');
byId.chatIn.value = '把周五的英语课改到 14:00';
byId.chatSend.onclick();
await flush(); await flush();
const localBubbles = bubbles('user', '把周五的英语课改到 14:00');
check('本地用户气泡恰好 1 条', localBubbles.length === 1);
check('带 data-local 待确认标记', localBubbles[0] && localBubbles[0].getAttribute('data-local') === '1');
check('末尾是流式 bot 气泡（复现原判断失效的场景）', log.lastElementChild.classList.contains('bBot'));
const countBeforeEcho = log.children.length;

console.log('3) watch 流回显 user/message（电脑端确认收到）——重复 bug 的触发点');
send({ t: 'message', role: 'user', text: '把周五的英语课改到 14:00', seq: 3 });
await flush();
const afterEcho = bubbles('user', '把周五的英语课改到 14:00');
const dupFixed = afterEcho.length === 1 && log.children.length === countBeforeEcho && afterEcho[0].getAttribute('data-local') === null;
if (dupFixed) { pass++; console.log('  ✓ 原位采纳：未新增气泡、data-local 已清除（不重复）'); }
else { fail++; console.log(`  ✗ 仍重复：该文本用户气泡 ${afterEcho.length} 条（期望 1），回显前后节点数 ${countBeforeEcho}→${log.children.length}`); }

console.log('4) 流式增量 → 助手最终消息原位替换流式气泡');
send({ t: 'partial', text: '正在处理…' });
send({ t: 'message', role: 'assistant', text: '已改好', seq: 4 });
await flush();
check('助手最终消息 1 条', bubbles('bot', '已改好').length === 1);
check('用户消息仍只 1 条（未被波及）', bubbles('user', '把周五的英语课改到 14:00').length === 1);

console.log('5) 电脑端新发言正常镜像 + 同 seq 幂等');
send({ t: 'message', role: 'user', text: '电脑端又发言', seq: 5 });
send({ t: 'message', role: 'user', text: '电脑端又发言', seq: 5 }); // 兜底轮询重复推送
await flush();
check('电脑端发言只渲染 1 条', bubbles('user', '电脑端又发言').length === 1);

console.log(`\n${pagePath}\n  通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
