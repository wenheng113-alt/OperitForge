'use strict';
/**
 * ============================================================
 *  native/roomwatch.js — 房间「读消息」常驻监听（云信 NIM）
 * ------------------------------------------------------------
 *  职责：
 *    - 在 server 进程内维持一个云信长连接（AI 身份）
 *    - 实时收取房间里真人发的消息，去重后放进环形缓冲
 *    - 对外暴露 pull(sinceSeq) 供 server 轮询消费
 *
 *  为什么需要它：
 *    HTTP 层 chatroom/{history,messages,get} 全部 404（已复测），
 *    读房间消息的唯一途径是云信长连接（见 native/im.js）。
 *
 *  ⚠️ 实测踩坑：
 *    - onReceiveMessages 必须注册在 V2NIMChatroomService 上（im.js 已处理）
 *    - 进房瞬间会收到「自己进房」系统通知（messageType=5），须过滤
 *    - 只处理进房之后的新消息（按 createTime 与 enterTs 比较），
 *      否则启动时会把历史消息全部当成新消息回灌，造成刷屏
 * ============================================================
 */
const im = require('./im');

function createRoomWatch() {
  let svc = null;
  let started = false;
  let roomId = '';
  let chatroomId = '';
  let buffer = [];       // [{ seq, msg }]
  let seq = 0;
  let seen = {};         // messageClientId -> 1（去重）
  let enterTs = 0;
  let onHuman = null;    // 收到真人消息时回调（可选，用于即时推送）

  /** 是否值得处理：非通知、非自己、有文本、未见过、且在进房之后 */
  function accept(m) {
    if (!m) return false;
    if (m.isNotification) return false;   // 进房/退房系统消息
    if (m.isSelf) return false;           // 自己（AI）发的
    if (!m.text) return false;            // 无正文
    if (started && enterTs && m.time && m.time < enterTs) return false; // 进房前的历史
    const id = m.id || (String(m.senderId) + '|' + String(m.time) + '|' + m.text);
    if (seen[id]) return false;
    seen[id] = 1;
    return true;
  }

  /**
   * 启动监听。
   * @param {{roomId:string, chatroomId:string|number, nick?:string}} opts
   */
  async function start(opts) {
    const o = opts || {};
    if (started) return { ok: true, already: true, chatroomId: chatroomId };
    roomId = o.roomId || '';
    chatroomId = String(o.chatroomId || '');
    if (!roomId || !chatroomId) throw new Error('缺少 roomId/chatroomId');

    svc = new im.RoomChatService({ who: 'ai' });
    await svc.enter({
      roomId: roomId,
      chatroomId: chatroomId,
      nick: o.nick || '',
      onMessage: function (m) {
        if (!accept(m)) return;
        seq += 1;
        const item = { seq: seq, msg: m };
        buffer.push(item);
        if (buffer.length > 300) buffer.shift();
        if (typeof onHuman === 'function') { try { onHuman(m); } catch (e) {} }
      },
    });
    enterTs = Date.now();
    started = true;
    return { ok: true, chatroomId: chatroomId };
  }

  /** 取 seq > since 的所有新消息（不删除缓冲） */
  function pull(since) {
    const s = Number(since || 0);
    return buffer.filter(function (it) { return it.seq > s; });
  }

  /** 当前已产生的最大 seq（用于初始化游标，跳过历史） */
  function cursor() { return seq; }

  function setOnHuman(fn) { onHuman = (typeof fn === 'function') ? fn : null; }

  function status() {
    return {
      started: started,
      roomId: roomId,
      chatroomId: chatroomId,
      seq: seq,
      bufferLen: buffer.length,
      seen: Object.keys(seen).length,
    };
  }

  function stop() {
    if (svc) { try { svc.exit(); } catch (e) {} }
    svc = null;
    started = false;
    buffer = [];
    seq = 0;
    seen = {};
    enterTs = 0;
    return { ok: true };
  }

  return {
    start: start,
    pull: pull,
    cursor: cursor,
    setOnHuman: setOnHuman,
    status: status,
    stop: stop,
  };
}

module.exports = { createRoomWatch: createRoomWatch };
