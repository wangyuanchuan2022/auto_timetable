// offline-page-test.mjs — APP 离线兜底页（assets/offline.html）回归测试。
// 运行：node .qrtest/offline-page-test.mjs
// 做法：提取 offline.html 内联脚本，在桩 DOM（复用 page-harness 的 makeEl）中执行；
//       领域判定用真实 occur.js（require 仓库根模块，与生产同源）。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { makeEl } from './page-harness.mjs';

const require = createRequire(import.meta.url);
const TTOccur = require('../occur.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  [OK] ' + name); }
  else { fail++; console.log('  [FAIL] ' + name); }
}

const html = readFileSync(new URL('../android-app/app/src/main/assets/offline.html', import.meta.url), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('[FAIL] offline.html 内联脚本未找到'); process.exit(1); }
const src = m[1];

function boot(bridgeImpl) {
  const ids = ['banner', 'bTitle', 'bMeta', 'bStale', 'bRemind', 'bRetry', 'bScan', 'bInput', 'dayBar', 'dPrev', 'dLabel', 'dNext', 'list'];
  const byId = {};
  ids.forEach(id => { byId[id] = makeEl('div'); });
  const sandbox = {
    console, Date, JSON, Math, Number, String, Array, Object, parseInt, isNaN, Promise,
    setTimeout, clearTimeout,
    document: {
      getElementById: id => byId[id] || null,
      createElement: t => makeEl(t),
      body: makeEl('body'),
    },
    location: { reload() { sandbox._reloaded = (sandbox._reloaded || 0) + 1; } },
    window: { NativeBridge: bridgeImpl || undefined, TTOccur },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { timeout: 10000 });
  return { byId, sandbox };
}

const items = (h) => h.byId.list.children.filter(el => String(el.className).indexOf('it') !== -1);
const pad2 = (n) => String(n).padStart(2, '0');
const iso = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const now = new Date();
const today = iso(now);
const yest = iso(new Date(now.getTime() - 86400000));
const weekday = ((now.getDay() + 6) % 7) + 1; // ISO 1=周一..7=周日
const goodCache = JSON.stringify({
  savedAt: Date.now(),
  data: { events: [
    { id: 'w1', type: 'weekly', weekday, title: '每周课', start: '09:00', end: '10:30' },
    { id: 'o1', type: 'once', date: yest, title: '昨天的事', start: '08:00', end: '09:00' },
    { id: 't1', type: 'task', title: '今天截止的任务', deadline: today },
  ] },
});

function makeBridge(cacheRaw, nextRemind) {
  const calls = { retry: 0, scan: 0, pairing: 0 };
  return {
    refreshPlan() {},
    saveCache() {},
    readCache() { if (cacheRaw === '__THROW__') throw new Error('io error'); return cacheRaw; },
    nextReminderAt() { return nextRemind === undefined ? '09-13 05:01' : nextRemind; },
    retryConnect() { calls.retry++; },
    startScan() { calls.scan++; },
    showPairingScreen() { calls.pairing++; },
    calls,
  };
}

console.log('-- O1 有缓存：横幅按用户格式展示同步时间，任务沉底，提醒状态可见 --');
const b1 = makeBridge(goodCache);
const h1 = boot(b1);
ok(h1.byId.bTitle.textContent.indexOf('离线数据 · 上次同步') === 0, 'O1 标题按「离线数据 · 上次同步 …」格式');
ok(/上次同步 \d{2}-\d{2} \d{2}:\d{2}/.test(h1.byId.bTitle.textContent), 'O1 同步时间为 MM-DD HH:mm');
ok(h1.byId.bMeta.textContent.indexOf('以缓存为准') !== -1, 'O1 横幅注明课表以缓存为准');
ok(h1.byId.bRemind.style.display === 'block' && h1.byId.bRemind.textContent.indexOf('提醒计划仍生效') !== -1, 'O1 提醒状态行显示');
ok(h1.byId.bRemind.textContent.indexOf('下次提醒 09-13 05:01') !== -1, 'O1 显示下次提醒时间');
ok(h1.byId.bStale.style.display === 'none', 'O1 新鲜缓存（<1 天）不显示陈旧警示');
ok(items(h1).length === 2, 'O1 今天条目数 = 2（weekly 命中 + task 截止日；once 昨天不渲染）');
const subs = items(h1).map(it => (it.children[1] && it.children[1].textContent) || '');
ok(String(subs[subs.length - 1]).indexOf('截止') !== -1, 'O1 任务条目沉底在最后');
ok(h1.byId.dLabel.textContent === '今天', 'O1 默认显示今天');

console.log('-- O2 按钮动作走原生桥 --');
h1.byId.bRetry.onclick();
h1.byId.bScan.onclick();
h1.byId.bInput.onclick();
ok(b1.calls.retry === 1 && b1.calls.scan === 1 && b1.calls.pairing === 1, 'O2 重连/扫码/手动输入各调用桥一次');

console.log('-- O3 日期切换 -7..+7 窗口 --');
h1.byId.dPrev.onclick();
ok(h1.byId.dLabel.textContent.indexOf('昨天') !== -1, 'O3 前翻显示昨天');
h1.byId.dNext.onclick();
h1.byId.dNext.onclick();
ok(h1.byId.dLabel.textContent.indexOf('明天') !== -1, 'O3 后翻显示明天');
for (let i = 0; i < 20; i++) h1.byId.dNext.onclick();
const clamped = h1.byId.dLabel.textContent;
h1.byId.dNext.onclick();
ok(h1.byId.dLabel.textContent === clamped, 'O3 越界翻页被钳制（+7 天窗后不再移动）');

console.log('-- O4 无缓存 / 缓存损坏 / 读缓存抛异常：给出明确提示不炸 --');
const b4 = makeBridge('');
const h4 = boot(b4);
ok(h4.byId.bTitle.textContent.indexOf('尚未同步过课表') !== -1, 'O4 无缓存时标题说明尚未同步');
ok(h4.byId.bMeta.textContent.indexOf('没有可用的离线缓存') !== -1, 'O4 无缓存时横幅说明原因');
ok(h4.byId.bRemind.style.display === 'none', 'O4 无缓存时不显示提醒状态（从未同步即无提醒）');
ok(h4.byId.list.textContent.indexOf('暂无离线数据') !== -1, 'O4 无缓存时列表给出引导文案');
const b4b = makeBridge('{broken json');
const h4b = boot(b4b);
ok(h4b.byId.bMeta.textContent.indexOf('没有可用的离线缓存') !== -1, 'O4 缓存损坏同样走无缓存路径');
const b4c = makeBridge('__THROW__');
const h4c = boot(b4c);
ok(h4c.byId.list.textContent.indexOf('暂无离线数据') !== -1, 'O4 桥读缓存抛异常不炸（try/catch 兜住）');

console.log('-- O5 无原生桥（纯浏览器打开）：扫码/手输禁用，重连退化为 reload，提醒状态隐藏 --');
const h5 = boot(null);
ok(h5.byId.bScan.disabled === true && h5.byId.bInput.disabled === true, 'O5 无桥时扫码/手输按钮禁用');
ok(h5.byId.bRetry.textContent === '重试', 'O5 无桥时重连按钮退化为「重试」');
ok(h5.byId.bRemind.style.display === 'none', 'O5 无桥时提醒状态行隐藏');
h5.byId.bRetry.onclick();
ok((h5.sandbox._reloaded || 0) === 1, 'O5 无桥重连走 location.reload 兜底');

console.log('-- O6 空日程日：明确「暂无日程」而非空白 --');
const emptyCache = JSON.stringify({ savedAt: Date.now(), data: { events: [{ id: 'o2', type: 'once', date: yest, title: '昨天唯一的事', start: '08:00', end: '09:00' }] } });
const h6 = boot(makeBridge(emptyCache));
ok(h6.byId.list.className === 'empty' && h6.byId.list.textContent.indexOf('暂无日程') !== -1, 'O6 今天无事件时显示暂无日程');

console.log('-- O7 陈旧缓存（≥1 天）：标题带天数 + 陈旧警示行 --');
const staleCache = JSON.stringify({
  savedAt: Date.now() - 2 * 86400000,
  data: { events: [{ id: 'w9', type: 'weekly', weekday, title: '每周课', start: '09:00', end: '10:30' }] },
});
const h7 = boot(makeBridge(staleCache));
ok(h7.byId.bTitle.textContent.indexOf('（2 天前同步）') !== -1, 'O7 标题带「2 天前同步」陈旧度');
ok(h7.byId.bStale.style.display === 'block' && h7.byId.bStale.textContent.indexOf('删除或新增') !== -1, 'O7 陈旧警示行点出「期间的改动不反映」');

console.log('-- O8 无已排提醒：提醒行明示「暂无」而非沉默 --');
const h8 = boot(makeBridge(goodCache, ''));
ok(h8.byId.bRemind.style.display === 'block' && h8.byId.bRemind.textContent.indexOf('暂无未来 30 天内的已排提醒') !== -1, 'O8 无已排提醒时明确说明（30 天窗口径）');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
