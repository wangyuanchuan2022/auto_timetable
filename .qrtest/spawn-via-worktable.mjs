// 经 dsh-worktable 终端通道拉起 mobile-server（服务成为 DSH web 宿主子进程，跨命令存活）
// 与 schedule.html 手机访问面板的自动拉起完全同路径。
// 鉴权（2026-09-10 安全补丁）：补丁生效时经 login 换 token 走 ?auth=；未生效时自动回退直连。
import { worktableToken, termUrl } from './worktable-auth.mjs';

const auth = await worktableToken();
if (!auth) console.log('[auth] 无 token（补丁未生效或未配置 PIN）——按旧版无鉴权直连');
const ws = new WebSocket(termUrl(auth?.token, 'cwd=' + encodeURIComponent('D:\\tools\\auto_timetable') + '&cols=80&rows=24'));
const done = new Promise((resolve) => {
  let settled = false;
  const fin = (ok, why) => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve({ ok, why }); } };
  ws.onopen = () => {
    try {
      ws.send("Start-Process node -ArgumentList 'mobile-server.mjs' -WorkingDirectory 'D:\\tools\\auto_timetable' -WindowStyle Hidden\r");
    } catch (e) { fin(false, 'send: ' + e.message); return; }
    setTimeout(() => fin(true, 'sent'), 1500);
  };
  ws.onerror = () => fin(false, 'ws error（若 401：PIN 文件缺失/密码已变，重跑 patches/dsh-worktable/setup-pin.mjs）');
  ws.onclose = () => fin(false, 'closed early');
  setTimeout(() => fin(false, 'timeout'), 6000);
});
const r = await done;
console.log('spawn via worktable:', r.ok ? 'sent' : 'FAILED: ' + r.why);
