'use strict';
/* 只读探针：验证「双人房间 sync/playlist/get 能否读到播放态」这一核心假设 */
const P = __dirname;
const ltapi = require(P + '/native/ltapi.js');
const identity = require(P + '/native/identity.js');
const ROOM = process.env.ROOM || 'c25de7704fb9d3fa602683cb67fc5948_1789462242';

(async () => {
  const cookie = identity.readCookie('ai');
  console.log('cookie len =', cookie.length);
  const st = await ltapi.statusGet('ai');
  console.log('=== status/get ===');
  console.log(JSON.stringify(st, null, 2).slice(0, 1200));
  console.log('=== sync/playlist/get roomId=' + ROOM + ' ===');
  const r = await ltapi.weapiPost('/api/listen/together/sync/playlist/get', { roomId: ROOM }, cookie);
  console.log('HTTP', r.status);
  console.log(r.text.slice(0, 4000));
})().catch(e => { console.error('ERR', e && e.stack || e); });
