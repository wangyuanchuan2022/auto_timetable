// 模拟 schedule.html 的 autoStartServer：经 worktable 终端 WS 分离启动 mobile-server.mjs
const URL_ = 'ws://127.0.0.1:3080/api/worktable/term?cwd=' + encodeURIComponent('D:\\tools\\auto_timetable') + '&cols=80&rows=24';
const ws = new WebSocket(URL_);
const t = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 6000);
ws.onopen = () => {
  ws.send("Start-Process node -ArgumentList 'mobile-server.mjs' -WorkingDirectory 'D:\\tools\\auto_timetable' -WindowStyle Hidden\r");
  setTimeout(() => { ws.close(); }, 1200);
};
ws.onerror = () => { console.log('WS ERROR'); process.exit(1); };
ws.onmessage = (ev) => { /* 终端回显，忽略 */ };
ws.onclose = () => {
  clearTimeout(t);
  // 等 1.6s 后探测 /api/status（与页面逻辑一致）
  setTimeout(() => {
    fetch('http://127.0.0.1:3190/api/status').then(r => r.json()).then(j => {
      console.log('auto-start', j.ok ? 'SUCCESS' : 'unexpected', JSON.stringify(j).slice(0, 200));
    }).catch(e => { console.log('auto-start FAILED:', e.message); process.exit(1); });
  }, 1600);
};
