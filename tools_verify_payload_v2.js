'use strict';
const fs = require('fs');
const F = '/tmp/nl_pkg_new/packages/netease_listen.js';
const ROOT = '/data/user/0/com.ai.assistance.operit/files/workspace/0b64e418-1e3c-474c-ac69-5d982078c232/p1/netease-listen';
const s = fs.readFileSync(F, 'utf8');

const keys = ['server', 'player', 'lottie', 'disk', 'n_driver', 'n_ltapi', 'n_identity', 'n_crypto', 'n_qrlogin', 'n_smslogin'];
console.log('=== payload keys present ===');
for (const k of keys) {
  const re = new RegExp('(?:^|[,\\n])' + k + ':"([A-Za-z0-9+/=]+)"');
  const m = s.match(re);
  console.log(' ', k, m ? ('OK b64len=' + m[1].length) : 'MISSING');
}
console.log('=== structure ===');
console.log('mkdir native:', s.includes('/public/vendor ${SERVER_DIR}/native'));
console.log('jobs native count:', (s.match(/SERVER_DIR \+ '\/native\//g) || []).length);
console.log('threshold 10:', s.includes('trim()) >= 10) return false;'));

// 校验 n_driver 与源一致
const m = s.match(/n_driver:"([A-Za-z0-9+/=]+)"/);
fs.writeFileSync('/tmp/chk_driver.js', Buffer.from(m[1], 'base64'));
const a = fs.readFileSync('/tmp/chk_driver.js');
const b = fs.readFileSync(ROOT + '/native/driver.js');
console.log('n_driver match source:', a.equals(b), a.length);