// page-harness.mjs — 手机端页面回归测试共用架：提取 mobile.html 内联 <script>，
// 在桩 DOM/网络环境中执行真实页面代码，提供帧注入与微任务冲刷。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function makeEl(tag) {
  const el = {
    tagName: String(tag || '').toUpperCase(),
    nodeType: 1,
    style: {},
    attrs: [],
    children: [],
    parentNode: null,
    className: '',
    value: '',
    disabled: false,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    appendChild(c) {
      // 与真实 DOM 一致：追加已有父节点的节点 = 从原父节点移除再挂载
      if (c.parentNode && c.parentNode !== el) {
        const prev = c.parentNode.children.indexOf(c);
        if (prev >= 0) c.parentNode.children.splice(prev, 1);
      }
      c.parentNode = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; return c; },
    addEventListener() {}, removeEventListener() {},
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    removeAttribute(k) { delete el.attrs[k]; },
    scrollIntoView() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    click() {}, focus() {},
  };
  Object.defineProperty(el, 'lastElementChild', { get() { return el.children[el.children.length - 1] || null; } });
  Object.defineProperty(el, 'firstChild', { get() { return el.children[0] || null; } });
  el.classList = {
    contains(c) { return el.className.split(/\s+/).indexOf(c) !== -1; },
    add(c) { if (!el.classList.contains(c)) el.className = (el.className ? el.className + ' ' : '') + c; },
    remove(c) { el.className = el.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
  };
  // textContent 与真实 DOM 一致：读取时拼接后代文本；写入时清空后代
  let directText = '';
  Object.defineProperty(el, 'textContent', {
    get() {
      if (!el.children.length) return directText;
      let out = '';
      for (const c of el.children) out += c.textContent;
      return out;
    },
    set(v) { directText = String(v); el.children = []; },
  });
  let inner = '';
  Object.defineProperty(el, 'innerHTML', { get() { return inner; }, set(v) { inner = String(v); if (inner === '') { el.children = []; directText = ''; } } });
  return el;
}

export function makeTextNode(t) {
  return { nodeType: 3, tagName: null, textContent: String(t), parentNode: null, children: [] };
}

export function loadPage(pagePath) {
  const html = readFileSync(pagePath, 'utf8');
  // 页面主脚本已抽离为外链 mobile-app.js（mobile.html 内只余 <script src> 引用）：
  // 优先加载外链文件内容；找不到时回退旧版内联 <script> 提取（向后兼容）。
  let appSrc = '';
  if (/<script src="\/mobile-app\.js"><\/script>/.test(html)) {
    try { appSrc = readFileSync(new URL('../mobile-app.js', import.meta.url), 'utf8'); } catch (e) {}
  }
  if (!appSrc) {
    const m = html.match(/<script>([\s\S]*)<\/script>/);
    if (!m) throw new Error('未找到页面主脚本（外链 mobile-app.js 或内联 <script>）: ' + pagePath);
    appSrc = m[1];
  }

  // 共享领域模块 occur.js 先于页面脚本加载（与浏览器 <script src> 同路径；
  // UMD 包装在沙箱全局挂 TTOccur——页面内联脚本以裸引用 TTOccur 使用，绝不在页面里留副本）
  let occurSrc = '';
  try { occurSrc = readFileSync(new URL('../occur.js', import.meta.url), 'utf8'); } catch (e) {}

  const ids = ['datePick', 'list', 'notifyBtn', 'notifyState', 'chatLog', 'chatThumbs', 'chatIn', 'chatAttach', 'chatSend', 'chatFile', 'modelBtn', 'newChatBtn', 'dDel', 'pIn', 'pOk', 'pCancel', 'pMsg', 'dWeekPattern', 'dWeekPatternWrap', 'dSkip', 'dTaskStart', 'dTaskStartWrap'];
  const byId = {}; ids.forEach(id => { byId[id] = makeEl('div'); });

  let lastWs = null;
  class WebSocketStub {
    constructor(url) { this.url = url; this.readyState = 1; lastWs = this; }
    close() { this.readyState = 3; }
  }
  class EventSourceStub { constructor() { this.readyState = 0; } close() {} }

  const calls = []; // 记录页面发起的 fetch（url 顺序），供测试断言
  const sandbox = {
    console, Date, Promise, JSON, Math, Number, String, Array, Object, RegExp, parseInt, parseFloat, isNaN, isFinite, Set, Map,
    URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      getElementById: id => byId[id] || null,
      createElement: t => makeEl(t),
      createTextNode: t => makeTextNode(t),
      addEventListener() {},
      body: makeEl('body'),
    },
    window: { prompt: () => null },
    navigator: {},
    location: { protocol: 'http:', host: '127.0.0.1:3190', search: '', href: 'http://x/' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    WebSocket: WebSocketStub,
    EventSource: EventSourceStub,
    fetch: (url) => {
      calls.push(String(url));
      if (url === '/api/chat/models') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, current: { provider: 'p', model: 'm' } }) });
      if (url === '/api/schedule') return Promise.resolve({ ok: true, status: 200, json: async () => ({ events: [] }) });
      if (url === '/api/chat/reset') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'session-new' }) });
      if (url === '/api/chat/stream') return Promise.resolve({ ok: true, status: 200, text: async () => '' }); // 立即收尾：busy UI 复位，最终消息由 watch 流落地
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    },
  };
  vm.createContext(sandbox);
  if (occurSrc) vm.runInContext(occurSrc, sandbox, { timeout: 10000 }); // 先挂全局 TTOccur
  vm.runInContext(appSrc, sandbox, { timeout: 10000 }); // 再跑页面主脚本（与浏览器顺序一致）
  return {
    byId,
    calls,
    send: (f) => lastWs && lastWs.onmessage({ data: JSON.stringify(f) }),
    ws: () => lastWs,
    flush: () => new Promise(r => setImmediate(r)),
    log: byId.chatLog,
  };
}

// 遍历辅助：收集满足谓词的元素（深度优先）
export function collect(el, pred, out = []) {
  if (!el) return out;
  if (el.nodeType === 1 && pred(el)) out.push(el);
  for (const c of el.children || []) collect(c, pred, out);
  return out;
}
