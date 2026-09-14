// verify-tunnel-content.mjs — 一次性内容级验证：公网隧道三个端点各回什么（不看状态码看内容）
const BASE = process.argv[2] || 'https://weather-personal-individually-cooked.trycloudflare.com';
const kind = (t) => t.includes('"tunnel"') ? 'JSON_API'
  : t.includes('datePick') ? 'MOBILE_HTML'
  : t.includes('请使用安全地址') ? 'NOTICE_PAGE' : 'OTHER';
for (const path of ['/', '/api/status']) {
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(9000) });
    const t = await r.text();
    console.log(`${path} -> STATUS ${r.status} KIND ${kind(t)} | ${t.slice(0, 100).replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`${path} -> ERR ${e.message}`);
  }
}
