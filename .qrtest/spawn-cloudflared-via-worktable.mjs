// spawn-cloudflared-via-worktable.mjs — 经 dsh-worktable 终端通道拉起 cloudflared 守护
// （同 spawn-via-worktable.mjs 的存活机制：DSH 宿主子进程，跨命令不被 job-object 回收）。
// 场景：quick tunnel 进程活着但边缘断线（进程活≠隧道活），守护只查进程存在性救不了，
// 需先 Stop-Process 僵死实例，再跑本脚本重启守护 → 新 URL 10 秒内写入 tunnel.log，
// mobile-server 每 10 秒自动发现，面板二维码与 /api/status 随之更新。
const ws = new WebSocket('ws://127.0.0.1:3080/api/worktable/term?cwd=' + encodeURIComponent('D:\\tools\\auto_timetable') + '&cols=80&rows=24');
const done = new Promise((resolve) => {
  let settled = false;
  const fin = (ok, why) => { if (!settled) { settled = true; try { ws.close(); } catch {} resolve({ ok, why }); } };
  ws.onopen = () => {
    try {
      ws.send('start "" /min "D:\\tools\\auto_timetable\\.mobile-srv\\start-cloudflared.cmd"\r');
    } catch (e) { fin(false, 'send: ' + e.message); return; }
    setTimeout(() => fin(true, 'sent'), 1500);
  };
  ws.onerror = () => fin(false, 'ws error');
  ws.onclose = () => fin(false, 'closed early');
  setTimeout(() => fin(false, 'timeout'), 6000);
});
const r = await done;
console.log('spawn cloudflared guardian via worktable:', r.ok ? 'sent' : 'FAILED: ' + r.why);
