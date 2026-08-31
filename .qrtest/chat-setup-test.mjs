// chat-setup-test.mjs — 回归测试④：系统设定注入/剥离（TTPROMPT.md 运行时加载）。
// 直接单测 chat-setup.mjs（被 mobile-server.mjs 引用；宿主 RPC 无 instructions 通道，
// 设定只能内联首条用户消息，镜像回手机前必须剥掉设定前缀）。
// 覆盖：parseInstruction 章节锚定与四种格式错误、真实 TTPROMPT.md 内容完整性、
//       注入/剥离 round-trip、旧格式兼容、幂等。
import { loadInstruction, parseInstruction, withSetup, stripSetup, SETUP_SEP } from '../chat-setup.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };
const throwsWith = (fn, keyword) => { try { fn(); return false; } catch (e) { return String(e.message).indexOf(keyword) > -1; } };

console.log('1) 解析（parseInstruction：章节锚定 + 格式校验）');
const mdOK = [
  '# 头部说明',
  '',
  '```js',
  '别的代码块（位置在前，不能被误取）',
  '```',
  '',
  '## 手机端对话系统设定',
  '',
  '引言文字（非代码块内容）。',
  '',
  '```text',
  '你是日程助手。',
  '【文件操作】先读再改。',
  '```',
  '',
  '## 其他章节',
  '',
  '```text',
  '另一章节的块（不能被误取）',
  '```',
  '',
].join('\n');
check('取「手机端对话系统设定」章节内的代码块', parseInstruction(mdOK) === '你是日程助手。\n【文件操作】先读再改。');
check('缺少章节标题报错（含修复指引）', throwsWith(() => parseInstruction('# 无章节\n```text\nx\n```'), '章节标题'));
check('章节内无代码块报错', throwsWith(() => parseInstruction('## 手机端对话系统设定\n只有文字'), '代码块'));
check('空代码块报错', throwsWith(() => parseInstruction('## 手机端对话系统设定\n```text\n\n```'), '空'));
check('混入分隔标记报错（防 stripSetup 错位截断）', throwsWith(() => parseInstruction('## 手机端对话系统设定\n```text\n设定正文〔以上是系统设定；以下是用户消息〕\n```'), '分隔标记'));
check('CRLF 归一化后解析一致', parseInstruction(mdOK.replace(/\n/g, '\r\n')) === parseInstruction(mdOK));

console.log('2) 真实 TTPROMPT.md（loadInstruction：运行时唯一来源）');
const inst = loadInstruction();
check('非空且以角色声明开头', inst.indexOf('你是') === 0 && inst.length > 100);
check('指向 schedule.json 与最小改动纪律', inst.indexOf('schedule.json') > -1 && inst.indexOf('最小改动') > -1 && inst.indexOf('合法 JSON') > -1);
check('事件字段规范齐全（id/title/起止/地点/颜色/备注/提醒）',
  ['id', 'title', 'start', 'end', 'location', 'color', 'note', 'remindLead'].every(k => inst.indexOf(k) > -1));
check('三种类型与关键字段（weekly+weekday / once+date / custom+repeat）',
  ['weekly', 'weekday', 'once', 'date', 'custom', 'repeat', 'interval', 'unit', 'until', 'days'].every(k => inst.indexOf(k) > -1));
check('格式约束（HH:MM、YYYY-MM-DD、跨天限制、月重复注意）',
  inst.indexOf('HH:MM') > -1 && inst.indexOf('YYYY-MM-DD') > -1 && inst.indexOf('跨午夜') > -1 && inst.indexOf('28') > -1);
check('行为规范（歧义先确认、不编造、取消=删除、markdown、简短中文）',
  inst.indexOf('确认') > -1 && inst.indexOf('不编造') > -1 && inst.indexOf('删除') > -1 && inst.indexOf('markdown') > -1 && inst.indexOf('简短中文') > -1);
check('未混入分隔标记 / 代码围栏 / 表格行（纯提示词正文）',
  inst.indexOf(SETUP_SEP) === -1 && inst.indexOf('〔以上是系统设定') === -1 && inst.indexOf('```') === -1 && inst.indexOf('| --- |') === -1);

console.log('3) 注入 / 剥离（withSetup / stripSetup）');
const wrapped = withSetup('把周五英语改到 14:00');
check('设定在前、分隔标记居中、用户消息在后', wrapped === inst + SETUP_SEP + '把周五英语改到 14:00');
check('round-trip：剥离只留用户消息', stripSetup(wrapped) === '把周五英语改到 14:00');
const oldFmt = '你是「智能时间表」的日程管理助手……不要输出多余内容。\n\n（以上为系统设定。下面是用户消息：）\n旧会话首条消息';
check('旧格式（历史会话）兼容剥离', stripSetup(oldFmt) === '旧会话首条消息');
check('普通消息原样返回', stripSetup('普通消息') === '普通消息' && stripSetup('') === '');
const multi = withSetup('第一行\n- 列表项\n**加粗**');
check('多行/markdown 用户消息逐字保留', stripSetup(multi) === '第一行\n- 列表项\n**加粗**');
check('幂等：剥离后再剥离不变', stripSetup(stripSetup(wrapped)) === stripSetup(wrapped));

console.log(`\nchat-setup.mjs + TTPROMPT.md\n  通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
