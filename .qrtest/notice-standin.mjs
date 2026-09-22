// notice-standin.mjs — 故障注入替身：在 127.0.0.1:<port> 回直连收口引导页，
// 把隧道置于 2026-09-14 事故签名态（公网 200 + 引导页内容），验证探活/守护/监视器判定。
// 用法：node notice-standin.mjs [port]   （默认 3191；测试结束 kill 即收）
import http from 'node:http';

const port = parseInt(process.argv[2], 10) || 3191;
const NOTICE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>智能时间表 · 请使用安全地址访问</title></head>
<body><main><h1>🔒 请使用安全地址访问</h1>
<p>为提升安全性，本端口已停用明文直连服务。</p>
<p class="tip">3 秒后自动跳转到安全地址（FAULT-INJECTION STANDIN）。</p></main></body></html>`;

http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(NOTICE);
}).listen(port, '127.0.0.1', () => console.log(`[standin] notice page serving on 127.0.0.1:${port} (all paths)`));
