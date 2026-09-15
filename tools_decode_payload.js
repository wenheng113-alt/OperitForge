// 解码 toolpkg 内嵌载荷，用于与项目 server 做 diff
const fs = require('fs');
const s = fs.readFileSync('/tmp/tp/packages/netease_listen.js', 'utf8');
const keys = [['server', '.js'], ['player', '.html'], ['lottie', '.js'], ['disk', '.png']];
for (const [k, ext] of keys) {
  const re = new RegExp(k + ':"([A-Za-z0-9+/=]+)"');
  const m = s.match(re);
  if (!m) { console.log(k, 'NOT FOUND'); continue; }
  const b = Buffer.from(m[1], 'base64');
  fs.writeFileSync('/tmp/payload_' + k + ext, b);
  console.log(k, m[1].length, '->', b.length, 'bytes');
}
