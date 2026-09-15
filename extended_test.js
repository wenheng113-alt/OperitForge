'use strict';
/* 扩展冒烟 v2：跳过 SSE /events，每个请求 3s 超时 */
const BASE = 'http://127.0.0.1:18765';
const http = require('http');
function req(method, p, body) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE + p);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, timeout: 3000, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (x) => {
      let s = ''; x.on('data', c => s += c); x.on('end', () => res({ code: x.statusCode, body: s }));
    });
    r.on('timeout', () => { r.destroy(); res({ code: -1, body: 'TIMEOUT' }); });
    r.on('error', e => res({ code: 0, body: String(e.message) }));
    if (data) r.write(data); r.end();
  });
}
(async () => {
  const cases = [
    ['GET', '/mode', null],
    ['GET', '/playlist', null],
    ['GET', '/source/list', null],
    ['GET', '/native/cookie/status', null],
    ['GET', '/native/login/qr/status', null],
    ['GET', '/native/login/sms/status', null],
    ['GET', '/ai/config', null],
    ['GET', '/state', null],
    ['POST', '/control', { action: 'setmeta', meta: { listenSeconds: 100 } }],
    ['POST', '/control', { action: 'setmode', mode: 'order' }],
    ['POST', '/control', { action: 'refreshurl' }],
    ['POST', '/control', { action: 'heartbeat', position: 1000 }],
    ['POST', '/control', { action: 'bogus_action' }],
    ['GET', '/api/song/url?id=1965565156', null],
    ['GET', '/favorite/list', null],
    ['POST', '/favorite/toggle', { song: { id: 'test123', name: 'T', artist: 'A' } }],
    ['GET', '/unknown_endpoint_xyz', null],
  ];
  for (const [m, p, b] of cases) {
    const r = await req(m, p, b);
    let brief = (r.body || '').replace(/\s+/g, ' ').slice(0, 170);
    console.log(m.padEnd(4), p.padEnd(34), r.code, brief);
  }
  // 撤销测试红心，避免每次跑都把 test123 写进 state.json
  await req('POST', '/favorite/toggle', { song: { id: 'test123', name: 'T', artist: 'A' } });
  console.log('EXT_DONE');
})();