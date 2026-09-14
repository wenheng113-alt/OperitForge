'use strict';
/**
 * 私信收发（一起听邀请的传递通道）。
 *
 * ⚠️ 参考实现，尚未接入 server.js。
 *
 * ── 为什么房间内聊天走不通，而私信可以 ────────────────────────
 * 实测探测了 23 个「房间内聊天」候选端点，**全部 404**：
 *   /api/listen/together/chat/{get,list,send}
 *   /api/listen/together/message/{get,list,send}
 *   /api/chatroom/{get,message/send,message/get,history} ...
 *
 * 原因：`roomInfo.roomRTCType === "yunxin"`，房间内的文字/语音消息
 * 走**网易云信（Yunxin）IM 长连接**，不是 HTTP。想在插件里做「房间内
 * 发言」，要么集成云信 SDK，要么放弃。
 *
 * 但**私信是纯 HTTP 的**，而且实测收发都通 —— 所以邀请、以及
 * 「AI 想跟真人说句话」这类需求，都走私信通道。
 *
 * ── 实测确认的能力（2026-09，真机双账号）─────────────────────
 *   ✅ 发：POST /api/msg/private/send        -> code 200，对方能收到
 *   ✅ 收：POST /api/msg/private/users       -> 会话列表（含 lastMsg）
 *           POST /api/msg/private/history     -> 与某人完整历史
 *   ❌ 房间内聊天：全部 404（走云信，非 HTTP）
 *
 * ── 三个必须记住的坑 ─────────────────────────────────────────
 *  1. **history 是新→旧排序**（`msgs[0]` 是最新的）。
 *     按「最后一条是最新」读会误判成「没发出去」。
 *  2. **富卡片会被降级**。照抄官方邀请卡片（resType:23 + generalMsg）
 *     发出去，对方客户端显示「当前版本无法显示该信息，请在应用市场
 *     下载最新版app」—— 缺字段就会降级。**发纯文本最稳。**
 *  3. **正文可能二次 JSON 嵌套**：`msg` 字段本身是
 *     `{"msg":"...","resType":23,...}` 字符串，要先 JSON.parse 再取 `.msg`。
 *     直接用会看到一坨转义 JSON。
 */

const PATHS = {
  send: '/api/msg/private/send',
  users: '/api/msg/private/users',
  history: '/api/msg/private/history',
  // ✅ v0.4：房间内发言走这个 HTTP 端点（**不是**云信长连接）
  roomSend: '/api/middle/im/chatroom/send',
};

/** 私信正文长度上限：实测 907 字符的卡片被判「发送字数超过限制」(code 2004)。 */
const MAX_MSG_CHARS = 700;

/**
 * 把私信记录的 `msg` 字段还原成人类可读文本。
 *
 * 层层剥壳：字符串 -> 可选的 JSON 对象 -> 取 .msg -> 再来一轮。
 * 任何一层不是合法 JSON 就停在那里，绝不抛错。
 *
 * @param {unknown} raw
 * @returns {string}
 */
function unwrapMessage(raw) {
  let cur = raw;
  for (let depth = 0; depth < 3; depth += 1) {
    if (cur && typeof cur === 'object') {
      // 对象形态直接取 msg 字段
      if (typeof cur.msg === 'string') {
        cur = cur.msg;
        continue;
      }
      cur = JSON.stringify(cur);
      continue;
    }
    if (typeof cur !== 'string') return '';
    const trimmed = cur.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      return cur; // 不是合法 JSON，就当纯文本
    }
    if (parsed && typeof parsed === 'object' && typeof parsed.msg === 'string') {
      cur = parsed.msg;
      continue;
    }
    return cur;
  }
  return typeof cur === 'string' ? cur : String(cur);
}

/**
 * 从一条私信记录里抽出「发件人 uid」。
 * 兼容 fromUser.userId / fromUserId / user.id 三种形态。
 * @param {object} m
 * @returns {string}
 */
function senderOf(m) {
  const rec = m || {};
  const from = rec.fromUser || rec.user || {};
  const id = from.userId || rec.fromUserId || from.id || '';
  return id ? String(id) : '';
}

/**
 * 私信服务。刻意只做纯文本，避免踩富卡片降级的坑。
 */
class MessageService {
  /**
   * @param {{eapiRequest: Function}} client
   */
  constructor(client) {
    this.client = client;
  }

  /**
   * 发一条私信。
   *
   * ⚠️ 返回 `code:200` **但对方可能收不到展示**（长度超限是 2004，
   * 富卡片畸形则是降级显示）。发完请用 `history()` 复核。
   *
   * @param {string|number} userId 收件人 uid
   * @param {string} text 正文（纯文本，建议 < 700 字符）
   * @returns {Promise<object>} 网易云原始响应
   */
  send(userId, text) {
    const body = String(text || '');
    if (!body) return Promise.reject(new Error('私信正文不能为空'));
    if (body.length > MAX_MSG_CHARS) {
      return Promise.reject(new Error(
        `私信正文过长（${body.length} > ${MAX_MSG_CHARS}），服务端会返回 2004「发送字数超过限制」`,
      ));
    }
    return this.client.eapiRequest(PATHS.send, {
      type: 'text',
      msg: body,
      userIds: JSON.stringify([Number(userId) || userId]),
    });
  }

  /**
   * 在**一起听房间里**发一条文字消息（v0.4 已跑通，真人客户端可见）。
   *
   * ⚠️ v0.3 曾判定「房间内聊天走云信私有长连接，HTTP 够不着」——
   *    **该结论错误**。实测走 HTTP 明文表单即可，只是端点不在
   *    `listen/together/*` 命名空间下，所以按关键词爆破全部 404。
   *
   * 抓包得到的真实形态：
   *   POST /api/middle/im/chatroom/send
   *     chatroomId = <roomInfo.chatRoomId>
   *     msgType    = 0
   *     clientExt  = {"bizType":"listenTogether","ltType":"FRIEND","roomId":"<roomId>"}
   *     msgBody    = {"msg":"内容","msgType":0}
   *
   * ⚠️ **只能发，不能读**：`chatroom/{history,messages,get}` 全部 404。
   *    AI 想"听"真人说什么，只能用私信或轮询房间状态。
   *
   * @param {object} o
   * @param {string|number} o.chatroomId roomInfo.chatRoomId
   * @param {string} o.text 正文
   * @param {string} [o.roomId] 一起听 roomId（放进 clientExt）
   * @param {string} [o.ltType] 默认 FRIEND（取自 roomInfo.ltType）
   * @returns {Promise<object>}
   */
  sendToRoom(o) {
    const opts = o || {};
    const body = String(opts.text || '');
    if (!body) return Promise.reject(new Error('房间消息不能为空'));
    if (!opts.chatroomId) return Promise.reject(new Error('缺少 chatroomId（取自 roomInfo.chatRoomId）'));
    return this.client.eapiRequest(PATHS.roomSend, {
      chatroomId: String(opts.chatroomId),
      msgType: '0',
      clientExt: JSON.stringify({
        bizType: 'listenTogether',
        ltType: opts.ltType || 'FRIEND',
        roomId: opts.roomId || '',
      }),
      msgBody: JSON.stringify({ msg: body, msgType: 0 }),
    });
  }

  /**
   * 会话列表（每个会话带 lastMsg 摘要）。
   * @param {{limit?: number, offset?: number}} [o]
   * @returns {Promise<Array<object>>}
   */
  async conversations(o) {
    const opts = o || {};
    const r = await this.client.eapiRequest(PATHS.users, {
      limit: opts.limit || 30,
      offset: opts.offset || 0,
    });
    return (r && r.msgs) || [];
  }

  /**
   * 与某人的完整私信历史。
   *
   * ⚠️ **新→旧排序**，`[0]` 是最新的那条。
   * 每条会附上解析后的 `text` 与 `senderUid`，方便直接判断方向。
   *
   * @param {string|number} userId
   * @param {{limit?: number, offset?: number}} [o]
   * @returns {Promise<Array<{text: string, senderUid: string, msgId: any, time: number, raw: object}>>}
   */
  async history(userId, o) {
    const opts = o || {};
    const r = await this.client.eapiRequest(PATHS.history, {
      userId: Number(userId) || userId,
      limit: opts.limit || 30,
      offset: opts.offset || 0,
    });
    return ((r && r.msgs) || []).map(function (m) {
      return {
        text: unwrapMessage(m.msg),
        senderUid: senderOf(m),
        msgId: m.msgId,
        time: m.time || 0,
        raw: m,
      };
    });
  }

  /**
   * 从会话列表里找最新一条「一起听邀请」。
   * 用会话列表而非 history，因为新会话不会出现在 history 里。
   *
   * @param {import('./invite.js')} inviteModule 提供 extractInvites
   * @returns {Promise<object|null>}
   */
  async latestInvite(inviteModule) {
    const convs = await this.conversations({ limit: 30 });
    const found = [];
    for (const c of convs) {
      const user = c.user || {};
      const text = unwrapMessage(user.lastMsg);
      const invites = inviteModule.extractInvites(text);
      for (const inv of invites) {
        found.push(Object.assign({}, inv, {
          senderUid: inv.senderUid || String(user.fromUserId || ''),
          conversationId: user.id,
        }));
      }
    }
    return found.length ? found[0] : null;
  }
}

module.exports = {
  MessageService,
  PATHS,
  MAX_MSG_CHARS,
  unwrapMessage,
  senderOf,
};
