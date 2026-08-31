// schedule-harness.mjs — schedule.html 回归测试共用架（F-1）。
// 提取页面首个内联 <script> 块（非贪婪匹配，跳过 <script src=...>，不吞第二个内联块），
// 在 node:vm 桩 DOM/网络环境中执行真实页面代码。加载顺序同浏览器：先 occur.js（挂全局
// TTOccur，单一领域实现），再页面内联脚本。
// 桩 DOM 复用 page-harness.mjs 的 makeEl/makeTextNode/collect —— 其 appendChild
// 「先摘除旧父节点」与 textContent getter「拼接后代文本」语义都真实踩过坑，勿重造。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { makeEl, makeTextNode, collect } from './page-harness.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // 仓库根目录
export const PAGE_PATH = ROOT + 'schedule.html';
export const OCCUR_PATH = ROOT + 'occur.js';

// 页面主脚本引用过的全部元素 id（漏一个，页面 $(id) 拿 null 直接炸——README 已记录该坑）
const IDS = [
  'ttTitle', 'ttSub', 'ttStatus', 'ttGrid', 'rangeSel', 'zoomSel', 'datePicker', 'ttLegend', 'ttStats',
  'detailPanel', 'editPanel', 'jsonArea', 'editMsg', 'saveStatus', 'backupPanel', 'edHead', 'btnDeleteEdit',
  'eName', 'eType', 'eWeekday', 'eDate', 'eDeadline', 'eInterval', 'eUnit', 'eRStart', 'eDays', 'eStart',
  'eEnd', 'eLoc', 'eNote', 'eLead', 'edMsg', 'editorPanel', 'ewWrap', 'edWrap', 'eiWrap', 'euWrap',
  'ersWrap', 'edaysWrap', 'edTypeBadge', 'termBadge', 'badEventsPanel', 'badEventsText', 'historyList',
  'historyPanel', 'btnHistory', 'btnCloseHistory', 'btnImport', 'importFile', 'btnImportCancel',
  'importPanel', 'importText', 'btnImportOk', 'btnExportJson', 'btnExportIcs', 'btnPrev', 'btnNext',
  'btnToday', 'btnRefresh', 'btnEdit', 'btnApply', 'btnReset', 'btnCloseDetail', 'btnNew', 'btnUseBackup',
  'btnKeepFile', 'btnCancelEdit', 'btnSaveEdit', 'dTitle', 'dType', 'dTime', 'dRepeat', 'dLoc', 'dNote',
];
// 页面 HTML 内联 style="display:none" 的面板：桩同样初始化为 'none'，
// 否则「display === 'none' 则切换」类逻辑（如 btnHistory）语义反转。
const HIDDEN_IDS = ['termBadge', 'saveStatus', 'badEventsPanel', 'editPanel', 'historyPanel',
  'importPanel', 'backupPanel', 'editorPanel', 'detailPanel'];

/**
 * 加载 schedule.html 主脚本并执行。
 * @param {object} [opts.schedule] 初始 schedule.json 内容（GET 候选全部命中它）
 * @param {object|string|null} [opts.backup] 预置 localStorage 备份（模拟上次写回失败）
 */
export function loadPage(opts = {}) {
  const html = readFileSync(PAGE_PATH, 'utf8');
  const occurSrc = readFileSync(OCCUR_PATH, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/); // 非贪婪：只取首个内联块
  if (!m) throw new Error('未找到内联 <script> 块: ' + PAGE_PATH);

  const byId = {};
  IDS.forEach((id) => { byId[id] = makeEl('div'); });
  HIDDEN_IDS.forEach((id) => { byId[id].style.display = 'none'; });

  // localStorage 桩（带真实读写语义，备份冲突场景依赖）
  const store = {};
  if (opts.backup !== undefined && opts.backup !== null) {
    store['tt-schedule-backup'] = typeof opts.backup === 'string' ? opts.backup : JSON.stringify(opts.backup);
  }
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };

  // fetch 桩：GET 数据文件 → 返回当前 serve 内容；POST /api/worktable/write → 记录并更新 serve（写后回读校验可见）
  let serve = opts.schedule === undefined ? null : JSON.stringify(opts.schedule);
  const writes = []; // { path, content }
  const calls = [];
  const warns = [];
  const fetchStub = (url, opts2) => {
    const u = String(url);
    calls.push(u + (opts2 && opts2.method === 'POST' ? ' [POST]' : ''));
    if (opts2 && opts2.method === 'POST' && u.indexOf('/api/worktable/write') > -1) {
      const body = JSON.parse(opts2.body);
      writes.push({ path: body.path, content: body.content });
      serve = body.content;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    }
    const path = u.replace(/^[a-z]+:\/\/[^/]+/i, '');
    if (/(^|\/)schedule\.json$/i.test(path) && serve !== null) {
      return Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse(serve), text: async () => serve });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  };

  const doc = {
    getElementById: (id) => (id in byId ? byId[id] : null),
    createElement: (t) => makeEl(t),
    createTextNode: (t) => makeTextNode(t),
    addEventListener() {},
    // saveEdit 用 document.querySelectorAll('#eDays .ed-day') 收集星期复选框：
    // 精确实现这一个选择器（桩 DOM 无真实选择器引擎），其余返回空
    querySelectorAll: (sel) => {
      if (sel === '#eDays .ed-day') {
        return collect(byId.eDays, (e) => e.classList.contains('ed-day'));
      }
      return [];
    },
    body: makeEl('body'),
    documentElement: makeEl('html'),
    head: makeEl('head'),
    title: '',
  };

  const sandbox = {
    console: { log() {}, error() {}, warn: (...a) => { warns.push(a.map(String).join(' ')); } },
    Date, Promise, JSON, Math, Number, String, Array, Object, Boolean, RegExp,
    parseInt, parseFloat, isNaN, isFinite, Set, Map, URLSearchParams,
    // 定时器全桩为 no-op：页面有 3 个周期 setInterval（主题轮询/分钟重渲/45s 自动重读），真跑会引入时序不确定性
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: fetchStub, localStorage, document: doc,
    location: { protocol: 'http:', host: '127.0.0.1:3080', search: '', href: 'http://127.0.0.1:3080/schedule.html' },
    // window.parent 不提供 → ttParentDark 走 catch 返回 null → matchMedia 判暗色（稳定路径）
    window: { matchMedia: () => ({ matches: true, addEventListener() {} }), confirm: () => true },
    navigator: {},
  };
  sandbox.self = sandbox; // occur.js UMD：root=self → TTOccur 挂到沙箱全局（同浏览器）

  vm.createContext(sandbox);
  vm.runInContext(occurSrc, sandbox, { timeout: 10000 }); // ① 先领域模块（挂 TTOccur）
  vm.runInContext(m[1], sandbox, { timeout: 10000 });     // ② 再页面内联脚本（顺序同浏览器）

  return {
    byId, writes, calls, warns, store, collect,
    grid: byId.ttGrid,
    flush: () => new Promise((r) => setImmediate(r)),
    setSchedule: (obj) => { serve = JSON.stringify(obj); },      // 模拟外部改文件后「刷新」
    getSchedule: () => JSON.parse(serve),                        // 当前文件内容（含写回后的）
    eventsOnGrid: () => collect(byId.ttGrid, (e) => e.classList.contains('tt-ev')),
    // 勾选编辑器「重复星期」复选框（模拟用户勾选；saveEdit 经 querySelectorAll 读它）
    checkDays: (vals) => {
      collect(byId.eDays, (e) => e.classList.contains('ed-day')).forEach((cb) => {
        cb.checked = vals.indexOf(parseInt(cb.value, 10)) > -1;
      });
    },
  };
}
