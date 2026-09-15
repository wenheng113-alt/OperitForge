'use strict';
/**
 * ============================================================
 *  native/message.js — 私信收发 + 房间内发言（P8 融合自参考实现）
 * ------------------------------------------------------------
 *  适配说明（本地化改造）：
 *    参考实现用 `this.client.eapiRequest(path, body)`（类式 NativeClient）。
 *    本地 ltapi.js 是函数式：`ltapi.weapiPost(path, body, cookie) → {status,text}`，
 *    身份 cookie 由 `identity.readCookie(who)` 取。故这里统一改为：
 *      const cookie = identity.readCookie(who);
 *      const r = await ltapi.weapiPost(PATHS.x, body, cookie);
 *      const j = parse(r.text);
 *    对外返回「已解析的 JSON 对象」而非原始响应，语义与参考保持一致。
 *
 *  ── 为什么房间内聊天走不通，而私信可以 ────────────────────────
 *  实测探测了 23 个「房间内聊天」候选端点，**全部 404**。
 *  但 v0.4 又实测确认：房间内发言走 HTTP 端点
 *    POST /api/middle/im/chatroom/send（不是云信长连接）。
 *
 *  ── 实测确认的能力（2026-09，真机双账号）─────────────────────
 *    ✅ 发：POST /api/msg/private/send        -> code 200，对方能收到
 *    ✅ 收：POST /api/msg/private/users       -> 会话列表（含 lastMsg）
 *            POST /api/msg/private/history    -> 与某人完整历史
 *    ✅ 房间内发言：POST /api/middle/im/chatroom/send
 *    ❌ 读取房间聊天历史：无 HTTP 接口
 *
 *  ── 三个必须记住的坑 ─────────────────────────────────────────
 *   1. history 是新→旧排序（msgs[0] 是最新的）。
 *   2. 富卡片会被降级，发纯文本最稳。
 *   3. 正文可能二次 JSON 嵌套，用 unwrapMessage 剥壳。
 * ============================================================
 */
const identity = require('./identity');
const ltapi = require('./ltapi');

const PATHS = {
  send: '/api/msg/private/send',
  users: '/api/msg/private/users',
  history: '/api/msg/private/history',
  // ✅ v0.4：房间内发言走这个 HTTP 端点（**不是**云信长连接）
  roomSend: '/api/middle/im/chatroom/send',
};

/** 私信正文长度上限：实测 907 字符的卡片被判「发送字数超过限制」(code 2004)。 */
const MAX_MSG_CHARS = 700;

/** 解析 JSON，容错 */
function parse(text) {
  try { return JSON.parse(text); } catch (e) { return {}; }
}

/**
 * 把私信记录的 `msg` 字段还原成人类可读文本。
 * 层层剥壳：字符串 -> 可选的 JSON 对象 -> 取 .msg -> 再来一轮。
 * 任何一层不是合法 JSON 就停在那里，绝不抛错。
 * @param {unknown} raw
 * @returns {string}
 */
function unwrapMessage(raw) {
  let cur = raw;
  for (let depth = 0; depth < 3; depth += 1) {
    if (cur && typeof cur === 'object') {
      if (typeof cur.msg === 'string') { cur = cur.msg; continue; }
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
 * 本地化：所有方法接收 who（'ai' | 'human'），内部自取 cookie。
 */
class MessageService {
  /**
   * @param {string} who 身份（'ai' | 'human'）
   */
  constructor(who) {
    this.who = who || 'ai';
  }

  /** 内部：带 cookie 的 eapi 请求 + 解析 */
  async _req(path, body) {
    const cookie = identity.readCookie(this.who);
    if (!cookie) return { code: -1, message: 'no cookie for ' + this.who };
    const r = await ltapi.weapiPost(path, body, cookie);
    return parse(r.text);
  }

  /**
   * 发一条私信。
   * ⚠️ 返回 code:200 但对方可能收不到展示；发完请用 history() 复核。
   * @param {string|number} userId 收件人 uid
   * @param {string} text 正文（纯文本，建议 < 700 字符）
   * @returns {Promise<object>}
   */
  send(userId, text) {
    const body = String(text || '');
    if (!body) return Promise.reject(new Error('私信正文不能为空'));
    if (body.length > MAX_MSG_CHARS) {
      return Promise.reject(new Error(
        '私信正文过长（' + body.length + ' > ' + MAX_MSG_CHARS + '），服务端会返回 2004「发送字数超过限制」',
      ));
    }
    return this._req(PATHS.send, {
      type: 'text',
      msg: body,
      userIds: JSON.stringify([Number(userId) || userId]),
    });
  }

  /**
   * 在**一起听房间里**发一条文字消息（v0.4 已跑通，真人客户端可见）。
   * 抓包真实形态：
   *   POST /api/middle/im/chatroom/send
   *     chatroomId = <roomInfo.chatRoomId>
   *     msgType    = 0
   *     clientExt  = {"bizType":"listenTogether","ltType":"FRIEND","roomId":"<roomId>"}
   *     msgBody    = {"msg":"内容","msgType":0}
   * ⚠️ 只能发，不能读。
   * @param {object} o
   * @param {string|number} o.chatroomId roomInfo.chatRoomId
   * @param {string} o.text 正文
   * @param {string} [o.roomId]
   * @param {string} [o.ltType] 默认 FRIEND
   * @returns {Promise<object>}
   */
  sendToRoom(o) {
    const opts = o || {};
    const body = String(opts.text || '');
    if (!body) return Promise.reject(new Error('房间消息不能为空'));
    if (!opts.chatroomId) return Promise.reject(new Error('缺少 chatroomId（取自 roomInfo.chatRoomId）'));
    return this._req(PATHS.roomSend, {
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
    const r = await this._req(PATHS.users, {
      limit: opts.limit || 30,
      offset: opts.offset || 0,
    });
    return (r && r.msgs) || [];
  }

  /**
   * 与某人的完整私信历史。
   * ⚠️ 新→旧排序，[0] 是最新的那条。
   * @param {string|number} userId
   * @param {{limit?: number, offset?: number}} [o]
   * @returns {Promise<Array<{text, senderUid, msgId, time, raw}>>}
   */
  async history(userId, o) {
    const opts = o || {};
    const r = await this._req(PATHS.history, {
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
   * @param {object} inviteModule 提供 extractInvites（默认 require('./invite')）
   * @returns {Promise<object|null>}
   */
  async latestInvite(inviteModule) {
    const inv = inviteModule || require('./invite');
    const convs = await this.conversations({ limit: 30 });
    const found = [];
    for (const c of convs) {
      const user = c.user || {};
      const text = unwrapMessage(user.lastMsg);
      const invites = inv.extractInvites(text);
      for (const it of invites) {
        found.push(Object.assign({}, it, {
          senderUid: it.senderUid || String(user.fromUserId || ''),
          conversationId: user.id,
        }));
      }
    }
    return found.length ? found[0] : null;
  }

  /**
   * 收集会话列表里**全部**候选邀请（不只第一条），供 list_invites 工具使用。
   * @param {object} [inviteModule]
   * @returns {Promise<Array<object>>}
   */
  async listInvites(inviteModule) {
    const inv = inviteModule || require('./invite');
    const convs = await this.conversations({ limit: 30 });
    const found = [];
    const seen = new Set();
    for (const c of convs) {
      const user = c.user || {};
      const text = unwrapMessage(user.lastMsg);
      const invites = inv.extractInvites(text);
      for (const it of invites) {
        if (seen.has(it.roomId)) continue;
        seen.add(it.roomId);
        found.push(Object.assign({}, it, {
          senderUid: it.senderUid || String(user.fromUserId || ''),
          conversationId: user.id,
        }));
      }
    }
    return found;
  }
}

module.exports = {
  MessageService,
  PATHS,
  MAX_MSG_CHARS,
  unwrapMessage,
  senderOf,
};