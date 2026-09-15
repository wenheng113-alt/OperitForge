'use strict';
/* 全接口冒烟测试：逐个打关键端点，只打印 状态码 + 关键字段，控制输出量 */
const http = require('http');
const BASE = 'http://127.0.0.1:18765';
function req(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(path, BASE);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => { let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ code: res.statusCode, body: s })); });
    r.on('error', e => resolve({ code: 0, body: 'ERR:' + e.message }));
    if (data) r.write(data);
    r.end();
  });
}
function brief(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }
(async () => {
  const tests = [
    ['GET', '/health', null],
    ['GET', '/state', null],
    ['GET', '/mode', null],
    ['GET', '/chat/history', null],
    ['GET', '/ai/config', null],
    ['GET', '/source/list', null],
    ['GET', '/favorite/list', null],
    ['GET', '/avatar/me', null],
    ['GET', '/avatar/has', null],
    ['GET', '/native/cookie/status', null],
    ['GET', '/native/login/qr/status', null],
    ['GET', '/native/login/sms/status', null],
    ['POST', '/chat', { from: 'host', name: '体检', text: 'smoke test' }],
    ['POST', '/control', { action: 'heartbeat' }],
    ['POST', '/control', { action: 'songinfo' }],
  ];
  for (const [m, p, b] of tests) {
    const r = await req(m, p, b);
    console.log(m.padEnd(4), p.padEnd(28), '->', r.code, brief(r.body, 120));
  }
  console.log('SMOKE_DONE');
})();