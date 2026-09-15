'use strict';
const path = require('path');
const R = '/home/ubuntu/netease_listen';
process.chdir(R);
const messageLib = require(path.join(R, 'native/message.js'));
(async () => {
  const chatroomId = '10000000001';
  const roomId = '00000000000000000000000000000000_0000000000';
  const text = 'P9AE-AI' + Date.now();
  const svc = new messageLib.MessageService('ai');
  const r = await svc.sendToRoom({ chatroomId: chatroomId, text: text, roomId: roomId, ltType: 'FRIEND' });
  console.log('SENT(ai):', JSON.stringify(r), 'TEXT:', text);
  process.exit(0);
})().catch(e => { console.log('ERR', e.stack); process.exit(2); });
