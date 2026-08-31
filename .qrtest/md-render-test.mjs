// md-render-test.mjs — 回归测试②：手机端会话 markdown 渲染 + 安全不变量 + 与去重逻辑联动。
// 用法：node .qrtest/md-render-test.mjs <mobile.html 路径>
import { loadPage, collect } from './page-harness.mjs';

const pagePath = process.argv[2];
if (!pagePath) { console.error('用法: node .qrtest/md-render-test.mjs <mobile.html>'); process.exit(2); }

const { byId, send, flush, log } = loadPage(pagePath);
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };
const tag = t => e => e.tagName === String(t).toUpperCase();

send({ t: 'hello' });
await flush(); await flush();

// ---- 1) 助手消息：完整 GFM 子集 ----
const mdMsg = [
  '## 周五安排',
  '',
  '**已把英语课**改到 `14:00`，*请知悉*，~~旧时间作废~~。',
  '',
  '- 上午：英语（14:00-15:40）',
  '- 下午：自习',
  '  1. 带课本',
  '  2. 带耳机',
  '',
  '- [x] 改期',
  '- [ ] 通知老师',
  '',
  '> 注意：周五半天',
  '',
  '| 时间 | 课程 |',
  '|---|---:|',
  '| 14:00 | 英语 |',
  '| 16:00 | 自习 |',
  '',
  '```json',
  '{"start":"14:00"}',
  '```',
  '',
  '详情见 [教务系统](https://example.com/x) 与 https://example.com/y ，示意图 ![课表](https://example.com/z.png)',
  '',
  '---',
].join('\n');
send({ t: 'message', role: 'assistant', text: mdMsg, seq: 10 });
await flush();
const mdBubble = log.children.find(c => c.classList.contains('bBot') && c._mdRaw === mdMsg);
console.log('1) GFM 子集结构渲染');
check('气泡按 markdown 渲染（记录 _mdRaw）', !!mdBubble);
if (mdBubble) {
  const h2s = collect(mdBubble, tag('h2'));
  check('标题 h2 ×1（"周五安排"）', h2s.length === 1 && h2s[0].textContent === '周五安排');
  check('粗体 strong ×1（"已把英语课"）', collect(mdBubble, tag('strong')).filter(e => e.textContent === '已把英语课').length === 1);
  check('斜体 em ×1（"请知悉"）', collect(mdBubble, tag('em')).filter(e => e.textContent === '请知悉').length === 1);
  check('删除线 del ×1（"旧时间作废"）', collect(mdBubble, tag('del')).filter(e => e.textContent === '旧时间作废').length === 1);
  check('行内代码（"14:00"）', collect(mdBubble, tag('code')).some(e => e.textContent === '14:00'));
  const pre = collect(mdBubble, tag('pre'));
  check('fenced 代码块 ×1 且内容原样', pre.length === 1 && pre[0].children[0].textContent === '{"start":"14:00"}');
  check('代码块语言标签 data-lang=json', pre[0].getAttribute('data-lang') === 'json');
  const ths = collect(mdBubble, tag('th'));
  const tds = collect(mdBubble, tag('td'));
  check('表格：表头 2 列、数据 4 格', ths.length === 2 && tds.length === 4 && tds.some(e => e.textContent === '英语'));
  check('表格右对齐（第二列 ---:）', ths[1] && ths[1].style.textAlign === 'right');
  const lis = collect(mdBubble, tag('li'));
  const ols = collect(mdBubble, tag('ol'));
  check('列表共 6 项（含嵌套有序 2 项）', lis.length === 6 && ols.length === 1 && ols[0].children.length === 2);
  const tasks = lis.filter(e => e.classList.contains('mdTask'));
  check('任务列表：☑ 改期 / ☐ 通知老师', tasks.length === 2 && tasks.some(e => e.textContent.indexOf('☑') === 0 && e.textContent.indexOf('改期') > -1) && tasks.some(e => e.textContent.indexOf('☐') === 0));
  const bqs = collect(mdBubble, tag('blockquote'));
  check('引用块 ×1（"注意：周五半天"）', bqs.length === 1 && bqs[0].textContent.indexOf('注意：周五半天') > -1);
  const as = collect(mdBubble, tag('a'));
  check('链接 ×3（显式/裸 URL 自动/图片链接）', as.length === 3
    && as.some(e => e.href === 'https://example.com/x' && e.textContent === '教务系统')
    && as.some(e => e.href === 'https://example.com/y')
    && as.some(e => e.href === 'https://example.com/z.png' && e.textContent.indexOf('🖼') === 0 && e.textContent.indexOf('课表') > -1));
  check('分隔线 hr ×1', collect(mdBubble, tag('hr')).length === 1);
}

// ---- 2) 安全不变量：源文本 HTML 不进 DOM；链接白名单 http/https/mailto ----
const xss = '<img src=x onerror=alert(1)> 与 <script>alert(2)</scr' + 'ipt> [点我](javascript:alert(3)) [二](data:text/html;base64,xxx) [三](vbscript:msg) [正常](mailto:a@b.c)';
send({ t: 'message', role: 'assistant', text: xss, seq: 11 });
await flush();
console.log('2) XSS / URL 白名单');
const xssBubble = log.children.find(c => c.classList.contains('bBot') && c._mdRaw === xss);
check('恶意消息气泡存在', !!xssBubble);
if (xssBubble) {
  check('不产生 <img> / <script> 元素', collect(xssBubble, tag('img')).length === 0 && collect(xssBubble, tag('script')).length === 0);
  check('HTML 按字面文本显示', xssBubble.textContent.indexOf('<img src=x onerror=alert(1)>') > -1 && xssBubble.textContent.indexOf('<script>alert(2)') > -1);
  const badHref = collect(xssBubble, tag('a')).filter(e => String(e.href || '').match(/^(javascript|data|vbscript):/i));
  check('javascript:/data:/vbscript: 链接不渲染为 <a>', badHref.length === 0);
  check('危险链接文本按原文保留', xssBubble.textContent.indexOf('[点我](javascript:alert(3))') > -1);
  check('mailto: 白名单放行', collect(xssBubble, tag('a')).some(e => e.href === 'mailto:a@b.c'));
}

// ---- 3) 流式 partial 逐帧 markdown：未闭合语法按原文，闭合后成形 ----
console.log('3) 流式渲染');
send({ t: 'partial', text: '生成中 **未闭合' });
await flush();
const live1 = log.lastElementChild;
check('未闭合 ** 按字面显示', live1.classList.contains('bBot') && live1.textContent.indexOf('生成中 **未闭合') > -1);
send({ t: 'partial', text: '生成中 **已闭合**' });
await flush();
const live2 = log.lastElementChild;
check('闭合后渲染为 <strong>', collect(live2, tag('strong')).some(e => e.textContent === '已闭合'));
send({ t: 'message', role: 'assistant', text: '生成中 **已闭合**', seq: 12 });
await flush();
check('最终消息替换流式气泡（各 1 条）', log.children.filter(c => c.classList.contains('bBot') && c._mdRaw === '生成中 **已闭合**').length === 1 && log.children.filter(c => c.textContent.indexOf('（继续处理中）') > -1).length === 0);

// ---- 4) 与去重「原位采纳」联动：markdown 用户消息也不重复 ----
console.log('4) markdown 用户消息去重联动');
byId.chatIn.value = '**加粗**的消息';
byId.chatSend.onclick();
await flush();
send({ t: 'message', role: 'user', text: '**加粗**的消息', seq: 13 });
await flush();
const mdUser = log.children.filter(c => c.classList.contains('bUser') && c._mdRaw === '**加粗**的消息');
check('只渲染 1 条且原位采纳（data-local 清除）', mdUser.length === 1 && mdUser[0].getAttribute('data-local') === null);
check('用户消息同样渲染 markdown（strong）', mdUser.length === 1 && collect(mdUser[0], tag('strong')).length === 1);

console.log(`\n${pagePath}\n  通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
