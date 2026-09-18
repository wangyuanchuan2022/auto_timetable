// chat-setup.mjs — 手机端专属会话的系统设定注入与镜像剥离。
// 提示词正文唯一来源：同目录 TTPROMPT.md（「## 手机端对话系统设定」章节内的首个 ``` 代码块）。
// 运行时按次加载 + mtime/size 缓存：直接编辑 TTPROMPT.md 即生效，无需改代码、无需重启服务。
//
// 失败语义（TTPROMPT.md 是唯一权威来源，**故意不内置提示词副本**，防双源漂移）：
//   - 文件暂不可读/格式被改坏，且此前成功加载过 → 警告日志 + 沿用上一次成功内容
//     （覆盖"编辑到一半保存"的瞬态抖动；文件修复后自动恢复最新）；
//   - 进程启动以来从未成功加载过 → 抛出带修复指引的错误（经 chatOnce 透传为手机端
//     「发送失败：提示词加载失败：…」），绝不静默注入陈旧内容。
//
// 宿主 session.create / session.prompt 均无 instructions 通道（见 dsh-host-apiproxy schema），
// 设定只能内联在首条用户消息里（chatInited=false 时由 chatOnce 拼接）；手机端 watch 镜像与
// 历史快照用 stripSetup 剥掉设定前缀，只显示用户真实消息（同时保证「原位采纳」文本一致）。

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TTPROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'TTPROMPT.md');
const SECTION_TITLE = '手机端对话系统设定';

/**
 * 从 TTPROMPT.md 正文提取注入用提示词（纯函数，便于单测）。
 * 章节锚定：只取「## 手机端对话系统设定」到下一个二级标题之间的首个 ``` 代码块，
 * 防止文件其他位置的示例/引用代码块被误取。CRLF 归一为 LF。
 * @throws {Error} 缺章节 / 章节内无代码块 / 空块 / 混入分隔标记（均带修复指引）
 */
export function parseInstruction(md) {
  const text = String(md ?? '').replace(/\r\n/g, '\n');
  const head = text.match(/^##[ \t]*手机端对话系统设定[ \t]*$/m);
  if (!head) throw new Error(`TTPROMPT.md 缺少「## ${SECTION_TITLE}」章节标题`);
  const rest = text.slice(head.index + head[0].length);
  const next = rest.search(/^##[ \t]/m); // 章节边界 = 下一个二级标题
  const section = next === -1 ? rest : rest.slice(0, next);
  const m = section.match(/```[^\n]*\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`TTPROMPT.md「${SECTION_TITLE}」章节内没有 \`\`\` 代码块`);
  const body = m[1].trim();
  if (!body) throw new Error('TTPROMPT.md 提示词代码块内容为空');
  // 分隔标记（SETUP_SEP/OLD_SEP）是协议常量，由本模块拼接；混进提示词会让
  // stripSetup 在错误位置截断 → 设定原文泄漏到手机 + 原位采纳失效，加载期直接拒绝
  if (body.includes('〔以上是系统设定') || body.includes('（以上为系统设定')) {
    throw new Error('TTPROMPT.md 提示词里混入了分隔标记（〔以上是系统设定…〕）——请从中移除，标记由 chat-setup.mjs 自动添加');
  }
  return body;
}

let _good = null; // { mtimeMs, size, text }：最近一次成功加载（mtime/size 未变走缓存；故障时兜底）

function failOrLastGood(reason) {
  if (_good) {
    console.warn(`chat-setup: ${reason}，本次注入沿用上一次成功加载的提示词（修复 TTPROMPT.md 后自动恢复最新）`);
    return _good.text;
  }
  throw new Error(`提示词加载失败：${reason}`);
}

/** 读取并解析 TTPROMPT.md；失败语义见文件头注释。 */
export function loadInstruction() {
  let st;
  try {
    st = statSync(TTPROMPT_PATH);
    if (_good && _good.mtimeMs === st.mtimeMs && _good.size === st.size) return _good.text; // 未变走缓存
  } catch (e) {
    return failOrLastGood(`TTPROMPT.md 不可读（${e.message}）`);
  }
  try {
    const text = parseInstruction(readFileSync(TTPROMPT_PATH, 'utf8'));
    _good = { mtimeMs: st.mtimeMs, size: st.size, text };
    return text;
  } catch (e) {
    return failOrLastGood(e.message);
  }
}

/** 设定与用户消息的分隔标记（新格式；协议常量，不要写进 TTPROMPT.md）。 */
export const SETUP_SEP = '\n\n〔以上是系统设定；以下是用户消息〕\n';

/** 旧版分隔标记（历史会话里已存在的格式，剥离时一并兼容）。 */
const OLD_SEP = '（以上为系统设定。下面是用户消息：）\n';

/** 拼接：首条消息 = 设定 + 分隔标记 + 用户消息（提示词加载失败时向上抛错）。 */
export function withSetup(message) {
  return loadInstruction() + SETUP_SEP + String(message ?? '');
}

/** 剥离：镜像到手机的用户消息去掉设定前缀；无标记则原样返回。 */
export function stripSetup(text) {
  const s = String(text ?? '');
  const i = s.indexOf(SETUP_SEP);
  if (i !== -1) return s.slice(i + SETUP_SEP.length);
  const j = s.indexOf(OLD_SEP);
  if (j !== -1) return s.slice(j + OLD_SEP.length);
  return s;
}

// ---------- 定期重注入（防长对话遗忘：设定只在首条注入，几十轮后模型会漂移） ----------
/** 缺省重注入间隔：每 5 条用户消息把系统设定重新包进一次
 *  （可用 settings.chatReinjectEvery 覆盖；0 / 负数 = 关闭）。 */
export const REINJECT_EVERY_DEFAULT = 5;

/** 判定本条用户消息是否应重注入系统设定（纯函数，供单测）。
 *  count = 本会话已成功发送的用户消息条数（不含本条）；首条注入由 chatInited=false
 *  单独驱动，不计入本判定（count<=0 恒 false）；everyN 非正整数视为关闭。 */
export function shouldReinjectSetup(count, everyN = REINJECT_EVERY_DEFAULT) {
  const n = Number(everyN);
  const c = Number(count);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (!Number.isInteger(c) || c <= 0) return false;
  return c % n === 0;
}

/** chatOnce 的注入决策（纯函数，供单测）：新会话首条强制注入；之后每 N 条重注入一次。
 *  重注入与首条注入同构（withSetup 包裹），镜像回手机时 stripSetup 剥掉前缀、
 *  injected 标记照常驱动「已注入系统提示词」提示，用户正文正常显示。 */
export function injectDecision(inited, count, everyN = REINJECT_EVERY_DEFAULT) {
  if (!inited) return { inject: true, reason: 'first' };
  return shouldReinjectSetup(count, everyN)
    ? { inject: true, reason: 'periodic' }
    : { inject: false, reason: 'none' };
}

/** 是否首条注入消息（设定 + 分隔标记 + 用户正文）。⚠️ 必须先过 isHostInjection：
 *  宿主运行时快照正文可能引用分隔标记常量（项目 key 记忆含原文），仅凭含标记会误判。 */
export function hasSetup(text) {
  const s = String(text ?? '');
  return s.indexOf(SETUP_SEP) !== -1 || s.indexOf(OLD_SEP) !== -1;
}

/** 宿主内部注入识别（DSH 宿主会往会话里写自己的系统级 user 消息）：
 *  runtime context 快照 / system-reminder / 上下文压缩检查点。这些不是用户发言，
 *  镜像到手机前必须整条跳过——显示出来就是「一整段系统提示词」事故的根源。 */
export function isHostInjection(text) {
  const s = String(text ?? '');
  return s.startsWith('<system-reminder>')
    || s.startsWith('Current runtime context.')
    || s.startsWith('This is an automatically generated checkpoint');
}
