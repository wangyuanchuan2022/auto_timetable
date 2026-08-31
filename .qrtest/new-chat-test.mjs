// new-chat-test.mjs — 回归测试③：手机端「新建对话」。
// 用法：node .qrtest/new-chat-test.mjs <mobile.html 路径>
// 覆盖：忙碌时禁止新建、两段式确认、重置后清屏并重连新会话、旧流帧不写入新对话、新会话正常收发。
import { loadPage } from './page-harness.mjs';

const pagePath = process.argv[2];
if (!pagePath) { console.error('用法: node .qrtest/new-chat-test.mjs <mobile.html>'); process.exit(2); }

const { byId, calls, send, ws, flush, log } = loadPage(pagePath);
const bubbles = (who, text) => log.children.filter(c => c.classList.contains(who === 'user' ? 'bUser' : 'bBot') && c.textContent === text);
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };
const resetCalls = () => calls.filter(u => u === '/api/chat/reset').length;

send({ t: 'hello' });
send({ t: 'message', role: 'user', text: '旧会话提问', seq: 1 });
send({ t: 'message', role: 'assistant', text: '旧会话回复', seq: 2 });
await flush(); await flush();

console.log('1) 发送中禁止新建（防打断进行中的轮次）');
byId.chatIn.value = '进行中的消息';
byId.chatSend.onclick();                       // busy 置位（同步）
byId.newChatBtn.onclick();                     // 忙碌 → 拦截
check('忙碌时首点不触发 reset 请求', resetCalls() === 0);
check('忙碌时给出提示文案', byId.newChatBtn.textContent.indexOf('处理中') === 0);
await flush(); await flush();                  // stream 立即收尾 → busy 复位
send({ t: 'message', role: 'assistant', text: '已答复', seq: 3 });
await flush();

console.log('2) 两段式确认（防误触）');
const wsOld = ws();
byId.newChatBtn.onclick();                     // 首点：武装确认
check('首点仅武装，不执行', resetCalls() === 0 && byId.newChatBtn.textContent.indexOf('再点一次') === 0);
byId.newChatBtn.onclick();                     // 3 秒内二点：执行
await flush(); await flush(); await flush();
check('二点执行 reset 恰好一次', resetCalls() === 1);

console.log('3) 重置效果：清屏 + 重连新会话 + 提示');
check('对话区只剩 1 条提示气泡', log.children.length === 1 && log.children[0].textContent.indexOf('已开启新对话') > -1);
check('watch 已重连（新 WS 实例）', ws() && ws() !== wsOld);
check('按钮文案恢复', byId.newChatBtn.textContent === '✚ 新对话');

console.log('4) 旧流帧不写入新对话 / 新会话正常收发');
send({ t: 'hello' });
send({ t: 'message', role: 'assistant', text: '新会话开始', seq: 1 }); // 新会话空快照后首条
await flush();
check('新会话消息正常渲染', bubbles('bot', '新会话开始').length === 1);
check('旧会话内容未复活', bubbles('user', '旧会话提问').length === 0 && bubbles('bot', '旧会话回复').length === 0);
byId.chatIn.value = '新会话提问';
byId.chatSend.onclick();
send({ t: 'message', role: 'user', text: '新会话提问', seq: 2 });
await flush();
check('新会话发送 + 回显去重正常（1 条）', bubbles('user', '新会话提问').length === 1);

console.log(`\n${pagePath}\n  通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
