// mux 传输层冒烟测试：连宿主 /api/events.mux，确认能收到 session/event 帧
const ws = new WebSocket('ws://127.0.0.1:3080/api/events.mux');
let frames = 0, sessionEvents = 0;
const t0 = Date.now();
const timer = setTimeout(() => {
  console.log(`frames=${frames} session/event=${sessionEvents} →`, frames > 0 && sessionEvents > 0 ? 'MUX OK' : 'MUX NO TRAFFIC');
  process.exit(frames > 0 && sessionEvents > 0 ? 0 : 1);
}, 25000);
ws.onopen = () => console.log('mux ws open');
ws.onmessage = (ev) => {
  frames++;
  try {
    const full = JSON.parse(String(ev.data));
    if (full?.type === 'server-request' && full.payload?.type === 'session/event') {
      sessionEvents++;
      if (sessionEvents === 1) console.log('first session/event:', full.payload.event?.type, 'sid=', String(full.payload.sessionId).slice(0, 18) + '…');
    } else if (frames <= 2) console.log('frame:', full?.type, full?.payload?.type ?? '');
  } catch (e) { console.log('bad frame'); }
};
ws.onerror = () => { console.log('mux ws ERROR'); process.exit(1); };
