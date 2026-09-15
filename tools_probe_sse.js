/* SSE 端到端探针：模拟播放页挂载 SSE，发一条 toggle，看是否收到 sync 回推 */
const http = require('http');
const base = 'http://127.0.0.1:18765';

function post(p, b) {
  return new Promise((res) => {
    const data = JSON.stringify(b || {});
    const r = http.request(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (x) => { let s = ''; x.on('data', (c) => s += c); x.on('end', () => res(s)); });
    r.on('error', (e) => res('ERR:' + e.message));
    r.write(data); r.end();
  });
}

let syncCount = 0, lastSync = null;
const sse = http.get(base + '/events', (res) => {
  console.log('SSE status', res.statusCode);
  res.setEncoding('utf8');
  let buf = '';
  res.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      if (chunk.startsWith('event: sync')) {
        syncCount++;
        try {
          const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
          if (dataLine) { lastSync = JSON.parse(dataLine.slice(6)); }
        } catch (e) {}
        console.log('>> SYNC#' + syncCount, 'playing=' + (lastSync && lastSync.playing),
                    'pos=' + (lastSync && lastSync.positionMs),
                    'song=' + (lastSync && lastSync.song && lastSync.song.id),
                    'seq=' + (lastSync && lastSync.seq));
      }
    }
  });
});
sse.on('error', (e) => console.log('SSE err', e.message));

(async () => {
  await new Promise(r => setTimeout(r, 800));
  console.log('join =>', await post('/join', { clientId: 'probe_sse', name: 'probe', role: 'host' }));
  await new Promise(r => setTimeout(r, 300));
  const c = await post('/control', { action: 'toggle' });
  console.log('control toggle =>', c.slice(0, 200));
  // 等 >2.5s 让轮询回灌一次
  await new Promise(r => setTimeout(r, 4000));
  console.log('=== RESULT: syncCount=' + syncCount + ' ===');
  process.exit(0);
})();
