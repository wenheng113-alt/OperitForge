'use strict';
/** expS: 受控实验——用 human 身份发一条独特消息到房间，验证 roomwatch 能否收到。 */
const path = require('path');
const R = '/home/ubuntu/netease_listen';
process.chdir(R);
const messageLib = require(path.join(R, 'native/message.js'));

(async () => {
  try {
    const chatroomId = '10000000001';
    const roomId = '00000000000000000000000000000000_0000000000';
    const text = 'P9AD测试' + Date.now();
    const svc = new messageLib.MessageService('human');
    const r = await svc.sendToRoom({ chatroomId: chatroomId, text: text, roomId: roomId, ltType: 'FRIEND' });
    console.log('SENT(human):', JSON.stringify(r));
    console.log('TEXT:', text);
    process.exit(0);
  } catch (e) {
    console.log('ERR', (e && e.stack) || e);
    process.exit(2);
  }
})();