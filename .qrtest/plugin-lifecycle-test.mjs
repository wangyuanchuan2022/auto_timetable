// 插件生命周期验证（确定性版）：
// apply → 子进程出现并监听；dispose → 该子进程（按插件日志中的 pid）确定死亡
import { apply } from '../mobile-plugin/src/index.js';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

const portTaken = (port) => new Promise((r) => {
  const s = net.connect({ port, host: '127.0.0.1', timeout: 400 });
  s.once('connect', () => { s.destroy(); r(true); });
  s.once('error', () => r(false));
  s.once('timeout', () => { s.destroy(); r(false); });
});

let dispose = null;
let pluginPid = null;
const ctx = {
  logger: {
    info: (msg) => {
      console.log('[plugin]', msg);
      const m = String(msg).match(/pid=(\d+)/);
      if (m) pluginPid = Number(m[1]);
    },
    warn: (msg) => console.log('[plugin:warn]', msg),
  },
  effect(fn) { dispose = fn(); return dispose; }, // cordis 语义：fn() 返回清理函数
};

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

apply(ctx);
await sleep(2500);
console.log('child pid =', pluginPid, '| listening =', await portTaken(3190));
if (!pluginPid || !alive(pluginPid)) { console.log('FAIL: child not spawned'); process.exit(1); }

dispose();
let dead = false;
for (let i = 0; i < 10 && !dead; i++) {
  await sleep(700); // eslint-disable-line no-await-in-loop
  dead = !alive(pluginPid);
}
console.log('after dispose: child dead =', dead);
console.log(dead ? 'RESULT: 插件生命周期 OK（apply 拉起 / dispose 回收）' : 'FAIL: child still alive');
process.exit(dead ? 0 : 1);
