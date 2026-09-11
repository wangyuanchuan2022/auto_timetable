// page-tabs-test.mjs — 手机页「日程/对话分页 + 长文本输入框 + DeepSeek 式思考块 + 注入剥离兜底」回归测试。
// 运行：node .qrtest/page-tabs-test.mjs（经 page-harness 桩 DOM 执行真实 mobile-app.js）。
import { loadPage, collect } from './page-harness.mjs';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  [OK] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name); }
}
const cls = (el) => String((el && el.className) || '');
const flush = async (h, n = 3) => { for (let i = 0; i < n; i++) await h.flush(); };
const reasons = (h) => collect(h.log, el => cls(el).indexOf('bReason') !== -1);
const userBubbles = (h) => collect(h.log, el => cls(el).indexOf('bUser') !== -1);
const lastChild = (el) => el.children[el.children.length - 1] || null;

const SETUP_SEP = '\n\n〔以上是系统设定；以下是用户消息〕\n';

// ---------- 页面 A：默认从日程页开始 ----------
const h = loadPage(new URL('../mobile.html', import.meta.url));

console.log('-- T1 默认页签 --');
ok(cls(h.byId.pageSched).indexOf('on') !== -1, 'T1 默认显示日程页');
ok(cls(h.byId.pageChat).indexOf('on') === -1, 'T1 对话页默认隐藏');
ok(cls(h.byId.tabSched).indexOf('on') !== -1, 'T1 日程标签高亮');

console.log('-- T2 切换到对话页 + 持久化 --');
h.byId.tabChat.onclick();
ok(cls(h.byId.pageChat).indexOf('on') !== -1, 'T2 点击对话标签显示对话页');
ok(cls(h.byId.pageSched).indexOf('on') === -1, 'T2 日程页隐藏');
ok(cls(h.byId.tabChat).indexOf('on') !== -1 && cls(h.byId.tabSched).indexOf('on') === -1, 'T2 标签高亮互换');
ok(h.store['tt-tab'] === 'chat', 'T2 页签状态写入 localStorage');

console.log('-- T3 长文本输入框：Enter 发送 / Shift+Enter 换行 / 自适应增高 --');
const streamCount = () => h.calls.filter(u => u.indexOf('/api/chat/stream') !== -1).length;
h.byId.chatIn.value = '第一行想保留';
h.byId.chatIn._ls.keydown({ key: 'Enter', shiftKey: true, preventDefault() {} });
await flush(h);
ok(streamCount() === 0, 'T3 Shift+Enter 不发送（换行）');
ok(h.byId.chatIn.value === '第一行想保留', 'T3 Shift+Enter 保留输入');
h.byId.chatIn._ls.input(); // 模拟输入触发自适应增高
ok(typeof h.byId.chatIn.style.height === 'string' && /px$/.test(h.byId.chatIn.style.height), 'T3 输入触发自适应增高');
h.byId.chatIn.value = '把周五英语改到14:00';
h.byId.chatIn._ls.keydown({ key: 'Enter', shiftKey: false, preventDefault() {} });
await flush(h);
ok(streamCount() === 0, 'T3 普通 Enter 不发送（浏览器默认换行，参考 DSH 输入框）');
ok(h.byId.chatIn.value === '把周五英语改到14:00', 'T3 普通 Enter 保留输入');
h.byId.chatIn._ls.keydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
await flush(h);
ok(streamCount() === 1, 'T3 Ctrl+Enter 发送消息');
ok(h.byId.chatIn.value === '', 'T3 发送后清空输入');
ok(/42px/.test(String(h.byId.chatIn.style.height)), 'T3 发送后输入框收回单行高度');

console.log('-- T4 思考块（DeepSeek 风格）：生成中展开跟随 → 结束收起计时 --');
h.send({ t: 'hello', sid: 's-tabs' });
h.send({ t: 'reasoning', text: '第一轮思考内容…' });
let blocks = reasons(h);
let blk = blocks[blocks.length - 1];
ok(blocks.length === 1, 'T4 生成思考块');
ok(blk.open === true, 'T4 生成中折叠块展开');
ok(blk.children[0] && blk.children[0].textContent === '💭 深度思考中…', 'T4 生成中标签「深度思考中…」');
ok(blk.children[1] && blk.children[1].textContent === '第一轮思考内容…', 'T4 思考正文写入');
h.send({ t: 'message', role: 'assistant', text: '回答一', seq: 101 });
ok(blk.open === false, 'T4 最终消息落地后收起');
ok(blk.children[0].textContent.indexOf('已深度思考') !== -1, 'T4 收起后标签「已深度思考」');
ok(blk.children[0].textContent.indexOf('用时') !== -1, 'T4 标签含用时统计');

h.send({ t: 'reasoning', text: '第二轮思考内容…' });
blocks = reasons(h);
ok(blocks.length === 2, 'T4 新一轮思考生成新折叠块');
blk = blocks[1];
ok(blk.open === true && blk.children[0].textContent === '💭 深度思考中…', 'T4 新一轮重新展开');
h.send({ t: 'message', role: 'assistant', text: '回答二', seq: 102 });
ok(blocks[1].open === false && blocks[0].open === false, 'T4 各轮思考块均收起保留');

console.log('-- T5 快照回放思考块（fresh）：直接呈收起态 --');
h.send({ t: 'reasoning', text: '历史快照步骤思考', fresh: true });
blocks = reasons(h);
blk = blocks[blocks.length - 1];
ok(blocks.length === 3, 'T5 快照块独立成块');
ok(blk.open === false, 'T5 快照块不展开');
ok(blk.children[0].textContent === '💭 已深度思考', 'T5 快照块无用时统计（时刻未知）');

console.log('-- T6 注入设定剥离兜底：用户消息含设定全文 → 只显示真实消息 --');
h.send({ t: 'message', role: 'user', text: '（很长的系统设定全文……）' + SETUP_SEP + '把周五英语改到14:00', seq: 103 });
await flush(h);
const ub = userBubbles(h);
const lastUb = ub[ub.length - 1];
ok(lastUb && lastUb.textContent === '把周五英语改到14:00', 'T6 气泡只含分隔标记后的用户消息');
ok(!ub.some(b => String(b.textContent).indexOf('系统设定') !== -1), 'T6 设定全文不出现在任何用户气泡');

console.log('-- T7 未读红点：日程页收到新回复/提问时点亮，回到对话页清除 --');
h.byId.tabSched.onclick();
ok(cls(h.byId.pageSched).indexOf('on') !== -1, 'T7 切回日程页');
h.send({ t: 'message', role: 'assistant', text: '后台新回复', seq: 104 });
ok(cls(h.byId.chatDot).indexOf('on') !== -1, 'T7 日程页收到新回复点亮红点');
h.send({ t: 'question', rpcId: 'rq1', questions: [{ id: 'q1', question: '选一个', options: [{ label: 'A' }] }] });
ok(cls(h.byId.chatDot).indexOf('on') !== -1, 'T7 提问卡保持红点');
h.byId.tabChat.onclick();
ok(cls(h.byId.chatDot).indexOf('on') === -1, 'T7 回到对话页清除红点');
ok(cls(h.byId.pageChat).indexOf('on') !== -1, 'T7 对话页显示');
const qcard = collect(h.log, el => cls(el).indexOf('qcard') !== -1);
ok(qcard.length === 1, 'T7 提问卡已渲染');

console.log('-- T9 中文输入法组词不误发（isComposing / keyCode 229，作用于 Ctrl+Enter 发送路径）--');
const before9 = streamCount();
h.byId.chatIn.value = 'nihao';
h.byId.chatIn._ls.keydown({ key: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229, preventDefault() {} });
await flush(h);
ok(streamCount() === before9, 'T9 组词中 Ctrl+Enter（isComposing=true）不发送');
h.byId.chatIn._ls.keydown({ key: 'Enter', ctrlKey: true, isComposing: false, keyCode: 229, preventDefault() {} });
await flush(h);
ok(streamCount() === before9, 'T9 提交回车（keyCode 229，Safari 形态）不发送');
h.byId.chatIn.value = '你好';
h.byId.chatIn._ls.keydown({ key: 'Enter', ctrlKey: true, isComposing: false, keyCode: 13, preventDefault() {} });
await flush(h);
ok(streamCount() === before9 + 1, 'T9 干净 Ctrl+Enter 正常发送');
ok(h.byId.chatIn.value === '', 'T9 发送后清空');

console.log('-- T10 宿主内部注入整条不显示；注入首条只显示一条「已注入系统提示词」--');
const bubbleCount = () => collect(h.log, el => cls(el).indexOf('bubble') !== -1).length;
const notes = () => collect(h.log, el => cls(el).indexOf('sysNote') !== -1);
const bBefore = bubbleCount();
h.send({ t: 'message', role: 'user', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n〔以上是系统设定；以下是用户消息〕\n（快照正文引用分隔标记）', seq: 201 });
await flush(h);
ok(bubbleCount() === bBefore, 'T10 宿主 runtime 快照整条不显示（含分隔标记也不剥离显示）');
h.send({ t: 'message', role: 'user', text: '<system-reminder>\nThe following workspace instructions may be relevant…', seq: 202 });
await flush(h);
ok(bubbleCount() === bBefore, 'T10 system-reminder 整条不显示');
h.send({ t: 'message', role: 'user', text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation.', seq: 203 });
await flush(h);
ok(bubbleCount() === bBefore, 'T10 上下文压缩检查点整条不显示');
const nBefore = notes().length;
h.send({ t: 'message', role: 'user', text: '（很长的系统设定全文……）' + SETUP_SEP + '明天有课吗', seq: 204 });
await flush(h);
ok(notes().length === nBefore + 1, 'T10 注入首条渲染一条通知');
const lastNote = notes()[notes().length - 1];
ok(lastNote.textContent === '📌 已注入系统提示词', 'T10 通知文案固定，不含设定原文');
const lastUb2 = userBubbles(h)[userBubbles(h).length - 1];
ok(lastUb2 && lastUb2.textContent === '明天有课吗', 'T10 用户正文正常显示');
h.send({ t: 'message', role: 'user', text: '周五英语改到14:00', injected: true, seq: 205 });
await flush(h);
ok(notes().length === nBefore + 2, 'T10 服务端 injected 标记同样驱动通知');
ok(!userBubbles(h).some(b => String(b.textContent).indexOf('系统设定全文') !== -1), 'T10 设定原文不出现在任何气泡');

console.log('-- T8 重开恢复上次页签 --');
const h2 = loadPage(new URL('../mobile.html', import.meta.url), { store: { 'tt-tab': 'chat' } });
ok(cls(h2.byId.pageChat).indexOf('on') !== -1, 'T8 上次停在对话页 → 重开直接进对话页');
ok(cls(h2.byId.pageSched).indexOf('on') === -1, 'T8 日程页隐藏');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0); // 显式退出：页面脚本的 15s 僵尸自检 interval 会挂住事件循环
