'use strict';
/** expU: 用 human 身份建长连接，验证能否收到 human 自己发的消息。 */
const path = require('path');
const R = '/home/ubuntu/netease_listen';
process.chdir(R);
const im = require(path.join(R, 'native/im.js'));

(async () => {
  try {
    const roomId = '00000000000000000000000000000000_0000000000';
    const chatroomId = '10000000001';
    const svc = new im.RoomChatService({ who: 'human' });
    console.log('=== entering as human ===');
    await svc.enter({
      roomId: roomId, chatroomId: chatroomId, nick: 'test',
      onMessage: function (m) {
        console.log('[HUMAN-RECV]', JSON.stringify({
          isSelf: m.isSelf, notif: m.isNotification, type: m.messageType,
          sender: m.senderId, nick: m.senderNick, text: String(m.text || '').slice(0, 50),
        }));
      },
    });
    console.log('=== entered, waiting 20s ===');
    setTimeout(function () { console.log('=== done ==='); process.exit(0); }, 20000);
  } catch (e) {
    console.log('ERR', (e && e.stack) || e);
    process.exit(2);
  }
})();